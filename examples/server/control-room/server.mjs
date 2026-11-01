import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startController } from './dist/controller.js';

const state = process.env.GALATEA_STATE_DIR ?? path.join(os.homedir(), '.local', 'state', 'galatea', 'example');
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
if (!process.env.CONTROLLER_API_TOKEN && !process.env.CONTROLLER_API_TOKEN_FILE) {
  const filename = path.join(state, 'access-token');
  if (!fs.existsSync(filename)) fs.writeFileSync(filename, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  process.env.CONTROLLER_API_TOKEN_FILE = filename;
}
process.env.GELATO_PAIRING_STORE ??= path.join(state, 'pairings.json');
process.env.GELATO_STREAM_DIR ??= path.join(state, 'media');
process.env.TASK_ARTIFACT_DIR ??= path.join(state, 'artifacts');
process.env.GALATEA_HARNESS_STATE_FILE ??= path.join(state, 'commands.json');
if (process.env.GALATEA_PUBLIC_URL) process.env.PUBLIC_CONTROLLER_URL ??= process.env.GALATEA_PUBLIC_URL;
const controller = await startController({ publicDirectory: fileURLToPath(new URL('public/', import.meta.url)) });
const stop = async () => { await controller.close(); process.exit(0); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
