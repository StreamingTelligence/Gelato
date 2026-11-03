import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import type { Request } from "express";
import { nanoid } from "nanoid";
import { WebSocket, WebSocketServer } from "ws";
import { PacketOverlayHub } from "@gelato/server-ios";
import { IosDeviceDriver } from "@gelato/server-ios";
import { AndroidDeviceDriver } from "@gelato/server-android";
import { AgentGateway } from "@gelato/server-core";
import { TinodeAccounts } from "./account/tinode.js";
import { accountRoutes } from "./account/routes.js";
import { CapabilityRouter, DeviceControlPausedError } from "@gelato/server-core";
import { CommandService } from "@gelato/server-core";
import { UnifiedDeviceRegistry } from "@gelato/server-core";
import { DeviceAgentPairingService } from "@gelato/server-core";
import { StreamBroker } from "@gelato/server-core";
import { UnifiedRemoteDeviceDriver } from "@gelato/server-core";
import { GELATO_PROTOCOL, type ProtocolEnvelope, type StreamOffer, type UnifiedDeviceRecord } from "@gelato/server-core";
import { transportConfig, createControllerServer, requestOrigin } from "./transportConfig.js";
import { ObservationHub } from "@gelato/server-core";
import { createHostRouter, loadGrants } from "@gelato/server-core";
import { ModelBridge, deliverReply } from "@gelato/server-core";
import { createModelConnection } from "@gelato/model-interface";
import { LatestScreenFrames } from "./latestScreenFrames.js";

export interface ControllerOptions { publicDirectory?: string; }

