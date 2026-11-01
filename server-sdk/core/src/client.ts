import { createHash } from 'node:crypto';

export interface DeviceObservation {
  frame_ref: string; device_id: string; stream_id: string; sequence: number;
  cursor_sequence: number; captured_at_s: number | null; source_time_s: number | null;
  received_at_s: number; available_at_s: number; mime_type: string; sha256: string; data_base64: string;
}
export interface ObservationBatch {
  schema: string; epoch: string; cursor: number; oldest_sequence: number; gap: boolean; frames: DeviceObservation[];
}
export interface CommandState {
  command_id: string; device_id: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'result_unknown';
  result?: unknown; error?: string;
}
export class GelatoError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export class GelatoClient {
  private base: string;
  constructor(baseUrl: string, private token: string, private options: { prefix?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || !['https:','http:'].includes(url.protocol)
      || (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('Use HTTPS for remote endpoints');
    this.base = baseUrl.replace(/\/$/, '') + (options.prefix ?? '/v1');
  }
  async request<T>(route: string, body?: object): Promise<T> {
    if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Relative API path required');
    const response = await (this.options.fetchImpl ?? fetch)(this.base + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new GelatoError(response.status, 'gelato_http_' + response.status);
    if (!response.body) throw new Error('Empty response');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const { value, done } = await reader.read(); if (done) break;
        size += value.length; if (size > 24 * 1024 * 1024) throw new Error('Response size limit exceeded'); chunks.push(value); }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  }
  devices() { return this.request<{ devices: import('./types.js').UnifiedDeviceRecord[] }>('/devices'); }
  async observe(deviceId: string, { after = 0, epoch }: { after?: number; epoch?: string } = {}): Promise<ObservationBatch> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid observation cursor');
    const batch = await this.request<ObservationBatch>('/devices/' + encodeURIComponent(deviceId) + '/observations?after=' + after + (epoch ? '&epoch=' + encodeURIComponent(epoch) : ''));
    for (const frame of batch.frames) {
      if (frame.device_id !== deviceId || createHash('sha256').update(Buffer.from(frame.data_base64, 'base64')).digest('hex') !== frame.sha256)
        throw new Error('Observation device or checksum mismatch');
    }
    return batch;
  }
  command(deviceId: string, commandId: string, capability: string, args: object, deadlineMs = 30_000) {
    return this.request<CommandState>('/devices/' + encodeURIComponent(deviceId) + '/commands', { command_id: commandId, capability, arguments: args, deadline_ms: deadlineMs });
  }
  status(commandId: string) { return this.request<CommandState>('/commands/' + encodeURIComponent(commandId)); }
  cancel(commandId: string) { return this.request<CommandState>('/commands/' + encodeURIComponent(commandId) + '/cancel', {}); }
}

export class GelatoHost extends GelatoClient {
  constructor(baseUrl: string, token: string, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    super(baseUrl, token, { ...options, prefix: '/harness/v1' });
  }
}
