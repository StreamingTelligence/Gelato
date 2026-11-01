#!/usr/bin/env node
// USB is a commissioning transport only. The installed agent uses Wi-Fi.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const packageName = "dev.galatea.rokid.nativeexample";
const component = `${packageName}/.BootstrapActivity`;
const defaultApk = path.join(root, "examples/device/rokid-native-app/app/build/outputs/apk/debug/rokid-native-example-debug.apk");

function usage() {
  console.log("Usage: node examples/device/rokid-native-app/scripts/commission.mjs [--serial ADB_SERIAL] [--allow-control | --update-only | --re-enroll] [--skip-build] [--apk PATH]");
  console.log("Builds and installs the glasses example, prepares permissions, then privately prompts for a gelato://pair link. --update-only restores an existing pairing without a link.");
}

function options(argv) {
  const out = { serial: "", allowControl: false, reEnroll: false, updateOnly: false, skipBuild: false, apk: defaultApk };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--help" || value === "-h") { usage(); process.exit(0); }
    if (value === "--serial" || value === "--apk") {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      if (value === "--serial") out.serial = next;
      else out.apk = path.resolve(next);
    } else if (value === "--allow-control") out.allowControl = true;
    else if (value === "--re-enroll") out.reEnroll = true;
    else if (value === "--update-only") out.updateOnly = true;
    else if (value === "--skip-build") out.skipBuild = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (out.updateOnly && (out.reEnroll || out.allowControl)) throw new Error("--update-only cannot be combined with --re-enroll or --allow-control");
  return out;
}

