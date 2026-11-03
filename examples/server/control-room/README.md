# Control room

From the repository root:

```sh
npm ci
npm run build
npm start
npm run token
```

Open `http://127.0.0.1:8090` and unlock the console with the token.

| Variable | Purpose |
| --- | --- |
| `HOST`, `PORT` | Listener; defaults to `127.0.0.1:8090` |
| `GALATEA_STATE_DIR` | Private persistent state directory |
| `CONTROLLER_API_TOKEN_FILE` | Existing private operator-token file; otherwise generated locally |
| `PUBLIC_CONTROLLER_URL` | Public HTTPS root origin for device links |
| `CONTROLLER_TRANSPORT` | `local`, `loopback-proxy` or `direct` |
| `TLS_KEY`, `TLS_CERT` | Direct TLS private key and certificate chain |
| `TINODE_WS_URL`, `TINODE_API_KEY` | Account provider for native-app login |
| `GALATEA_HARNESS_GRANTS_FILE` | Optional user/device-scoped host API grants |
| `GELATO_PAIRING_STORE`, `GELATO_STREAM_DIR` | Pairing store and media directory |
| `GELATO_MODEL_PROVIDER` | Optional `streamingtelligence`, `qwen-live-harness`, `codex`, generic `ws`, or `http`; unset disables the model unless an HTTP URL is given |
| `STREAMINGTELLIGENCE_API_KEY`, `STREAMINGTELLIGENCE_MODEL` | Private service key and optional model ID (default `kairos-v2`) for the native streaming mux |
| `DASHSCOPE_API_KEY` | Required only for the Qwen Live Harness mode; keep it outside the repository |
| `QWEN_LIVE_ENDPOINT`, `QWEN_LIVE_MODEL`, `QWEN_LIVE_VOICE` | Optional Qwen provider origin, model, and supported voice override |
| `GELATO_MODEL_SESSION_URL` | `gelato.model.v1` WSS runtime URL for `codex` or generic `ws` mode (loopback WS for development) |
| `GELATO_MODEL_ENDPOINT_URL` | HTTPS (or loopback HTTP) URL for the simple `http` mode |
| `GELATO_MODEL_API_KEY`, `GELATO_MODEL_ID` | Service bearer token for `codex`/`ws` mode; optional bearer key and model ID for `http` mode |

For a persistent Qwen Live model session, set `GELATO_MODEL_PROVIDER=qwen-live-harness`
and a private `DASHSCOPE_API_KEY`, then start the Controller normally. This mode
reuses the Qwen Live Harness 1.0.0 realtime client and maintains a separate
conversation per device for up to 20 minutes of inactivity. It uses the
headless Node runtime, not the macOS Host. Upstream does not publish this
realtime module as a stable package export, so the adapter in
[`model_interface/`](../../../model_interface/README.md) pins the exact version
and fails closed if its shape changes. This is an example integration,
not a production compatibility promise. Ordinary device instructions still
accept text or completed 16 kHz mono PCM16 audio (`audio/pcm`) and return one
final text reply. For the native Rokid example, an owner-authorized live
16 kHz microphone stream and 1 fps JPEG camera stream feed the same per-device
Omni session. Qwen's 24 kHz PCM16 speech response is sent through an
authenticated Controller-to-device audio stream with a text transcript in
`reply.deliver`; the glasses play it locally. The model receives no device
credentials and is configured with no callable tools. Other devices do not
automatically acquire this live-media behavior.

The separate `http` mode remains a small one-shot example, not a
`gelato.model.v1` model session. Its endpoint receives `POST` JSON containing
`{"protocol":"gelato.v1","model":"...","input":{"deviceId":"...","messageId":"...","parts":[...]}}`.
Text parts contain `text`; media parts contain `mimeType` and `dataBase64`.
It returns `{"text":"..."}`. The server sends that text as `reply.deliver`;
it never treats model output as a control command. An authenticated operator
may also send a reply through `POST /api/devices/:deviceId/replies` with
`{"text":"...","inReplyTo":"msg_..."}`. Model keys belong in private
environment configuration, not in the repository.

The provider-neutral Controller-to-model contract is defined in the
[Gelato model session interface](../../../model_interface/protocol.md). The
`codex` and generic `ws` modes use its WebSocket client, with one persistent session per
device. Valid model action proposals pass through the current device capability
and consent checks, then the device command service. The device keeps final
execution authority; paused control, offline devices, and unadvertised
capabilities are rejected. A fresh screen preview can satisfy `screen.capture`
without a redundant capture command. The in-process Qwen example observes the same session and authority
boundaries but does not claim to implement every optional event or a remote
WebSocket model server.

The independent [Codex model plugin](../../../model_interface/gelato-codex-model/README.md)
is one `gelato.model.v1` runtime. Start it separately, then select
`GELATO_MODEL_PROVIDER=codex` with its WSS URL and matching service token.
The Controller does not run Codex or hold its login. Codex can propose device
actions, but it cannot bypass the Controller or the device's execution decision.

The console includes pairing, phone/glasses commands, H.264 and JPEG screen streams, App tasks,
packet overlays, TCP/mDNS forwarding and WDA/system-pairing controls.
When an iPhone or Android phone has started system-approved screen sharing, authenticated
`GET /api/devices/:deviceId/screen/latest` returns the most recent JPEG (or
`503` when no frame arrived in the last three seconds). It does not issue a
`screen.capture` command. The iOS 27 app and Android phone app send approximately
one preview frame per second; those transient previews are not recorded to the stream directory.
The existing `/api/devices/:deviceId/screenshot` route also serves that fresh
frame first, so existing screenshot clients benefit without a client change;
`?forceCapture=1` requests an on-demand capture. If sharing is not active, the
route falls back to the on-demand capture path.
The bundled Qwen Live endpoint still has no GUI-control tools, so a model-driven
control loop must explicitly consume this endpoint and supply its own actions.
It combines the independent server SDKs; the full controller and account adapter
live in this example's `src/`, not in the shared core.
Native device apps enforce owner consent and account ownership independently.

`scripts/` contains manual lifecycle, certificate publishing and App-task CLIs.
Private keys, tokens and deployment configuration belong outside the repository.
