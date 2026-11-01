import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { DeviceTransportState } from "./types.js";

export function requestNetworkClass(
  request: IncomingMessage,
  trustLocalCloudflared = false
): NonNullable<DeviceTransportState["networkClass"]> {
  const peer = normalizeAddress(request.socket.remoteAddress ?? "");
  const forwarded = firstHeader(request, "cf-connecting-ip");
  if (trustLocalCloudflared && isLoopbackAddress(peer) && forwarded && isIP(forwarded)) {
    return isPublicAddress(forwarded) ? "public-relay" : "lan";
  }
  if (isLoopbackAddress(peer)) return "loopback";
  return isPrivateAddress(peer) ? "lan" : "public-direct";
}

function firstHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isPublicAddress(value: string): boolean {
  const address = normalizeAddress(value);
  return Boolean(address) && !isLoopbackAddress(address) && !isPrivateAddress(address);
}

function normalizeAddress(value: string): string {
  return value.trim().replace(/^\[|\]$/g, "").replace(/^::ffff:/, "").split("%")[0];
}

function isLoopbackAddress(value: string): boolean {
  return value === "::1" || value === "localhost" || /^127\./.test(value);
}

function isPrivateAddress(value: string): boolean {
  if (!isIP(value)) return true;
  if (/^(10\.|192\.168\.|169\.254\.)/.test(value)) return true;
  const match = /^172\.(\d+)\./.exec(value);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  const carrier = /^100\.(\d+)\./.exec(value);
  if (carrier && Number(carrier[1]) >= 64 && Number(carrier[1]) <= 127) return true;
  return /^(fc|fd|fe8|fe9|fea|feb)/i.test(value);
}
