export const GELATO_PROTOCOL = "gelato.v1" as const;
export type AgentKind = "android-phone" | "ios" | "rokid-bolon-native" | string;
export type DriverLocation = "device" | "companion" | "controller-sidecar";
export type DriverState = "starting" | "ready" | "degraded" | "unavailable" | "authorization-required";
export type SessionState = "offline" | "authenticating" | "synchronizing" | "online" | "degraded";

export interface CapabilityDescriptor {
  name: string;
  version: number;
  limits?: Record<string, unknown>;
  consent?: string;
  requestSchema?: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
}

export interface DriverDescriptor {
  id: string;
  version: string;
  location: DriverLocation;
  state: DriverState;
  hostAgentId?: string;
  error?: string;
}

export interface HardwareState {
  present: boolean;
  connected: boolean;
  stableKey?: string;
  userAction?: {
    code: string;
    message: string;
  } | null;
  [key: string]: unknown;
}

export interface UnifiedDeviceRecord {
  deviceId: string;
  kind: string;
  displayName: string;
  os: {
    family: string;
    version: string;
  };
  agent: {
    agentId: string;
    installationId: string;
    kind: AgentKind;
    hostPlatform: string;
    version: string;
  };
  driver: DriverDescriptor;
  connection: {
    online: boolean;
    sessionState: SessionState;
    connectedAt?: string;
    lastSeenAt: string;
    transports?: Record<string, DeviceTransportState>;
  };
  hardware: HardwareState;
  capabilities: CapabilityDescriptor[];
  revision: number;
  updatedAt: string;
}

export interface DeviceTransportState {
  online: boolean;
  lastSeenAt: string;
  networkClass?: "loopback" | "lan" | "public-direct" | "public-relay";
}

export interface ProtocolEnvelope<T = Record<string, unknown>> {
  protocol: typeof GELATO_PROTOCOL;
  type: string;
  messageId: string;
  deviceId?: string;
  sentAt: string;
  commandId?: string;
  eventId?: string;
  body: T;
}

export interface CommandRequest {
  commandId?: string;
  capability: string;
  capabilityVersion?: number;
  arguments?: Record<string, unknown>;
  deadlineMs?: number;
  idempotency?: "read-only" | "idempotent" | "side-effecting";
  consentRef?: string;
}

export interface CommandTerminal {
  commandId: string;
  deviceId: string;
  state: "completed" | "failed" | "cancelled" | "timed-out";
  result?: Record<string, unknown>;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface StreamOffer {
  streamId: string;
  commandId?: string;
  purpose: "audio" | "screen" | "file" | "tunnel" | "photo";
  direction: "agent-to-controller" | "controller-to-agent";
  contentType: string;
  maxFrameBytes: number;
  maxTotalBytes: number;
  expectedBytes?: number;
  metadata?: Record<string, unknown>;
}
