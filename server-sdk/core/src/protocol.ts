import { randomBytes } from 'node:crypto';
import { GELATO_PROTOCOL } from './types.js';

export function envelope(type: string, body: Record<string, unknown>,
  { deviceId, commandId }: { deviceId?: string; commandId?: string } = {}) {
  if (typeof type !== 'string' || !body || typeof body !== 'object') throw new Error('invalid_envelope');
  return { protocol: GELATO_PROTOCOL, type, body, messageId: 'msg_' + randomBytes(12).toString('hex'),
    sentAt: new Date().toISOString(), ...(deviceId ? { deviceId } : {}), ...(commandId ? { commandId } : {}) };
}

export function imagePacket(sequence: number, bytes: Buffer,
  { sourceTimeS = null, capturedAtS = null }: { sourceTimeS?: number | null; capturedAtS?: number | null } = {}) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff || !Buffer.isBuffer(bytes)
    || bytes.length > 10 * 1024 * 1024 || [sourceTimeS, capturedAtS].some(t => t !== null && !Number.isFinite(t))) {
    throw new Error('invalid_image_packet');
  }
  const binary = Buffer.alloc(4 + bytes.length);
  binary.writeUInt32BE(sequence); bytes.copy(binary, 4);
  return { timing: { type: 'stream.frame', sequence, sourceTimeS, capturedAtS }, binary };
}
