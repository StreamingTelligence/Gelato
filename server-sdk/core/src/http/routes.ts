import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import type { CommandService } from "../commandService.js";
import type { UnifiedDeviceRegistry } from "../registry.js";
import type { DeviceAgentPairingService } from "../pairingService.js";
import type { StreamBroker } from "../streamBroker.js";
import { ObservationHub } from "./observations.js";

export interface AccessGrant {
  token: string;
  userId: string;
  deviceIds: string[];
  capabilities: string[];
  expiresAt: number;
}
interface CommandRecord {
  command_id: string; device_id: string; user_id: string; fingerprint: string;
  state: string; capability: string; result?: unknown; error?: string;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function save(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp";
  const fd = fs.openSync(temp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
export function loadGrants(file: string): AccessGrant[] {
  const values = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(values)) throw new Error("invalid_access_grants");
  const tokens = new Set<string>();
  for (const g of values) {
    if (typeof g.token !== "string" || g.token.length < 24 || tokens.has(g.token)
        || typeof g.userId !== "string" || !g.userId || !Array.isArray(g.deviceIds)
        || !g.deviceIds.every((id: any) => typeof id === "string" && /^dev_[A-Za-z0-9_-]+$/.test(id))
        || !Array.isArray(g.capabilities) || !g.capabilities.every((c: any) => typeof c === "string")
        || !Number.isFinite(g.expiresAt)) throw new Error("invalid_access_grant");
    tokens.add(g.token);
  }
  return values;
}

export function createHostRouter(options: {
  grants: () => AccessGrant[]; registry: UnifiedDeviceRegistry; pairing: DeviceAgentPairingService;
  commands: CommandService; observations: ObservationHub; stateFile: string; streams?: StreamBroker;
}) {
  const { registry, pairing, commands, observations, stateFile } = options;
  const records: Record<string, CommandRecord> = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
  for (const r of Object.values(records)) if (r.state === "running") r.state = "result_unknown";
  save(stateFile, records);
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const supplied = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const incoming = Buffer.from(hash(supplied));
      const grant = options.grants().find(g => timingSafeEqual(incoming, Buffer.from(hash(g.token))) && g.expiresAt > Date.now());
      if (!grant) { res.status(401).json({ error: "unauthorized" }); return; }
      res.locals.grant = grant; next();
    } catch { res.status(503).json({ error: "authorization_unavailable" }); }
  });
  function owns(g: AccessGrant, deviceId: string, consent = true) {
    const paired = pairing.listPairings().some(p => p.deviceId === deviceId && p.ownerUserId === g.userId && !p.revokedAt);
    if (!g.deviceIds.includes(deviceId) || !paired) return false;
    return !consent || registry.get(deviceId)?.hardware.controlAllowed === true;
  }
  router.get("/devices", (_req, res) => {
    const g = res.locals.grant as AccessGrant;
    res.json({ devices: registry.list().filter(d => owns(g, d.deviceId, false)) });
  });
  router.get("/devices/:deviceId/observations", (req, res) => {
    const g = res.locals.grant as AccessGrant;
    if (!owns(g, req.params.deviceId)) { res.status(403).json({ error: "device_observation_denied" }); return; }
    try { res.json(observations.read(req.params.deviceId, Number(req.query.after ?? 0), typeof req.query.epoch === "string" ? req.query.epoch : undefined)); }
    catch { res.status(400).json({ error: "invalid_observation_cursor" }); }
  });
  router.post("/devices/:deviceId/commands", (req, res) => {
    const g = res.locals.grant as AccessGrant;
    if (!owns(g, req.params.deviceId)) { res.status(403).json({ error: "device_command_denied" }); return; }
    const body = req.body;
    if (!body || typeof body.command_id !== "string" || !/^cmd_[A-Za-z0-9_-]{10,80}$/.test(body.command_id)
        || typeof body.capability !== "string" || !g.capabilities.includes(body.capability)
        || !body.arguments || typeof body.arguments !== "object" || Array.isArray(body.arguments)
        || (body.deadline_ms !== undefined && (!Number.isSafeInteger(body.deadline_ms) || body.deadline_ms < 1 || body.deadline_ms > 120000))
        || Object.keys(body).some(k => !["command_id", "capability", "arguments", "deadline_ms"].includes(k))) {
      res.status(400).json({ error: "invalid_or_unauthorized_command" }); return;
    }
    const fingerprint = hash(stable([req.params.deviceId, body]));
    const existing = records[body.command_id];
    if (existing) {
      if (existing.user_id !== g.userId || existing.fingerprint !== fingerprint) {
        res.status(409).json({ error: "command_id_conflict" }); return;
      }
      res.json(existing); return;
    }
    const pending = Object.values(records).some(r => r.device_id === req.params.deviceId && r.state === "running"
      && r.capability !== "screen.capture" && body.capability !== "screen.capture");
    if (pending) { res.status(409).json({ error: "device_action_in_progress" }); return; }
    const record: CommandRecord = { command_id: body.command_id, device_id: req.params.deviceId, user_id: g.userId,
      capability: body.capability, fingerprint, state: "running" };
    records[body.command_id] = record;
    try { save(stateFile, records); }
    catch { delete records[body.command_id]; res.status(503).json({ error: "command_journal_unavailable" }); return; }
    try {
      void commands.execute(record.device_id, { commandId: body.command_id, capability: body.capability,
        arguments: body.arguments, deadlineMs: body.deadline_ms }).then(result => {
          if (record.state !== "running") return;
          record.state = result.state; record.result = result.result; save(stateFile, records);
        }, () => {
          if (record.state !== "running") return;
          record.state = commands.get(body.command_id)?.state ?? "result_unknown";
          record.error = "device_command_unsuccessful"; save(stateFile, records);
        }).catch(() => { record.state = "result_unknown"; });
    } catch { record.state = "failed"; record.error = "command_rejected_before_dispatch"; save(stateFile, records); }
    res.status(record.state === "running" ? 202 : 200).json(record);
  });
  router.get('/devices/:deviceId/streams/:streamId/content', (req, res) => {
    const g = res.locals.grant as AccessGrant;
    if (!owns(g, req.params.deviceId)) { res.status(403).json({ error: 'device_media_denied' }); return; }
    const stream = options.streams?.get(req.params.streamId);
    const file = options.streams?.file(req.params.streamId);
    if (!stream || stream.deviceId !== req.params.deviceId || stream.state !== 'complete' || !file) {
      res.status(404).json({ error: 'stream_unavailable' }); return;
    }
    res.setHeader('Content-Type', stream.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.resolve(file));
  });
  router.get("/commands/:commandId", (req, res) => {
    const r = records[req.params.commandId];
    if (!r || r.user_id !== res.locals.grant.userId || !owns(res.locals.grant, r.device_id)) {
      res.status(404).json({ error: "command_unavailable" }); return;
    }
    res.json(r);
  });
  router.post("/commands/:commandId/cancel", (req, res) => {
    const r = records[req.params.commandId];
    if (!r || r.user_id !== res.locals.grant.userId || !owns(res.locals.grant, r.device_id, false)) {
      res.status(404).json({ error: "command_unavailable" }); return;
    }
    if (r.state === "running") { commands.cancel(r.device_id, r.command_id); r.state = "cancelled"; save(stateFile, records); }
    res.json({ ...r, effects_rolled_back: false });
  });
  return router;
}
