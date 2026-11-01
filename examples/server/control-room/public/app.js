let devices = [];
let selectedDeviceId = "";
let screenSocket = null;
let jmuxer = null;
let screenFrameUrl = null;
let pointerStart = null;
let capabilityBusy = false;
let pairingRequestPoll = null;

const els = {
  connectionState: document.getElementById("connectionState"),
  deviceList: document.getElementById("deviceList"),
  deviceTitle: document.getElementById("deviceTitle"),
  deviceMeta: document.getElementById("deviceMeta"),
  appState: document.getElementById("appState"),
  engineState: document.getElementById("engineState"),
  screenState: document.getElementById("screenState"),
  screenPane: document.querySelector(".screen-pane"),
  screenVideo: document.getElementById("screenVideo"),
  screenImage: document.getElementById("screenImage"),
  tapX: document.getElementById("tapX"),
  tapY: document.getElementById("tapY"),
  tapButton: document.getElementById("tapButton"),
  textInput: document.getElementById("textInput"),
  typeButton: document.getElementById("typeButton"),
  packageInput: document.getElementById("packageInput"),
  activityInput: document.getElementById("activityInput"),
  launchButton: document.getElementById("launchButton"),
  screenshotButton: document.getElementById("screenshotButton"),
  uiTreeButton: document.getElementById("uiTreeButton"),
  shellInput: document.getElementById("shellInput"),
  shellButton: document.getElementById("shellButton"),
  commandOutput: document.getElementById("commandOutput"),
  authDialog: document.getElementById("authDialog"),
  authForm: document.getElementById("authForm"),
  authToken: document.getElementById("authToken"),
  authError: document.getElementById("authError"),
  pairForm: document.getElementById("pairForm"),
  pairKind: document.getElementById("pairKind"),
  pairResult: document.getElementById("pairResult"),
  pairCode: document.getElementById("pairCode"),
  pairUrl: document.getElementById("pairUrl"),
  pairUrlLabel: document.getElementById("pairUrlLabel"),
  pairLink: document.getElementById("pairLink"),
  pairHint: document.getElementById("pairHint"),
  pairExpiry: document.getElementById("pairExpiry"),
  pairError: document.getElementById("pairError"),
  pairingRequests: document.getElementById("pairingRequests"),
  pairingRequestError: document.getElementById("pairingRequestError"),
  capabilityForm: document.getElementById("capabilityForm"),
  capabilitySelect: document.getElementById("capabilitySelect"),
  capabilityArgs: document.getElementById("capabilityArgs"),
  capabilitySend: document.getElementById("capabilitySend"),
  mediaLink: document.getElementById("mediaLink")
};

wireControls();
renderSelectedDevice();
start();

async function start() {
  if (await hasSession()) {
    connectConsole();
    startPairingRequestPoll();
    return;
  }
  els.authDialog.showModal();
}

async function hasSession() {
  const response = await fetch("/auth/status");
  return response.ok;
}

