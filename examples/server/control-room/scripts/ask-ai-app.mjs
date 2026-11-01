#!/usr/bin/env node

const controllerUrl = requiredEnvironment("CONTROLLER_URL").replace(/\/+$/, "");
const apiToken = requiredEnvironment("CONTROLLER_API_TOKEN");
const deviceId = requiredEnvironment("DEVICE_ID");
const jsonOutput = process.argv[2] === "--json";
const providerIndex = jsonOutput ? 3 : 2;
const provider = (process.argv[providerIndex] ?? "").trim().toLowerCase();
const question = process.argv.slice(providerIndex + 1).join(" ").trim();
const supportedProviders = new Set([
  "xiaohongshu", "qwen", "doubao", "deepseek", "xiaobu", "meituan", "kimi"
]);

if (!supportedProviders.has(provider) || !question) {
  fail("Usage: node scripts/ask-ai-app.mjs [--json] <xiaohongshu|qwen|doubao|deepseek|xiaobu|meituan|kimi> <question>");
}

const requestedTimeoutMs = Number(process.env.AI_APP_TIMEOUT_MS ?? 120_000);
if (!Number.isFinite(requestedTimeoutMs)) {
  fail("AI_APP_TIMEOUT_MS must be a finite number");
}
const timeoutMs = Math.max(30_000, Math.min(requestedTimeoutMs, 180_000));
const endpoint = `${controllerUrl}/api/devices/${encodeURIComponent(deviceId)}/ai/${provider}`;

try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ question, timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 10_000)
  });
  const bodyText = await response.text();
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error(`Controller returned HTTP ${response.status} with a non-JSON response`);
  }
  if (!response.ok) {
    throw new Error(payload.error ?? `Controller returned HTTP ${response.status}`);
  }
  if (!payload.result || typeof payload.result.answer !== "string") {
    throw new Error("Controller response did not contain an AI app answer");
  }
  process.stdout.write(jsonOutput
    ? `${JSON.stringify(payload.result, null, 2)}\n`
    : `${payload.result.answer}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

function fail(message) {
  process.stderr.write(`ask-ai-app: ${message}\n`);
  process.exit(1);
}
