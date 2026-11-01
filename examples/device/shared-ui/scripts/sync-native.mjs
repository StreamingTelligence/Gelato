import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const built = fileURLToPath(new URL('../dist/', import.meta.url));
const config = { appId: 'dev.galatea.deviceapp', appName: 'Gelato', webDir: 'public',
  loggingBehavior: 'none', server: { androidScheme: 'https' } };
for (const target of ['device-sdk/android/phone/src/main/assets']) {
  const directory = path.join(root, target);
  await fs.mkdir(directory, { recursive: true });
  const output = path.join(directory, 'public');
  await fs.rm(output, { recursive: true, force: true });
  await fs.cp(built, output, { recursive: true });
  await fs.writeFile(path.join(directory, 'capacitor.config.json'), JSON.stringify(config));
}
const ios = path.join(root, 'device-sdk/ios/MobileAgent/public');
await fs.rm(ios, { recursive: true, force: true });
await fs.cp(built, ios, { recursive: true });
