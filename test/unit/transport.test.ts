import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { requestNetworkClass } from "../../server-sdk/core/src/transport.js";

function request(remoteAddress: string, headers: Record<string, string | string[]> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

describe("requestNetworkClass", () => {
  it("classifies loopback, private, carrier, and public peers", () => {
    expect(requestNetworkClass(request("127.0.0.1"))).toBe("loopback");
    expect(requestNetworkClass(request("::1"))).toBe("loopback");
    expect(requestNetworkClass(request("::ffff:127.0.0.1"))).toBe("loopback");
    for (const address of ["10.0.0.1", "192.168.1.2", "172.16.0.1", "100.64.0.1", "fd00::1", "unknown-peer"]) {
      expect(requestNetworkClass(request(address))).toBe("lan");
    }
    expect(requestNetworkClass(request("8.8.8.8"))).toBe("public-direct");
    expect(requestNetworkClass(request("2001:4860:4860::8888"))).toBe("public-direct");
  });

  it("trusts a valid Cloudflare source header only from loopback", () => {
    expect(requestNetworkClass(request("127.0.0.1", { "cf-connecting-ip": "8.8.8.8" }), true))
      .toBe("public-relay");
    expect(requestNetworkClass(request("127.0.0.1", { "cf-connecting-ip": "192.168.1.2" }), true))
      .toBe("lan");
    expect(requestNetworkClass(request("127.0.0.1", { "cf-connecting-ip": ["8.8.8.8", "1.1.1.1"] }), true))
      .toBe("public-relay");
    expect(requestNetworkClass(request("8.8.8.8", { "cf-connecting-ip": "1.1.1.1" }), true))
      .toBe("public-direct");
  });

  it("ignores forwarded metadata unless explicitly trusted and valid", () => {
    expect(requestNetworkClass(request("127.0.0.1", { "cf-connecting-ip": "8.8.8.8" })))
      .toBe("loopback");
    expect(requestNetworkClass(request("127.0.0.1", { "cf-connecting-ip": "not-an-ip" }), true))
      .toBe("loopback");
  });
});
