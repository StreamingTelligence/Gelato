<p align="center">
  <img src="docs/assets/streamingtelligence-mark-clean.png" alt="" width="64" align="middle">
  <strong>StreamingTelligence Lab</strong>
</p>

# Gelato

Gelato 是 **StreamingTelligence Lab 的生态支撑项目**。Gelato名字源于希腊神话里被赐予生命的雕像Galatea，正如其名，我们的目标是把流式智能带到各种设备中，重塑人与设备的交互方式：让设备既成为流式智能感知世界的传感器，也成为它回应用户、与真实世界交互的环境。Gelato v1 是连接这些设备与控制端的统一协议；本仓库提供协议规范、SDK 和各设备的最小可行实现（MVP）。

[文档导航](docs/README.zh-CN.md) · [设备协议](docs/protocol.zh-CN.md) · [模型端接口](model_interface/README.zh-CN.md) · [快速开始](docs/getting-started.zh-CN.md) · [English](README.md)

## 演示视频

https://github.com/user-attachments/assets/5811c155-1fd8-4fdc-9f51-a381bf7f0e6c

观看 [Gelato 演示（1 分 46 秒，MP4）](docs/assets/gelato-demo-v7.mp4)：iPhone 无线控制、水壶提醒，以及通过 Rokid 眼镜提供实时辅助。

## 设计原则

- **无线交互。** 摆脱对调试线的依赖，让 Android、iOS 手机和其他设备通过网络完成配对与控制。Gelato 配对和控制不依赖物理连接。
- **最小侵入性。** 不限定设备形态，也不要求昂贵的端侧算力或特殊硬件。通过开放协议，哪怕只有摄像头和 Wi-Fi 的设备也能接入流式智能；设备只声明自己实际具备的能力。
- **开放性和隐私性。** 设备端 SDK、服务端 SDK 和每种已支持设备的 MVP 都应成为开源构件，让开发者能快速接入新设备。Gelato协议不绑定任何模型提供商（包括Streamingtelligence）。 Gelato协议尊重用户本地设备的隐私，且不需要将用户账号信息或者本地工作环境在云端克隆重建即可在本地工作。

详情见[架构说明](docs/architecture.zh-CN.md)。

## Gelato v1 由哪些部分组成

| 部分 | 契约 |
| --- | --- |
| 本地前置条件检查 | 配对和控制前的设备专属条件检查、权限申请与修复引导 |
| 配对与会话 | 一次性配对码、设备端和服务端首次配对、配对状态保持 |
| 连接与状态 | 设备端主动与服务端建立连接、在线状态与能力快照 |
| 输入与回复 | 设备向服务端发出指令／观察信息 `input.publish`，服务端内容回复 `reply.deliver`或对设备端的控制指令 `command.request`|

线上标识为 `gelato.v1`。报文规则见[协议规范](docs/protocol.zh-CN.md)，新硬件的最低实现要求见[实现一个设备](docs/implementing-a-device.zh-CN.md)。

## 已支持的模型端

模型推理是可选部分，与设备配对和控制分离。Controller 可通过 `gelato.model.v1` [模型会话规范](model_interface/protocol.zh-CN.md)连接模型运行时：设备输入可以送给模型，模型内容可以成为设备回复。`action.propose` 仅是操作提议，Controller 仍通过当前设备会话路由，最终执行权留在设备端；模型不会取得设备配对凭据。

[`model_interface/`](model_interface/README.zh-CN.md) 集中放置规范、Schema 和不绑定模型厂商的 Controller 侧适配器。[Controller MVP](examples/server/control-room/) 可以接入下面两种模型端：

