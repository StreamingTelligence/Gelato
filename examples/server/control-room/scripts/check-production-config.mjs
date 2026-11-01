import fs from 'node:fs';
import path from 'node:path';
import {transportConfig,loadTlsMaterial} from '../dist/transportConfig.js';
const config=transportConfig(process.env);
if (config.mode !== 'direct') throw new Error('Production startup requires direct HTTPS/WSS');
if (process.env.CONTROLLER_API_TOKEN || !process.env.CONTROLLER_API_TOKEN_FILE) throw new Error('Production startup requires a private CONTROLLER_API_TOKEN_FILE');
const tokenFile=process.env.CONTROLLER_API_TOKEN_FILE;
function privatePath(value,label,isDirectory) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must use an absolute private path`);
  const metadata=fs.statSync(value);
  if ((metadata.mode & 0o077)!==0 || (process.getuid && metadata.uid!==process.getuid())
      || (isDirectory ? !metadata.isDirectory() : !metadata.isFile())) {
    throw new Error(`${label} must be private and owned by the Controller user (found uid ${metadata.uid})`);
  }
}
privatePath(tokenFile,'Operator token',false);
if (fs.readFileSync(tokenFile,'utf8').trim().length < 32) throw new Error('Operator token must contain at least 32 characters');
for (const key of ['GELATO_PAIRING_STORE','GELATO_STREAM_DIR','TASK_ARTIFACT_DIR']) {
  const value=process.env[key];
  if (!value || !path.isAbsolute(value)) throw new Error(`${key} must explicitly point to absolute persistent private storage`);
  if (fs.existsSync(value)) privatePath(value,key,key!=='GELATO_PAIRING_STORE');
  // Fail during check, before the launcher creates files or starts a process.
  privatePath(path.dirname(value),`${key} parent`,true);
}
if (!process.env.TINODE_WS_URL || !process.env.TINODE_API_KEY) throw new Error('Production accounts require the existing Tinode service configuration');
const accountUrl=new URL(process.env.TINODE_WS_URL);
if (accountUrl.username || accountUrl.password || accountUrl.hash ||
    (accountUrl.protocol!=='wss:' && !(accountUrl.protocol==='ws:' && ['127.0.0.1','localhost','[::1]'].includes(accountUrl.hostname)))) {
  throw new Error('Tinode must use WSS, or WS restricted to the local host');
}
const tls=loadTlsMaterial(config,60*60*1000);
console.log(JSON.stringify({transport:'direct',publicOrigin:config.publicOrigin,host:config.host,port:config.port,
  certificateExpiresAt:new Date(tls.expiresAt).toISOString(),accountProvider:'tinode'}));
