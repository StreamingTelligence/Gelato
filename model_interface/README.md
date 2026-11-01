# Gelato model interface

[简体中文](README.zh-CN.md) · [Model session specification](protocol.md) · [Event schema](schemas/model-event.schema.json)

`gelato.model.v1` is the optional boundary between a Gelato Controller and a model runtime. It is separate from the device-facing `gelato.v1` protocol. Devices never connect to a model runtime or receive its service token. A model can return content or propose an action; the Controller and the device remain responsible for routing, capability checks, consent, and execution.

This directory owns the model protocol, provider-neutral TypeScript interfaces, and model adapters. The Controller example imports `createModelConnection` from `@gelato/model-interface`; it contains no Qwen or Codex runtime implementation.

| Runtime | Location | Integration | Declared scope |
| --- | --- | --- | --- |
| Qwen Live Harness | [`src/qwenLiveEndpoint.ts`](src/qwenLiveEndpoint.ts) | In-process adapter using a pinned `qwen-live-harness` version | Text/PCM audio turns, live Rokid audio and 1 fps JPEG input, audio reply; no device-action proposals |
| Codex | [`gelato-codex-model/`](gelato-codex-model/) | Independent `gelato.model.v1` WebSocket runtime, driven by Codex app-server | Text/image turns and device-action proposals; no audio or continuous 1 fps ingestion |

`src/modelSessionEndpoint.ts` is the provider-neutral Controller-side WebSocket client. A different conforming model runtime can use the same client. `src/httpEndpoint.ts` preserves a one-shot HTTP example, but it is **not** a `gelato.model.v1` session implementation.

## Connect the Controller example

Build from the repository root with `npm ci && npm run build`. Choose one provider:

- Qwen: set `GELATO_MODEL_PROVIDER=qwen-live-harness` and `DASHSCOPE_API_KEY`; optionally set `QWEN_LIVE_ENDPOINT`, `QWEN_LIVE_MODEL`, and `QWEN_LIVE_VOICE`.
- Codex: start the [Codex model runtime](gelato-codex-model/README.md), then set `GELATO_MODEL_PROVIDER=codex`, `GELATO_MODEL_SESSION_URL`, and `GELATO_MODEL_API_KEY` on the Controller. The token must match the runtime's `GELATO_MODEL_TOKEN`. The generic `ws` provider has the same wire behavior.

Use WSS between hosts; plain WS is allowed only on loopback. The Codex plugin does not start itself when the Controller starts. Keep model service credentials distinct from device pairing credentials. Provider configuration and deployment remain local; no test endpoint or secret is stored here.
