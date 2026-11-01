import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { DeviceAgentPairingService } from './pairingService.js';
import { UnifiedDeviceRegistry } from './registry.js';
import { AgentGateway } from './gateway.js';
import { CapabilityRouter } from './capabilityRouter.js';
import { CommandService } from './commandService.js';
import { StreamBroker } from './streamBroker.js';
import { ObservationHub } from './http/observations.js';
import { createHostRouter, type AccessGrant } from './http/routes.js';
import type { UnifiedDeviceRecord } from './types.js';
import { GELATO_PROTOCOL } from './types.js';
import { ModelBridge } from './modelBridge.js';
import type { ModelEndpoint } from '@gelato/model-interface';

export interface ServerOptions {
  stateDirectory: string;
  grants: () => AccessGrant[];
  allowedOrigins?: string[];
  modelEndpoint?: ModelEndpoint;
}

/** Owns transport and device state. Applications own authentication and drivers. */
export class GelatoServer {
  readonly pairing: DeviceAgentPairingService;
  readonly devices = new UnifiedDeviceRegistry();
  readonly gateway: AgentGateway;
  readonly commands: CommandService;
  readonly streams: StreamBroker;
  readonly observations: ObservationHub;
  readonly router: ReturnType<typeof createHostRouter>;
  readonly model?: ModelBridge;
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 + 4 });
  private server?: HttpServer;
  private options: ServerOptions;
  private upgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const route = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.headers.origin && this.options.allowedOrigins && !this.options.allowedOrigins.includes(request.headers.origin)) {
      socket.destroy(); return;
    }
    if (!['/agent/control','/agent/streams/live'].includes(route) && !/^\/agent\/streams\/str_[A-Za-z0-9_-]+$/.test(route)) {
      socket.destroy(); return;
    }
    this.sockets.handleUpgrade(request, socket, head, ws => {
      if (route === '/agent/control') this.gateway.attach(ws, request);
      else if (route === '/agent/streams/live') this.streams.attachDirect(ws, request);
      else this.streams.attach(route.split('/').at(-1)!, ws, request);
    });
  };

  constructor(options: ServerOptions) {
    this.options = options;
    const root = path.resolve(options.stateDirectory);
    this.pairing = new DeviceAgentPairingService(path.join(root, 'pairings.json'));
    this.gateway = new AgentGateway(this.pairing, this.devices);
    this.commands = new CommandService(this.gateway, new CapabilityRouter(this.devices));
    this.streams = new StreamBroker(this.pairing, path.join(root, 'media'), id => this.devices.get(id)?.hardware.controlAllowed === true);
    this.observations = new ObservationHub(this.streams);
    if (options.modelEndpoint) this.model = new ModelBridge(this.gateway, this.streams, options.modelEndpoint);
    this.gateway.on('stream.offer', (envelope, reply) => {
      if (!envelope.deviceId) return;
      const device = this.devices.get(envelope.deviceId);
      if (!device) return;
      try {
        const terminal = envelope.commandId ? this.commands.get(envelope.commandId) : undefined;
        if (terminal && terminal.state !== 'completed') throw new Error('Command has already ended');
        const stream = this.streams.offer(device.agent.agentId, device.deviceId, envelope);
        reply({ protocol: GELATO_PROTOCOL, type: 'stream.accept', messageId: 'msg_' + randomUUID().replaceAll('-',''),
          sentAt: new Date().toISOString(), deviceId: device.deviceId, commandId: envelope.commandId,
          body: { streamId: stream.streamId, path: '/agent/streams/' + stream.streamId,
            maxFrameBytes: stream.maxFrameBytes, maxTotalBytes: stream.maxTotalBytes } });
      } catch {
        reply({ protocol: GELATO_PROTOCOL, type: 'protocol.error', messageId: 'msg_' + randomUUID().replaceAll('-',''),
          sentAt: new Date().toISOString(), deviceId: device.deviceId, commandId: envelope.commandId,
          body: { error: 'Stream offer rejected' } });
      }
    });
    this.commands.on('cancel', ({ deviceId, commandId, reason }) => this.streams.cancelCommand(deviceId, commandId, reason));
    this.devices.on('changed', (device: UnifiedDeviceRecord) => {
      if (device.hardware.controlAllowed !== true) {
        this.commands.cancelDevice(device.deviceId);
        this.streams.cancelDevice(device.deviceId);
      }
    });
    this.router = createHostRouter({ grants: options.grants, registry: this.devices, pairing: this.pairing,
      commands: this.commands, observations: this.observations, streams: this.streams, stateFile: path.join(root, 'commands.json') });
  }

  attach(server: HttpServer): this {
    if (this.server) throw new Error('Gateway is already attached');
    this.server = server;
    server.on('upgrade', this.upgrade);
    return this;
  }

  async close(): Promise<void> {
    this.server?.off('upgrade', this.upgrade);
    for (const device of this.devices.list()) this.commands.cancelDevice(device.deviceId, 'Gateway shutting down');
    for (const socket of this.sockets.clients) socket.terminate();
    this.observations.close();
    this.model?.close();
    await new Promise<void>(resolve => this.sockets.close(() => resolve()));
    this.server = undefined;
  }
}