export async function startController(options: ControllerOptions = {}) {
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const transport = transportConfig(process.env);
const port = transport.port;
const bindHost = transport.host;
const controllerApiToken = readControllerApiToken();
const adminSessionCookie = "serverized_admin";
const adminSessionTtlMs = 12 * 60 * 60_000;
const adminSessions = new Map<string, number>();
type PairingRequest = {
  id: string;
  secret: string;
  agentKind: string;
  displayName: string;
  remoteAddress: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied";
  pairingCode?: string;
};
const pairingRequests = new Map<string, PairingRequest>();
const pairingRequestRate = new Map<string, number[]>();
const pairingRequestTtlMs = 10 * 60_000;
if ((process.env.PUBLIC_CONTROLLER_URL || !isLoopbackHost(bindHost)) && !controllerApiToken) {
  throw new Error(
    "CONTROLLER_API_TOKEN is required with PUBLIC_CONTROLLER_URL or a non-loopback HOST"
  );
}
const app = express();
const trustLocalCloudflared = process.env.ACCOUNT_TRUST_LOCAL_CLOUDFLARED === "1";
if (trustLocalCloudflared && !isLoopbackHost(bindHost)) {
  throw new Error("ACCOUNT_TRUST_LOCAL_CLOUDFLARED requires a loopback HOST");
}
const deviceAgentPairing = new DeviceAgentPairingService(
  process.env.GELATO_PAIRING_STORE ?? path.resolve(process.cwd(), "data/gelato-pairings.json")
);
const packetOverlay = new PacketOverlayHub(deviceAgentPairing, trustLocalCloudflared);
const unifiedRegistry = new UnifiedDeviceRegistry();
const agentGateway = new AgentGateway(deviceAgentPairing, unifiedRegistry, trustLocalCloudflared);
const capabilityRouter = new CapabilityRouter(unifiedRegistry);
const commandService = new CommandService(agentGateway, capabilityRouter);
const streamBroker = new StreamBroker(
  deviceAgentPairing,
  process.env.GELATO_STREAM_DIR ?? path.resolve(process.cwd(), "data/gelato-streams"),
  (deviceId) => unifiedRegistry.get(deviceId)?.hardware.controlAllowed === true
);
const latestScreenFrames = new LatestScreenFrames();
const modelConnection = await createModelConnection({
  env: process.env,
  onLiveReply: (deviceId, text, pcm16) => {
    const device = unifiedRegistry.get(deviceId);
    if (device?.kind !== "rokid.bolon" || !device.connection.online
        || device.hardware.controlAllowed !== true || pcm16.length < 2
        || pcm16.length > 8 * 1024 * 1024 || pcm16.length % 2 !== 0) return;
    const stream = streamBroker.offerDownload(device.agent.agentId, deviceId, pcm16, {
      purpose: "audio", contentType: "audio/pcm",
      metadata: { sampleRateHz: 24000, channels: 1, sampleFormat: "s16le" }
    });
    deliverReply(agentGateway, deviceId, text, undefined, {
      streamId: stream.streamId, mimeType: "audio/pcm", sampleRateHz: 24000,
      channels: 1, sizeBytes: pcm16.length, sha256: stream.sha256!
    });
  },
  onAction: async (proposal, signal) => {
    // The model never receives pairing credentials or a direct device route.
    // Resolve only the capability that this device currently advertises;
    // the device remains the final authority on whether it executes it.
    try { capabilityRouter.resolve(proposal.deviceId, proposal.capability); }
    catch { return { status: "rejected" }; }
    if (signal.aborted) return { status: "unknown" };
    if (proposal.capability === "screen.capture") {
      const frame = latestScreenFrames.latest(proposal.deviceId);
      if (frame && frame.jpeg.length <= 600_000) {
        return { status: "completed", result: {
          mimeType: "image/jpeg", dataBase64: frame.jpeg.toString("base64"),
          sequence: frame.sequence
        } };
      }
    }
    const commandId = `cmd_${nanoid(24)}`;
    const cancel = () => { try { commandService.cancel(proposal.deviceId, commandId); }
      catch { /* A disconnected device may already have executed the action. */ } };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const terminal = await commandService.execute(proposal.deviceId, {
        commandId, capability: proposal.capability, arguments: proposal.args,
        idempotency: ["screen.capture", "ui.tree", "device.describe"].includes(proposal.capability)
          ? "read-only" : "side-effecting"
      });
      const result = terminal.result ?? {};
      if (proposal.capability === "screen.capture") {
        const stream = result.stream && typeof result.stream === "object"
          ? result.stream as { streamId?: unknown; contentType?: unknown } : undefined;
        const file = typeof stream?.streamId === "string" ? streamBroker.file(stream.streamId) : undefined;
        if (file && typeof stream?.contentType === "string") {
          const stat = fs.statSync(file);
          if (stat.size > 0 && stat.size <= 600_000) {
            return { status: "completed", commandId, result: {
              mimeType: stream.contentType, dataBase64: fs.readFileSync(file).toString("base64")
            } };
          }
        }
      }
      return { status: "completed", commandId, result };
    } catch {
      const terminal = commandService.get(commandId);
      return { status: terminal?.state === "failed" || terminal?.state === "cancelled"
        ? "failed" : "unknown", commandId };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
});
const modelEndpoint = modelConnection?.endpoint;
const visualSequences = new Map<string, number>();
const visualPump = modelConnection?.continuousVisual ? setInterval(() => {
  for (const device of unifiedRegistry.list()) {
    if (!device.connection.online || device.hardware.controlAllowed !== true) continue;
    const frame = latestScreenFrames.latest(device.deviceId);
    if (!frame || visualSequences.get(device.deviceId) === frame.sequence) continue;
    if (modelConnection.live?.pushImage(device.deviceId, frame.jpeg)) {
      visualSequences.set(device.deviceId, frame.sequence);
    }
  }
}, 1_000) : undefined;
visualPump?.unref();
const modelBridge = modelEndpoint
  ? new ModelBridge(agentGateway, streamBroker, modelEndpoint)
  : undefined;
commandService.on("cancel", ({ deviceId, commandId, reason }) => {
  streamBroker.cancelCommand(deviceId, commandId, reason);
});
unifiedRegistry.on("changed", (device: UnifiedDeviceRecord) => {
  if (device.hardware.controlAllowed === true && device.connection.online) return;
  modelConnection?.live?.stop(device.deviceId);
  visualSequences.delete(device.deviceId);
  commandService.cancelDevice(device.deviceId);
  streamBroker.cancelDevice(device.deviceId);
  latestScreenFrames.clear(device.deviceId);
});
const unifiedDriver = new UnifiedRemoteDeviceDriver(commandService, unifiedRegistry);
const androidDriver = new AndroidDeviceDriver(commandService, unifiedRegistry);
const iosDriver = new IosDeviceDriver(commandService, unifiedRegistry);
const consoles = new Set<WebSocket>();
const screenViewers = new Map<string, Set<WebSocket>>();
const mdnsAdvertisements = new Map<string, MdnsAdvertisementRecord>();
const localTcpProxies = new Map<string, LocalTcpProxyRecord>();
const localTcpProxyRanges = new Map<string, LocalTcpProxyRangeRecord>();
const taskArtifactDir = process.env.TASK_ARTIFACT_DIR
  ?? path.resolve(process.cwd(), "data/task-artifacts");
app.use(cors());
// Account requests never need the large media payload limit used by the API.
app.use("/account", express.json({ limit: "32kb" }), accountRoutes(new TinodeAccounts(
  process.env.TINODE_WS_URL ?? "", process.env.TINODE_API_KEY ?? ""
), deviceAgentPairing, unifiedRegistry, publicControllerUrl, trustLocalCloudflared));
app.use("/pairing-requests", express.json({ limit: "4kb" }));
app.use(express.json({ limit: "64mb" }));

// Opt-in host API. Separate expiring user/device-scoped grants, never the admin token.
// It reuses the existing drivers, pairing, consent and media pipeline.
if (process.env.GALATEA_HARNESS_GRANTS_FILE) {
  const grantsFile = process.env.GALATEA_HARNESS_GRANTS_FILE;
  loadGrants(grantsFile); // fail startup on malformed configuration
  const observations = new ObservationHub(streamBroker);
  app.use("/harness/v1", createHostRouter({ grants: () => loadGrants(grantsFile),
    registry: unifiedRegistry, pairing: deviceAgentPairing, commands: commandService,
    observations, streams: streamBroker, stateFile: process.env.GALATEA_HARNESS_STATE_FILE ??
      path.resolve(process.cwd(), "data/harness-commands.json") }));
}

app.get("/auth/status", (req, res) => {
  res.status(controllerRequestAuthorized(req) ? 200 : 401).json({
    authenticated: controllerRequestAuthorized(req),
    required: Boolean(controllerApiToken)
  });
});

app.post("/auth/session", (req, res) => {
  if (!controllerApiToken) {
    res.status(204).end();
    return;
  }
  const supplied = typeof req.body.token === "string" ? req.body.token.trim() : undefined;
  if (!secureTokenEqual(supplied, controllerApiToken)) {
    res.status(401).json({ error: "Invalid controller access token" });
    return;
  }
  const sessionId = nanoid(48);
  adminSessions.set(sessionId, Date.now() + adminSessionTtlMs);
  res.cookie(adminSessionCookie, sessionId, {
    httpOnly: true,
    sameSite: "strict",
    secure: requestUsesHttps(req),
    maxAge: adminSessionTtlMs,
    path: "/"
  });
  res.status(204).end();
});

app.delete("/auth/session", (req, res) => {
  const sessionId = requestCookie(req.headers.cookie, adminSessionCookie);
  if (sessionId) adminSessions.delete(sessionId);
  res.clearCookie(adminSessionCookie, {
    httpOnly: true,
    sameSite: "strict",
    secure: requestUsesHttps(req),
    path: "/"
  });
  res.status(204).end();
});

function expirePairingRequests() {
  const now = Date.now();
  for (const [id, item] of pairingRequests) {
    if (item.expiresAt <= now) pairingRequests.delete(id);
  }
  for (const [address, times] of pairingRequestRate) {
    const active = times.filter((time) => now - time < pairingRequestTtlMs);
    if (active.length) pairingRequestRate.set(address, active);
    else pairingRequestRate.delete(address);
  }
}

// A device only asks to be paired. It cannot create a pairing code or authorize itself.
app.post("/pairing-requests", (req, res) => {
  expirePairingRequests();
  const agentKind = stringOrUndefined(req.body?.agentKind);
  const displayName = stringOrUndefined(req.body?.displayName);
  if (!agentKind || !["android-phone", "ios", "rokid-bolon-native", "esp32s3-xiao-camera"].includes(agentKind)
    || !displayName || displayName.length > 80) {
    res.status(400).json({ error: "Invalid device description" });
    return;
  }
  const remoteAddress = req.socket.remoteAddress ?? "unknown";
  const recent = pairingRequestRate.get(remoteAddress) ?? [];
  const active = [...pairingRequests.values()].filter(
    (item) => item.remoteAddress === remoteAddress && item.status === "pending"
  ).length;
  if (recent.length >= 10 || active >= 3 || pairingRequests.size >= 100) {
    res.status(429).json({ error: "Too many pairing requests; try again later" });
    return;
  }
  pairingRequestRate.set(remoteAddress, [...recent, Date.now()]);
  const item: PairingRequest = {
    id: `pr_${nanoid(24)}`,
    secret: nanoid(48),
    agentKind,
    displayName,
    remoteAddress,
    createdAt: Date.now(),
    expiresAt: Date.now() + pairingRequestTtlMs,
    status: "pending"
  };
  pairingRequests.set(item.id, item);
  res.status(202).json({ requestId: item.id, secret: item.secret, expiresAt: item.expiresAt });
});

app.get("/pairing-requests/:id", (req, res) => {
  expirePairingRequests();
  const item = pairingRequests.get(req.params.id);
  if (!item || !secureTokenEqual(bearerToken(req.headers.authorization), item.secret)) {
    res.status(404).json({ error: "Pairing request not found or expired" });
    return;
  }
  res.set("Cache-Control", "no-store");
  res.json({ status: item.status, expiresAt: item.expiresAt,
    ...(item.status === "approved" ? { pairingCode: item.pairingCode } : {}) });
});

app.delete("/pairing-requests/:id", (req, res) => {
  const item = pairingRequests.get(req.params.id);
  if (!item || !secureTokenEqual(bearerToken(req.headers.authorization), item.secret)) {
    res.status(404).json({ error: "Pairing request not found or expired" });
    return;
  }
  if (item.status === "pending") item.status = "denied";
  res.status(204).end();
});

app.use("/api", (req, res, next) => {
  if (!controllerRequestAuthorized(req)) {
    res.status(401).json({ error: "Controller API authentication required" });
    return;
  }
  next();
});

const publicDir = options.publicDirectory ?? path.resolve(__dirname, "../public");
app.use(express.static(publicDir));

app.get("/vendor/jmuxer.min.js", (_req, res) => {
  res.sendFile(require.resolve("jmuxer/dist/jmuxer.min.js"));
});

app.get("/api/devices", (_req, res) => {
  res.json({ protocol: GELATO_PROTOCOL, devices: unifiedRegistry.list() });
});

// An authenticated operator may start a model turn without making the model
// endpoint a second Controller. Actions still return through onAction above and
// the current device session remains the authority that executes them.
app.post("/api/devices/:deviceId/model/turn", asyncRoute(async (req, res) => {
  if (!modelConnection?.interactive || !modelEndpoint) {
    res.status(409).json({ error: "Interactive model endpoint is not configured" });
    return;
  }
  const device = unifiedRegistry.get(req.params.deviceId);
  if (!device || device.connection.online !== true) {
    res.status(409).json({ error: "Device is offline" });
    return;
  }
  if (device.hardware.controlAllowed !== true) {
    res.status(403).json({ error: "Device control is disabled" });
    return;
  }
  const instruction = req.body?.instruction;
  if (typeof instruction !== "string" || !instruction.trim()
      || Buffer.byteLength(instruction, "utf8") > 16_384) {
    res.status(400).json({ error: "A nonempty instruction of at most 16 KiB is required" });
    return;
  }
  const text = await modelEndpoint.generate({
    deviceId: device.deviceId,
    messageId: `msg_${nanoid(24)}`,
    parts: [{ type: "text", text: instruction.trim() }]
  });
  res.json({ text });
}));

app.get("/api/pairing-requests", (_req, res) => {
  expirePairingRequests();
  res.json({ requests: [...pairingRequests.values()]
    .filter((item) => item.status === "pending")
    .map(({ id, agentKind, displayName, createdAt, expiresAt }) =>
      ({ id, agentKind, displayName, createdAt, expiresAt })) });
});

app.post("/api/pairing-requests/:id/approve", (req, res) => {
  expirePairingRequests();
  const item = pairingRequests.get(req.params.id);
  if (!item || item.status !== "pending") {
    res.status(404).json({ error: "Pairing request not found or expired" });
    return;
  }
  const session = deviceAgentPairing.createSession({
    allowedAgentKind: item.agentKind,
    displayName: item.displayName,
    controllerUrl: publicControllerUrl(req),
    ttlMs: pairingRequestTtlMs
  });
  item.status = "approved";
  item.pairingCode = session.code;
  item.expiresAt = session.expiresAt;
  res.json({ approved: true, displayName: item.displayName });
});

app.post("/api/pairing-requests/:id/deny", (req, res) => {
  expirePairingRequests();
  const item = pairingRequests.get(req.params.id);
  if (!item || item.status !== "pending") {
    res.status(404).json({ error: "Pairing request not found or expired" });
    return;
  }
  item.status = "denied";
  res.json({ denied: true });
});

app.post("/api/pairing-sessions", asyncRoute(async (req, res) => {
  const session = deviceAgentPairing.createSession({
    allowedAgentKind: stringOrUndefined(req.body.agentKind),
    displayName: stringOrUndefined(req.body.displayName),
    controllerUrl: stringOrUndefined(req.body.controllerUrl) ?? publicControllerUrl(req),
    ttlMs: Number(req.body.ttlMs ?? 10 * 60_000)
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ session });
}));

app.get("/api/pairing-sessions", (_req, res) => {
  res.json({ sessions: deviceAgentPairing.listPending() });
});

app.get("/api/pairings", (_req, res) => {
  res.json({ pairings: deviceAgentPairing.listPairings() });
});

app.delete("/api/pairings/:deviceId", (req, res) => {
  const revokedAgentIds = deviceAgentPairing.revokeDevice(req.params.deviceId);
  for (const agentId of revokedAgentIds) agentGateway.disconnectAgent(agentId);
  res.json({ revoked: revokedAgentIds.length > 0, revokedAgentIds });
});

app.delete("/api/agents/:agentId", (req, res) => {
  const revoked = deviceAgentPairing.revokeAgent(req.params.agentId);
  if (revoked) agentGateway.disconnectAgent(req.params.agentId);
  res.json({ revoked });
});

app.post("/api/devices/:deviceId/commands", asyncRoute(async (req, res) => {
  const terminal = await commandService.execute(req.params.deviceId, {
    commandId: stringOrUndefined(req.body.commandId),
    capability: String(req.body.capability ?? ""),
    capabilityVersion: Number(req.body.capabilityVersion ?? 1),
    arguments: req.body.arguments && typeof req.body.arguments === "object" && !Array.isArray(req.body.arguments)
      ? req.body.arguments : {},
    deadlineMs: req.body.deadlineMs === undefined ? undefined : Number(req.body.deadlineMs),
    idempotency: req.body.idempotency
  });
  res.json({ command: terminal });
}));

app.post("/api/devices/:deviceId/replies", (req, res) => {
  try {
    const replyId = deliverReply(agentGateway, req.params.deviceId, req.body?.text, req.body?.inReplyTo);
    res.status(202).json({ replyId });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid reply" });
  }
});

app.post("/api/devices/:deviceId/commands/:commandId/cancel", (req, res) => {
  res.status(202).json({
    accepted: commandService.cancel(req.params.deviceId, req.params.commandId)
  });
});

app.get("/api/commands/:commandId", (req, res) => {
  const command = commandService.get(req.params.commandId);
  if (!command) {
    res.status(404).json({ error: "Command not found or still running" });
    return;
  }
  res.json({ command });
});

app.get("/api/streams", (req, res) => {
  res.json({ streams: streamBroker.list(stringOrUndefined(req.query.deviceId)) });
});

app.get("/api/streams/:streamId", (req, res) => {
  const stream = streamBroker.get(req.params.streamId);
  if (!stream) {
    res.status(404).json({ error: "Stream not found" });
    return;
  }
  res.json({ stream });
});

app.get("/api/streams/:streamId/content", (req, res) => {
  const stream = streamBroker.get(req.params.streamId);
  const file = streamBroker.file(req.params.streamId);
  if (!stream || !file) {
    res.status(404).json({ error: "Stream content is not complete" });
    return;
  }
  res.type(stream.contentType).sendFile(file);
});

app.post(
  "/api/devices/:deviceId/streams",
  express.raw({ type: "application/octet-stream", limit: "128mb" }),
  (req, res) => {
    const device = unifiedRegistry.get(req.params.deviceId);
    if (!device) {
      res.status(404).json({ error: "Device is not registered" });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "Stream body must be non-empty application/octet-stream" });
      return;
    }
    const purpose = String(req.query.purpose ?? "file") as StreamOffer["purpose"];
    const contentType = String(req.query.contentType ?? "application/octet-stream");
    const stream = streamBroker.offerDownload(
      device.agent.agentId,
      device.deviceId,
      req.body,
      { purpose, contentType }
    );
    res.status(201).json({ stream });
  }
);

