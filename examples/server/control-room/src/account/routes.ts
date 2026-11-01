import { Router, type Request, type Response, type NextFunction } from "express";
import { isIP } from "node:net";
import { AccountError, TinodeAccounts } from "./tinode.js";
import type { DeviceAgentPairingService } from "@gelato/server-core";
import type { UnifiedDeviceRegistry } from "@gelato/server-core";

export function accountClientAddress(req: Pick<Request, "socket" | "headers">, trustLocalCloudflared = false): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const header = req.headers["cf-connecting-ip"];
  // Opt-in only for a loopback-bound origin reached through local cloudflared.
  // Never trust arbitrary forwarded headers from direct network clients.
  return trustLocalCloudflared && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) &&
    typeof header === "string" && isIP(header) ? header : peer;
}

export function accountRoutes(accounts: TinodeAccounts, pairings: DeviceAgentPairingService,
  registry: UnifiedDeviceRegistry, publicUrl?: (req: Request) => string, trustLocalCloudflared = false): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/status", (_req, res) => res.json({ available: accounts.configured, provider: "tinode" }));
  const attempts = new Map<string, { count: number; expires: number }>();
  const limit = (req: Request, res: Response, next: NextFunction) => {
    const key = accountClientAddress(req, trustLocalCloudflared);
    for (const [id, value] of attempts) if (value.expires <= Date.now()) attempts.delete(id);
    if (attempts.size >= 10000 && !attempts.has(key)) {
      res.setHeader("Retry-After", "60"); res.status(429).json({ error: "账号服务繁忙，请一分钟后重试" }); return;
    }
    const current = attempts.get(key);
    const slot = current && current.expires > Date.now() ? current : { count: 0, expires: Date.now() + 60_000 };
    attempts.set(key, slot);
    if (++slot.count > 12) { res.setHeader("Retry-After", "60"); res.status(429).json({ error: "操作太频繁，请一分钟后重试" }); return; }
    next();
  };
  const run = (handler: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response) => { handler(req, res).catch(error => {
      res.status(error instanceof AccountError ? error.status : 500)
        .json({ error: error instanceof AccountError ? error.message : "操作未完成，请重试" });
    }); };
  router.post("/login", limit, run(async (req, res) => {
    res.json(await accounts.login(String(req.body.username ?? ""), String(req.body.password ?? "")));
  }));
  router.post("/register", limit, run(async (req, res) => {
    res.json(await accounts.register(String(req.body.username ?? ""), String(req.body.password ?? ""),
      String(req.body.displayName ?? "")));
  }));
  router.use(run(async (req, res) => {
    const match = /^(?:Bearer|Token)\s+([^\s]+)$/i.exec(req.headers.authorization ?? "");
    if (!match) throw new AccountError("请先登录");
    const session = await accounts.verify(match[1]);
    if (req.method === "GET" && req.path === "/me") { res.json({ user: session.user }); return; }
    if (req.method === "GET" && req.path === "/devices") {
      res.json({ devices: pairings.listPairings().filter(record =>
        record.ownerUserId === session.user.id && !record.revokedAt).map(record => {
        const live = registry.get(record.deviceId);
        return { deviceId: record.deviceId, displayName: live?.displayName ?? record.displayName,
          kind: record.deviceKind, online: live?.connection.online ?? false,
          controlAllowed: live?.hardware.controlAllowed === true,
          ready: live?.driver.state === "ready", lastSeenAt: live?.connection.lastSeenAt ?? new Date(record.lastSeenAt).toISOString() };
      }) }); return;
    }
    if (req.method === "POST" && req.path === "/enroll") {
      const agentKind = String(req.body.agentKind ?? "");
      if (!["android-phone", "ios", "rokid-bolon-native", "esp32s3-xiao-camera"].includes(agentKind)) throw new AccountError("设备类型无效", 400);
      let url: URL;
      try { url = new URL(String(req.body.controllerUrl ?? "")); }
      catch { throw new AccountError("控制服务地址无效", 400); }
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new AccountError("控制服务地址无效，需要 HTTPS 根地址", 400);
      if (publicUrl && new URL(publicUrl(req)).origin !== url.origin) throw new AccountError("配对地址与当前控制服务不一致", 400);
      const controllerUrl = url.origin;
      res.json({ session: pairings.createSession({ controllerUrl, allowedAgentKind: agentKind,
        displayName: String(req.body.displayName ?? ""), ownerUserId: session.user.id }) }); return;
    }
    if (req.method === "POST" && req.path === "/claim") {
      const proof = pairings.authenticate(String(req.body.agentId ?? ""), String(req.body.credential ?? ""));
      if (!proof.accepted || !proof.agentId) throw new AccountError("无法验证本机配对，请重新连接", 403);
      if (!pairings.claimOwner(proof.agentId, session.user.id)) throw new AccountError("此设备已属于其他账号，请先解除原账号配对", 409);
      res.json({ claimed: true, deviceId: proof.deviceId }); return;
    }
    res.status(404).json({ error: "接口不存在" });
  }));
  return router;
}
