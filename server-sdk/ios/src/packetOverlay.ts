import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { nanoid } from "nanoid";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import type { DeviceAgentPairingService } from "@gelato/server-core";
import { GELATO_PROTOCOL, type ProtocolEnvelope } from "@gelato/server-core";
import { requestNetworkClass } from "@gelato/server-core";

type OverlayRole = "ios" | "linux";

const MDNS_IPV4 = Buffer.from([224, 0, 0, 251]);
const OVERLAY_IOS_IPV4 = Buffer.from([198, 18, 0, 2]);
const REMOTE_PAIRING_STREAM_MAGIC = Buffer.from("SRVTCP01");

interface OverlayPeer {
  role: OverlayRole;
  socket: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
  agentId?: string;
  networkClass: "loopback" | "lan" | "public-direct" | "public-relay";
}

export interface PacketOverlaySessionInfo {
  deviceId: string;
  sidecarToken?: string;
  createdAt: number;
  iosConnected: boolean;
  linuxConnected: boolean;
  iosConnectedAt?: number;
  iosLastSeenAt?: number;
  iosNetworkClass?: "loopback" | "lan" | "public-direct" | "public-relay";
  linuxConnectedAt?: number;
  linuxNetworkClass?: "loopback" | "lan" | "public-direct" | "public-relay";
  iosClientBuild?: string;
  iosConfigurationRevision?: number;
  iosNetworkMode?: string;
  iosControlVersion?: number;
  iosPairingProxyState?: string;
  iosPairingProxyPort?: number;
  iosPairingProxyUpdatedAt?: number;
  iosRemotePairingState?: string;
  iosRemotePairingIdentifier?: string;
  iosRemotePairingPort?: number;
  iosRemotePairingTxtBase64?: string;
  iosRemotePairingTransport?: "deviceLoopback";
  iosRemotePairingLoopbackPackets?: number;
  iosOnDeviceRemoteXpcState?: string;
  iosMainAppRemoteXpcState?: string;
  iosRemotePairingUpdatedAt?: number;
  lastPacketAt?: number;
  packetsFromIos: number;
  packetsFromLinux: number;
  bytesFromIos: number;
  bytesFromLinux: number;
  remotePairingStreamFramesFromIos: number;
  remotePairingStreamFramesFromLinux: number;
  packetsDropped: number;
  lastDropAt?: number;
}

interface PacketOverlaySession extends PacketOverlaySessionInfo {
  ios?: OverlayPeer;
  linux?: OverlayPeer;
}

export class PacketOverlayHub extends EventEmitter {
  private readonly sessions = new Map<string, PacketOverlaySession>();

  constructor(private readonly pairing: DeviceAgentPairingService, private readonly trustLocalCloudflared = false) {
    super();
  }

  createSession(deviceId: string): PacketOverlaySessionInfo {
    const existing = this.sessions.get(deviceId);
    if (existing) return this.toInfo(existing, true);
    const session: PacketOverlaySession = {
      deviceId,
      sidecarToken: this.pairing.sidecarToken(deviceId)
        ?? (() => { throw new Error(`Device ${deviceId} must be paired before creating an overlay`); })(),
      createdAt: Date.now(),
      iosConnected: false,
      linuxConnected: false,
      packetsFromIos: 0,
      packetsFromLinux: 0,
      bytesFromIos: 0,
      bytesFromLinux: 0,
      remotePairingStreamFramesFromIos: 0,
      remotePairingStreamFramesFromLinux: 0,
      packetsDropped: 0
    };
    this.sessions.set(deviceId, session);
    return this.toInfo(session, true);
  }

  listSessions(): PacketOverlaySessionInfo[] {
    return [...this.sessions.values()].map((session) => this.toInfo(session));
  }

  deleteSession(deviceId: string): boolean {
    const session = this.sessions.get(deviceId);
    if (!session) return false;
    session.ios?.socket.close(1000, "Packet overlay session deleted");
    session.linux?.socket.close(1000, "Packet overlay session deleted");
    this.sessions.delete(deviceId);
    this.emit("changed", { deviceId, deleted: true });
    return true;
  }

