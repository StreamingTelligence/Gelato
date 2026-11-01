import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../../..");
const require = createRequire(import.meta.url);
const port = Number(process.env.LAB_HOST_PORT ?? 8181);
const allowPhysical = process.env.LAB_ALLOW_PHYSICAL === "1";
const requireNonWired = process.env.LAB_REQUIRE_NON_WIRED === "1";
const defaultBundleId = process.env.LAB_DEFAULT_IOS_BUNDLE_ID ?? "com.apple.Preferences";
const iosDevelopmentTeam = process.env.LAB_IOS_DEVELOPMENT_TEAM ?? "";
const iosSigningId = process.env.LAB_IOS_SIGNING_ID ?? "Apple Development";
const wdaBundleId = process.env.LAB_WDA_BUNDLE_ID ?? "dev.galatea.wda.xctrunner";
const physicalMode = process.env.LAB_PHYSICAL_MODE ?? "devicehub-wda";
const deviceHubWdaPort = Number(process.env.LAB_DEVICEHUB_WDA_PORT ?? 8100);
const tunnelRegistryPort = Number(process.env.LAB_TUNNEL_REGISTRY_PORT ?? 43000);
const startRemoteXpcTunnel = process.env.LAB_START_REMOTE_XPC_TUNNEL === "1";
const appiumLogLevel = process.env.LAB_APPIUM_LOG_LEVEL ?? "info";
const controllerBaseUrl = (process.env.LAB_CONTROLLER_URL ?? "http://127.0.0.1:8090").replace(/\/+$/, "");
const usbNetworkServiceName = process.env.LAB_USB_NETWORK_SERVICE ?? "iPhone USB";
const overlayDeviceId = process.env.LAB_OVERLAY_DEVICE_ID ?? "";
const overlayFreshnessMs = Number(process.env.LAB_OVERLAY_FRESHNESS_MS ?? 120_000);
const sessions = new Map();

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Remote iOS Lab Host listening on http://127.0.0.1:${port}`);
  console.log(`Physical devices are ${allowPhysical ? "enabled" : "blocked"} for this run.`);
  console.log(`Non-wired acceptance gate is ${requireNonWired ? "required" : "development-only"}.`);
});

process.on("SIGINT", async () => {
  await closeAllSessions();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await closeAllSessions();
  process.exit(143);
});

async function route(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      allowPhysical,
      requireNonWired,
      physicalMode,
      deviceHubWdaPort,
      controllerBaseUrl,
      sessions: sessions.size
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/lab/acceptance") {
    json(res, 200, await getLabAcceptance());
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/lab/devices") {
    json(res, 200, await listLabDevices());
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/lab/sessions") {
    json(res, 200, { sessions: [...sessions.values()].map(publicSession) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/lab/sessions") {
    const body = await readJson(req);
    const session = await createLabSession(String(body.udid ?? ""), String(body.bundleId ?? defaultBundleId));
    json(res, 201, { session: publicSession(session) });
    return;
  }

  const match = url.pathname.match(/^\/api\/lab\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    json(res, 404, { error: "Not found" });
    return;
  }
  const session = requireSession(match[1]);
  const action = match[2] ?? "";

  if (req.method === "DELETE" && !action) {
    await closeSession(session.id);
    json(res, 200, { closed: true });
    return;
  }
  if (req.method === "POST" && action === "tap") {
    const body = await readJson(req);
    await webdriverRequest(session, "POST", `/session/${session.appiumSessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: Number(body.x), y: Number(body.y) },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: Number(body.durationMs ?? 80) },
            { type: "pointerUp", button: 0 }
          ]
        }
      ]
    });
    json(res, 200, { result: { type: "tap", output: "ok" } });
    return;
  }
  if (req.method === "POST" && action === "swipe") {
    const body = await readJson(req);
    await webdriverRequest(session, "POST", `/session/${session.appiumSessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: Number(body.fromX), y: Number(body.fromY) },
            { type: "pointerDown", button: 0 },
            {
              type: "pointerMove",
              duration: Number(body.durationMs ?? 450),
              x: Number(body.toX),
              y: Number(body.toY)
            },
            { type: "pointerUp", button: 0 }
          ]
        }
      ]
    });
    json(res, 200, { result: { type: "swipe", output: "ok" } });
    return;
  }
  if (req.method === "POST" && action === "launch") {
    const body = await readJson(req);
    const bundleId = String(body.bundleId ?? body.appId ?? defaultBundleId);
    const result = await executeMobile(session, "mobile: launchApp", { bundleId })
      .catch(() => executeMobile(session, "mobile: activateApp", { bundleId }));
    json(res, 200, { result: { type: "launchApp", bundleId, value: result.value ?? result } });
    return;
  }
  if (req.method === "GET" && action === "screenshot") {
    const result = await webdriverRequest(session, "GET", `/session/${session.appiumSessionId}/screenshot`);
    const png = Buffer.from(String(result.value ?? ""), "base64");
    res.writeHead(200, { "content-type": "image/png", "content-length": png.length });
    res.end(png);
    return;
  }
  if (req.method === "GET" && action === "source") {
    const result = await webdriverRequest(session, "GET", `/session/${session.appiumSessionId}/source`);
    res.writeHead(200, { "content-type": "application/xml; charset=utf-8" });
    res.end(String(result.value ?? ""));
    return;
  }

  json(res, 404, { error: "Not found" });
}