function connectConsole() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/console`);
  socket.addEventListener("open", () => {
    els.connectionState.textContent = "online";
    socket.send(JSON.stringify({ type: "requestSnapshot" }));
  });
  socket.addEventListener("close", () => {
    els.connectionState.textContent = "reconnecting";
    setTimeout(connectConsole, 1000);
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "snapshot") {
      devices = message.devices;
      if (!selectedDeviceId && devices.length) selectedDeviceId = devices[0].deviceId;
      renderDevices();
      renderSelectedDevice();
    }
  });
}

function startPairingRequestPoll() {
  if (pairingRequestPoll) return;
  void loadPairingRequests();
  pairingRequestPoll = setInterval(() => void loadPairingRequests(), 3000);
}

async function loadPairingRequests() {
  try {
    const response = await fetch("/api/pairing-requests", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load pairing requests");
    const { requests } = await response.json();
    els.pairingRequests.replaceChildren();
    for (const item of requests) {
      const card = document.createElement("div");
      card.className = "pairing-request-card";
      const name = document.createElement("strong");
      name.textContent = item.displayName;
      const meta = document.createElement("small");
      meta.textContent = `${item.agentKind} · ${item.id.slice(-6)} · expires ${new Date(item.expiresAt).toLocaleTimeString()}`;
      const actions = document.createElement("div");
      actions.className = "pairing-request-actions";
      for (const [action, label] of [["approve", "Approve"], ["deny", "Deny"]]) {
        const button = document.createElement("button");
        button.textContent = label;
        button.addEventListener("click", async () => {
          actions.querySelectorAll("button").forEach((control) => { control.disabled = true; });
          try {
            const result = await fetch(`/api/pairing-requests/${encodeURIComponent(item.id)}/${action}`, { method: "POST" });
            if (!result.ok) throw new Error(`${label} failed`);
            await loadPairingRequests();
          } catch (error) {
            els.pairingRequestError.textContent = error.message;
            actions.querySelectorAll("button").forEach((control) => { control.disabled = false; });
          }
        });
        actions.append(button);
      }
      card.append(name, meta, actions);
      els.pairingRequests.append(card);
    }
    els.pairingRequestError.textContent = "";
  } catch (error) {
    els.pairingRequestError.textContent = error.message;
  }
}

function wireControls() {
  els.pairForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = els.pairForm.querySelector("button");
    button.disabled = true;
    els.pairError.textContent = "";
    els.pairResult.hidden = true;
    try {
      const response = await fetch("/api/pairing-sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentKind: els.pairKind.value })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Pairing could not be created");
      els.pairCode.textContent = data.session.code;
      els.pairUrl.value = data.session.setupUrl;
      els.pairLink.href = data.session.setupUrl;
      const headless = ["esp32s3-xiao-camera", "rokid-bolon-native"].includes(els.pairKind.value);
      els.pairLink.hidden = headless;
      els.pairUrlLabel.hidden = false;
      els.pairHint.hidden = !headless;
      els.pairHint.textContent = els.pairKind.value === "rokid-bolon-native"
        ? "Connect the glasses by USB and run the Rokid native commissioning script on your computer. Paste this one-time link when prompted."
        : "Join the camera's temporary Wi-Fi, open http://192.168.4.1/, then enter this code there. USB is not used for pairing.";
      els.pairExpiry.textContent = "Expires " + new Date(data.session.expiresAt).toLocaleTimeString();
      els.pairResult.hidden = false;
    } catch (error) { els.pairError.textContent = error.message; }
    finally { button.disabled = false; }
  });
  els.capabilityForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const deviceId = selectedDeviceId;
    if (!deviceId || capabilityBusy) return;
    const option = els.capabilitySelect.selectedOptions[0];
    if (!option) return;
    capabilityBusy = true;
    els.capabilitySend.disabled = true;
    els.mediaLink.hidden = true;
    els.commandOutput.textContent = "running...";
    try {
      const args = JSON.parse(els.capabilityArgs.value);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be a JSON object");
      const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/commands`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: "cmd_" + crypto.randomUUID().replaceAll("-", ""),
          capability: option.value, capabilityVersion: Number(option.dataset.version), arguments: args, deadlineMs: 60_000 })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Command could not be completed");
      if (selectedDeviceId !== deviceId) return;
      els.commandOutput.textContent = JSON.stringify(data.command, null, 2);
      const streamId = data.command?.result?.stream?.streamId ?? data.command?.result?.streamId;
      if (typeof streamId === "string" && /^str_[A-Za-z0-9_-]+$/.test(streamId)) {
        els.mediaLink.href = `/api/streams/${encodeURIComponent(streamId)}/content`;
        els.mediaLink.hidden = false;
      }
    } catch (error) {
      if (selectedDeviceId === deviceId) els.commandOutput.textContent = error.message;
    } finally {
      capabilityBusy = false;
      els.capabilitySend.disabled = !selectedDevice()?.connection?.online || !els.capabilitySelect.value;
    }
  });
  els.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    els.authError.textContent = "";
    const response = await fetch("/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: els.authToken.value })
    });
    if (!response.ok) {
      els.authError.textContent = "Access denied";
      els.authToken.select();
      return;
    }
    els.authToken.value = "";
    els.authDialog.close();
    connectConsole();
    startPairingRequestPoll();
  });
  els.tapButton.addEventListener("click", () => command("tap", {
    x: Number(els.tapX.value),
    y: Number(els.tapY.value)
  }));
  els.typeButton.addEventListener("click", () => command("type", { text: els.textInput.value }));
  els.launchButton.addEventListener("click", () => command("launch", {
    packageName: els.packageInput.value,
    activity: els.activityInput.value
  }));
  els.shellButton.addEventListener("click", () => command("shell", { command: els.shellInput.value, timeoutMs: 30000 }));
  els.uiTreeButton.addEventListener("click", async () => {
    if (!selectedDeviceId) return;
    const response = await fetch(`/api/devices/${encodeURIComponent(selectedDeviceId)}/uitree`);
    els.commandOutput.textContent = await response.text();
  });
  els.screenshotButton.addEventListener("click", () => {
    if (!selectedDeviceId) return;
    window.open(`/api/devices/${encodeURIComponent(selectedDeviceId)}/screenshot`, "_blank");
  });
  els.screenPane.addEventListener("pointerdown", (event) => {
    const point = screenPoint(event);
    if (!point) return;
    pointerStart = point;
    els.screenPane.setPointerCapture(event.pointerId);
  });
  els.screenPane.addEventListener("pointerup", (event) => {
    const end = screenPoint(event);
    const start = pointerStart;
    pointerStart = null;
    if (!start || !end) return;
    els.tapX.value = String(end.x);
    els.tapY.value = String(end.y);
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    if (distance < 12) {
      command("tap", end);
    } else {
      command("swipe", {
        fromX: start.x,
        fromY: start.y,
        toX: end.x,
        toY: end.y,
        durationMs: 450
      });
    }
  });
}

