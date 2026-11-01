# Gelato v1 model session interface

[简体中文](protocol.zh-CN.md)

This optional Controller-to-model-runtime boundary is identified as `gelato.model.v1`. It does not add a third participant to the device protocol: devices connect only to the Controller. The model never receives pairing credentials or connects directly to a device. A Controller without model inference can still implement device-side `gelato.v1` fully.

**MUST**, **MUST NOT**, **SHOULD**, and **MAY** have the meanings used by the [device specification](../docs/protocol.md). A model runtime may be in-process or separate; the event semantics are provider-independent. An in-process implementation MUST preserve the same session, correlation, and authority boundaries.

## 1. Connection and session

The standard separate-process transport is TLS-protected WebSocket; loopback development may use unencrypted WebSocket. The Controller initiates the connection using `Authorization: Bearer <service-token>` in the upgrade request; failed authentication MUST reject the upgrade. It MUST NOT reuse device-pairing credentials or put a key in the URL. The runtime MUST bound message size and concurrent sessions. Both sides MUST accept only JSON text messages matching the [event schema](schemas/model-event.schema.json); each JSON message is at most 1 MiB. One WebSocket connection carries one model session; v1 media uses chunked `input.append` messages, not unlabelled binary frames.

The Controller sends `session.open` with an opaque `sessionId`, `deviceId`, and optional `model`; the runtime replies with `session.ready` and its actual `capabilities` before accepting input. The Controller MUST NOT send an undeclared input modality; it must reject an action proposal from a runtime that did not declare `action-proposal`. A device may have multiple sessions, but the Controller SHOULD isolate contexts by user conversation rather than merge different users solely by `deviceId`. Normal termination sends `session.close`. On disconnection, unfinished turns become **unknown**. Reconnection opens a new session or uses a separately negotiated state-restoration mechanism. It MUST NOT assume the old session survived or replay input that may have caused side effects.

Each event carries `protocol`, `type`, `eventId`, `sessionId`, a monotonically increasing `seq`, `sentAt`, and an object `body`. `eventId` supports deduplication; `seq` starts at 1 independently in each direction. Process events in transport order and never execute a duplicate `eventId` twice. `turnId` is unique within a session and correlates one input, output, cancellation, and action proposals.

Normal path: `session.open → session.ready → input.begin → input.append* → input.commit → reply.delta* → reply.complete → turn.end`. Subsequent turns reuse the connection; neither device re-pairing nor a new model session is required.

## 2. Input and streaming reply

| Direction | Event | Meaning |
| --- | --- | --- |
| Controller → model | `input.begin` | Begin `turnId` with `kind` (`instruction` or `observation`) and optional device-side `sourceMessageId` |
| Controller → model | `input.append` | Append ordered text or a media chunk with MIME type, index, and base64 bytes; at most 256 KiB decoded per chunk |
| Controller → model | `input.commit` | Finish the turn's input; only then may the model treat it as complete |
| Model → Controller | `reply.delta` | Incremental text for streaming presentation, not a final answer |
| Model → Controller | `reply.complete` | Authoritative final text, possibly empty when there is no user-facing reply |
| Either direction | `turn.cancel` | Best-effort generation cancellation; cannot undo an action |
| Model → Controller | `turn.end` | Exactly one terminal state per turn: `completed`, `cancelled`, or `failed` |

A text `input.append` carries `text`. A media append carries `mimeType`, `chunkIndex`, `dataBase64`, and `final: true` on its last chunk. Each media part starts at `chunkIndex: 0`; only after `final: true` may the next media part restart at zero. Chunk indexes MUST be contiguous and MIME types truthful. The model MUST NOT interpret partial chunks as a complete image or audio recording. The Controller SHOULD forward live audio in small chunks with backpressure; completed device-side streams may also be converted to one or more model input chunks. `reply.complete` is the final turn content and may be mapped to device-side `reply.deliver`. Device-side v1 does not yet support incremental `reply.deliver`, so `reply.delta` does not imply device presentation.

## 3. Action proposals and authority

The model may send `action.propose` with `turnId`, unique `proposalId`, an advertised device `capability`, and `args`. This is only a proposal. The Controller MUST check the current device session, capability snapshot, local owner consent, and its own policy before deciding whether to issue device-side `command.request`. It reports `rejected`, `accepted`, `completed`, `failed`, or `unknown` using `action.result`, including `commandId` when a device command was created. Only a confirmed terminal device result permits `completed`; a network loss or timeout is not proof of failure and cannot authorize blind retry of a side-effecting command. The model MUST NOT hold pairing credentials or acquire execution authority from `reply.complete`, prompts, or media.

A runtime without action proposal support may implement only input, replies, and cancellation. Model text, visual observations, and third-party content remain untrusted data and cannot replace user authorization.

## 4. Errors and scope

The runtime may send `session.error` with a stable code, retryability, and a short credential-free description. A failed turn must also end with `turn.end: failed`. The Controller MUST NOT forward model keys, raw upstream errors, or other devices' context to a device.

This interface specifies sessions and events, not model selection, prompting, memory policy, or an App-control catalog. Each model adapter implements only its explicitly declared subset; it must not claim unsupported live media, recovery, or action proposals.
