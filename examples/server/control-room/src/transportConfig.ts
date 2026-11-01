import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import type { Request } from "express";

export interface TransportConfig {
  host: string;
  port: number;
  mode: "local" | "loopback-proxy" | "direct";
  publicOrigin?: string;
  keyPath?: string;
  certPath?: string;
}

export function loopbackHost(host: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(host.replace(/^\[|\]$/g, "").toLowerCase());
}

export function transportConfig(env: NodeJS.ProcessEnv): TransportConfig {
  const host = env.HOST ?? "127.0.0.1";
  const port = Number(env.PORT ?? 8090);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
  const keyPath = env.TLS_KEY?.trim() || undefined;
  const certPath = env.TLS_CERT?.trim() || undefined;
  if (Boolean(keyPath) !== Boolean(certPath)) throw new Error("TLS_KEY and TLS_CERT must be supplied together; refusing HTTP fallback");
  let publicOrigin: string | undefined;
  if (env.PUBLIC_CONTROLLER_URL) {
    const url = new URL(env.PUBLIC_CONTROLLER_URL);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
        || (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHost(url.hostname)))) {
      throw new Error("PUBLIC_CONTROLLER_URL must be an HTTPS root origin (HTTP is local-only)");
    }
    publicOrigin = url.origin;
  }
  const mode = env.CONTROLLER_TRANSPORT ?? (keyPath ? "direct" : publicOrigin?.startsWith("https:") ? "loopback-proxy" : "local");
  if (!["local", "loopback-proxy", "direct"].includes(mode)) throw new Error("Invalid CONTROLLER_TRANSPORT");
  if (mode === "direct" && (!keyPath || !publicOrigin?.startsWith("https:"))) {
    throw new Error("Direct transport requires TLS_KEY, TLS_CERT and an HTTPS PUBLIC_CONTROLLER_URL");
  }
  if (mode !== "direct" && !loopbackHost(host)) throw new Error("Non-loopback listeners require direct TLS transport");
  if (mode !== "direct" && keyPath) throw new Error("TLS listener must use direct transport");
  if (mode === "direct" && env.ACCOUNT_TRUST_LOCAL_CLOUDFLARED === "1") {
    throw new Error("Direct transport must not trust Cloudflare forwarding headers");
  }
  return {host, port, mode: mode as TransportConfig["mode"], publicOrigin, keyPath, certPath};
}

export function loadTlsMaterial(config: TransportConfig, minimumValidityMs = 60_000) {
  if (!config.keyPath || !config.certPath) throw new Error("TLS material is not configured");
  const metadata = fs.statSync(config.keyPath);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("TLS private key must be a private regular file (mode 0600 or 0400)");
  const key = fs.readFileSync(config.keyPath);
  const cert = fs.readFileSync(config.certPath);
  const leaf = new X509Certificate(cert);
  const expiresAt = Date.parse(leaf.validTo);
  if (Date.parse(leaf.validFrom) > Date.now() || expiresAt - Date.now() < minimumValidityMs) {
    throw new Error("TLS certificate is not yet valid, expired, or too close to expiration");
  }
  const privatePublicKey = createPublicKey(createPrivateKey(key)).export({type:"spki", format:"der"});
  if (!privatePublicKey.equals(leaf.publicKey.export({type:"spki",format:"der"}))) throw new Error("TLS certificate and key do not match");
  if (config.publicOrigin) {
    const hostname = new URL(config.publicOrigin).hostname.replace(/^\[|\]$/g, "");
    if (!(isIP(hostname) ? leaf.checkIP(hostname) : leaf.checkHost(hostname))) {
      throw new Error("TLS certificate does not cover PUBLIC_CONTROLLER_URL");
    }
  }
  return {key, cert, expiresAt, fingerprint:createHash("sha256").update(key).update(cert).digest("hex")};
}

export function createControllerServer(handler: http.RequestListener, config: TransportConfig,
  options: {reloadMs?: number; log?: (message: string) => void} = {}): http.Server | https.Server {
  if (config.mode !== "direct") return http.createServer(handler);
  let material = loadTlsMaterial(config);
  const server = https.createServer({key:material.key,cert:material.cert,minVersion:"TLSv1.2"}, handler);
  const sockets = new Set<Duplex>();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const log = options.log ?? console.log;
  let lastError = "";
  const reload = () => {
    try {
      const updated = loadTlsMaterial(config);
      if (updated.fingerprint !== material.fingerprint) {
        server.setSecureContext({key:updated.key,cert:updated.cert,minVersion:"TLSv1.2"});
        material = updated;
        log(`TLS certificate reloaded; expires ${new Date(material.expiresAt).toISOString()}`);
      }
      lastError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid certificate update";
      if (message !== lastError) log(`TLS reload rejected; keeping previous valid certificate: ${message}`);
      lastError = message;
    }
    if (Date.now() >= material.expiresAt) {
      log("TLS certificate expired; closing listener and connections");
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  };
  const timer = setInterval(reload, options.reloadMs ?? 30_000);
  timer.unref();
  process.on("SIGHUP", reload);
  server.once("close", () => { clearInterval(timer); process.off("SIGHUP", reload); });
  return server;
}

export function requestOrigin(req: Pick<Request,"headers">, config: TransportConfig): string {
  if (config.publicOrigin) return config.publicOrigin;
  // Without an explicit public origin this is a local-only listener. Never
  // let untrusted Forwarded/X-Forwarded-* headers construct pairing links.
  const url = new URL(`http://${req.headers.host ?? `127.0.0.1:${config.port}`}`);
  if (!loopbackHost(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("A non-local Host requires PUBLIC_CONTROLLER_URL");
  }
  return url.origin;
}