app.get("/agent/streams/:streamId/content", (req, res, next) => {
  const download = streamBroker.openAgentDownload(
    req.params.streamId,
    req.header("x-device-id"),
    req.header("x-agent-id"),
    bearerToken(req.headers.authorization)
  );
  if (!download) {
    res.status(404).json({ error: "Device stream is unavailable" });
    return;
  }
  res.setHeader("cache-control", "no-store");
  const stopPausedDownload = (stream: { streamId: string }) => {
    if (stream.streamId === download.stream.streamId) res.destroy();
  };
  streamBroker.on("failed", stopPausedDownload);
  res.once("close", () => streamBroker.off("failed", stopPausedDownload));
  res.type(download.stream.contentType).sendFile(download.filePath, (error) => {
    streamBroker.off("failed", stopPausedDownload);
    if (error) {
      next(error);
      return;
    }
    streamBroker.completeAgentDownload(download.stream.streamId);
  });
});

app.get("/api/acceptance/network", asyncRoute(async (_req, res) => {
  const devices = unifiedRegistry.list().map((device) => {
    const overlay = packetOverlay.listSessions().find((value) => value.deviceId === device.deviceId);
    const isIos = device.os.family === "ios";
    const publicPacketTunnelReady = isIos
      && overlay?.iosConnected === true
      && (overlay.iosNetworkClass === "public-relay" || overlay.iosNetworkClass === "public-direct");
    const persistentWdaReady = isIos
      && publicPacketTunnelReady
      && overlay?.linuxConnected === true
      && (overlay.iosOnDeviceRemoteXpcState === "wdaReady" || overlay.iosMainAppRemoteXpcState === "wdaReady");
    const publicTransportReady = Object.values(device.connection.transports ?? {}).some(
      (transport) => transport.online
        && (transport.networkClass === "public-relay" || transport.networkClass === "public-direct")
    );
    const blockers = [
      ...(!device.connection.online ? ["No authenticated device connection is online"] : []),
      ...(!publicTransportReady ? ["No authenticated public relay/direct transport is online"] : []),
      ...(device.driver.state !== "ready" ? [device.driver.error ?? `Driver ${device.driver.id} is ${device.driver.state}`] : []),
      ...(!device.hardware.connected ? ["Device-local hardware is not connected"] : []),
      ...(device.capabilities.length === 0 ? ["Device advertised no capabilities"] : []),
      ...(isIos && !publicPacketTunnelReady
        ? ["Authenticated iOS Packet Tunnel is not online through a public relay/direct path"] : []),
      ...(isIos && overlay?.linuxConnected !== true
        ? ["Authenticated pure-Linux sidecar is not online"] : []),
      ...(isIos && !persistentWdaReady
        ? ["Pure-Linux RemoteXPC/WDA driver has not reported ready through the Packet Tunnel"] : [])
    ];
    return {
      deviceId: device.deviceId,
      kind: device.kind,
      displayName: device.displayName,
      connection: device.connection,
      driver: device.driver,
      hardware: device.hardware,
      capabilities: device.capabilities.map((capability) => `${capability.name}@${capability.version}`),
      productReady: blockers.length === 0,
      blockers,
      packetOverlay: isIos ? overlay : undefined
    };
  });
  res.json({
    requirement: "Product acceptance requires an authenticated public device connection and ready device-side capability implementation. iOS additionally requires its authenticated Packet Tunnel and a pure-Linux-created RemoteXPC/WDA-ready report. USB, macOS/Xcode Lab Host, simulator, same-LAN, and loopback control paths never count.",
    productReady: devices.length > 0 && devices.every((device) => device.productReady),
    devices
  });
}));

app.get("/api/devices/:deviceId", (req, res) => {
  const device = unifiedRegistry.get(req.params.deviceId);
  if (!device) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  res.json({ device });
});

app.post("/api/devices/:deviceId/tap", asyncRoute(async (req, res) => {
  const result = await unifiedDriver.tap(req.params.deviceId, Number(req.body.x), Number(req.body.y));
  res.json({ result });
}));

app.post("/api/devices/:deviceId/swipe", asyncRoute(async (req, res) => {
  const result = await unifiedDriver.swipe(
        req.params.deviceId,
        Number(req.body.fromX),
        Number(req.body.fromY),
        Number(req.body.toX),
        Number(req.body.toY),
        Number(req.body.durationMs ?? 450)
      );
  res.json({ result });
}));

app.post("/api/devices/:deviceId/type", asyncRoute(async (req, res) => {
  const result = await unifiedDriver.typeText(req.params.deviceId, String(req.body.text ?? ""));
  res.json({ result });
}));

app.post("/api/devices/:deviceId/launch", asyncRoute(async (req, res) => {
  const bundleId = String(req.body.packageName ?? req.body.appId ?? "");
  const result = await unifiedDriver.launchApp(
        req.params.deviceId,
        bundleId,
        String(req.body.activity ?? "")
      );
  res.json({ result });
}));

app.post("/api/devices/:deviceId/shell", asyncRoute(async (req, res) => {
  const result = await androidDriver.shell(
    req.params.deviceId,
    String(req.body.command ?? ""),
    Number(req.body.timeoutMs ?? 30_000)
  );
  res.json({ result });
}));

