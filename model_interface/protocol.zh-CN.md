# Gelato v1 模型会话接口

[English](protocol.md)

本接口规范 Controller 与模型运行时之间的可选边界，标识为 `gelato.model.v1`。它不是设备协议的第三个参与方：设备只连接 Controller，模型看不到配对凭据，也不能直接连接设备。没有启用模型的 Controller 仍可完整实现设备侧 `gelato.v1`。

**MUST**、**MUST NOT**、**SHOULD**、**MAY** 的含义与[设备协议](../docs/protocol.zh-CN.md)一致。模型运行时可以是同进程模块，也可以是单独进程；下述事件语义不依赖模型厂商。同进程实现 **MUST** 保持相同的会话、关联与授权边界。

## 1. 连接与会话

独立进程的标准传输是经 TLS 保护的 WebSocket；同机回环可使用未加密 WebSocket。连接由 Controller 发起，在升级请求中使用 `Authorization: Bearer <service-token>` 鉴权；鉴权失败 **MUST** 拒绝升级。它 **MUST NOT** 复用设备配对凭据或把密钥放在 URL 中。模型运行时 **MUST** 限制消息大小及并发会话数。双方 **MUST** 仅接受符合[事件 Schema](schemas/model-event.schema.json)的 JSON 文本消息；单条 JSON 消息不超过 1 MiB。单个 WebSocket 连接承载一个模型会话；二进制媒体在 v1 中使用分块的 `input.append` 消息，不直接混入未标记的二进制帧。

Controller 发送 `session.open`，包含不透明 `sessionId`、`deviceId` 和可选的 `model`。模型返回 `session.ready` 及实际支持的 `capabilities` 后才能接收输入。Controller **MUST NOT** 发送未声明的输入模态；未声明 `action-proposal` 的模型发来的操作提议必须拒绝。一个设备可以有多个会话，但 Controller **SHOULD** 按用户会话隔离上下文，不能仅凭 `deviceId` 将不同用户的对话合并。正常结束发送 `session.close`。断线使未完成的回合变为 **unknown**；重连必须创建新模型会话或执行双方另行约定的状态恢复，**MUST NOT** 假设旧会话仍在或重放可能已触发副作用的输入。

每个事件都含 `protocol`、`type`、`eventId`、`sessionId`、单调递增的 `seq`、`sentAt` 和对象 `body`。`eventId` 用于去重；`seq` 对每个发送方向分别计数，从 1 开始。事件按传输顺序处理，重复的 `eventId` **MUST NOT** 再次执行。`turnId` 在一个会话内唯一，用于关联一轮输入、输出、取消和操作提议。

常规路径：`session.open → session.ready → input.begin → input.append* → input.commit → reply.delta* → reply.complete → turn.end`。同一连接可继续进行下一轮，不必重新配对设备或重建模型会话。

## 2. 输入与流式回复

| 方向 | 事件 | 语义 |
| --- | --- | --- |
| Controller → 模型 | `input.begin` | 开始 `turnId`，声明 `kind`（`instruction` 或 `observation`）和可选设备侧 `sourceMessageId` |
| Controller → 模型 | `input.append` | 追加有序文字，或带 MIME、序号及 base64 内容的媒体块；一个块解码后不超过 256 KiB |
| Controller → 模型 | `input.commit` | 本轮输入结束；模型才可将其视为完整输入 |
| 模型 → Controller | `reply.delta` | 增量文字，仅供流式呈现，尚非最终结果 |
| 模型 → Controller | `reply.complete` | 本轮最终文字；可为空，表示没有用户可见回复 |
| 双向 | `turn.cancel` | 尽力取消生成；不能撤销已经发生的操作 |
| 模型 → Controller | `turn.end` | 每轮恰好一次终态：`completed`、`cancelled` 或 `failed` |

`input.append` 的文字块直接包含 `text`。媒体块包含 `mimeType`、`chunkIndex`、`dataBase64`，最后一块标记 `final: true`；每个媒体部分从 `chunkIndex: 0` 开始，发出 `final: true` 后下一个媒体部分才可重新从 0 开始。发送方 **MUST** 保持块序号连续并声明实际 MIME 类型。模型 **MUST NOT** 将部分块当作完整图像或完整音频。Controller **SHOULD** 对实时音频按小块转发并执行背压；设备侧已完成的媒体流也可以转成一个或多个模型输入块。`reply.complete` 的文字是本轮权威最终内容；Controller 可将其映射为设备侧 `reply.deliver`。设备侧 v1 目前不支持增量 `reply.deliver`，所以 `reply.delta` 不意味着设备已经看到文字。

## 3. 操作提议与信任边界

模型可发送 `action.propose`，包含 `turnId`、唯一 `proposalId`、设备已声明的 `capability` 与 `args`。这只是提议。Controller **MUST** 检查当前设备会话、能力快照、本地所有者授权和自身策略，才可决定是否发送设备侧 `command.request`。Controller 用 `action.result` 回报 `rejected`、`accepted`、`completed`、`failed` 或 `unknown`，并在产生设备命令时附带 `commandId`。只有确认收到设备最终结果后才能报告 `completed`；网络中断或超时不能伪装成失败且自动重试有副作用的命令。模型 **MUST NOT** 持有设备配对凭据，亦不能通过 `reply.complete`、提示词或媒体内容获得执行权。

运行时不支持操作提议时，可以只实现输入、回复和取消；这不妨碍文字／多模态问答。模型生成的文字、图像识别结果和第三方内容均视作不可信数据，不得替代用户授权。

## 4. 错误与实现范围

模型可发送 `session.error`，其 `body` 只包含稳定错误码、是否可重试和不含凭据的简短说明。单轮失败还必须以 `turn.end: failed` 收束。Controller **MUST NOT** 将模型密钥、原始上游错误或其他设备的上下文回送到设备。

本规范定义会话与事件，而非模型选型、提示词、记忆策略或 App 控制目录。每种模型适配器只实现其声明支持的事件；不能把未实现的实时媒体、恢复或操作提议伪装成已支持。
