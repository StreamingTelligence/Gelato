import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const token = process.env.CONTROLLER_API_TOKEN;
const filename = process.env.CONTROLLER_API_TOKEN_FILE ?? path.join(process.env.GALATEA_STATE_DIR ?? path.join(os.homedir(), '.local', 'state', 'galatea', 'example'), 'access-token');
if (token) console.log(token);
else if (fs.existsSync(filename)) console.log(fs.readFileSync(filename, 'utf8').trim());
else { console.error('Start the control room first, or set CONTROLLER_API_TOKEN_FILE.'); process.exitCode = 1; }