app.post("/api/devices/:deviceId/logcat", asyncRoute(async (req, res) => {
  const result = await androidDriver.logcat(req.params.deviceId, Number(req.body.lines ?? 200));
  res.json({ result });
}));

app.get("/api/devices/:deviceId/uitree", asyncRoute(async (req, res) => {
  const result = await unifiedDriver.getUiTree(req.params.deviceId);
  res.type("application/xml").send(result.output ?? "");
}));

app.get("/api/devices/:deviceId/screenshot", asyncRoute(async (req, res) => {
  const device = unifiedRegistry.get(req.params.deviceId);
  if (!device) { res.status(404).json({ error: "Device not found" }); return; }
  if (device.hardware.controlAllowed !== true) { res.status(403).json({ error: "Device control paused" }); return; }
  if (req.query.forceCapture !== "1") {
    const frame = latestScreenFrames.latest(device.deviceId);
    if (frame) {
      res.set("Cache-Control", "no-store");
      res.set("X-Gelato-Frame-Source", "stream");
      res.set("X-Gelato-Frame-Sequence", String(frame.sequence));
      res.type("image/jpeg").send(frame.jpeg);
      return;
    }
  }
  const result = await unifiedDriver.getScreenshot(req.params.deviceId);
  const stream = result.stream && typeof result.stream === "object"
    ? result.stream as { streamId?: unknown; contentType?: unknown } : undefined;
  const streamId = typeof stream?.streamId === "string" ? stream.streamId : undefined;
  const file = streamId ? streamBroker.file(streamId) : undefined;
  if (!file) throw new Error("Screenshot command returned no completed typed stream");
  res.type(String(stream?.contentType ?? "image/png")).sendFile(file);
}));

app.get("/api/devices/:deviceId/screen/latest", (req, res) => {
  const device = unifiedRegistry.get(req.params.deviceId);
  if (!device) { res.status(404).json({ error: "Device not found" }); return; }
  if (device.hardware.controlAllowed !== true) { res.status(403).json({ error: "Device control paused" }); return; }
  const frame = latestScreenFrames.latest(device.deviceId);
  if (!frame) { res.status(503).json({ error: "No fresh visual stream frame" }); return; }
  res.set("Cache-Control", "no-store");
  res.set("X-Gelato-Frame-Sequence", String(frame.sequence));
  res.set("X-Gelato-Frame-Received-At", String(frame.receivedAt));
  res.type("image/jpeg").send(frame.jpeg);
});

app.post("/api/devices/:deviceId/wda", asyncRoute(async (req, res) => {
  const result = await iosDriver.wdaHttpRequest(
    req.params.deviceId,
    String(req.body.method ?? "GET"),
    String(req.body.path ?? "/status"),
    req.body.body,
    Number(req.body.timeoutMs ?? 30_000)
  );
  res.json({ result });
}));

app.post("/api/devices/:deviceId/tcp-probe", asyncRoute(async (req, res) => {
  const result = await unifiedDriver.execute(req.params.deviceId, "network.tcp.probe", {
    host: String(req.body.host ?? "127.0.0.1"),
    port: Number(req.body.port ?? 32498),
    timeoutMs: Number(req.body.timeoutMs ?? 3000)
  }, Number(req.body.timeoutMs ?? 3000) + 5_000, "read-only");
  res.json({ result });
}));

app.post("/api/devices/:deviceId/tcp-exchange", asyncRoute(async (req, res) => {
  const timeoutMs = Number(req.body.timeoutMs ?? 3000);
  const result = await unifiedDriver.execute(req.params.deviceId, "network.tcp.exchange", {
    host: String(req.body.host ?? "127.0.0.1"),
    port: Number(req.body.port ?? 49152),
    payload: typeof req.body.payload === "string" ? req.body.payload : undefined,
    payloadBase64: typeof req.body.payloadBase64 === "string" ? req.body.payloadBase64 : undefined,
    timeoutMs,
    maxBytes: Number(req.body.maxBytes ?? 4096)
  }, timeoutMs + 5_000, "side-effecting");
  res.json({ result });
}));

app.get("/api/devices/:deviceId/local-network-info", asyncRoute(async (req, res) => {
  const result = await unifiedDriver.execute(
    req.params.deviceId, "network.local-info", {}, 10_000, "read-only"
  );
  res.json({ result });
}));

app.post("/api/devices/:deviceId/bonjour-browse", asyncRoute(async (req, res) => {
  const timeoutMs = Number(req.body.timeoutMs ?? 5_000);
  const serviceTypes = Array.isArray(req.body.serviceTypes)
    ? req.body.serviceTypes.map(String)
    : ["_remotepairing._tcp.", "_apple-mobdev2._tcp."];
  const result = await unifiedDriver.execute(req.params.deviceId, "network.bonjour.browse", {
    serviceTypes,
    timeoutMs
  }, timeoutMs + 5_000, "read-only");
  res.json({ result });
}));

app.get("/api/mdns/advertisements", (_req, res) => {
  res.json({ advertisements: [...mdnsAdvertisements.values()].map(toMdnsAdvertisementInfo) });
});

app.delete("/api/mdns/advertisements/:advertisementId", (req, res) => {
  res.json({ stopped: stopMdnsAdvertisement(req.params.advertisementId) });
});

app.get("/api/packet-overlays", (_req, res) => {
  res.json({ overlays: packetOverlay.listSessions() });
});

app.delete("/api/packet-overlays/:deviceId", (req, res) => {
  res.json({ deleted: packetOverlay.deleteSession(req.params.deviceId) });
});

app.post("/api/devices/:deviceId/packet-overlay/sessions", (req, res) => {
  const session = packetOverlay.createSession(req.params.deviceId);
  const controllerUrl = stringOrUndefined(req.body.controllerUrl) ?? publicControllerUrl(req);
  const baseUrl = controllerUrl.replace(/\/+$/, "");
  res.json({
    session,
    overlay: {
      linuxAddress: "198.18.0.1",
      iosAddress: "198.18.0.2",
      subnetMask: "255.255.255.0",
      mtu: 1280,
      linuxUrl: websocketUrl(baseUrl, `/packet-overlay/${encodeURIComponent(req.params.deviceId)}`, { role: "linux" }),
      linuxAuthorization: `Bearer ${session.sidecarToken}`,
      iosUrl: websocketUrl(baseUrl, `/packet-overlay/${encodeURIComponent(req.params.deviceId)}`, {
        role: "ios"
      }),
      iosAuthentication: "Authorization: Bearer <device-credential>; X-Agent-Id: <paired-installation-id>"
    }
  });
});

app.get("/api/local-tcp-proxies", (_req, res) => {
  res.json({ proxies: [...localTcpProxies.values()].map(toLocalTcpProxyInfo) });
});

app.delete("/api/local-tcp-proxies/:proxyId", asyncRoute(async (req, res) => {
  res.json({ stopped: await stopLocalTcpProxy(req.params.proxyId) });
}));

app.get("/api/local-tcp-proxy-ranges", (_req, res) => {
  res.json({ ranges: [...localTcpProxyRanges.values()].map(toLocalTcpProxyRangeInfo) });
});

app.post("/api/local-tcp-proxy-ranges", asyncRoute(async (req, res) => {
  const range = await startLocalTcpProxyRange({
    label: stringOrUndefined(req.body.label),
    targetHost: String(req.body.targetHost ?? "198.18.0.2"),
    listenHost: String(req.body.listenHost ?? "0.0.0.0"),
    startPort: Number(req.body.startPort ?? 64000),
    endPort: Number(req.body.endPort ?? 64180),
    connectRetryMs: Number(req.body.connectRetryMs ?? 50),
    connectRetryDeadlineMs: Number(req.body.connectRetryDeadlineMs ?? 7500)
  });
  res.json({ range });
}));

app.delete("/api/local-tcp-proxy-ranges/:rangeId", asyncRoute(async (req, res) => {
  res.json({ stopped: await stopLocalTcpProxyRange(req.params.rangeId) });
}));