function renderDevices() {
  els.deviceList.innerHTML = "";
  if (selectedDeviceId && !devices.some((device) => device.deviceId === selectedDeviceId)) {
    selectedDeviceId = devices[0]?.deviceId ?? "";
  }
  for (const device of devices) {
    const button = document.createElement("button");
    button.className = `device-card ${device.deviceId === selectedDeviceId ? "selected" : ""}`;
    const online = device.connection?.online ? "online" : "offline";
    button.innerHTML = `<strong>${escapeHtml(device.displayName)}</strong><small>${escapeHtml(online)} · ${escapeHtml(device.os?.family)} ${escapeHtml(device.os?.version)} · ${escapeHtml(device.driver?.state)}</small>`;
    button.addEventListener("click", () => {
      els.mediaLink.hidden = true;
      els.commandOutput.textContent = "";
      selectedDeviceId = device.deviceId;
      renderDevices();
      renderSelectedDevice();
      connectScreen();
    });
    els.deviceList.appendChild(button);
  }
}

function renderSelectedDevice() {
  const device = selectedDevice();
  const previous = els.capabilitySelect.value;
  els.capabilitySelect.replaceChildren();
  for (const capability of device?.capabilities ?? []) {
    const option = new Option(`${capability.name}@${capability.version}`, capability.name);
    option.dataset.version = String(capability.version);
    els.capabilitySelect.append(option);
  }
  if ([...els.capabilitySelect.options].some(option => option.value === previous)) els.capabilitySelect.value = previous;
  els.capabilitySelect.disabled = !device?.connection?.online || capabilityBusy;
  els.capabilitySend.disabled = !device?.connection?.online || !els.capabilitySelect.value || capabilityBusy;
  if (!device) {
    for (const control of [els.shellButton, els.shellInput, els.tapButton, els.typeButton,
      els.launchButton, els.screenshotButton, els.uiTreeButton]) control.disabled = true;
    els.deviceTitle.textContent = "No device selected";
    els.deviceMeta.textContent = "";
    els.appState.textContent = "App";
    els.engineState.textContent = "Engine";
    els.screenState.textContent = "Screen";
    return;
  }
  els.deviceTitle.textContent = device.displayName;
  els.deviceMeta.textContent = `${device.deviceId} · ${device.kind} · ${device.os?.family} ${device.os?.version} · ${transportBadge(device)}`;
  els.appState.textContent = device.connection?.online
    ? `CONNECTION ${String(device.connection.sessionState ?? "online").toUpperCase()}`
    : "CONNECTION OFFLINE";
  els.engineState.textContent = `DRIVER ${String(device.driver?.state ?? "unknown").toUpperCase()}`;
  els.screenState.textContent = device.hardware?.connected ? "HARDWARE CONNECTED" : "HARDWARE DISCONNECTED";
  els.packageInput.value = device.os?.family === "ios" ? "com.apple.Preferences" : "com.android.settings";
  const shellAvailable = hasCapability(device, "vendor.android.shell");
  els.shellButton.disabled = !shellAvailable;
  els.shellInput.disabled = !shellAvailable;
  els.tapButton.disabled = !hasCapability(device, "input.tap");
  els.typeButton.disabled = !hasCapability(device, "text.type");
  els.launchButton.disabled = !hasCapability(device, "app.launch");
  els.screenshotButton.disabled = !hasCapability(device, "screen.capture");
  els.uiTreeButton.disabled = !hasCapability(device, "ui.tree");
  connectScreen();
}

