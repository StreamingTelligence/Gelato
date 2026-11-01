#!/usr/bin/env node

const controllerUrl = requiredEnvironment("CONTROLLER_URL").replace(/\/+$/, "");
const apiToken = requiredEnvironment("CONTROLLER_API_TOKEN");
const deviceId = requiredEnvironment("DEVICE_ID");
const jsonOutput = process.argv[2] === "--json";
const question = process.argv.slice(jsonOutput ? 3 : 2).join(" ").trim();

if (!question) {
  fail("Usage: node scripts/ask-xiaohongshu.mjs [--json] <question>");
}

const requestedTimeoutMs = Number(process.env.XHS_TIMEOUT_MS ?? 120_000);
if (!Number.isFinite(requestedTimeoutMs)) {
  fail("XHS_TIMEOUT_MS must be a finite number");
}
const timeoutMs = Math.max(30_000, Math.min(requestedTimeoutMs, 180_000));
const endpoint = `${controllerUrl}/api/devices/${encodeURIComponent(deviceId)}/ai/xiaohongshu`;

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
    throw new Error("Controller response did not contain a Xiaohongshu AI answer");
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
  process.stderr.write(`ask-xiaohongshu: ${message}\n`);
  process.exit(1);
}