app.post("/api/devices/:deviceId/remote-pairing-overlay/start", asyncRoute(async (req, res) => {
  const timeoutMs = Number(req.body.timeoutMs ?? 5_000);
  let services = normalizeRemotePairingServices(req.body.services);
  let discovery: Record<string, unknown> | undefined;
  if (services.length === 0) {
    discovery = await unifiedDriver.execute(req.params.deviceId, "network.bonjour.browse", {
      serviceTypes: Array.isArray(req.body.serviceTypes)
        ? req.body.serviceTypes.map(String)
        : ["_remotepairing._tcp."],
      timeoutMs
    }, timeoutMs + 5_000, "read-only");
    services = normalizeRemotePairingServices(discovery?.services);
  }
  if (services.length === 0) {
    throw new Error("No remote pairing Bonjour services were discovered by the Gelato device app");
  }

  const overlaySession = packetOverlay.createSession(req.params.deviceId);
  const overlayHost = stringOrUndefined(req.body.overlayHost) ?? "198.18.0.2";
  const preserveRemotePorts = req.body.preserveRemotePorts !== false;
  const advertise = req.body.advertise !== false;
  const proxyHost = stringOrUndefined(req.body.proxyHost) ?? defaultMdnsProxyHost();
  const proxyAddress = stringOrUndefined(req.body.proxyAddress) ?? defaultMdnsProxyAddress();
  const startedProxyIds: string[] = [];
  const startedAdvertisementIds: string[] = [];
  const relays: RemotePairingOverlayRelayInfo[] = [];
  try {
    for (const service of services) {
      const listenPort = preserveRemotePorts ? service.port : 0;
      const proxy = await startLocalTcpProxy({
        label: `remote-pairing-overlay:${service.name}:${service.serviceType}`,
        targetHost: overlayHost,
        targetPort: service.port,
        listenHost: stringOrUndefined(req.body.listenHost) ?? "0.0.0.0",
        listenPort,
        connectRetryMs: Number(req.body.connectRetryMs ?? 50),
        connectRetryDeadlineMs: Number(req.body.connectRetryDeadlineMs ?? 7500)
      });
      startedProxyIds.push(proxy.id);
      const relay: RemotePairingOverlayRelayInfo = { service, proxy };
      if (advertise) {
        const advertisement = startMdnsAdvertisement({
          localProxyId: proxy.id,
          instanceName: service.name,
          serviceType: service.serviceType,
          port: proxy.listenPort,
          txt: service.txt,
          proxyHost,
          proxyAddress
        });
        startedAdvertisementIds.push(advertisement.id);
        relay.advertisement = advertisement;
      }
      relays.push(relay);
    }
  } catch (error) {
    for (const id of startedAdvertisementIds) stopMdnsAdvertisement(id);
    for (const id of startedProxyIds) await stopLocalTcpProxy(id);
    throw error;
  }

  res.json({
    overlaySession,
    relays,
    discovery
  });
}));

app.post("/api/devices/:deviceId/ai/:provider", asyncRoute(async (req, res) => {
  const provider = String(req.params.provider ?? "").trim().toLowerCase();
  const supportedProviders = new Set([
    "xiaohongshu", "qwen", "doubao", "deepseek", "xiaobu", "meituan", "kimi"
  ]);
  if (!supportedProviders.has(provider)) {
    res.status(400).json({
      error: `unsupported provider; expected one of ${[...supportedProviders].join(", ")}`
    });
    return;
  }
  const question = String(req.body.question ?? "").trim();
  if (!question) {
    res.status(400).json({ error: "question is required" });
    return;
  }
  if (question.length > 2_000) {
    res.status(400).json({ error: "question must not exceed 2000 characters" });
    return;
  }
  const requestedTimeoutMs = Number(req.body.timeoutMs ?? 90_000);
  if (!Number.isFinite(requestedTimeoutMs)) {
    res.status(400).json({ error: "timeoutMs must be a finite number" });
    return;
  }
  const timeoutMs = Math.max(30_000, Math.min(requestedTimeoutMs, 180_000));
  const result = await androidDriver.askAiApp(req.params.deviceId, provider, question, timeoutMs);
  res.json({ result });
}));

app.post("/api/devices/:deviceId/tasks", asyncRoute(async (req, res) => {
  const action = String(req.body.action ?? "").trim().toLowerCase();
  const supportedActions = new Set(["alarm.create", "image.generate", "ride.prepare"]);
  if (!supportedActions.has(action)) {
    res.status(400).json({
      error: `unsupported task action; expected one of ${[...supportedActions].join(", ")}`
    });
    return;
  }
  const argumentsValue = req.body.arguments;
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    res.status(400).json({ error: "arguments must be a JSON object" });
    return;
  }
  const requestedTimeoutMs = Number(req.body.timeoutMs ?? 120_000);
  if (!Number.isFinite(requestedTimeoutMs)) {
    res.status(400).json({ error: "timeoutMs must be a finite number" });
    return;
  }
  const timeoutMs = Math.max(30_000, Math.min(requestedTimeoutMs, 180_000));
  const taskId = nanoid(24);
  const result = await androidDriver.runAiTask(req.params.deviceId, taskId, action,
    argumentsValue as Record<string, unknown>, timeoutMs);
  persistTaskArtifact(req, result);
  res.json({ task: result });
}));

app.get("/api/task-artifacts/:artifactId", (req, res) => {
  const artifactId = String(req.params.artifactId ?? "");
  if (!/^[A-Za-z0-9_-]{20,40}\.(png|jpe?g)$/i.test(artifactId)) {
    res.status(400).json({ error: "invalid task artifact id" });
    return;
  }
  const artifactPath = path.join(taskArtifactDir, artifactId);
  if (!fs.existsSync(artifactPath)) {
    res.status(404).json({ error: "task artifact not found" });
    return;
  }
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(artifactPath);
});

app.post("/api/devices/:deviceId/agent-update", asyncRoute(async (req, res) => {
  const requiredBuild = String(req.body.requiredBuild ?? "").trim();
  if (!/^[1-9][0-9]{0,9}$/.test(requiredBuild)) {
    res.status(400).json({ error: "requiredBuild must be a positive integer" });
    return;
  }
  const manifestValue = req.body.manifestUrl;
  let manifestUrl: string | undefined;
  if (manifestValue !== undefined) {
    try {
      const parsed = new URL(String(manifestValue));
      if (
        parsed.protocol !== "https:"
        || parsed.username
        || parsed.password
        || parsed.hash
        || !parsed.pathname.endsWith("/manifest.plist")
      ) {
        throw new Error("invalid manifest URL");
      }
      manifestUrl = parsed.toString();
    } catch {
      res.status(400).json({
        error: "manifestUrl must be an HTTPS manifest.plist URL without credentials or a fragment"
      });
      return;
    }
  }
  const result = await iosDriver.requireUpdate(req.params.deviceId, requiredBuild, manifestUrl);
  res.status(202).json({
    accepted: result.accepted === true,
    requiredBuild,
    result
  });
}));

app.post("/api/devices/:deviceId/system-pairing-pin", asyncRoute(async (req, res) => {
  const pin = String(req.body.pin ?? "").trim();
  const expiresAt = Number(req.body.expiresAt);
  const now = Date.now();
  if (!/^[0-9]{6}$/.test(pin)) {
    res.status(400).json({ error: "pin must contain exactly six digits" });
    return;
  }
  if (
    !Number.isFinite(expiresAt)
    || expiresAt <= now
    || expiresAt > now + 5 * 60_000
  ) {
    res.status(400).json({ error: "expiresAt must be within the next five minutes" });
    return;
  }
  const result = await iosDriver.showPairingPin(req.params.deviceId, pin, expiresAt);
  res.status(202).json({ accepted: result.accepted === true, result });
}));

app.post("/api/devices/:deviceId/system-pairing-complete", asyncRoute(async (req, res) => {
  const result = await iosDriver.confirmPairing(req.params.deviceId);
  res.status(202).json({ accepted: result.accepted === true, result });
}));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof DeviceControlPausedError) {
    res.status(403).json({ error: err.message, code: "DEVICE_CONTROL_PAUSED" });
    return;
  }
  if (err && typeof err === "object" && "type" in err && err.type === "entity.too.large") {
    res.status(413).json({ error: "Request body is too large" });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
});

const server = createControllerServer(app, transport);
const deviceAgentWss = new WebSocketServer({ noServer: true });
const deviceAgentStreamWss = new WebSocketServer({ noServer: true });
const directDeviceAgentStreamWss = new WebSocketServer({ noServer: true });
const consoleWss = new WebSocketServer({ noServer: true });
const screenWss = new WebSocketServer({ noServer: true });
const packetOverlayWss = new WebSocketServer({ noServer: true });

deviceAgentWss.on("connection", (socket, request) => agentGateway.attach(socket, request));
deviceAgentStreamWss.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/", "http://controller.local");
  const streamId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[2] ?? "");
  streamBroker.attach(streamId, socket, request);
});
directDeviceAgentStreamWss.on("connection", (socket, request) => {
  streamBroker.attachDirect(socket, request);
});