  attach(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? "/", "http://controller.local");
    const parts = url.pathname.split("/").filter(Boolean);
    const deviceId = decodeURIComponent(parts[1] ?? "");
    const role = parseRole(url.searchParams.get("role"));
    if (!deviceId || !role) {
      socket.close(1008, "Packet overlay requires deviceId and role");
      return;
    }

    if (!this.sessions.has(deviceId) && role === "ios") {
      this.createSession(deviceId);
    }
    const session = this.sessions.get(deviceId);
    if (!session) {
      socket.close(1008, "Packet overlay session has not been created");
      return;
    }
    if (!this.authorize(session, role, request)) {
      socket.close(1008, "Packet overlay token is invalid");
      return;
    }

    const previous = role === "ios" ? session.ios : session.linux;
    if (previous && previous.socket !== socket) {
      previous.socket.close(1012, "Packet overlay peer replaced");
    }
    const peer: OverlayPeer = {
      role,
      socket,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      networkClass: requestNetworkClass(request, this.trustLocalCloudflared),
      ...(role === "ios" ? { agentId: requestHeader(request, "x-agent-id") } : {})
    };
    if (role === "ios") {
      const metadata = parseIosClientMetadata(url);
      session.ios = peer;
      session.iosConnected = true;
      session.iosConnectedAt = peer.connectedAt;
      session.iosNetworkClass = peer.networkClass;
      session.iosClientBuild = metadata.clientBuild;
      session.iosConfigurationRevision = metadata.configurationRevision;
      session.iosNetworkMode = metadata.networkMode;
      session.iosControlVersion = metadata.controlVersion;
      session.iosPairingProxyState = undefined;
      session.iosPairingProxyPort = undefined;
      session.iosPairingProxyUpdatedAt = undefined;
      session.iosRemotePairingState = undefined;
      session.iosRemotePairingIdentifier = undefined;
      session.iosRemotePairingPort = undefined;
      session.iosRemotePairingTxtBase64 = undefined;
      session.iosRemotePairingTransport = undefined;
      session.iosRemotePairingLoopbackPackets = undefined;
      session.iosOnDeviceRemoteXpcState = undefined;
      session.iosMainAppRemoteXpcState = undefined;
      session.iosRemotePairingUpdatedAt = undefined;
    } else {
      session.linux = peer;
      session.linuxConnected = true;
      session.linuxConnectedAt = peer.connectedAt;
      session.linuxNetworkClass = peer.networkClass;
    }

