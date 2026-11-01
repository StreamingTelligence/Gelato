# Gelato v1 协议规范

[English](protocol.md)

Gelato 是设备与服务端之间的协议，线上标识为 `gelato.v1`。协议规定生命周期和消息契约。

本文是 v1 的规范性入口。报文内容受对应 [JSON Schema](../device-sdk/schemas/) 约束。角色说明见[架构说明](architecture.zh-CN.md)，实现路径见[实现一个设备](implementing-a-device.zh-CN.md)。下文保留 **MUST**（必须）、**MUST NOT**（不得）、**SHOULD**（应该）、**MAY**（可以）这些规范术语，以区分协议要求与可选行为。

## 1. 设备必须实现的行为

Gelato v1 设备实现 **MUST**：

1. 提供无需联网也能展示的本地配对前引导，且仅通过用户明确的操作申请必要的平台权限。必要步骤未完成时，**MUST NOT** 开始首次配对。
2. 使用一次性码配对，保存签发的线上标识和凭据，并在后续会话中使用该凭据鉴权。
3. 主动建立并维持控制连接。用户在本地关闭连接时，**MUST** 断开连接但不删除配对；重新开启后用已保存的凭据连接。
4. 鉴权后发送新的 `device.snapshot`，声明 `device.describe@1`，并通过 `hardware.controlAllowed` 报告本地控制授权。缺少该值等同于 false。
5. 支持通过 `input.publish` 发送设备发起的文字指令和观察信息。媒体部分引用已完成的类型化流，而非在消息中内嵌二进制内容。
6. 将 `reply.deliver` 作为给用户的内容接收，绝不当作可执行命令；本地收到后发送 `reply.ack`。
7. 只执行当前已声明能力对应的 `command.request`，返回一个最终的 `command.result` 或 `command.error`，并尽力处理 `command.cancel`。设备 **MAY** 报告 `command.progress`。

配对、是否开启连接、是否允许控制是三个独立状态。关闭控制授权时，配对仍有效，设备也可以保持在线，但设备会拒绝 `device.describe` 以外的命令，并停止控制媒体。本地关闭连接后，重新开启前不会再收到新回复或命令。

## 2. 首次配对之前

前置条件检查是**设备本地**契约，不是服务端消息。设备端 **MUST** 按自身实现列出首次配对及控制能力所需的条件；每项包含稳定的 `id`、面向用户的 `title` 和 `detail`、`phase`、`required`、`check` 和 `done`，可提供本地 `action`／`button` 引导修复。`check.state` 为 `passed`、`failed`、`checking` 或 `unknown`；`check.basis` 记录系统状态、功能探测、推断或无依据。只有有依据的 `passed` 才能令 `done: true`。无法检测必须标为 `unknown`、`done: false`，不能把用户自述或静态配置当作验证。`unknown` 和 `checking` **不得**阻止流程；仅当前阶段 `required: true` 且确认 `failed` 的条件会阻止该阶段操作。参见[前置条件 Schema](../device-sdk/schemas/preflight.schema.json)。

`before-pairing` 条件在首次配对前检查；依赖已建立的连接或配对才能验证的条件放在 `before-control`，在尝试相应控制能力时继续检查。`unknown` 不妨碍尝试，真实执行失败仍按命令错误报告；它只是不能被声明为“条件已满足”。检查结果可随权限、连接及设备状态变化而更新。设备特定的驱动依赖由设备端实现声明，不塞进基础协议；如果远端条件暂不可验证，仍是 `unknown`，不能假装完成。

本地流程为 `unconfigured → preflight → pairing → paired → connected`，控制能力另有 `before-control` 检查。配对链接可以预填服务地址和一次性码，但 **MUST NOT** 静默授予权限或启动首次配对。由所有者明确确认配对操作。已确认失败的必要权限仍显示恢复指引；用户重试时不必重置已完成的步骤。

本地界面因设备而异：手机可在 App 中申请系统权限；无屏开发板可提供临时启用、需在本地认证的配置页面。控制授权默认关闭，并与首次配对分开处理。

## 3. 连接与会话

设备端连接 `wss://<controller>/agent/control`。本机回环开发环境 **MAY** 使用 `ws://`。第一条控制消息是以下之一：

| 第一条消息 | 使用时机 | 必要内容 |
| --- | --- | --- |
| `pairing.request` | 首次配对 | 一次性 `pairingCode` 和设备连接描述信息 |
| `session.hello` | 后续连接 | 已保存的 `agentId`、凭据和设备连接描述信息 |

Controller 回复 `pairing.accepted` 或 `session.accepted`，也可明确拒绝。首次配对被接受时返回 `agentId`、`deviceId` 和凭据。这里的 `agentId` 是当前线上报文对已配对设备端安装实例的命名，`deviceId` 则标识 Controller 设备池中的设备；它们不意味着协议还有第三类参与方。`/agent/...` 路径和[描述信息 Schema](../device-sdk/schemas/agent-descriptor.schema.json)沿用同一命名。凭据 **MUST NOT** 放在 URL 中。重连必须重新鉴权并发送新快照，不能假定上一次连接的状态仍然有效。撤销配对会使凭据失效。

鉴权后，Controller 请求新快照。设备端每 10 秒续租；超过 35 秒的租约视为过期。实现应把传输中断作为重连的理由，而不是静默改变本地控制授权。

每个控制报文都有 `protocol`、`type`、`messageId`、`sentAt` 和对象类型的 `body`。已鉴权的设备消息包含 `deviceId`；命令消息包含 `commandId`。参见[信封 Schema](../device-sdk/schemas/envelope.schema.json)。示例：

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

