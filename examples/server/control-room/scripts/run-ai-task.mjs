#!/usr/bin/env node

const controllerUrl = requiredEnvironment("CONTROLLER_URL").replace(/\/+$/, "");
const apiToken = requiredEnvironment("CONTROLLER_API_TOKEN");
const deviceId = requiredEnvironment("DEVICE_ID");
const jsonOutput = process.argv[2] === "--json";
const actionIndex = jsonOutput ? 3 : 2;
const action = (process.argv[actionIndex] ?? "").trim().toLowerCase();
const values = process.argv.slice(actionIndex + 1);
const argumentsValue = parseArguments(action, values);
const requestedTimeoutMs = Number(process.env.AI_TASK_TIMEOUT_MS ?? 180_000);
if (!Number.isFinite(requestedTimeoutMs)) {
  fail("AI_TASK_TIMEOUT_MS must be a finite number");
}
const timeoutMs = Math.max(30_000, Math.min(requestedTimeoutMs, 180_000));

try {
  const response = await fetch(
    `${controllerUrl}/api/devices/${encodeURIComponent(deviceId)}/tasks`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ action, arguments: argumentsValue, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 20_000)
    }
  );
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(payload.error ?? `Controller returned HTTP ${response.status}`);
  }
  if (!payload.task || typeof payload.task.status !== "string") {
    throw new Error("Controller response did not contain a task result");
  }
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(payload.task, null, 2)}\n`);
  } else {
    printSummary(payload.task);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function parseArguments(action, values) {
  if (action === "alarm.create") {
    const [date, time] = values;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !/^\d{2}:\d{2}$/.test(time ?? "")) {
      usage();
    }
    return { date, time };
  }
  if (action === "image.generate") {
    const prompt = values.join(" ").trim();
    if (!prompt) usage();
    return { prompt };
  }
  if (action === "ride.prepare") {
    const [origin, destination] = values;
    if (!origin?.trim() || !destination?.trim() || values.length !== 2) usage();
    return { origin: origin.trim(), destination: destination.trim() };
  }
  usage();
}

function printSummary(task) {
  process.stdout.write(`${task.action}: ${task.status}\n`);
  if (task.message) process.stdout.write(`${task.message}\n`);
  if (task.confirmation) {
    process.stdout.write(`${task.confirmation.prompt}\n`);
    for (const [index, option] of (task.confirmation.options ?? []).entries()) {
      process.stdout.write(`${index + 1}. ${option}\n`);
    }
  }
  if (task.artifact?.downloadUrl) {
    process.stdout.write(`artifact: ${task.artifact.downloadUrl}\n`);
  }
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Controller returned HTTP ${response.status} with a non-JSON response`);
  }
}

function usage() {
  fail([
    "Usage:",
    "  node scripts/run-ai-task.mjs [--json] alarm.create YYYY-MM-DD HH:mm",
    "  node scripts/run-ai-task.mjs [--json] image.generate <prompt>",
    "  node scripts/run-ai-task.mjs [--json] ride.prepare <origin> <destination>"
  ].join("\n"));
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function fail(message) {
  process.stderr.write(`run-ai-task: ${message}\n`);
  process.exit(1);
}