agentGateway.on("stream.offer", (envelope: ProtocolEnvelope, reply: (value: ProtocolEnvelope) => void) => {
  if (!envelope.deviceId) return;
  const device = unifiedRegistry.get(envelope.deviceId);
  if (!device) return;
  try {
    const terminal = envelope.commandId ? commandService.get(envelope.commandId) : undefined;
    if (terminal && ["timed-out", "cancelled", "failed"].includes(terminal.state)) {
      throw new Error("Cannot open a stream for an ended command");
    }
    const stream = streamBroker.offer(device.agent.agentId, device.deviceId, envelope);
    reply({
      protocol: GELATO_PROTOCOL,
      type: "stream.accept",
      messageId: `msg_${nanoid(24)}`,
      deviceId: device.deviceId,
      commandId: envelope.commandId,
      sentAt: new Date().toISOString(),
      body: {
        streamId: stream.streamId,
        path: `/agent/streams/${stream.streamId}`,
        maxFrameBytes: stream.maxFrameBytes,
        maxTotalBytes: stream.maxTotalBytes
      }
    });
  } catch (error) {
    reply({
      protocol: GELATO_PROTOCOL,
      type: "protocol.error",
      messageId: `msg_${nanoid(24)}`,
      deviceId: device.deviceId,
      commandId: envelope.commandId,
      sentAt: new Date().toISOString(),
      body: { error: error instanceof Error ? error.message : String(error) }
    });
  }
});

consoleWss.on("connection", (socket) => {
  consoles.add(socket);
  socket.send(JSON.stringify({ type: "snapshot", devices: controllerDevices() }));
  socket.on("close", () => consoles.delete(socket));
  socket.on("error", () => consoles.delete(socket));
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(data.toString("utf8")) as { type?: string };
    if (message.type === "requestSnapshot") {
      socket.send(JSON.stringify({ type: "snapshot", devices: controllerDevices() }));
    }
  });
});

screenWss.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/", "http://controller.local");
  const parts = url.pathname.split("/").filter(Boolean);
  const deviceId = decodeURIComponent(parts[1] ?? "");
  const viewers = screenViewers.get(deviceId) ?? new Set<WebSocket>();
  viewers.add(socket);
  screenViewers.set(deviceId, viewers);
  const detach = () => {
    viewers.delete(socket);
    if (viewers.size === 0) screenViewers.delete(deviceId);
  };
  socket.on("close", detach);
  socket.on("error", detach);
});

streamBroker.on("frame", (value: unknown) => {
  const frame = value as { deviceId?: unknown; streamId?: unknown; payload?: unknown };
  if (typeof frame.deviceId !== "string" || typeof frame.streamId !== "string" || !Buffer.isBuffer(frame.payload)) return;
  const contentType = streamBroker.get(frame.streamId)?.contentType;
  if (contentType === "video/h264" || contentType === "image/jpeg") {
    latestScreenFrames.accept({ deviceId: frame.deviceId, streamId: frame.streamId,
      payload: frame.payload, contentType });
    const device = unifiedRegistry.get(frame.deviceId);
    if (contentType === "image/jpeg" && modelConnection?.live && !modelConnection.continuousVisual
        && device?.kind === "rokid.bolon" && device.connection.online
        && device.hardware.controlAllowed === true) {
      modelConnection.live.pushImage(frame.deviceId, frame.payload);
    }
  }
  if (contentType !== "video/h264" && contentType !== "image/jpeg") return;
  for (const viewer of screenViewers.get(frame.deviceId) ?? []) {
    if (viewer.readyState === WebSocket.OPEN) viewer.send(frame.payload, { binary: true });
  }
});

streamBroker.on("media.chunk", (value: unknown) => {
  if (!modelConnection?.live || !value || typeof value !== "object") return;
  const chunk = value as { deviceId?: unknown; streamId?: unknown; payload?: unknown; contentType?: unknown };
  if (typeof chunk.deviceId !== "string" || typeof chunk.streamId !== "string"
      || !Buffer.isBuffer(chunk.payload) || chunk.contentType !== "audio/pcm") return;
  const device = unifiedRegistry.get(chunk.deviceId);
  const stream = streamBroker.get(chunk.streamId);
  if (device?.kind !== "rokid.bolon" || !device.connection.online
      || device.hardware.controlAllowed !== true || stream?.purpose !== "audio"
      || stream.metadata?.sampleRateHz !== 16000 || stream.metadata?.channels !== 1
      || stream.metadata?.sampleFormat !== "s16le" || stream.metadata?.transient !== true) return;
  modelConnection.live.pushAudio(chunk.deviceId, chunk.payload);
});

packetOverlayWss.on("connection", (socket, request) => {
  packetOverlay.attach(socket, request);
});

packetOverlay.on("changed", (value: unknown) => {
  if (!value || typeof value !== "object" || !("deviceId" in value)) return;
  const info = value as {
    deviceId?: unknown;
    deleted?: unknown;
    iosConnected?: unknown;
    iosConnectedAt?: unknown;
    iosLastSeenAt?: unknown;
    iosNetworkClass?: unknown;
  };
  if (typeof info.deviceId !== "string") return;
  const transportOnline = info.deleted !== true && info.iosConnected === true;
  const pairing = deviceAgentPairing.listPairings().find(
    (record) => record.deviceId === info.deviceId && !record.revokedAt
  );
  agentGateway.setExternalTransport(
    info.deviceId,
    pairing?.agentId ?? "",
    transportOnline && pairing
      ? (envelope) => packetOverlay.sendAgentEnvelope(info.deviceId as string, envelope)
      : undefined
  );
  unifiedRegistry.markTransport(
    info.deviceId,
    "ios-packet-tunnel",
    transportOnline,
    typeof info.iosLastSeenAt === "number" ? info.iosLastSeenAt : Date.now(),
    typeof info.iosNetworkClass === "string"
      ? { networkClass: info.iosNetworkClass as "loopback" | "lan" | "public-direct" | "public-relay" }
      : {}
  );
});

packetOverlay.on("agentEnvelope", (value: unknown) => {
  const message = value as { deviceId?: unknown; agentId?: unknown; envelope?: unknown };
  if (typeof message.deviceId !== "string" || typeof message.agentId !== "string") return;
  if (!message.envelope || typeof message.envelope !== "object") return;
  agentGateway.ingestExternal(
    message.deviceId,
    message.agentId,
    message.envelope as ProtocolEnvelope
  );
});

unifiedRegistry.on("changed", () => {
  const payload = JSON.stringify({ type: "snapshot", devices: controllerDevices() });
  for (const socket of consoles) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://controller.local");
  if (url.pathname === "/agent/control") {
    deviceAgentWss.handleUpgrade(request, socket, head, (ws) => deviceAgentWss.emit("connection", ws, request));
    return;
  }
  if (url.pathname === "/agent/streams/live") {
    directDeviceAgentStreamWss.handleUpgrade(
      request,
      socket,
      head,
      (ws) => directDeviceAgentStreamWss.emit("connection", ws, request)
    );
    return;
  }
  if (url.pathname.startsWith("/agent/streams/")) {
    deviceAgentStreamWss.handleUpgrade(
      request,
      socket,
      head,
      (ws) => deviceAgentStreamWss.emit("connection", ws, request)
    );
    return;
  }
  if (url.pathname === "/console") {
    if (!controllerWebSocketAuthorized(request, url)) {
      rejectWebSocketUpgrade(socket);
      return;
    }
    consoleWss.handleUpgrade(request, socket, head, (ws) => consoleWss.emit("connection", ws, request));
    return;
  }
  if (url.pathname.startsWith("/screen/")) {
    if (!controllerWebSocketAuthorized(request, url)) {
      rejectWebSocketUpgrade(socket);
      return;
    }
    screenWss.handleUpgrade(request, socket, head, (ws) => screenWss.emit("connection", ws, request));
    return;
  }
  if (url.pathname.startsWith("/packet-overlay/")) {
    packetOverlayWss.handleUpgrade(request, socket, head, (ws) => packetOverlayWss.emit("connection", ws, request));
    return;
  }
  socket.destroy();
});

await new Promise<void>((resolve, reject) => {
server.once("error", reject);
server.listen(port, bindHost, () => {
  server.off("error", reject);
  resolve();
  console.log(`Controller listening on ${scheme()}://${bindHost}:${port}`);
  if (bindHost === "0.0.0.0" || bindHost === "::") {
    for (const url of localUrls(port)) {
      console.log(`LAN URL: ${url}`);
    }
  }
});
});

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, expiresAt] of adminSessions) {
    if (expiresAt <= now) adminSessions.delete(sessionId);
  }
}, 60_000).unref();

function scheme(): "http" | "https" {
  return transport.mode === "direct" ? "https" : "http";
}

function localUrls(port: number): string[] {
  const urls: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`${scheme()}://${entry.address}:${port}`);
      }
    }
  }
  return urls;
}

function asyncRoute(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
): express.RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

