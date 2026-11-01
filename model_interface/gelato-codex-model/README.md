# Gelato Codex Model

An independent Codex plugin that serves as a `gelato.model.v1` model endpoint.
It is **not** a Controller: it has no device pool, pairing flow, device key, or
direct device transport. A Gelato Controller connects to this process over a
bearer-authenticated WebSocket and sends device inputs. Codex may propose
device actions, but the Controller routes them through its current device
session and capability checks, and the device decides whether to execute them.

## Run

Requires Node.js 22.12+ and an authenticated Codex CLI with `app-server`
support. From the StreamingGelato repository root:

```sh
npm ci
npm run build --workspace @gelato/codex-model-plugin
GELATO_MODEL_TOKEN='<random secret of at least 24 characters>' \
  node model_interface/gelato-codex-model/dist/index.mjs serve
```

The endpoint is `ws://127.0.0.1:19081/model` by default. It binds only to
loopback. For a remote Controller, use a trusted TLS reverse proxy and configure
the Controller with `GELATO_MODEL_PROVIDER=ws`, `GELATO_MODEL_SESSION_URL`, and
`GELATO_MODEL_API_KEY` set to this endpoint and the same secret. Do not reuse
pairing keys. The plugin may also be loaded in Codex, where `model_start`,
`model_status`, and `model_stop` manage this endpoint inside the plugin process.
These tools do not control devices.

Optional variables: `GELATO_MODEL_HOST` (loopback only), `GELATO_MODEL_PORT`,
`GELATO_CODEX_BIN`, `GELATO_CODEX_MODEL` (default `gpt-6-sol`),
`GELATO_CODEX_REASONING_EFFORT` (`none`, `low`, `medium`, `high`; default `low`,
subject to model support), and
`GELATO_CODEX_SERVICE_TIER` (`auto`, `default`, `fast`, `ultrafast`; omitted by
default, so Codex uses its own configured tier), and
`GELATO_CODEX_SANDBOX` (`workspace-write` by default, or explicitly
`danger-full-access`). Codex uses the host's login and provider configuration.
For production, run this process with a dedicated, minimally privileged OS
identity and put TLS, rate limits, and service supervision at the deployment
boundary. The process is not a substitute for host isolation.

## Turn flow

`session.open → session.ready → input.begin/append/commit → Codex turn`.
Each Gelato device session owns one long-running Codex app-server process and
thread. Later input turns reuse that process and thread until the Gelato session
closes; a new Gelato session starts a fresh thread. The process is prewarmed
after `session.open`, and the first turn waits for it if necessary. Within a
turn, Codex can invoke a turn-scoped native MCP tool; the plugin sends
`action.propose` and waits for `action.result`. The tool uses an authenticated
local socket and checks the current turn ID, but does not require the Codex
worker to have host-wide access.
It returns `reply.complete` and
`turn.end` only after the turn finishes. Action results may be `rejected`,
`completed`, `failed`, or `unknown`; a lost response is not proof that an action
did not happen. Device media is untrusted model input. The service emits
content-free `thread_ready` and `turn_metrics` events on stderr, including
turn duration and accumulated device-action time, for latency diagnosis.

The protocol is documented at [`../protocol.md`](../protocol.md). This package
deliberately contains no device SDK or Controller implementation. It is one
model runtime under `model_interface/`, alongside the Qwen Live Harness adapter.
