import { chmodSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createControllerServer,
  loadTlsMaterial,
  loopbackHost,
  requestOrigin,
  transportConfig
} from "../../examples/server/control-room/src/transportConfig.js";
import { tempDirectory } from "../helpers.js";

const temporaryDirectories: Array<ReturnType<typeof tempDirectory>> = [];

function certificate(name: string, host = "controller.example.test") {
  const directory = tempDirectory("gelato-tls-");
  temporaryDirectories.push(directory);
  const keyPath = join(directory.path, `${name}.key`);
  const certPath = join(directory.path, `${name}.crt`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-subj", `/CN=${host}`,
    "-addext", `subjectAltName=DNS:${host},IP:127.0.0.1`,
    "-keyout", keyPath,
    "-out", certPath
  ], { stdio: "ignore" });
  chmodSync(keyPath, 0o600);
  return { keyPath, certPath };
}

describe("controller transport configuration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) directory.cleanup();
  });

  it.each(["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]"])("recognizes loopback host %s", (host) => {
    expect(loopbackHost(host)).toBe(true);
  });

  it("creates safe defaults and explicit proxy configuration", () => {
    expect(transportConfig({})).toEqual({
      host: "127.0.0.1",
      port: 8090,
      mode: "local",
      publicOrigin: undefined,
      keyPath: undefined,
      certPath: undefined
    });
    expect(transportConfig({ PUBLIC_CONTROLLER_URL: "https://controller.example.test" }))
      .toMatchObject({ mode: "loopback-proxy", publicOrigin: "https://controller.example.test" });
  });

  it.each([
    [{ PORT: "0" }, /PORT/],
    [{ PORT: "abc" }, /PORT/],
    [{ TLS_KEY: "/key" }, /supplied together/],
    [{ TLS_CERT: "/cert" }, /supplied together/],
    [{ HOST: "0.0.0.0" }, /Non-loopback/],
    [{ PUBLIC_CONTROLLER_URL: "http://public.test" }, /HTTPS root/],
    [{ PUBLIC_CONTROLLER_URL: "https://user:pass@public.test" }, /HTTPS root/],
    [{ PUBLIC_CONTROLLER_URL: "https://public.test/path" }, /HTTPS root/],
    [{ CONTROLLER_TRANSPORT: "invalid" }, /Invalid/],
    [{ CONTROLLER_TRANSPORT: "direct", PUBLIC_CONTROLLER_URL: "https://public.test" }, /Direct transport requires/],
    [{ CONTROLLER_TRANSPORT: "direct", PUBLIC_CONTROLLER_URL: "https://public.test", TLS_KEY: "/key", TLS_CERT: "/cert", ACCOUNT_TRUST_LOCAL_CLOUDFLARED: "1" }, /must not trust/]
  ] as const)("rejects unsafe environment %#", (env, error) => {
    expect(() => transportConfig(env)).toThrow(error);
  });

  it("constructs origins only from a trusted loopback Host", () => {
    const config = transportConfig({ PORT: "9000" });
    expect(requestOrigin({ headers: { host: "localhost:9000", "x-forwarded-host": "attacker.test" } }, config))
      .toBe("http://localhost:9000");
    expect(() => requestOrigin({ headers: { host: "attacker.test" } }, config)).toThrow(/non-local Host/);
    expect(requestOrigin({ headers: { host: "ignored.test" } }, {
      ...config,
      publicOrigin: "https://controller.example.test"
    })).toBe("https://controller.example.test");
  });

  it("loads matching private TLS material and checks certificate identity", () => {
    const pair = certificate("primary");
    const config = {
      host: "0.0.0.0",
      port: 8443,
      mode: "direct" as const,
      publicOrigin: "https://controller.example.test",
      ...pair
    };
    const material = loadTlsMaterial(config);
    expect(material.key.length).toBeGreaterThan(100);
    expect(material.cert.length).toBeGreaterThan(100);
    expect(material.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    chmodSync(pair.keyPath, 0o644);
    expect(() => loadTlsMaterial(config)).toThrow(/private regular file/);
    chmodSync(pair.keyPath, 0o600);
    expect(() => loadTlsMaterial({ ...config, publicOrigin: "https://other.example.test" }))
      .toThrow(/does not cover/);
    expect(() => loadTlsMaterial(config, 3 * 24 * 60 * 60_000)).toThrow(/too close/);
    expect(() => loadTlsMaterial({ ...config, keyPath: undefined })).toThrow(/not configured/);
  });

  it("rejects a certificate/key mismatch", () => {
    const first = certificate("first");
    const second = certificate("second");
    expect(() => loadTlsMaterial({
      host: "0.0.0.0",
      port: 8443,
      mode: "direct",
      publicOrigin: "https://controller.example.test",
      keyPath: first.keyPath,
      certPath: second.certPath
    })).toThrow(/do not match/);
  });

  it("creates local and TLS servers and reloads changed material", () => {
    const local = createControllerServer((_request, response) => response.end(), transportConfig({}));
    expect(local.constructor.name).toBe("Server");

    const first = certificate("active");
    const replacement = certificate("replacement");
    const logs: string[] = [];
    const tls = createControllerServer((_request, response) => response.end(), {
      host: "0.0.0.0",
      port: 8443,
      mode: "direct",
      publicOrigin: "https://controller.example.test",
      ...first
    }, { reloadMs: 3_600_000, log: (value) => logs.push(value) });
    copyFileSync(replacement.keyPath, first.keyPath);
    copyFileSync(replacement.certPath, first.certPath);
    chmodSync(first.keyPath, 0o600);
    process.emit("SIGHUP", "SIGHUP");
    expect(logs.some((value) => value.includes("reloaded"))).toBe(true);
    tls.emit("close");
    local.emit("close");
  });
});