function persistTaskArtifact(req: Request, result: Record<string, unknown>): void {
  if (result.status !== "completed") return;
  const artifactValue = result.artifact;
  if (!artifactValue || typeof artifactValue !== "object" || Array.isArray(artifactValue)) {
    return;
  }
  const artifact = artifactValue as Record<string, unknown>;
  const encoded = typeof artifact.base64 === "string" ? artifact.base64.replace(/\s+/g, "") : "";
  if (!encoded) return;
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Task artifact Base64 payload is invalid");
  }
  if (artifact.mimeType !== "image/png" && artifact.mimeType !== "image/jpeg") {
    throw new Error("Task artifact MIME type is unsupported");
  }
  const mimeType = artifact.mimeType;
  const bytes = Buffer.from(encoded, "base64");
  const expectedSize = Number(artifact.sizeBytes ?? bytes.length);
  if (!Number.isFinite(expectedSize) || expectedSize !== bytes.length || bytes.length > 20 * 1024 * 1024) {
    throw new Error("Task artifact payload is invalid or exceeds 20 MiB");
  }
  const extension = mimeType === "image/jpeg" ? "jpg" : "png";
  const artifactId = `${nanoid(24)}.${extension}`;
  fs.mkdirSync(taskArtifactDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(taskArtifactDir, artifactId), bytes, { mode: 0o600 });
  delete artifact.base64;
  artifact.artifactId = artifactId;
  artifact.downloadPath = `/api/task-artifacts/${artifactId}`;
  artifact.downloadUrl = `${publicControllerUrl(req)}/api/task-artifacts/${artifactId}`;
}

function publicControllerUrl(req: express.Request): string {
  return requestOrigin(req, transport);
}

function controllerDevices() {
  return unifiedRegistry.list();
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function secureTokenEqual(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length
    && timingSafeEqual(suppliedBytes, expectedBytes);
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

function controllerWebSocketAuthorized(request: http.IncomingMessage, url: URL): boolean {
  if (!controllerApiToken) return true;
  const supplied = bearerToken(request.headers.authorization)
    ?? url.searchParams.get("controllerToken")
    ?? undefined;
  if (secureTokenEqual(supplied, controllerApiToken)) return true;
  return validAdminSession(requestCookie(request.headers.cookie, adminSessionCookie));
}

function controllerRequestAuthorized(req: express.Request): boolean {
  if (!controllerApiToken) return true;
  const supplied = bearerToken(req.headers.authorization) ?? req.header("x-controller-token");
  if (secureTokenEqual(supplied, controllerApiToken)) return true;
  return validAdminSession(requestCookie(req.headers.cookie, adminSessionCookie));
}

function validAdminSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const expiresAt = adminSessions.get(sessionId);
  if (!expiresAt || expiresAt <= Date.now()) {
    adminSessions.delete(sessionId);
    return false;
  }
  return true;
}

function requestCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function requestUsesHttps(req: express.Request): boolean {
  return Boolean(transport.publicOrigin?.startsWith("https://")) || req.secure;
}

function readControllerApiToken(): string | undefined {
  const inline = process.env.CONTROLLER_API_TOKEN?.trim();
  const tokenFile = process.env.CONTROLLER_API_TOKEN_FILE?.trim();
  if (inline && tokenFile) {
    throw new Error("Use CONTROLLER_API_TOKEN or CONTROLLER_API_TOKEN_FILE, not both");
  }
  if (!tokenFile) return inline || undefined;
  const metadata = fs.statSync(tokenFile);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("CONTROLLER_API_TOKEN_FILE must not be accessible by group or others");
  }
  const value = fs.readFileSync(tokenFile, "utf8").trim();
  if (!value) throw new Error("CONTROLLER_API_TOKEN_FILE is empty");
  return value;
}

function rejectWebSocketUpgrade(socket: NodeJS.WritableStream & { destroy(): void }): void {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  socket.destroy();
}

function websocketUrl(baseUrl: string, pathname: string, params: Record<string, string>): string {
  const url = new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

interface RemotePairingService {
  name: string;
  serviceType: string;
  host?: string;
  hostName?: string;
  port: number;
  txt: Record<string, string>;
}

interface MdnsAdvertisementInfo {
  id: string;
  forwarderId?: string;
  localProxyId?: string;
  instanceName: string;
  serviceType: string;
  domain: string;
  port: number;
  txt: Record<string, string>;
  proxyHost?: string;
  proxyAddress?: string;
  startedAt: number;
  pid?: number;
}

interface MdnsAdvertisementRecord extends MdnsAdvertisementInfo {
  process: ChildProcess;
}

interface LocalTcpProxyInfo {
  id: string;
  label?: string;
  targetHost: string;
  targetPort: number;
  listenHost: string;
  listenPort: number;
  connectRetryMs: number;
  connectRetryDeadlineMs: number;
  startedAt: number;
  connectionsAccepted: number;
  activeConnections: number;
  connectErrors: number;
  bytesFromLocal: number;
  bytesFromTarget: number;
  lastActivityAt?: number;
}

interface LocalTcpProxyRecord extends LocalTcpProxyInfo {
  server: net.Server;
  sockets: Set<net.Socket>;
}

interface LocalTcpProxyRangeInfo {
  id: string;
  label?: string;
  targetHost: string;
  listenHost: string;
  startPort: number;
  endPort: number;
  startedAt: number;
  proxyIds: string[];
  proxies: LocalTcpProxyInfo[];
}

interface LocalTcpProxyRangeRecord {
  id: string;
  label?: string;
  targetHost: string;
  listenHost: string;
  startPort: number;
  endPort: number;
  startedAt: number;
  proxyIds: string[];
}

interface RemotePairingOverlayRelayInfo {
  service: RemotePairingService;
  proxy: LocalTcpProxyInfo;
  advertisement?: MdnsAdvertisementInfo;
}

function normalizeRemotePairingServices(value: unknown): RemotePairingService[] {
  if (!Array.isArray(value)) return [];
  const services: RemotePairingService[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = stringOrUndefined(record.name) ?? stringOrUndefined(record.instanceName);
    const serviceType = normalizeServiceType(
      stringOrUndefined(record.serviceType) ?? stringOrUndefined(record.type)
    );
    const port = Number(record.port);
    if (!name || !serviceType || !Number.isInteger(port) || port <= 0 || port > 65535) continue;
    services.push({
      name,
      serviceType,
      host: stringOrUndefined(record.host),
      hostName: stringOrUndefined(record.hostName),
      port,
      txt: normalizeTxt(record.txt)
    });
  }
  return services;
}

function normalizeServiceType(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("_") || !trimmed.includes("._tcp")) return undefined;
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

function normalizeTxt(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const txt: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key || raw === undefined || raw === null) continue;
    txt[key] = String(raw);
  }
  return txt;
}

async function startLocalTcpProxy(input: {
  label?: string;
  targetHost: string;
  targetPort: number;
  listenHost: string;
  listenPort: number;
  connectRetryMs?: number;
  connectRetryDeadlineMs?: number;
}): Promise<LocalTcpProxyInfo> {
  const targetHost = input.targetHost.trim();
  const targetPort = Number(input.targetPort);
  if (!targetHost) throw new Error("targetHost is required");
  if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
    throw new Error("targetPort must be a TCP port");
  }
  const id = `localtcp-${nanoid(10)}`;
  const record: LocalTcpProxyRecord = {
    id,
    label: input.label,
    targetHost,
    targetPort,
    listenHost: input.listenHost,
    listenPort: input.listenPort,
    connectRetryMs: Math.max(0, Number(input.connectRetryMs ?? 0)),
    connectRetryDeadlineMs: Math.max(0, Number(input.connectRetryDeadlineMs ?? 0)),
    startedAt: Date.now(),
    connectionsAccepted: 0,
    activeConnections: 0,
    connectErrors: 0,
    bytesFromLocal: 0,
    bytesFromTarget: 0,
    lastActivityAt: undefined,
    server: net.createServer(),
    sockets: new Set()
  };
  record.server.on("connection", (localSocket) => attachLocalTcpProxySocket(record, localSocket));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      record.server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      record.server.off("error", onError);
      const address = record.server.address() as AddressInfo | null;
      if (address) {
        record.listenHost = typeof address.address === "string" ? address.address : record.listenHost;
        record.listenPort = address.port;
      }
      resolve();
    };
    record.server.once("error", onError);
    record.server.once("listening", onListening);
    record.server.listen(record.listenPort, record.listenHost);
  });
  localTcpProxies.set(id, record);
  return toLocalTcpProxyInfo(record);
}