## 4. 设备状态与能力

`device.snapshot` 包含在当前已接受会话内递增的 `revision`、设备 `kind` 和 `displayName`、操作系统信息、本地能力实现的位置／状态、硬件状态，以及带版本号的能力列表。重连后开启新的快照序列。具体结构以[快照 Schema](../device-sdk/schemas/snapshot.schema.json)为准。现有 `driver.location` 线上字段区分能力实现在设备本体、伴侣设备或 Controller sidecar；它不要求另起一个驱动进程，也不改变线上契约。

每台设备都声明 `device.describe@1`。其他能力是可选的，且必须反映硬件和权限当前是否就绪。决定哪些命令可以路由的是当前快照，而不只是设备种类。`hardware.controlAllowed` 代表所有者在设备本地的授权，不是服务端单方面的许可。

## 5. 输入与回复

`input.publish` 从设备发往 Controller。其 `body` 的 `kind` 为 `"instruction"` 或 `"observation"`，包含一到八个有序 `parts`。每个部分是文字，或对**已完成**媒体流的引用：

```json
{"kind":"instruction","parts":[{"type":"text","text":"Hello"}]}
```

```json
{"kind":"observation","parts":[{"type":"media","streamId":"str_exampleABCDEF","mimeType":"image/jpeg"}]}
```

`reply.deliver` 从 Controller 发往设备。其 `body` 包含非空 `text`，也可以用 `inReplyTo` 指向先前输入消息的 ID。设备响应 `reply.ack`，并把 `body.replyMessageId` 设为所收到回复的消息 ID。确认只证明设备**本地收到**，不证明用户已经阅读、听到或看到回复。回复不授权硬件操作。参见[输入](../device-sdk/schemas/input.schema.json)与[回复](../device-sdk/schemas/reply.schema.json) Schema。

支持音频的设备 **MAY** 在 `reply.deliver` 收到可选 `audio` 描述：`streamId`、`mimeType: "audio/pcm"`、`sampleRateHz: 24000`、`channels: 1`、`sizeBytes` 和 `sha256`。Controller 先提供 `controller-to-agent` 音频流；设备用自身凭据从 `/agent/streams/:streamId/content` 下载，并在播放前核对长度和 SHA-256。必填的文字仍可供不支持播放的设备呈现。`reply.ack` 仍只代表控制消息已收到，不代表下载成功或用户听到了；设备 **MAY** 另外报告媒体错误。音频呈现不是设备命令。

## 6. 命令

Controller 只能针对当前快照中的能力及版本发送 `command.request`。请求包含参数、绝对截止时间，以及幂等性分类（`read-only`、`idempotent` 或 `side-effecting`）。其内容由[命令 Schema](../device-sdk/schemas/command.schema.json)定义。

设备端在通过本地实现执行命令前，检查能力是否已声明以及本地是否允许控制。它可以发送进度消息，然后必须且只能发送一个最终结果或错误。结果可以引用已完成的媒体流。取消是尽力而为，无法撤销已经发生的操作。重试使用相同的命令 ID 和参数；以同一 ID 搭配不同参数属于错误。如果执行中断且结果不明，调用方在发起替代性的、具有副作用的操作前应先检查设备状态。

基础协议不规定 App 操作目录。驱动可以声明硬件或厂商专属能力，但这些能力不会因此成为其他设备的必备要求。

## 7. 流与观察信息

媒体不嵌入控制 JSON。设备端在 `stream.offer` 和 `stream.accept` 之后，通过 `/agent/streams/live` 或协商后的 `/agent/streams/:streamId` 上传。offer 声明用途、方向、内容类型，以及单帧和总字节数限制。每条二进制消息以四字节大端序序号开头。`stream.end` 声明总字节数和 SHA-256；两项都校验通过后，流才算完成。参见[流提议 Schema](../device-sdk/schemas/stream-offer.schema.json)。

完整 JPEG 或 PNG 图像使用 `metadata.observationFraming = "image-per-message.v1"`。H.264 消息是编码片段，需要解码。对于带时间戳的帧，双方 **MAY** 协商 `metadata.frameTiming = "source-time.v1"`；`stream.frame` 时间消息紧邻其二进制帧之前发送。源端／采集时间与 Controller 接收、可用时间不同。消费者使用不可变的帧引用、游标和处理周期标识，让超限丢帧和重启形成明确的空缺；持久化与保留期限由各消费者自行负责。参见[观察信息 Schema](../device-sdk/schemas/observation.schema.json)。

设备在本地授权后 **MAY** 在同一个流上连续推送完整图像，不必每帧等待控制命令。若使用 `metadata.transient = true` 和逐消息成像标记，Controller **MAY** 不等 `stream.end` 就转发每帧；该标记不授予持久保存此流的权限。一次性拍照仍是独立的已完成流，可以由命令结果或 `input.publish` 引用。

## 8. 可选的服务端集成

模型推理、账号登录和应用工作流由 Controller 实现选择，不是设备必备能力。[Gelato 模型会话接口](../model_interface/protocol.zh-CN.md)是服务端与模型运行时之间可互通的标准；声称支持 `gelato.model.v1` 的实现 **MUST** 遵守该接口，不能把无状态的一次性 HTTP 问答冒充为持续会话。模型会话接口不改变设备侧 `gelato.v1` 报文，也不要求设备知道模型供应商。

Controller **MUST NOT** 将模型输出或控制提议隐式当作 `command.request`。执行命令仍需设备当前已声明的能力、有效会话和设备所有者的本地授权。