async function listLabDevices() {
  const simulators = await listSimulators();
  const transportProof = allowPhysical ? await collectNoPhysicalUsbProof().catch((error) => ({
    productReady: false,
    noPhysicalUsbControlPath: false,
    physicalUsbBlocked: false,
    overlayTrafficObserved: false,
    blockers: [`Transport proof failed: ${error instanceof Error ? error.message : String(error)}`],
    warnings: []
  })) : null;
  const coreDevices = await listCoreDevices().catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
    devices: []
  }));
  const physicalCoreDevices = coreDevices.devices.filter((device) => device.reality === "physical");
  const physicalWithTunnel = allowPhysical
    ? await Promise.all(physicalCoreDevices.map(async (device) => {
      const tunnel = device.udid ? summarizeTunnelEntry(await getTunnelEntry(device.udid, 0).catch(() => null)) : null;
      const deviceHubWda = physicalMode === "devicehub-wda" && device.tunnelIPAddressString
        ? await probeDeviceHubWda(device.tunnelIPAddressString)
        : null;
      const acceptanceEligible = isAcceptedPhysicalDeviceTransport(device, transportProof)
        && (physicalMode === "devicehub-wda"
          ? Boolean(device.tunnelIPAddressString && deviceHubWda?.ready)
          : isNonWiredTunnel(tunnel));
      return {
        ...device,
        labEligible: true,
        acceptanceEligible,
        tunnelRegistryPort,
        tunnel,
        deviceHubWdaUrl: physicalMode === "devicehub-wda" && device.tunnelIPAddressString
          ? wdaUrlForHost(device.tunnelIPAddressString, deviceHubWdaPort)
          : undefined,
        deviceHubWda
      };
    }))
    : physicalCoreDevices.map((device) => ({
      name: device.name,
      osVersion: device.osVersion,
      transportType: device.transportType,
      pairingState: device.pairingState,
      blocked: true,
      reason: "LAB_ALLOW_PHYSICAL is not enabled for this simulator-only run."
    }));
  return {
    mode: allowPhysical ? "physical-lab-development" : "simulator-development",
    allowPhysical,
    requireNonWired,
    physicalMode,
    deviceHubWdaPort,
    controllerBaseUrl,
    transportProof,
    acceptanceReady: physicalWithTunnel.some((device) => device.acceptanceEligible),
    acceptanceReason: allowPhysical
      ? "Physical lab development is enabled; acceptance requires a ready WDA endpoint plus either a non-wired CoreDevice tunnel or hard proof that USB data is blocked while the pairing/control traffic is carried by the project overlay."
      : "Simulator development never counts as no-USB physical iOS acceptance.",
    tunnelRegistryPort,
    simulators: simulators.map((device) => ({
      ...device,
      labEligible: true,
      acceptanceEligible: false
    })),
    physicalCoreDevices: physicalWithTunnel,
    coreDeviceError: coreDevices.error
  };
}

async function getLabAcceptance() {
  const devices = await listLabDevices();
  const physical = devices.physicalCoreDevices ?? [];
  const blockers = [];
  const warnings = [];
  if (!allowPhysical) {
    blockers.push("LAB_ALLOW_PHYSICAL is not enabled.");
  }
  const eligible = physical.filter((device) => device.acceptanceEligible);
  const wired = physical.filter((device) => device.transportType === "wired");
  if (eligible.length === 0) {
    blockers.push("No physical iOS device is available through an accepted no-physical-USB Device Hub path.");
  }
  const proof = devices.transportProof;
  for (const blocker of proof?.blockers ?? []) {
    blockers.push(blocker);
  }
  for (const warning of proof?.warnings ?? []) {
    warnings.push(warning);
  }
  if (wired.length > 0 && !hasNoPhysicalUsbControlPath(proof)) {
    blockers.push("At least one physical iOS device is still reported as wired; wired devices cannot pass acceptance.");
  } else if (wired.length > 0) {
    warnings.push(
      "CoreDevice reports the physical device as wired, but USB data is blocked and the project overlay carries remote-pairing/CoreDevice traffic; treating this as a virtual overlay Device Hub route."
    );
  }
  if (physicalMode === "devicehub-wda") {
    for (const device of physical) {
      if (isAcceptedPhysicalDeviceTransport(device, proof) && !device.tunnelIPAddressString) {
        blockers.push(`CoreDevice tunnel address is missing for ${device.udid ?? device.name}.`);
      }
      if (isAcceptedPhysicalDeviceTransport(device, proof) && device.tunnelIPAddressString && !device.deviceHubWda?.ready) {
        blockers.push(`WDA is not ready on the CoreDevice tunnel for ${device.udid ?? device.name}.`);
      }
    }
  } else {
    for (const device of physical) {
      if (device.tunnel?.connectionType === "USB") {
        blockers.push(`RemoteXPC tunnel for ${device.udid ?? device.name} was created from USB.`);
      }
    }
  }
  return {
    productReady: blockers.length === 0,
    requireNonWired,
    physicalMode,
    deviceHubWdaPort,
    tunnelRegistryPort,
    controllerBaseUrl,
    blockers,
    warnings,
    transportProof: proof,
    physicalCoreDevices: physical
  };
}

async function createLabSession(udid, bundleId) {
  if (!udid) throw new Error("udid is required");
  const simulators = await listSimulators();
  const simulator = simulators.find((device) => device.udid === udid);
  if (!simulator) {
    if (!allowPhysical) {
      throw new Error("Only simulators are allowed in this run. Set LAB_ALLOW_PHYSICAL=1 for physical-device lab work.");
    }
    const coreDevices = await listCoreDevices();
    const physical = coreDevices.devices.find((device) =>
      device.reality === "physical" && (device.udid === udid || device.identifier === udid)
    );
    if (!physical) {
      throw new Error(`No physical iOS device found for ${udid}`);
    }
    return physicalMode === "devicehub-wda"
      ? createDeviceHubWdaPhysicalSession(physical, bundleId)
      : createAppiumPhysicalSession(physical, bundleId);
  }

  return createSimulatorSession(simulator, bundleId);
}