function attachLocalTcpProxySocket(record: LocalTcpProxyRecord, localSocket: net.Socket): void {
  record.connectionsAccepted += 1;
  record.activeConnections += 1;
  record.lastActivityAt = Date.now();
  record.sockets.add(localSocket);
  const pending: Buffer[] = [];
  const startedAt = Date.now();
  let targetSocket: net.Socket | undefined;
  let closed = false;
  let connected = false;
  let lastTargetError: Error | undefined;

  localSocket.on("data", (chunk: Buffer) => {
    record.bytesFromLocal += chunk.byteLength;
    record.lastActivityAt = Date.now();
    if (connected && targetSocket && !targetSocket.destroyed) {
      targetSocket.write(chunk);
    } else {
      pending.push(Buffer.from(chunk));
    }
  });
  localSocket.on("error", () => closeBoth());
  const closeBoth = () => {
    closed = true;
    if (!localSocket.destroyed) localSocket.destroy();
    if (targetSocket && !targetSocket.destroyed) targetSocket.destroy();
  };
  localSocket.once("close", () => {
    closed = true;
    record.activeConnections = Math.max(0, record.activeConnections - 1);
    record.sockets.delete(localSocket);
    if (targetSocket) {
      record.sockets.delete(targetSocket);
      if (!targetSocket.destroyed) targetSocket.end();
    }
  });
  localSocket.setTimeout(120_000, closeBoth);

  const connectTarget = () => {
    if (closed || localSocket.destroyed) return;
    const socket = net.createConnection({
      host: record.targetHost,
      port: record.targetPort
    });
    targetSocket = socket;
    record.sockets.add(socket);
    socket.setTimeout(120_000, closeBoth);
    socket.once("connect", () => {
      connected = true;
      record.lastActivityAt = Date.now();
      targetSocket = socket;
      socket.on("data", (chunk: Buffer) => {
        record.bytesFromTarget += chunk.byteLength;
        record.lastActivityAt = Date.now();
        localSocket.write(chunk);
      });
      socket.on("error", closeBoth);
      socket.once("close", () => {
        record.sockets.delete(socket);
        if (!localSocket.destroyed) localSocket.end();
      });
      for (const chunk of pending.splice(0)) {
        socket.write(chunk);
      }
    });
    socket.once("error", (error) => {
      if (connected) return;
      lastTargetError = error;
      record.connectErrors += 1;
      record.sockets.delete(socket);
      socket.destroy();
      const retryElapsed = Date.now() - startedAt;
      if (
        record.connectRetryMs > 0
        && retryElapsed < record.connectRetryDeadlineMs
        && !closed
        && !localSocket.destroyed
      ) {
        setTimeout(connectTarget, record.connectRetryMs);
        return;
      }
      localSocket.destroy(lastTargetError);
    });
  };

  connectTarget();
}

async function stopLocalTcpProxy(id: string): Promise<boolean> {
  const record = localTcpProxies.get(id);
  if (!record) return false;
  localTcpProxies.delete(id);
  for (const socket of record.sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => record.server.close(() => resolve()));
  return true;
}

function toLocalTcpProxyInfo(record: LocalTcpProxyRecord): LocalTcpProxyInfo {
  const { server: _server, sockets: _sockets, ...info } = record;
  return info;
}

async function startLocalTcpProxyRange(input: {
  label?: string;
  targetHost: string;
  listenHost: string;
  startPort: number;
  endPort: number;
  connectRetryMs?: number;
  connectRetryDeadlineMs?: number;
}): Promise<LocalTcpProxyRangeInfo> {
  const startPort = Number(input.startPort);
  const endPort = Number(input.endPort);
  if (!Number.isInteger(startPort) || !Number.isInteger(endPort) || startPort <= 0 || endPort > 65535 || startPort > endPort) {
    throw new Error("startPort/endPort must be a valid inclusive TCP port range");
  }
  if (endPort - startPort > 512) {
    throw new Error("TCP proxy ranges are limited to 513 ports");
  }
  const id = `localtcprange-${nanoid(10)}`;
  const proxyIds: string[] = [];
  try {
    for (let portNumber = startPort; portNumber <= endPort; portNumber += 1) {
      const proxy = await startLocalTcpProxy({
        label: input.label ? `${input.label}:${portNumber}` : `range:${id}:${portNumber}`,
        targetHost: input.targetHost,
        targetPort: portNumber,
        listenHost: input.listenHost,
        listenPort: portNumber,
        connectRetryMs: input.connectRetryMs,
        connectRetryDeadlineMs: input.connectRetryDeadlineMs
      });
      proxyIds.push(proxy.id);
    }
  } catch (error) {
    await Promise.all(proxyIds.map((proxyId) => stopLocalTcpProxy(proxyId)));
    throw error;
  }
  const record: LocalTcpProxyRangeRecord = {
    id,
    label: input.label,
    targetHost: input.targetHost,
    listenHost: input.listenHost,
    startPort,
    endPort,
    startedAt: Date.now(),
    proxyIds
  };
  localTcpProxyRanges.set(id, record);
  return toLocalTcpProxyRangeInfo(record);
}

async function stopLocalTcpProxyRange(id: string): Promise<boolean> {
  const record = localTcpProxyRanges.get(id);
  if (!record) return false;
  localTcpProxyRanges.delete(id);
  await Promise.all(record.proxyIds.map((proxyId) => stopLocalTcpProxy(proxyId)));
  return true;
}

function toLocalTcpProxyRangeInfo(record: LocalTcpProxyRangeRecord): LocalTcpProxyRangeInfo {
  const proxies = record.proxyIds
    .map((id) => localTcpProxies.get(id))
    .filter((proxy): proxy is LocalTcpProxyRecord => Boolean(proxy))
    .map(toLocalTcpProxyInfo);
  return {
    ...record,
    proxies
  };
}

function startMdnsAdvertisement(input: {
  forwarderId?: string;
  localProxyId?: string;
  instanceName: string;
  serviceType: string;
  port: number;
  txt: Record<string, string>;
  proxyHost?: string;
  proxyAddress?: string;
}): MdnsAdvertisementInfo {
  if (!fs.existsSync("/usr/bin/dns-sd")) {
    throw new Error("/usr/bin/dns-sd is required to publish local Bonjour advertisements");
  }
  const id = `mdns-${nanoid(10)}`;
  const domain = "local.";
  const txtArgs = Object.entries(input.txt).map(([key, value]) => `${key}=${value}`);
  const proxyHost = input.proxyHost?.trim();
  const proxyAddress = input.proxyAddress?.trim();
  const args = proxyHost && proxyAddress
    ? [
        "-P",
        input.instanceName,
        input.serviceType,
        domain,
        String(input.port),
        proxyHost.endsWith(".") ? proxyHost : `${proxyHost}.`,
        proxyAddress,
        ...txtArgs
      ]
    : [
        "-R",
        input.instanceName,
        input.serviceType,
        domain,
        String(input.port),
        ...txtArgs
      ];
  const child = spawn("/usr/bin/dns-sd", args, { stdio: ["ignore", "ignore", "ignore"] });
  const record: MdnsAdvertisementRecord = {
    id,
    forwarderId: input.forwarderId,
    localProxyId: input.localProxyId,
    instanceName: input.instanceName,
    serviceType: input.serviceType,
    domain,
    port: input.port,
    txt: input.txt,
    proxyHost: proxyHost || undefined,
    proxyAddress: proxyAddress || undefined,
    startedAt: Date.now(),
    pid: child.pid,
    process: child
  };
  mdnsAdvertisements.set(id, record);
  child.once("exit", () => {
    if (mdnsAdvertisements.get(id) === record) {
      mdnsAdvertisements.delete(id);
    }
  });
  child.once("error", () => {
    if (mdnsAdvertisements.get(id) === record) {
      mdnsAdvertisements.delete(id);
    }
  });
  return toMdnsAdvertisementInfo(record);
}

function stopMdnsAdvertisement(id: string): boolean {
  const record = mdnsAdvertisements.get(id);
  if (!record) return false;
  mdnsAdvertisements.delete(id);
  record.process.kill("SIGTERM");
  return true;
}

function toMdnsAdvertisementInfo(record: MdnsAdvertisementRecord): MdnsAdvertisementInfo {
  const { process: _process, ...info } = record;
  return info;
}

function defaultMdnsProxyHost(): string | undefined {
  const baseName = os.hostname()
    .replace(/\.local$/i, "")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "mac";
  return `serverized-${baseName}-${process.pid}.local`;
}

function defaultMdnsProxyAddress(): string | undefined {
  const en0 = os.networkInterfaces().en0 ?? [];
  const primary = en0.find((entry) => entry.family === "IPv4" && !entry.internal);
  if (primary?.address) return primary.address;
  for (const entries of Object.values(os.networkInterfaces())) {
    const fallback = (entries ?? []).find((entry) => entry.family === "IPv4" && !entry.internal);
    if (fallback?.address) return fallback.address;
  }
  return undefined;
}

return { app, server, pairing: deviceAgentPairing, devices: unifiedRegistry, commands: commandService, streams: streamBroker,
  async close() {
    if (visualPump) clearInterval(visualPump);
    modelBridge?.close();
    latestScreenFrames.close();
    for (const device of unifiedRegistry.list()) {
      commandService.cancelDevice(device.deviceId, "Controller shutting down");
      streamBroker.cancelDevice(device.deviceId);
      packetOverlay.deleteSession(device.deviceId);
    }
    for (const proxy of localTcpProxies.values()) {
      for (const socket of proxy.sockets) socket.destroy();
      proxy.server.close();
    }
    for (const record of mdnsAdvertisements.values()) record.process.kill();
    for (const wss of [deviceAgentWss, deviceAgentStreamWss, directDeviceAgentStreamWss, consoleWss, screenWss, packetOverlayWss]) {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
};
}