function connectScreen() {
  if (!selectedDeviceId) return;
  if (screenSocket) screenSocket.close();
  screenSocket = null;
  if (jmuxer) jmuxer.destroy();
  jmuxer = null;
  if (screenFrameUrl) URL.revokeObjectURL(screenFrameUrl);
  screenFrameUrl = null;
  els.screenImage.removeAttribute("src");
  els.screenImage.hidden = true;
  els.screenVideo.hidden = true;
  const device = selectedDevice();
  if (!device || !hasCapability(device, "screen.capture")) return;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  screenSocket = new WebSocket(`${scheme}://${location.host}/screen/${encodeURIComponent(selectedDeviceId)}`);
  screenSocket.binaryType = "arraybuffer";
  screenSocket.addEventListener("message", (event) => {
    const frame = new Uint8Array(event.data);
    if (frame[0] === 0xff && frame[1] === 0xd8) {
      if (jmuxer) jmuxer.destroy();
      jmuxer = null;
      els.screenVideo.hidden = true;
      els.screenImage.hidden = false;
      if (screenFrameUrl) URL.revokeObjectURL(screenFrameUrl);
      screenFrameUrl = URL.createObjectURL(new Blob([frame], { type: "image/jpeg" }));
      els.screenImage.src = screenFrameUrl;
      return;
    }
    if (!jmuxer) {
      els.screenImage.hidden = true;
      els.screenVideo.hidden = false;
      jmuxer = new window.JMuxer({
        node: "screenVideo", mode: "video", flushingTime: 33, fps: 30, debug: false
      });
    }
    jmuxer.feed({ video: frame });
  });
}

function screenPoint(event) {
  const device = selectedDevice();
  if (!device) return null;
  const media = els.screenImage.hidden ? els.screenVideo : els.screenImage;
  const sourceWidth = media === els.screenVideo ? media.videoWidth : media.naturalWidth;
  const sourceHeight = media === els.screenVideo ? media.videoHeight : media.naturalHeight;
  if (!sourceWidth || !sourceHeight) return null;
  const rect = media.getBoundingClientRect();
  const sourceAspect = sourceWidth / sourceHeight;
  const boxAspect = rect.width / rect.height;
  const contentWidth = boxAspect > sourceAspect ? rect.height * sourceAspect : rect.width;
  const contentHeight = boxAspect > sourceAspect ? rect.height : rect.width / sourceAspect;
  const left = rect.left + (rect.width - contentWidth) / 2;
  const top = rect.top + (rect.height - contentHeight) / 2;
  const relativeX = (event.clientX - left) / contentWidth;
  const relativeY = (event.clientY - top) / contentHeight;
  if (relativeX < 0 || relativeX > 1 || relativeY < 0 || relativeY > 1) return null;
  return {
    x: Math.round(relativeX * sourceWidth),
    y: Math.round(relativeY * sourceHeight)
  };
}

async function command(name, payload) {
  if (!selectedDeviceId) return;
  els.commandOutput.textContent = "running...";
  const response = await fetch(`/api/devices/${encodeURIComponent(selectedDeviceId)}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  try {
    els.commandOutput.textContent = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    els.commandOutput.textContent = text;
  }
}

function selectedDevice() {
  return devices.find((device) => device.deviceId === selectedDeviceId);
}

function hasCapability(device, name, version = 1) {
  return device?.capabilities?.some((capability) => capability.name === name && capability.version === version) ?? false;
}

function transportBadge(device) {
  if (!device?.connection?.online) return "offline";
  const transports = Object.entries(device?.connection?.transports ?? {})
    .filter(([, state]) => state?.online)
    .map(([name, state]) => `${name}:${state.networkClass ?? "unknown"}`);
  return transports.length ? transports.join("+") : "control-websocket";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
