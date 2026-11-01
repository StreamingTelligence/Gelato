# Gelato v1 protocol specification

[简体中文](protocol.zh-CN.md)

Gelato is a device-to-server protocol. Its wire identifier is `gelato.v1`. The protocol defines lifecycle and message contracts.

This document is the normative entry point for v1. Message bodies are constrained by the linked [JSON schemas](../device-sdk/schemas/). Read [architecture](architecture.md) for roles and [Implement a device](implementing-a-device.md) for an implementation path. The capitalized terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** indicate protocol requirements or options.

## 1. Required device behavior

A Gelato v1 device implementation MUST:

1. Offer local, offline-capable pre-pairing guidance and request required platform permissions only through explicit user actions. It MUST NOT start first pairing while a required step is incomplete.
2. Pair with a one-use code, retain the issued wire identifiers and credential, and authenticate later sessions with that credential.
3. Initiate and maintain its control connection. Disabling the connection locally MUST close it without deleting the pairing; re-enabling it reconnects with the saved credential.
4. Send a fresh `device.snapshot` after authentication, advertise `device.describe@1`, and report local control consent as `hardware.controlAllowed`. A missing value means false.
5. Support `input.publish` for device-originated text instructions and observations. Media parts reference completed typed streams, not inline binary data.
6. Accept `reply.deliver` as content for the user, never as an executable command, and send `reply.ack` after local receipt.
7. Execute only currently advertised `command.request` capabilities, return one terminal `command.result` or `command.error`, and handle `command.cancel` on a best-effort basis. It MAY report `command.progress`.

Pairing, connection enablement, and control consent are independent states. With consent off, the pairing stays valid and the device may stay online, but it rejects commands other than `device.describe` and stops control media. A locally disabled connection prevents new replies and commands until it is re-enabled.

## 2. Before first pairing

Prerequisite checks are a **device-local** contract, not a server message. A device implementation MUST list the conditions needed for first pairing and control capabilities. Each item has a stable `id`, user-facing `title` and `detail`, `phase`, `required`, `check`, and `done`; a local `action`/`button` MAY guide recovery. `check.state` is `passed`, `failed`, `checking`, or `unknown`; `check.basis` records a system value, functional probe, inference, or no evidence. Only an evidenced `passed` can set `done: true`. An unobservable condition MUST be `unknown` with `done: false`; neither a user assertion nor static configuration proves it. `unknown` and `checking` MUST NOT block progress. Only a confirmed `failed` condition with `required: true` blocks the operation for its current phase. See the [prerequisite schema](../device-sdk/schemas/preflight.schema.json).

Check `before-pairing` conditions before first pairing. Conditions that depend on a connection or pairing belong in `before-control` and continue to be checked when the corresponding control capability is attempted. `unknown` does not prevent an attempt; a real execution failure is still reported as a command error. It merely cannot be claimed as a satisfied prerequisite. Results can change with permissions, connectivity, and device state. Device-specific driver dependencies are declared by that device implementation, not the base protocol. An unverifiable remote condition remains `unknown`, never implicitly complete.

The local flow is `unconfigured → preflight → pairing → paired → connected`, with a separate `before-control` check for control capabilities. A pairing link may stage a service origin and one-use code, but MUST NOT silently grant permission or start first pairing. The owner explicitly confirms pairing. A confirmed failed required permission stays visible with recovery guidance; the user can retry without resetting completed work.

The local surface depends on the device: a phone can request system permissions in its app; a headless board can expose a temporary, locally authenticated setup page. Control consent defaults off and remains separate from first pairing.

## 3. Connection and session

The device side opens `wss://<controller>/agent/control`. Loopback development MAY use `ws://`. Its first control message is one of:

| First message | When | Essential body data |
| --- | --- | --- |
| `pairing.request` | First pairing | One-use `pairingCode` and device connection descriptor |
| `session.hello` | Later connection | Saved `agentId`, credential, and device connection descriptor |

The Controller responds with `pairing.accepted` or `session.accepted`, or an explicit rejection. Accepted first pairing returns `agentId`, `deviceId`, and a credential. Here `agentId` is the existing wire name for the paired device-side installation, while `deviceId` identifies its entry in the Controller's device pool; neither implies a third protocol participant. The same naming persists in `/agent/...` routes and the [descriptor schema](../device-sdk/schemas/agent-descriptor.schema.json). The credential MUST NOT be placed in a URL. A reconnect authenticates anew and sends a fresh snapshot; it cannot assume that the previous connection's state survived. Revocation invalidates the credential.

The Controller requests a fresh snapshot after authentication. The device side renews its lease every 10 seconds; a lease older than 35 seconds is stale. An implementation should treat transport loss as a reason to reconnect, not as a reason to silently change local consent.

Every control envelope has `protocol`, `type`, `messageId`, `sentAt`, and object `body`. Authenticated device messages carry `deviceId`; command messages carry `commandId`. See the [envelope schema](../device-sdk/schemas/envelope.schema.json). A representative envelope is:

