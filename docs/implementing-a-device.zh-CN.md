# 实现一个设备

[English](implementing-a-device.md)

新设备需要实现 Gelato v1 契约，无须额外部署一个独立组件。设备端代码可以运行在硬件本体，也可以运行在获准访问该硬件的伴侣设备上。如果您的设备想加快被Gelato官方团队的收录速度，请至少实现一个可运行的MVP。

## 最低实现契约

1. **本地前置条件检查。** 提供无需联网也能展示的设备专属清单，分别检查 `before-pairing` 和 `before-control` 条件，并按[前置条件 Schema](../device-sdk/schemas/preflight.schema.json)报告依据与状态。无法可靠检测时报告 `unknown`、`done: false`，但不阻止流程；仅已确认失败的必需条件阻止对应阶段。权限只能通过明确的本地操作申请，传入的链接不能绕过这些步骤。无屏幕设备可使用临时启用、需在本地认证的配置页面。
2. **身份与配对。** 使用一次性码发送 `pairing.request`。将返回的两个线上标识（`agentId` 和 `deviceId`）及凭据保存在适当的受保护存储中。随后用 `session.hello` 重新连接；不要在 URL 中传递凭据。
3. **连接与状态。** 主动建立控制 WebSocket，定期续租，并在每次会话被接受后发送新的 `device.snapshot`。声明 `device.describe@1`、驱动就绪状态、硬件状态，以及当前确实可用的能力。
4. **所有者控制权。** 将配对、是否开启连接和是否允许远程控制分开处理。设备所有者可以在不丢失配对的情况下关闭连接或暂停命令。用 `hardware.controlAllowed` 报告控制授权状态。
5. **信息交换与命令。** 支持通过 `input.publish` 发送指令和观察信息；将 `reply.deliver` 作为内容接收并确认。只执行当前已声明的 `command.request` 能力，并返回一个最终结果或错误。处理截止时间、重复 ID 和取消请求。
6. **有媒体能力时的传输。** 使用经过鉴权的类型化流传输二进制内容。声明内容类型和大小限制、为帧编号，并校验最终字节数与 SHA-256。没有摄像头或麦克风的设备无需虚构对应能力。

线上协议以[协议规范](protocol.zh-CN.md)为准；[Schema](../device-sdk/schemas/)定义报文结构。特定 App 的工作流和模型策略不属于此检查清单。

## 选择起点

| 实现 | 适合复用到 | 注意事项 |
| --- | --- | --- |
| [Android 协议客户端](../device-sdk/android/README.md) | 由其他 Android 设备承载的硬件驱动 | 实现 `DeviceAgentDriver`；厂商权限仍由本地处理 |
| [iOS SDK](../device-sdk/ios/README.md) | iOS 设备端 App 或扩展 | 签名、entitlement 和 iOS 生命周期 |
| [Rokid BOLON 原生端](../examples/device/rokid-native-app/README.zh-CN.md) | 无屏幕眼镜、本机摄像头和音频 | 首次 USB/ADB 配置，检查 Wi-Fi、相机、麦克风和后台权限 |
| [XIAO 摄像头固件](../device-sdk/esp32s3-xiao-camera/README.md) | 自定义AI硬件 | 引脚与固件针对特定开发板，不能当作通用 ESP32 默认配置 |

对应的可运行 MVP 见[文档索引](README.zh-CN.md)。Controller 实现可以使用[服务端核心](../server-sdk/core/README.md)，并在不修改线上协议的前提下加入设备专属辅助组件。

## 声称兼容前的检查

检查首次配对、凭据重连、新快照、本地暂停控制、`device.describe@1`、至少一个已声明命令的最终结果，以及任何媒体流的完整字节数和摘要。还应确认：权限被拒、服务端不可达或命令被取消时，设备仍处于安全状态。