function command(program, args, label, { quiet = false, sensitive = false } = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });
  if (result.error || result.status !== 0) {
    const detail = sensitive ? "" : (result.stderr || result.stdout || "").trim().slice(0, 300);
    throw new Error(`${label} failed${result.status === null ? "" : ` (exit ${result.status})`}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout?.trim() ?? "";
}

function selectDevice(requested) {
  const devices = command("adb", ["devices"], "ADB device listing", { quiet: true })
    .split("\n").slice(1).map(line => line.trim().split(/\s+/)).filter(parts => parts[0]);
  const connected = devices.filter(parts => parts[1] === "device").map(parts => parts[0]);
  if (requested && !connected.includes(requested)) throw new Error(`ADB device ${requested} is not authorized and connected`);
  if (!requested && connected.length !== 1) throw new Error(`Expected exactly one authorized ADB device; found ${connected.length}. Pass --serial if several are connected.`);
  return requested || connected[0];
}

function promptHidden(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("Run this command in an interactive terminal to paste the one-time link");
  process.stdout.write(label);
  return new Promise((resolve, reject) => {
    let input = "";
    const done = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(input.trim());
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") { done(); return; }
        if (char === "\u0003") { done(new Error("Cancelled")); return; }
        if (char === "\u007f" || char === "\b") input = input.slice(0, -1);
        else input += char;
      }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function parseSetupLink(value) {
  let link;
  try { link = new URL(value); } catch { throw new Error("Invalid pairing link"); }
  if (link.protocol !== "gelato:" || link.hostname !== "pair" || link.searchParams.get("protocol") !== "gelato.v1"
      || link.searchParams.get("agentKind") !== "rokid-bolon-native") {
    throw new Error("Use a Gelato v1 pairing link issued for Rokid BOLON glasses (native)");
  }
  const code = link.searchParams.get("pairingCode") ?? "";
  const controllerUrl = link.searchParams.get("controllerUrl") ?? "";
  let origin;
  try { origin = new URL(controllerUrl); } catch { throw new Error("Pairing link has no valid Controller URL"); }
  if (!/^[A-Z2-9]{8}$/.test(code) || origin.protocol !== "https:" || origin.username || origin.password
      || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("Pairing link must contain an eight-character code and an HTTPS Controller root origin");
  }
  return { code, controllerUrl: origin.origin };
}

async function main() {
  const config = options(process.argv.slice(2));
  if (!config.updateOnly && !process.stdin.isTTY) throw new Error("Use an interactive terminal; the pairing link cannot be read safely from a non-interactive session");
  const serial = selectDevice(config.serial);
  const adb = (...args) => command("adb", ["-s", serial, ...args], "ADB", { quiet: true });
  const installed = adb("shell", "pm", "path", packageName).startsWith("package:");
  if (installed && !config.reEnroll && !config.updateOnly) throw new Error("Gelato Rokid Native is already installed. Use --update-only to preserve pairing, or --re-enroll for a new session.");
  if (!installed && config.updateOnly) throw new Error("--update-only requires an already installed app");
  const api = Number(adb("shell", "getprop", "ro.build.version.sdk"));
  const model = adb("shell", "getprop", "ro.product.model");
  if (!Number.isInteger(api) || api < 32) throw new Error(`Android API ${api || "unknown"} is below the glasses example minimum (32)`);
  const wifi = adb("shell", "ip", "-4", "addr", "show", "wlan0");
  if (!/\binet\s+\d/.test(wifi)) throw new Error("Glasses have no wlan0 IPv4 address. Connect them to Wi-Fi before commissioning.");
  console.log(`ADB: ${serial} (${model}, API ${api}); Wi-Fi interface ready`);

  if (!config.skipBuild) command(path.join(root, "gradlew"), [":rokid-native-example:assembleDebug"], "APK build");
  console.log("Installing APK and preparing camera, microphone and background access...");
  adb("install", "-r", config.apk);
  adb("shell", "pm", "grant", packageName, "android.permission.CAMERA");
  adb("shell", "pm", "grant", packageName, "android.permission.RECORD_AUDIO");
  adb("shell", "cmd", "appops", "set", packageName, "RUN_IN_BACKGROUND", "allow");
  adb("shell", "cmd", "appops", "set", packageName, "RUN_ANY_IN_BACKGROUND", "allow");
  const camera = adb("shell", "dumpsys", "package", packageName);
  if (!/android\.permission\.CAMERA: granted=true/.test(camera)) throw new Error("Camera permission did not become granted");
  if (!/android\.permission\.RECORD_AUDIO: granted=true/.test(camera)) throw new Error("Microphone permission did not become granted");
  for (const operation of ["RUN_IN_BACKGROUND", "RUN_ANY_IN_BACKGROUND"]) {
    if (!/allow/i.test(adb("shell", "cmd", "appops", "get", packageName, operation))) {
      throw new Error(`${operation} remains restricted on the glasses`);
    }
  }
  console.log("Local prerequisites passed.");
  let enrollment;
  if (!config.updateOnly) {
    console.log("Create a one-time Rokid native pairing link in the private Controller console.");
    enrollment = parseSetupLink(await promptHidden("Paste pairing link (input hidden): "));
  }
  const marker = `commission-${randomUUID()}`;
  adb("shell", "log", "-t", "GelatoCommission", marker);
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  const launchArgs = config.updateOnly
    ? ["-a", `${packageName}.RESTORE`]
    : ["-a", `${packageName}.ENROLL`, "--es", "controllerUrl", enrollment.controllerUrl,
      "--es", "pairingCode", enrollment.code, "--ez", "allowControl", String(config.allowControl)];
  const launched = command("adb", ["-s", serial, "shell", "am", "start", "-W", "-n", component, ...launchArgs],
    "Enrollment launch", { quiet: true, sensitive: true });
  if (/Error:|Exception/.test(launched)) throw new Error("Enrollment Activity did not start");
  console.log(config.updateOnly ? "Update installed. Waiting for the saved pairing to reconnect..."
    : "Enrollment launched. Waiting for the glasses to accept the one-time code...");
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    // Rokid's system log is noisy: -t 500 truncates before tag filtering and
    // can drop our marker even when the saved pairing reconnects successfully.
    const logs = command("adb", ["-s", serial, "logcat", "-d", "-s", "GelatoCommission:I", "GelatoRokidNative:I"],
      "Enrollment status", { quiet: true });
    const recent = logs.slice(logs.indexOf(marker) + marker.length);
    if (logs.includes(marker)) {
      const accepted = recent.match(/Session accepted for device (dev_[A-Za-z0-9_-]+)/);
      if (accepted) {
        console.log(config.updateOnly ? `Reconnected: ${accepted[1]}; pairing was preserved.`
          : `Paired: ${accepted[1]}. Remote control ${config.allowControl ? "enabled" : "paused"}.`);
        console.log("Unplug USB and verify the device remains online in the private Controller console (and frames advance when control is allowed).");
        return;
      }
      const rejected = recent.match(/Pairing rejected: ([^\r\n]+)/);
      if (rejected) throw new Error(`Pairing rejected: ${rejected[1]}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(config.updateOnly
    ? "Saved pairing did not reconnect within 45 seconds. Check Wi-Fi, Controller ingress, and GelatoRokidNative logcat."
    : "No pairing acceptance within 45 seconds. Check Wi-Fi, Controller ingress, and GelatoRokidNative logcat; do not reuse an expired code.");
}

main().catch(error => { console.error(`Commissioning failed: ${error.message}`); process.exitCode = 1; });