```json
{
  "protocol": "gelato.v1",
  "type": "input.publish",
  "messageId": "msg_exampleABCDEF",
  "deviceId": "dev_exampleABCDEF",
  "sentAt": "2026-01-01T00:00:00Z",
  "body": {"kind": "instruction", "parts": [{"type": "text", "text": "Describe what you see"}]}
}
```

## 4. Device state and capabilities

`device.snapshot` contains a `revision` that increases within the accepted session, a device `kind` and `displayName`, OS information, capability implementation location/state, hardware state, and a list of versioned capabilities. A reconnect starts a new snapshot sequence. The [snapshot schema](../device-sdk/schemas/snapshot.schema.json) is authoritative. The existing `driver.location` wire field distinguishes implementation on the device, in a companion, or in a Controller sidecar; it does not require a separate driver process or change the wire contract.

Every device advertises `device.describe@1`. Other capabilities are optional and must reflect hardware and permission readiness. The current snapshot, not the device kind alone, determines which commands may be routed. `hardware.controlAllowed` is local owner consent, not a server-side grant.

## 5. Input and reply

`input.publish` travels from device to Controller. Its body has `kind: "instruction"` or `kind: "observation"` and one to eight ordered `parts`. A part is text or a reference to a **completed** media stream:

```json
{"kind":"instruction","parts":[{"type":"text","text":"Hello"}]}
```

```json
{"kind":"observation","parts":[{"type":"media","streamId":"str_exampleABCDEF","mimeType":"image/jpeg"}]}
```

`reply.deliver` travels from Controller to device. Its body contains nonempty `text` and may include `inReplyTo`, the ID of an earlier input message. The device responds with `reply.ack`, setting `body.replyMessageId` to the delivered message ID. An acknowledgement proves local receipt, **not** that the user read, heard, or saw the reply. A reply does not authorize a hardware action. See the [input](../device-sdk/schemas/input.schema.json) and [reply](../device-sdk/schemas/reply.schema.json) schemas.

An audio-capable device MAY receive an optional `audio` descriptor on `reply.deliver`: `streamId`, `mimeType: "audio/pcm"`, `sampleRateHz: 24000`, `channels: 1`, `sizeBytes`, and `sha256`. The Controller first offers a `controller-to-agent` audio stream; the device downloads its content from `/agent/streams/:streamId/content` using its own credential and verifies size and SHA-256 before playback. The required text remains available to devices without audio playback. `reply.ack` still confirms receipt of the control message only, not successful download or audible playback; a device MAY report media failure separately. Audio presentation is not a device command.

## 6. Commands

The Controller sends `command.request` only for a capability and version in the current snapshot. A request includes arguments, an absolute deadline, and an idempotency classification (`read-only`, `idempotent`, or `side-effecting`). The [command schema](../device-sdk/schemas/command.schema.json) defines its body.

The device side checks the advertised capability and local consent before executing the command through its local implementation. It may send progress, then sends exactly one terminal result or error. A result may reference a completed media stream. Cancellation is best-effort and cannot undo an action already performed. A retry uses the same command ID and arguments; reusing an ID with different arguments is an error. If execution was interrupted and the outcome is unknown, the caller inspects device state before starting a replacement side-effecting action.

The base protocol does not define a catalog of App actions. A driver may advertise hardware- or vendor-specific capabilities without making them requirements for other devices.

## 7. Streams and observations

Media is not embedded in control JSON. The device side uploads using `/agent/streams/live` or a negotiated `/agent/streams/:streamId` after `stream.offer` and `stream.accept`. An offer declares purpose, direction, content type, and frame/total byte limits. Each binary message begins with a four-byte big-endian sequence number. `stream.end` declares total byte count and SHA-256; the stream completes only after both verify. See the [stream-offer schema](../device-sdk/schemas/stream-offer.schema.json).

Complete JPEG or PNG images use `metadata.observationFraming = "image-per-message.v1"`. H.264 messages are coded chunks and require decoding. For timed frames, both sides MAY negotiate `metadata.frameTiming = "source-time.v1"`; a `stream.frame` timing message immediately precedes its binary frame. Source/capture time is distinct from Controller receipt and availability time. Consumers use immutable frame references, cursors, and process epochs so overruns and restarts are explicit gaps; each consumer owns its persistence and retention. See the [observation schema](../device-sdk/schemas/observation.schema.json).

A locally authorized device MAY push successive complete images on one stream without a command per frame. With `metadata.transient = true` and image-per-message framing, the Controller MAY forward each frame immediately without waiting for `stream.end`; that flag does not grant permission to persist the stream. A completed one-shot photograph remains a separate stream that can be referenced by a command result or `input.publish`.

## 8. Optional server integrations

Model inference, account login, and application workflows are Controller implementation choices, not required device capabilities. The separate [Gelato model session interface](../model_interface/protocol.md) is the interoperable Controller-to-runtime standard. An implementation claiming `gelato.model.v1` support MUST follow it; a stateless one-shot HTTP request cannot be presented as a persistent session. The model interface does not alter device-side `gelato.v1` messages or require a device to know the model provider.

The Controller MUST NOT treat model output or an action proposal as an implicit `command.request`. A command still requires an advertised capability, a valid session, and the device owner's local consent.