| 模型端 | 接入方式与当前能力 | MVP 实现位置 |
| --- | --- | --- |
| Qwen Live Harness | 进程内适配器接入固定版本的 `qwen-live-harness`，支持文字／PCM 音频回合、Rokid 实时音频与每秒一帧 JPEG 输入，以及音频回复；不提议设备操作。 | [`qwenLiveEndpoint.ts`](model_interface/src/qwenLiveEndpoint.ts) |
| Codex | 独立的 `gelato.model.v1` WebSocket 模型端通过 Codex app-server 处理文字／图像回合和设备操作提议；尚不接收音频或持续每秒一帧的视频。 | [Codex 模型端插件](model_interface/gelato-codex-model/) |

配置方法及准确的模态边界见[模型端目录说明](model_interface/README.zh-CN.md)。另有一次性 HTTP 示例，但它不属于 `gelato.model.v1` 持续会话实现。

## 已支持的硬件与 MVP 位置

下表列的是**本仓库中的实现**，不代表每种硬件都支持所有操控能力。它们在线上共用 Gelato v1，驱动和首次授权流程各自适配。

| 硬件 | 能力 | MVP 代码 | 配置指南 |
| --- | --- | --- | --- |
| Android 手机（Android 8+；无线调试配对需 Android 11+） | 手机GUI自动控制，观察摄像头，观察屏幕，语音助手 | [`examples/device/android-app/`](examples/device/android-app/) | [Android](examples/device/android-app/README.md) |
| iPhone（iOS 27） | 手机GUI自动控制，观察摄像头，观察屏幕，语音助手 | [`examples/device/ios-app/`](examples/device/ios-app/) | [iOS](examples/device/ios-app/README.md) |
| Rokid BOLON 眼镜 | 每秒一帧摄像头画面、麦克风输入、音频回复播放、最近一帧拍照 | [眼镜原生端](examples/device/rokid-native-app/) | [Rokid 原生安装与配对](examples/device/rokid-native-app/README.zh-CN.md) |
| Seeed XIAO ESP32S3 Sense | 观察摄像头| [`device-sdk/esp32s3-xiao-camera/GelatoXiaoCamera/`](device-sdk/esp32s3-xiao-camera/GelatoXiaoCamera/) | [XIAO](device-sdk/esp32s3-xiao-camera/README.md) |

与这些设备配合的 Controller MVP 在 [`examples/server/control-room/`](examples/server/control-room/)。设备 SDK 在 [`device-sdk/`](device-sdk/README.md)，服务端代码在 [`server-sdk/`](server-sdk/README.md)。

## 运行 Controller MVP

需要 Node.js 22+：

```sh
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:8090`；另开终端运行 `npm run token`，用输出的令牌解锁控制台。创建一次性配对链接，再按设备指南操作。远程设备需要可到达、支持 WebSocket 升级的 HTTPS Controller；回环 HTTP 只用于本地开发。完整步骤见[快速开始](docs/getting-started.zh-CN.md)，部署配置见[服务端示例](examples/server/control-room/README.md)。

## 文档与仓库导航

| 从这里开始 | 适用场景 |
| --- | --- |
| [文档索引](docs/README.zh-CN.md) | 按阅读目标找到文档 |
| [快速开始](docs/getting-started.zh-CN.md) | 本地 Controller 和第一台设备 |
| [架构说明](docs/architecture.zh-CN.md) | 设备端、Controller 与可选集成 |
| [协议规范](docs/protocol.zh-CN.md)与 [JSON Schema](device-sdk/schemas/) | Gelato v1 报文和符合性要求 |
| [实现一个设备](docs/implementing-a-device.zh-CN.md) | 接入新硬件 |
| [设备 SDK](device-sdk/README.md)与[服务端 SDK](server-sdk/README.md) | 源码模块和平台指南 |
| [模型端接口](model_interface/README.zh-CN.md) | 模型会话规范、Qwen 适配器及 Codex 插件 |

示例 Controller 通过 `@gelato/model-interface` 选择模型连接；配置见[服务端示例](examples/server/control-room/README.md)。

## 贡献与许可

贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。Gelato 采用 [Apache License 2.0](LICENSE) 开源；第三方组件仍遵循各自的许可证。