async function createSimulatorSession(simulator, bundleId) {
  if (simulator.state !== "Booted") {
    await execFileOk("xcrun", ["simctl", "boot", simulator.udid]).catch((error) => {
      if (!String(error).includes("Unable to boot device in current state")) throw error;
    });
  }
  await execFileOk("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"]);

  const serverPort = await freePort();
  const wdaPort = await freePort();
  const wdaUrl = `http://127.0.0.1:${wdaPort}`;
  const log = [];
  const wda = spawn("xcodebuild", [
    "-project",
    wdaProjectPath(),
    "-scheme",
    "WebDriverAgentRunner",
    "-destination",
    `id=${simulator.udid}`,
    "-derivedDataPath",
    path.join(packageRoot, "build/DerivedData-WDA"),
    "test"
  ], {
    cwd: packageRoot,
    env: { ...process.env, USE_PORT: String(wdaPort) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  wda.stdout.on("data", (chunk) => pushLog(log, chunk));
  wda.stderr.on("data", (chunk) => pushLog(log, chunk));
  wda.on("exit", (code, signal) => pushLog(log, `WDA xcodebuild exited code=${code} signal=${signal}`));

  const appium = spawn(await appiumBin(), [
    "server",
    "--address",
    "127.0.0.1",
    "--port",
    String(serverPort),
    "--base-path",
    "/",
    "--log-level",
    appiumLogLevel
  ], {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });

  appium.stdout.on("data", (chunk) => pushLog(log, chunk));
  appium.stderr.on("data", (chunk) => pushLog(log, chunk));
  appium.on("exit", (code, signal) => pushLog(log, `Appium exited code=${code} signal=${signal}`));

  const session = {
    id: randomUUID(),
    kind: "simulator",
    udid: simulator.udid,
    name: simulator.name,
    runtime: simulator.runtime,
    bundleId,
    serverPort,
    wdaPort,
    wdaUrl,
    wda,
    tunnel: null,
    tunnelEntry: null,
    tunnelRegistryPort: null,
    appium,
    appiumSessionId: "",
    createdAt: new Date().toISOString(),
    log
  };
  sessions.set(session.id, session);

  try {
    await waitForWda(session);
    await waitForAppium(session);
    const created = await appiumRequest(session, "POST", "/session", {
      capabilities: {
        alwaysMatch: {
          platformName: "iOS",
          "appium:automationName": "XCUITest",
          "appium:udid": simulator.udid,
          "appium:deviceName": simulator.name,
          "appium:platformVersion": simulator.platformVersion,
          "appium:bundleId": bundleId,
          "appium:webDriverAgentUrl": wdaUrl,
          "appium:noReset": true,
          "appium:newCommandTimeout": 300,
          "appium:showXcodeLog": false
        }
      }
    }, 180_000);
    session.appiumSessionId = String(created.sessionId ?? created.value?.sessionId ?? "");
    if (!session.appiumSessionId) {
      throw new Error(`Appium did not return a session id: ${JSON.stringify(created)}`);
    }
    return session;
  } catch (error) {
    await closeSession(session.id);
    const details = session.log.slice(-30).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${details}`);
  }
}

async function createDeviceHubWdaPhysicalSession(device, bundleId) {
  if (!device.udid) {
    throw new Error(`Physical device ${device.name ?? device.identifier} does not expose a hardware UDID`);
  }
  if (!device.tunnelIPAddressString) {
    throw new Error(`CoreDevice tunnelIPAddressString is missing for ${device.name ?? device.udid}`);
  }

  const wdaUrl = wdaUrlForHost(device.tunnelIPAddressString, deviceHubWdaPort);
  const log = [];
  const transportProof = await requireAcceptedPhysicalDeviceTransport(device, log);
  const session = {
    id: randomUUID(),
    kind: "physical-devicehub-wda",
    driver: "devicehub-wda",
    udid: device.udid,
    name: device.name,
    runtime: `iOS ${device.osVersion ?? ""}`.trim(),
    bundleId,
    serverPort: null,
    wdaPort: deviceHubWdaPort,
    wdaUrl,
    wda: null,
    tunnel: null,
    tunnelEntry: {
      udid: device.udid,
      address: device.tunnelIPAddressString,
      rsdPort: null,
      serviceCount: null,
      connectionType: isNonWiredDevice(device) ? device.transportType : "project-overlay"
    },
    transportProof,
    tunnelRegistryPort: null,
    appium: null,
    appiumSessionId: "",
    createdAt: new Date().toISOString(),
    log
  };
  sessions.set(session.id, session);

  try {
    await ensureDeviceHubWda(session);
    const existingSessionId = await existingWdaSessionId(session).catch(() => "");
    if (existingSessionId) {
      session.appiumSessionId = existingSessionId;
    } else {
      const created = await wdaRequest(session, "POST", "/session", {
        capabilities: {
          alwaysMatch: {
            platformName: "iOS",
            "appium:automationName": "XCUITest",
            "appium:noReset": true,
            "appium:forceAppLaunch": false,
            "appium:shouldTerminateApp": false,
            "appium:newCommandTimeout": 300
          }
        }
      }, 30_000);
      session.appiumSessionId = String(created.sessionId ?? created.value?.sessionId ?? "");
    }
    if (!session.appiumSessionId) {
      throw new Error("WDA did not return a session id");
    }
    if (bundleId) {
      await executeMobile(session, "mobile: launchApp", { bundleId })
        .catch(() => executeMobile(session, "mobile: activateApp", { bundleId }));
    }
    return session;
  } catch (error) {
    await closeSession(session.id);
    const details = session.log.slice(-40).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${details}`);
  }
}

async function createAppiumPhysicalSession(device, bundleId) {
  if (!device.udid) {
    throw new Error(`Physical device ${device.name ?? device.identifier} does not expose a hardware UDID`);
  }

  const serverPort = await freePort();
  const wdaPort = await freePort();
  const mjpegServerPort = await freePort();
  const log = [];
  const transportProof = await requireAcceptedPhysicalDeviceTransport(device, log);
  const tunnel = await ensureRemoteXpcTunnel(device.udid, log);
  if (requireNonWired && !isNonWiredTunnel(tunnel.entry) && !hasNoPhysicalUsbControlPath(transportProof)) {
    throw new Error(
      `LAB_REQUIRE_NON_WIRED=1 refuses ${device.name ?? device.udid}: RemoteXPC tunnel connectionType is ${tunnel.entry?.connectionType ?? "unknown"}`
    );
  }

  const appium = spawn(await appiumBin(), [
    "server",
    "--address",
    "127.0.0.1",
    "--port",
    String(serverPort),
    "--base-path",
    "/",
    "--log-level",
    appiumLogLevel
  ], {
    cwd: packageRoot,
    env: {
      ...process.env,
      APPIUM_XCUITEST_PREFER_DEVICECTL: process.env.APPIUM_XCUITEST_PREFER_DEVICECTL ?? "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  appium.stdout.on("data", (chunk) => pushLog(log, chunk));
  appium.stderr.on("data", (chunk) => pushLog(log, chunk));
  appium.on("exit", (code, signal) => pushLog(log, `Appium exited code=${code} signal=${signal}`));

  const session = {
    id: randomUUID(),
    kind: "physical",
    udid: device.udid,
    name: device.name,
    runtime: `iOS ${device.osVersion ?? ""}`.trim(),
    bundleId,
    serverPort,
    wdaPort,
    wdaUrl: `http://127.0.0.1:${wdaPort}`,
    wda: null,
    tunnel: tunnel.process,
    tunnelEntry: tunnel.entry,
    transportProof,
    tunnelRegistryPort,
    appium,
    appiumSessionId: "",
    createdAt: new Date().toISOString(),
    log
  };
  sessions.set(session.id, session);

  try {
    await waitForAppium(session);
    const created = await appiumRequest(session, "POST", "/session", {
      capabilities: {
        alwaysMatch: {
          platformName: "iOS",
          "appium:automationName": "XCUITest",
          "appium:udid": device.udid,
          "appium:deviceName": device.name ?? "iPhone",
          "appium:platformVersion": device.osVersion,
          "appium:bundleId": bundleId,
          "appium:xcodeOrgId": iosDevelopmentTeam,
          "appium:xcodeSigningId": iosSigningId,
          "appium:updatedWDABundleId": wdaBundleId,
          "appium:wdaLocalPort": wdaPort,
          "appium:mjpegServerPort": mjpegServerPort,
          "appium:noReset": true,
          "appium:newCommandTimeout": 300,
          "appium:showXcodeLog": false
        }
      }
    }, 240_000);
    session.appiumSessionId = String(created.sessionId ?? created.value?.sessionId ?? "");
    if (!session.appiumSessionId) {
      throw new Error(`Appium did not return a session id: ${JSON.stringify(created)}`);
    }
    return session;
  } catch (error) {
    await closeSession(session.id);
    const details = session.log.slice(-40).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${details}`);
  }
}

async function executeMobile(session, script, args) {
  if (session.driver === "devicehub-wda") {
    const bundleId = String(args?.bundleId ?? "");
    if (!bundleId) throw new Error("bundleId is required");
    if (script === "mobile: launchApp") {
      return wdaRequest(session, "POST", `/session/${session.appiumSessionId}/wda/apps/launch`, { bundleId });
    }
    if (script === "mobile: activateApp") {
      return wdaRequest(session, "POST", `/session/${session.appiumSessionId}/wda/apps/activate`, { bundleId });
    }
  }
  return webdriverRequest(session, "POST", `/session/${session.appiumSessionId}/execute/sync`, {
    script,
    args: [args]
  });
}

async function waitForAppium(session) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await appiumRequest(session, "GET", "/status", undefined, 2_000);
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw lastError ?? new Error("Timed out waiting for Appium");
}

async function waitForWda(session) {
  const deadline = Date.now() + 180_000;
  let lastError;
  while (Date.now() < deadline) {
    if (session.wda.exitCode !== null) {
      throw new Error(`WDA xcodebuild exited before /status became ready: ${session.log.slice(-40).join("\n")}`);
    }
    try {
      const response = await fetchWithTimeout(`${session.wdaUrl}/status`, {
        method: "GET",
        timeoutMs: 2_000
      });
      if (response.status >= 200 && response.status < 300) return;
      lastError = new Error(`WDA /status returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(1_000);
  }
  throw lastError ?? new Error("Timed out waiting for WDA");
}

async function ensureDeviceHubWda(session) {
  try {
    await waitForDirectWda(session, 5_000);
    return;
  } catch (error) {
    pushLog(session.log, `Direct WDA was not ready, starting WebDriverAgentRunner: ${error instanceof Error ? error.message : String(error)}`);
  }

  const wda = spawn("xcodebuild", [
    "-quiet",
    "-project",
    wdaProjectPath(),
    "-scheme",
    "WebDriverAgentRunner",
    "-configuration",
    "Debug",
    "-destination",
    `id=${session.udid}`,
    "-derivedDataPath",
    path.join(repoRoot, "build/WebDriverAgent-DerivedData"),
    `DEVELOPMENT_TEAM=${iosDevelopmentTeam}`,
    "CODE_SIGN_STYLE=Automatic",
    `PRODUCT_BUNDLE_IDENTIFIER=${wdaBundleId}`,
    "-allowProvisioningUpdates",
    "test"
  ], {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  session.wda = wda;
  wda.stdout.on("data", (chunk) => pushLog(session.log, chunk));
  wda.stderr.on("data", (chunk) => pushLog(session.log, chunk));
  wda.on("exit", (code, signal) => pushLog(session.log, `WDA xcodebuild exited code=${code} signal=${signal}`));
  await waitForDirectWda(session, 180_000);
}

async function waitForDirectWda(session, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (session.wda?.exitCode !== null && session.wda?.exitCode !== undefined) {
      throw new Error(`WDA xcodebuild exited before /status became ready: ${session.log.slice(-40).join("\n")}`);
    }
    try {
      const response = await fetchWithTimeout(`${session.wdaUrl}/status`, {
        method: "GET",
        timeoutMs: 3_000
      });
      if (response.status >= 200 && response.status < 300) {
        const parsed = JSON.parse(response.body.toString("utf8") || "{}");
        if (parsed.value?.ready !== false) return;
        lastError = new Error(`WDA /status was not ready: ${response.body.toString("utf8")}`);
      } else {
        lastError = new Error(`WDA /status returned ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await delay(1_000);
  }
  throw lastError ?? new Error("Timed out waiting for direct WDA");
}

async function ensureRemoteXpcTunnel(udid, log) {
  const existing = await getTunnelEntry(udid, 15_000).catch((error) => {
    pushLog(log, `RemoteXPC tunnel registry probe failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (isTunnelEntryReady(existing)) {
    pushLog(log, `RemoteXPC tunnel registry ready for ${udid} on port ${tunnelRegistryPort}`);
    return { entry: summarizeTunnelEntry(existing), process: null };
  }

  if (!startRemoteXpcTunnel) {
    throw new Error(
      `RemoteXPC tunnel registry has no ready entry for ${udid}. ` +
      `Start it first with: sudo appium driver run xcuitest tunnel-creation -- --udid ${udid} --tunnel-registry-port ${tunnelRegistryPort}`
    );
  }

  const appium = await appiumBin();
  const args = [
    "driver",
    "run",
    "xcuitest",
    "tunnel-creation",
    "--",
    "--udid",
    udid,
    "--tunnel-registry-port",
    String(tunnelRegistryPort),
    "--disconnect-retry-max-attempts",
    "10",
    "--disconnect-retry-interval-ms",
    "2000"
  ];
  const command = typeof process.getuid === "function" && process.getuid() === 0
    ? appium
    : "sudo";
  const commandArgs = command === "sudo" ? ["-n", appium, ...args] : args;
  const tunnel = spawn(command, commandArgs, {
    cwd: packageRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  tunnel.stdout.on("data", (chunk) => pushLog(log, chunk));
  tunnel.stderr.on("data", (chunk) => pushLog(log, chunk));
  tunnel.on("exit", (code, signal) => pushLog(log, `RemoteXPC tunnel process exited code=${code} signal=${signal}`));

  try {
    const entry = await waitForTunnelEntry(udid, tunnel);
    return { entry: summarizeTunnelEntry(entry), process: tunnel };
  } catch (error) {
    tunnel.kill("SIGTERM");
    throw error;
  }
}

async function waitForTunnelEntry(udid, tunnelProcess) {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    if (tunnelProcess.exitCode !== null) {
      throw new Error(`RemoteXPC tunnel process exited before registry became ready`);
    }
    try {
      const entry = await getTunnelEntry(udid, 5_000);
      if (isTunnelEntryReady(entry)) return entry;
    } catch (error) {
      lastError = error;
    }
    await delay(1_000);
  }
  throw lastError ?? new Error(`Timed out waiting for RemoteXPC tunnel registry entry for ${udid}`);
}

async function getTunnelEntry(udid, waitMs) {
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${tunnelRegistryPort}/remotexpc/tunnels/${encodeURIComponent(udid)}?waitMs=${waitMs}`,
    { method: "GET", timeoutMs: Math.max(1_000, waitMs + 1_000) }
  );
  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Tunnel registry returned ${response.status}: ${response.body.toString("utf8")}`);
  }
  return JSON.parse(response.body.toString("utf8"));
}

function isTunnelEntryReady(entry) {
  return Boolean(entry?.address && entry?.rsdPort && entry?.services && Object.keys(entry.services).length > 0);
}

function isNonWiredDevice(device) {
  const transportType = String(device?.transportType ?? "").toLowerCase();
  return Boolean(transportType && transportType !== "wired" && transportType !== "samemachine");
}

function isAcceptedPhysicalDeviceTransport(device, proof) {
  if (isNonWiredDevice(device)) return true;
  if (!requireNonWired) return true;
  return hasNoPhysicalUsbControlPath(proof);
}

function hasNoPhysicalUsbControlPath(proof) {
  return Boolean(proof?.noPhysicalUsbControlPath);
}

async function requireAcceptedPhysicalDeviceTransport(device, log) {
  if (!requireNonWired || isNonWiredDevice(device)) return null;
  const proof = await collectNoPhysicalUsbProof();
  if (hasNoPhysicalUsbControlPath(proof)) {
    pushLog(
      log,
      `CoreDevice transport is ${device.transportType ?? "unknown"}; accepting only because USB data is blocked and overlay traffic is observed.`
    );
    return proof;
  }
  throw new Error([
    `LAB_REQUIRE_NON_WIRED=1 refuses ${device.name ?? device.udid}: CoreDevice transport is ${device.transportType ?? "unknown"}.`,
    ...proof.blockers
  ].join(" "));
}

function isNonWiredTunnel(tunnel) {
  const connectionType = String(tunnel?.connectionType ?? "").toLowerCase();
  return Boolean(connectionType && connectionType !== "usb");
}

async function collectNoPhysicalUsbProof() {
  const [usb, overlay] = await Promise.all([
    collectUsbDataPathProof(),
    collectOverlayTrafficProof()
  ]);
  const blockers = [];
  const warnings = [];
  if (!usb.physicalUsbBlocked) {
    blockers.push(...usb.blockers);
  }
  if (!overlay.overlayTrafficObserved) {
    blockers.push(...overlay.blockers);
  }
  warnings.push(...usb.warnings, ...overlay.warnings);
  return {
    productReady: blockers.length === 0,
    noPhysicalUsbControlPath: usb.physicalUsbBlocked && overlay.overlayTrafficObserved,
    physicalUsbBlocked: usb.physicalUsbBlocked,
    overlayTrafficObserved: overlay.overlayTrafficObserved,
    controllerBaseUrl,
    usb,
    overlay,
    blockers,
    warnings
  };
}

async function collectUsbDataPathProof() {
  const warnings = [];
  const blockers = [];
  const hardwarePorts = await execFileOk("networksetup", ["-listallhardwareports"]).catch((error) => {
    warnings.push(`Could not list network hardware ports: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  });
  const usbInterfaces = parseHardwarePortDevices(hardwarePorts, usbNetworkServiceName);
  const serviceStateText = await execFileOk("networksetup", ["-getnetworkserviceenabled", usbNetworkServiceName])
    .catch((error) => {
      warnings.push(`Could not read ${usbNetworkServiceName} service state: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    });
  const serviceEnabled = parseNetworkServiceEnabled(serviceStateText);
  const interfaceStates = [];
  for (const name of usbInterfaces) {
    const ifconfig = await execFileOk("ifconfig", [name]).catch((error) => {
      warnings.push(`Could not inspect ${name}: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    });
    interfaceStates.push(parseIfconfigState(name, ifconfig));
  }
  const processList = await execFileOk("ps", ["-axo", "pid=,stat=,comm=,args="]).catch((error) => {
    warnings.push(`Could not inspect USB process state: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  });
  const usbmuxd = summarizeProcessState(processList, "usbmuxd");
  const mobileDeviceUpdater = summarizeProcessState(processList, "MobileDeviceUpdater");
  if (serviceEnabled !== false) {
    blockers.push(`${usbNetworkServiceName} network service is not disabled.`);
  }
  if (usbInterfaces.length === 0) {
    warnings.push(`${usbNetworkServiceName} network interface was not found in networksetup output.`);
  }
  for (const state of interfaceStates) {
    if (state.status !== "inactive") {
      blockers.push(`${state.name} is ${state.status || "unknown"} instead of inactive.`);
    }
  }
  if (!usbmuxd.stopped) {
    blockers.push("usbmuxd is not stopped; USB device multiplexing could still be a control path.");
  }
  if (!mobileDeviceUpdater.stopped) {
    blockers.push("MobileDeviceUpdater is not stopped; Apple MobileDevice USB services could still be active.");
  }
  return {
    physicalUsbBlocked: blockers.length === 0,
    serviceName: usbNetworkServiceName,
    serviceEnabled,
    usbInterfaces,
    interfaceStates,
    usbmuxd,
    mobileDeviceUpdater,
    blockers,
    warnings
  };
}

async function collectOverlayTrafficProof() {
  const warnings = [];
  const blockers = [];
  const [overlaysResponse, proxiesResponse] = await Promise.all([
    fetchControllerJson("/api/packet-overlays").catch((error) => {
      warnings.push(`Could not query packet overlays: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }),
    fetchControllerJson("/api/local-tcp-proxies").catch((error) => {
      warnings.push(`Could not query local TCP proxies: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    })
  ]);
  const overlays = Array.isArray(overlaysResponse?.overlays) ? overlaysResponse.overlays : [];
  const overlayCandidates = overlayDeviceId
    ? overlays.filter((overlay) => overlay.deviceId === overlayDeviceId)
    : overlays;
  const now = Date.now();
  const packetOverlay = overlayCandidates.find((overlay) =>
    overlay.iosConnected === true
      && overlay.macConnected === true
      && Number(overlay.packetsFromIos ?? 0) > 0
      && Number(overlay.packetsFromMac ?? 0) > 0
      && Number(overlay.bytesFromIos ?? 0) > 0
      && Number(overlay.bytesFromMac ?? 0) > 0
      && isFreshTimestamp(overlay.lastPacketAt, now)
      && !isFreshTimestamp(overlay.lastDropAt, now)
  );
  const proxies = Array.isArray(proxiesResponse?.proxies) ? proxiesResponse.proxies : [];
  const remotePairingProxy = proxies.find((proxy) =>
    String(proxy.label ?? "").startsWith("remote-pairing-overlay:")
      && hasBidirectionalProxyTraffic(proxy)
      && isFreshTimestamp(proxy.lastActivityAt, now)
  );
  const coreDeviceTunnelProxy = proxies.find((proxy) =>
    String(proxy.label ?? "").startsWith("coredevice-tunnel:")
      && hasBidirectionalProxyTraffic(proxy)
      && isFreshTimestamp(proxy.lastActivityAt, now)
  );
  if (!packetOverlay) {
    blockers.push(`No connected packet overlay has fresh bidirectional iOS/Mac traffic without recent dropped packets within ${overlayFreshnessMs}ms.`);
  }
  if (!remotePairingProxy) {
    blockers.push(`No remote-pairing overlay proxy has fresh bidirectional traffic within ${overlayFreshnessMs}ms.`);
  }
  if (!coreDeviceTunnelProxy) {
    blockers.push(`No CoreDevice tunnel overlay proxy has fresh bidirectional traffic within ${overlayFreshnessMs}ms.`);
  }
  return {
    overlayTrafficObserved: blockers.length === 0,
    overlayDeviceId: overlayDeviceId || undefined,
    freshnessMs: overlayFreshnessMs,
    packetOverlay: packetOverlay ? summarizePacketOverlay(packetOverlay) : null,
    remotePairingProxy: remotePairingProxy ? summarizeProxy(remotePairingProxy) : null,
    coreDeviceTunnelProxy: coreDeviceTunnelProxy ? summarizeProxy(coreDeviceTunnelProxy) : null,
    blockers,
    warnings
  };
}

function parseHardwarePortDevices(output, hardwarePortName) {
  const devices = [];
  let currentPort = "";
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const portMatch = line.match(/^Hardware Port:\s*(.+)$/);
    if (portMatch) {
      currentPort = portMatch[1].trim();
      continue;
    }
    const deviceMatch = line.match(/^Device:\s*(.+)$/);
    if (deviceMatch && currentPort === hardwarePortName) {
      devices.push(deviceMatch[1].trim());
    }
  }
  return devices;
}

function parseNetworkServiceEnabled(output) {
  const text = String(output ?? "").trim().toLowerCase();
  if (text === "enabled") return true;
  if (text === "disabled") return false;
  return null;
}

function parseIfconfigState(name, output) {
  const status = String(output ?? "").match(/\bstatus:\s*([^\s]+)/)?.[1] ?? "";
  const flags = String(output ?? "").match(/flags=\d+<([^>]+)>/)?.[1]?.split(",") ?? [];
  return { name, status, flags };
}

function summarizeProcessState(output, processName) {
  const processes = String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        stat: match[2],
        comm: match[3],
        args: match[4]
      };
    })
    .filter((processInfo) => processInfo && (
      path.basename(processInfo.comm) === processName
        || path.basename(processInfo.args.split(/\s+/)[0] ?? "") === processName
        || processInfo.args.split(/\s+/).some((part) => path.basename(part) === processName)
    ));
  return {
    processName,
    count: processes.length,
    stopped: processes.length === 0 || processes.every((processInfo) => processInfo.stat.includes("T")),
    processes: processes.map((processInfo) => ({
      pid: processInfo.pid,
      stat: processInfo.stat,
      comm: processInfo.comm
    }))
  };
}

async function fetchControllerJson(requestPath) {
  const response = await fetchWithTimeout(`${controllerBaseUrl}${requestPath}`, {
    method: "GET",
    timeoutMs: 5_000
  });
  const text = response.body.toString("utf8");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${controllerBaseUrl}${requestPath} returned ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function hasBidirectionalProxyTraffic(proxy) {
  return Number(proxy.connectionsAccepted ?? 0) > 0
    && Number(proxy.bytesFromLocal ?? 0) > 0
    && Number(proxy.bytesFromTarget ?? 0) > 0
    && Number(proxy.connectErrors ?? 0) === 0;
}

function isFreshTimestamp(value, now = Date.now()) {
  const timestamp = Number(value ?? 0);
  return timestamp > 0 && now - timestamp <= overlayFreshnessMs;
}

function summarizePacketOverlay(overlay) {
  return {
    deviceId: overlay.deviceId,
    iosConnected: overlay.iosConnected,
    macConnected: overlay.macConnected,
    packetsFromIos: Number(overlay.packetsFromIos ?? 0),
    packetsFromMac: Number(overlay.packetsFromMac ?? 0),
    bytesFromIos: Number(overlay.bytesFromIos ?? 0),
    bytesFromMac: Number(overlay.bytesFromMac ?? 0),
    packetsDropped: Number(overlay.packetsDropped ?? 0),
    lastDropAt: overlay.lastDropAt,
    lastPacketAt: overlay.lastPacketAt
  };
}

function summarizeProxy(proxy) {
  return {
    id: proxy.id,
    label: proxy.label,
    targetHost: proxy.targetHost,
    targetPort: proxy.targetPort,
    listenHost: proxy.listenHost,
    listenPort: proxy.listenPort,
    connectionsAccepted: Number(proxy.connectionsAccepted ?? 0),
    activeConnections: Number(proxy.activeConnections ?? 0),
    connectErrors: Number(proxy.connectErrors ?? 0),
    bytesFromLocal: Number(proxy.bytesFromLocal ?? 0),
    bytesFromTarget: Number(proxy.bytesFromTarget ?? 0),
    lastActivityAt: proxy.lastActivityAt
  };
}

async function probeDeviceHubWda(tunnelAddress) {
  const url = wdaUrlForHost(tunnelAddress, deviceHubWdaPort);
  try {
    const response = await fetchWithTimeout(`${url}/status`, {
      method: "GET",
      timeoutMs: 2_500
    });
    const text = response.body.toString("utf8");
    const parsed = text ? JSON.parse(text) : {};
    return {
      url,
      ready: response.status >= 200 && response.status < 300 && parsed.value?.ready !== false,
      status: response.status,
      message: parsed.value?.message,
      sessionId: parsed.sessionId ?? parsed.value?.sessionId
    };
  } catch (error) {
    return {
      url,
      ready: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function summarizeTunnelEntry(entry) {
  if (!entry) return null;
  return {
    udid: entry.udid,
    address: entry.address,
    rsdPort: entry.rsdPort,
    serviceCount: entry.services ? Object.keys(entry.services).length : 0,
    connectionType: entry.connectionType
  };
}

async function webdriverRequest(session, method, requestPath, body, timeoutMs = 30_000) {
  return session.driver === "devicehub-wda"
    ? wdaRequest(session, method, requestPath, body, timeoutMs)
    : appiumRequest(session, method, requestPath, body, timeoutMs);
}

async function appiumRequest(session, method, requestPath, body, timeoutMs = 30_000) {
  if (!session.serverPort) {
    throw new Error(`Session ${session.id} does not have an Appium server`);
  }
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const response = await fetchWithTimeout(`http://127.0.0.1:${session.serverPort}${requestPath}`, {
    method,
    headers: payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {},
    body: payload,
    timeoutMs
  });
  const text = response.body.toString("utf8");
  const parsed = text ? JSON.parse(text) : {};
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Appium ${method} ${requestPath} failed with ${response.status}: ${text}`);
  }
  if (parsed.value?.error) {
    throw new Error(`Appium error: ${JSON.stringify(parsed.value)}`);
  }
  return parsed;
}

async function wdaRequest(session, method, requestPath, body, timeoutMs = 30_000, didRefreshTunnel = false) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  let response;
  try {
    response = await fetchWithTimeout(`${session.wdaUrl}${requestPath}`, {
      method,
      headers: payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {},
      body: payload,
      timeoutMs
    });
  } catch (error) {
    if (session.driver === "devicehub-wda" && !didRefreshTunnel && isRecoverableWdaNetworkError(error)) {
      await refreshDeviceHubWdaSessionTunnel(session);
      return wdaRequest(session, method, requestPath, body, timeoutMs, true);
    }
    throw error;
  }
  const text = response.body.toString("utf8");
  const parsed = text ? JSON.parse(text) : {};
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`WDA ${method} ${requestPath} failed with ${response.status}: ${text}`);
  }
  if (parsed.value?.error) {
    throw new Error(`WDA error: ${JSON.stringify(parsed.value)}`);
  }
  return parsed;
}

function isRecoverableWdaNetworkError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|AbortError/i.test(message);
}

async function refreshDeviceHubWdaSessionTunnel(session) {
  const coreDevices = await listCoreDevices();
  const device = coreDevices.devices.find((candidate) => candidate.udid === session.udid);
  if (!device?.tunnelIPAddressString) {
    throw new Error(`Could not refresh CoreDevice tunnel address for ${session.udid}`);
  }
  const oldUrl = session.wdaUrl;
  session.wdaUrl = wdaUrlForHost(device.tunnelIPAddressString, session.wdaPort ?? deviceHubWdaPort);
  session.tunnelEntry = {
    ...(session.tunnelEntry ?? {}),
    udid: session.udid,
    address: device.tunnelIPAddressString,
    connectionType: isNonWiredDevice(device) ? device.transportType : "project-overlay"
  };
  pushLog(session.log, `Refreshed Device Hub WDA URL from ${oldUrl} to ${session.wdaUrl}`);
}

async function existingWdaSessionId(session) {
  const status = await wdaRequest(session, "GET", "/status", undefined, 5_000);
  return String(status.sessionId ?? status.value?.sessionId ?? "");
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.from(await response.arrayBuffer())
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function listSimulators() {
  const output = await execFileJson("xcrun", ["simctl", "list", "devices", "available", "--json"]);
  const devices = [];
  for (const [runtime, runtimeDevices] of Object.entries(output.devices ?? {})) {
    if (!runtime.includes("iOS")) continue;
    for (const device of runtimeDevices) {
      devices.push({
        kind: "simulator",
        name: device.name,
        udid: device.udid,
        state: device.state,
        runtime,
        platformVersion: parseSimulatorRuntimeVersion(runtime)
      });
    }
  }
  return devices.sort((a, b) => Number(b.state === "Booted") - Number(a.state === "Booted") || a.name.localeCompare(b.name));
}

function parseSimulatorRuntimeVersion(runtime) {
  const match = runtime.match(/iOS[-.]([0-9-]+)$/);
  if (!match) return undefined;
  return match[1].replaceAll("-", ".");
}

async function listCoreDevices() {
  const output = await execFileJson("xcrun", [
    "devicectl",
    "list",
    "devices",
    "--json-output",
    "-",
    "--omit-deprecated-fields-in-json",
    "--quiet"
  ]);
  const listedDevices = (output.result?.devices ?? [])
    .map(coreDeviceSummary)
    .filter((device) => device.platform === "iOS");
  const devices = await Promise.all(
    listedDevices.map(async (device) => {
      if (device.reality !== "physical") return device;
      return enrichCoreDeviceDetails(device).catch((error) => ({
        ...device,
        detailsError: error instanceof Error ? error.message : String(error)
      }));
    })
  );
  return { devices };
}

function coreDeviceSummary(device) {
  const properties = device.properties ?? {};
  const hardware = properties.hardware ?? {};
  const connection = properties.connection ?? {};
  return {
    identifier: String(device.identifier ?? ""),
    name: properties.state?.name,
    udid: hardware.udid,
    platform: hardware.platform,
    reality: hardware.reality,
    osVersion: properties.software?.osVersionNumber?.stringValue,
    state: connection.state,
    transportType: connection.transportType,
    pairingState: connection.pairingState,
    tunnelIPAddressString: connection.tunnelIPAddressString
  };
}

async function enrichCoreDeviceDetails(device) {
  const deviceRef = device.udid || device.identifier;
  if (!deviceRef) return device;
  const output = await execFileJson("xcrun", [
    "devicectl",
    "device",
    "info",
    "details",
    "--device",
    deviceRef,
    "--timeout",
    "45",
    "--json-output",
    "-",
    "--omit-deprecated-fields-in-json",
    "--quiet"
  ]);
  const details = coreDeviceSummary(output.result ?? {});
  return {
    ...device,
    ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined && value !== "")),
    detailsRefreshed: true
  };
}

async function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  if (session.appiumSessionId) {
    await webdriverRequest(session, "DELETE", `/session/${session.appiumSessionId}`).catch(() => undefined);
  }
  session.appium?.kill("SIGTERM");
  session.wda?.kill("SIGTERM");
  session.tunnel?.kill("SIGTERM");
  if (session.appium) await Promise.race([once(session.appium, "exit"), delay(2_000)]).catch(() => undefined);
  if (session.wda) await Promise.race([once(session.wda, "exit"), delay(2_000)]).catch(() => undefined);
  if (session.tunnel) await Promise.race([once(session.tunnel, "exit"), delay(2_000)]).catch(() => undefined);
  if (session.appium && !session.appium.killed) session.appium.kill("SIGKILL");
  if (session.wda && !session.wda.killed) session.wda.kill("SIGKILL");
  if (session.tunnel && !session.tunnel.killed) session.tunnel.kill("SIGKILL");
}

async function closeAllSessions() {
  await Promise.all([...sessions.keys()].map((id) => closeSession(id)));
}

function publicSession(session) {
  return {
    id: session.id,
    kind: session.kind,
    driver: session.driver ?? "appium",
    udid: session.udid,
    name: session.name,
    runtime: session.runtime,
    bundleId: session.bundleId,
    serverPort: session.serverPort,
    wdaPort: session.wdaPort,
    wdaUrl: session.wdaUrl,
    tunnelRegistryPort: session.tunnelRegistryPort,
    tunnelEntry: session.tunnelEntry,
    transportProof: session.transportProof,
    appiumSessionId: session.appiumSessionId,
    createdAt: session.createdAt,
    recentLog: session.log.slice(-20)
  };
}

function wdaUrlForHost(host, port) {
  const trimmed = String(host ?? "").trim();
  if (!trimmed) throw new Error("WDA host is required");
  const formattedHost = trimmed.includes(":") && !trimmed.startsWith("[")
    ? `[${trimmed}]`
    : trimmed;
  return `http://${formattedHost}:${port}`;
}

function requireSession(id) {
  const session = sessions.get(id);
  if (!session) throw new Error(`Unknown lab session ${id}`);
  return session;
}

function pushLog(log, chunk) {
  const text = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    log.push(line);
  }
  if (log.length > 500) log.splice(0, log.length - 500);
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length
  });
  res.end(body);
}

async function execFileJson(command, args) {
  return JSON.parse(await execFileOk(command, args));
}

function execFileOk(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: packageRoot, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function appiumBin() {
  const candidates = [
    path.join(packageRoot, "node_modules/.bin/appium"),
    path.join(repoRoot, "node_modules/.bin/appium"),
    "appium"
  ];
  for (const candidate of candidates) {
    if (candidate === "appium") return candidate;
    try {
      await execFileOk("test", ["-x", candidate]);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return "appium";
}

function wdaProjectPath() {
  if (process.env.LAB_WDA_PROJECT) return path.resolve(process.env.LAB_WDA_PROJECT);
  const driverRoot = path.dirname(require.resolve("appium-xcuitest-driver/package.json"));
  const wdaRoot = path.dirname(require.resolve("appium-webdriveragent/package.json", { paths: [driverRoot] }));
  return path.join(wdaRoot, "WebDriverAgent.xcodeproj");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const selected = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(selected));
    });
    server.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