    socket.on("message", (data, isBinary) => this.handleMessage(session, peer, data, isBinary));
    socket.on("close", () => this.detach(session, peer));
    socket.on("error", () => this.detach(session, peer));
    socket.send(JSON.stringify({
      type: "packetOverlayAccepted",
      deviceId,
      role,
      overlay: {
        linuxAddress: "198.18.0.1",
        iosAddress: "198.18.0.2",
        subnetMask: "255.255.255.0",
        mtu: 1280
      }
    }));
    this.emit("changed", this.toInfo(session));
  }

  sendAgentEnvelope(deviceId: string, envelope: ProtocolEnvelope): void {
    const ios = this.sessions.get(deviceId)?.ios;
    if (!ios || ios.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Device ${deviceId} has no Packet Tunnel transport`);
    }
    ios.socket.send(JSON.stringify(envelope));
  }

  private authorize(session: PacketOverlaySession, role: OverlayRole, request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
    if (role === "linux") {
      return this.pairing.authenticateSidecar(session.deviceId, bearer);
    }
    const agentIdValue = request.headers["x-agent-id"];
    const agentId = Array.isArray(agentIdValue) ? agentIdValue[0] : agentIdValue;
    return Boolean(agentId) && this.pairing.authenticateDevice(
      session.deviceId,
      agentId!,
      bearer
    );
  }

  private handleMessage(
    session: PacketOverlaySession,
    peer: OverlayPeer,
    data: RawData,
    isBinary: boolean
  ): void {
    peer.lastSeenAt = Date.now();
    if (!isBinary) {
      this.handleControlMessage(session, peer, data);
      return;
    }
    const packet = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data);
    if (packet.length === 0) return;
    const destination = peer.role === "ios" ? session.linux : session.ios;
    if (!destination || destination.socket.readyState !== WebSocket.OPEN) {
      session.packetsDropped += 1;
      const destinationHasConnectedBefore = peer.role === "ios"
        ? Boolean(session.linuxConnectedAt)
        : Boolean(session.iosConnectedAt);
      if (destinationHasConnectedBefore) {
        session.lastDropAt = Date.now();
      }
      return;
    }
    session.lastPacketAt = Date.now();
    if (peer.role === "ios") {
      session.packetsFromIos += 1;
      session.bytesFromIos += packet.byteLength;
      if (packet.subarray(0, REMOTE_PAIRING_STREAM_MAGIC.length).equals(
        REMOTE_PAIRING_STREAM_MAGIC
      )) {
        session.remotePairingStreamFramesFromIos += 1;
      }
    } else {
      session.packetsFromLinux += 1;
      session.bytesFromLinux += packet.byteLength;
      if (packet.subarray(0, REMOTE_PAIRING_STREAM_MAGIC.length).equals(
        REMOTE_PAIRING_STREAM_MAGIC
      )) {
        session.remotePairingStreamFramesFromLinux += 1;
      }
    }
    const packets = peer.role === "linux" ? packetsForIos(packet) : [packet];
    for (const outbound of packets) {
      destination.socket.send(outbound, { binary: true }, (error) => {
        if (error) {
          session.packetsDropped += 1;
          session.lastDropAt = Date.now();
        }
      });
    }
  }

  private handleControlMessage(
    session: PacketOverlaySession,
    peer: OverlayPeer,
    data: RawData
  ): void {
    if (peer.role !== "ios") return;
    const text = Buffer.isBuffer(data)
      ? data.toString("utf8")
      : Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.from(data).toString("utf8");
    if (text.length > 24 * 1024 * 1024) return;
    try {
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.protocol === GELATO_PROTOCOL && typeof message.type === "string") {
        this.emit("agentEnvelope", {
          deviceId: session.deviceId,
          agentId: peer.agentId,
          envelope: message as unknown as ProtocolEnvelope
        });
        return;
      }
      if (message.type === "pairingProxyStatus" && typeof message.state === "string") {
        if (!/^(bonjourStarting|bonjourReady|bonjourWaiting|bonjourFailed|tcpAccepted)$/.test(message.state)) {
          return;
        }
        session.iosPairingProxyState = message.state;
        session.iosPairingProxyPort = typeof message.port === "number"
          && Number.isInteger(message.port)
          && message.port > 0
          && message.port <= 65535
          ? message.port
          : undefined;
        session.iosPairingProxyUpdatedAt = Date.now();
        this.emit("changed", this.toInfo(session));
        return;
      }
      if (message.type === "remotePairingServiceStatus" && typeof message.state === "string") {
        if (!/^(browsing|ready|unavailable|failed)$/.test(message.state)) return;
        const identifier = typeof message.identifier === "string"
          && /^[0-9A-Fa-f-]{36}$/.test(message.identifier)
          ? message.identifier.toUpperCase()
          : undefined;
        const port = typeof message.port === "number"
          && Number.isInteger(message.port)
          && message.port > 0
          && message.port <= 65535
          ? message.port
          : undefined;
        const txtBase64 = typeof message.txtBase64 === "string"
          && message.txtBase64.length <= 4096
          && /^[A-Za-z0-9+/]*={0,2}$/.test(message.txtBase64)
          ? message.txtBase64
          : undefined;
        const transport = message.transport === "deviceLoopback"
          ? message.transport
          : undefined;
        const loopbackPackets = typeof message.loopbackPackets === "number"
          && Number.isSafeInteger(message.loopbackPackets)
          && message.loopbackPackets >= 0
          ? message.loopbackPackets
          : undefined;
        const onDeviceRemoteXpcState =
          typeof message.onDeviceRemoteXpcState === "string"
          && message.onDeviceRemoteXpcState.length >= 1
          && message.onDeviceRemoteXpcState.length <= 200
          && !/[\u0000-\u001f\u007f]/.test(message.onDeviceRemoteXpcState)
            ? message.onDeviceRemoteXpcState
            : undefined;
        const mainAppRemoteXpcState =
          typeof message.mainAppRemoteXpcState === "string"
          && message.mainAppRemoteXpcState.length >= 1
          && message.mainAppRemoteXpcState.length <= 200
          && !/[\u0000-\u001f\u007f]/.test(message.mainAppRemoteXpcState)
            ? message.mainAppRemoteXpcState
            : undefined;
        if (message.state === "ready" && (!identifier || !port || !txtBase64)) return;
        session.iosRemotePairingState = message.state;
        session.iosRemotePairingIdentifier = message.state === "ready" ? identifier : undefined;
        session.iosRemotePairingPort = message.state === "ready" ? port : undefined;
        session.iosRemotePairingTxtBase64 = message.state === "ready" ? txtBase64 : undefined;
        session.iosRemotePairingTransport = transport;
        session.iosRemotePairingLoopbackPackets = loopbackPackets;
        session.iosOnDeviceRemoteXpcState = onDeviceRemoteXpcState;
        session.iosMainAppRemoteXpcState = mainAppRemoteXpcState;
        session.iosRemotePairingUpdatedAt = Date.now();
        this.emit("changed", this.toInfo(session));
      }
    } catch {
      return;
    }
  }

  private detach(session: PacketOverlaySession, peer: OverlayPeer): void {
    if (peer.role === "ios" && session.ios === peer) {
      session.ios = undefined;
      session.iosConnected = false;
    }
    if (peer.role === "linux" && session.linux === peer) {
      session.linux = undefined;
      session.linuxConnected = false;
    }
    this.emit("changed", this.toInfo(session));
  }

  private toInfo(session: PacketOverlaySession, includeSidecarCredential = false): PacketOverlaySessionInfo {
    return {
      deviceId: session.deviceId,
      ...(includeSidecarCredential ? { sidecarToken: session.sidecarToken } : {}),
      createdAt: session.createdAt,
      iosConnected: Boolean(session.ios && session.ios.socket.readyState === WebSocket.OPEN),
      linuxConnected: Boolean(session.linux && session.linux.socket.readyState === WebSocket.OPEN),
      iosConnectedAt: session.iosConnectedAt,
      iosLastSeenAt: session.ios?.lastSeenAt,
      iosNetworkClass: session.iosNetworkClass,
      linuxConnectedAt: session.linuxConnectedAt,
      linuxNetworkClass: session.linuxNetworkClass,
      iosClientBuild: session.iosClientBuild,
      iosConfigurationRevision: session.iosConfigurationRevision,
      iosNetworkMode: session.iosNetworkMode,
      iosControlVersion: session.iosControlVersion,
      iosPairingProxyState: session.iosPairingProxyState,
      iosPairingProxyPort: session.iosPairingProxyPort,
      iosPairingProxyUpdatedAt: session.iosPairingProxyUpdatedAt,
      iosRemotePairingState: session.iosRemotePairingState,
      iosRemotePairingIdentifier: session.iosRemotePairingIdentifier,
      iosRemotePairingPort: session.iosRemotePairingPort,
      iosRemotePairingTxtBase64: session.iosRemotePairingTxtBase64,
      iosRemotePairingTransport: session.iosRemotePairingTransport,
      iosRemotePairingLoopbackPackets: session.iosRemotePairingLoopbackPackets,
      iosOnDeviceRemoteXpcState: session.iosOnDeviceRemoteXpcState,
      iosMainAppRemoteXpcState: session.iosMainAppRemoteXpcState,
      iosRemotePairingUpdatedAt: session.iosRemotePairingUpdatedAt,
      lastPacketAt: session.lastPacketAt,
      packetsFromIos: session.packetsFromIos,
      packetsFromLinux: session.packetsFromLinux,
      bytesFromIos: session.bytesFromIos,
      bytesFromLinux: session.bytesFromLinux,
      remotePairingStreamFramesFromIos: session.remotePairingStreamFramesFromIos,
      remotePairingStreamFramesFromLinux: session.remotePairingStreamFramesFromLinux,
      packetsDropped: session.packetsDropped,
      lastDropAt: session.lastDropAt
    };
  }

}

export interface IosOverlayClientMetadata {
  clientBuild?: string;
  configurationRevision?: number;
  networkMode?: string;
  controlVersion?: number;
}

export function parseIosClientMetadata(url: URL): IosOverlayClientMetadata {
  const clientBuild = url.searchParams.get("clientBuild") ?? "";
  const revision = url.searchParams.get("configurationRevision") ?? "";
  const networkMode = url.searchParams.get("networkMode") ?? "";
  const controlVersion = url.searchParams.get("controlVersion") ?? "";
  return {
    clientBuild: /^[A-Za-z0-9._-]{1,32}$/.test(clientBuild) ? clientBuild : undefined,
    configurationRevision: /^\d{1,6}$/.test(revision) ? Number.parseInt(revision, 10) : undefined,
    networkMode: /^[a-z0-9-]{1,64}$/.test(networkMode) ? networkMode : undefined,
    controlVersion: /^\d{1,3}$/.test(controlVersion) ? Number.parseInt(controlVersion, 10) : undefined
  };
}

function parseRole(value: string | null): OverlayRole | undefined {
  return value === "ios" || value === "linux" ? value : undefined;
}

function requestHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function packetsForIos(packet: Buffer): Buffer[] {
  const unicast = multicastMdnsToIosUnicast(packet);
  return unicast ? [packet, unicast] : [packet];
}

export function multicastMdnsToIosUnicast(packet: Buffer): Buffer | undefined {
  if (packet.length < 28 || packet[0] >>> 4 !== 4) return undefined;
  const headerLength = (packet[0] & 0x0f) * 4;
  if (headerLength < 20 || packet.length < headerLength + 8 || packet[9] !== 17) return undefined;
  const totalLength = packet.readUInt16BE(2);
  if (totalLength < headerLength + 8 || totalLength > packet.length) return undefined;
  if (!packet.subarray(16, 20).equals(MDNS_IPV4)) return undefined;
  if (packet.readUInt16BE(headerLength + 2) !== 5353) return undefined;
  const udpLength = packet.readUInt16BE(headerLength + 4);
  if (udpLength < 8 || headerLength + udpLength > totalLength) return undefined;

  const translated = Buffer.from(packet.subarray(0, totalLength));
  OVERLAY_IOS_IPV4.copy(translated, 16);
  translated[8] = 255;
  translated.writeUInt16BE(0, 10);
  translated.writeUInt16BE(internetChecksum(translated.subarray(0, headerLength)), 10);

  const udp = translated.subarray(headerLength, headerLength + udpLength);
  udp.writeUInt16BE(0, 6);
  const pseudoHeader = Buffer.alloc(12);
  translated.copy(pseudoHeader, 0, 12, 20);
  pseudoHeader[9] = 17;
  pseudoHeader.writeUInt16BE(udpLength, 10);
  const udpChecksum = internetChecksum(Buffer.concat([pseudoHeader, udp]));
  udp.writeUInt16BE(udpChecksum === 0 ? 0xffff : udpChecksum, 6);
  return translated;
}

function internetChecksum(data: Buffer): number {
  let sum = 0;
  for (let offset = 0; offset < data.length; offset += 2) {
    const word = offset + 1 < data.length
      ? data.readUInt16BE(offset)
      : data[offset] << 8;
    sum += word;
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}
