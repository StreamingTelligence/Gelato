# Gelato 模型端接口

[English](README.md) · [模型会话规范](protocol.zh-CN.md) · [事件 Schema](schemas/model-event.schema.json)

`gelato.model.v1` 是 Gelato Controller 与模型运行时之间的可选接口，与设备侧 `gelato.v1` 分开。设备不直接连接模型端，也不会收到模型端的服务令牌。模型可以返回内容或提出操作，但命令路由、能力检查、用户授权及实际执行仍由 Controller 和设备端负责。

本目录集中管理模型会话协议、与厂商无关的 TypeScript 接口和模型适配器。Controller 示例只从 `@gelato/model-interface` 导入 `createModelConnection`，不包含 Qwen 或 Codex 的实现代码。

| 模型端 | 位置 | 接入方式 | 当前能力边界 |
| --- | --- | --- | --- |
| Qwen Live Harness | [`src/qwenLiveEndpoint.ts`](src/qwenLiveEndpoint.ts) | 固定版本的进程内适配器 | 文字／PCM 音频回合、Rokid 实时音频及每秒一帧 JPEG 输入、音频回复；不提议设备操作 |
| Codex | [`gelato-codex-model/`](gelato-codex-model/) | 独立的 `gelato.model.v1` WebSocket 运行时，内部使用 Codex app-server | 文字／图像回合和设备操作提议；尚不接收音频或持续每秒一帧的输入 |

`src/modelSessionEndpoint.ts` 是不绑定厂商的 Controller 侧 WebSocket 客户端，其他符合规范的模型运行时也可复用。`src/httpEndpoint.ts` 保留了一次性 HTTP 示例，但它**不是** `gelato.model.v1` 持续会话实现。

## 接入 Controller 示例

在仓库根目录运行 `npm ci && npm run build`，然后选择一种模型端：

- Qwen：设置 `GELATO_MODEL_PROVIDER=qwen-live-harness` 和 `DASHSCOPE_API_KEY`；可选设置 `QWEN_LIVE_ENDPOINT`、`QWEN_LIVE_MODEL`、`QWEN_LIVE_VOICE`。
- Codex：先启动 [Codex 模型端](gelato-codex-model/README.md)，再在 Controller 设置 `GELATO_MODEL_PROVIDER=codex`、`GELATO_MODEL_SESSION_URL` 和 `GELATO_MODEL_API_KEY`。令牌须与模型端的 `GELATO_MODEL_TOKEN` 一致。通用 `ws` 选项使用同一线协议。

跨主机连接必须使用 WSS；未加密 WS 仅可用于回环地址。Controller 启动时不会自动启动 Codex 插件。模型端令牌不可与设备配对凭据复用。本仓库不存放测试地址或密钥。
