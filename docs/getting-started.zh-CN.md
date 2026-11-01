# 快速开始

[English](getting-started.md)

本指南使用可运行的 Controller MVP。本机回环模式可用于查看控制台和构建代码；从其他主机接入的手机、眼镜原生应用或 XIAO 开发板则需要可访问的 HTTPS 地址。

## 1. 构建并启动 Controller

安装 Node.js 22+，在仓库根目录运行：

```sh
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:8090`。另开一个终端运行 `npm run token`，将得到的令牌输入控制台。不要把令牌、TLS 密钥、账号凭据和采集的媒体内容提交到仓库。

为 Controller 主机之外的设备创建配对链接前，先配置可信的 HTTPS 地址并确保支持 WebSocket 升级。Controller 支持直接启用 TLS，或在本机回环地址前设置反向代理；按[控制台指南](../examples/server/control-room/README.md)配置 `PUBLIC_CONTROLLER_URL` 和对应的传输方式。不要直接对外发布默认的回环服务，也不要把设备连接凭据放进 URL。

## 2. 选择设备 MVP

| 硬件 | 从这里开始 | 本地要求 |
| --- | --- | --- |
| Android 手机 | [Android 示例](../examples/device/android-app/README.md) | 完成手机上的权限申请与配对流程 |
| iPhone | [iOS 示例](../examples/device/ios-app/README.md) | Apple 签名及必要的扩展 |
| Rokid BOLON 眼镜 | [眼镜原生端](../examples/device/rokid-native-app/README.zh-CN.md) | 首次通过 USB/ADB 安装和配置；之后经 Wi-Fi 直连控制端 |
| Seeed XIAO ESP32S3 Sense | [XIAO 固件](../device-sdk/esp32s3-xiao-camera/README.md) | 首次烧录固件；在临时 Wi-Fi 页面配置并配对 |

同一个 Controller MVP 可服务以上四类设备，但设备本地的配对前准备和可用命令不同。XIAO 固件需要 Sense 摄像头扩展板和 2.4 GHz Wi-Fi。

## 3. 配对，然后允许控制

1. 在 Controller 中创建一次性的设备配对链接或配对码。
2. 在设备上查看本地前置条件检查；`unknown` 不阻止配对，已确认失败的必要条件需先修复。配对链接可以预填配置，但不能替用户授权，也不能在首次配对时绕过用户确认。
3. 在设备本地确认配对。设备端保存签发的凭据，后续会话用该凭据重新连接。
4. 确认 Controller 收到了新的设备快照，以及驱动实际声明的能力。
5. 如需远程操作，**在设备上**开启允许控制。这与配对是两个独立选择。无屏幕的 XIAO 使用带密码保护的本地 Wi-Fi 页面。

先尝试 `device.describe@1`，再尝试设备当前快照中列出的能力，例如摄像头已就绪的 XIAO 上的 `camera.capture@1`。包含媒体的结果引用独立鉴权的流，而不是内嵌的 base64。如果设备已配对但驱动尚未就绪，请参阅该设备的专属指南，不要直接认定是协议故障。

## 后续阅读

- 阅读[架构说明](architecture.zh-CN.md)，了解驱动与协议的边界。
- 参考[实现一个设备](implementing-a-device.zh-CN.md)接入新硬件。
- 使用[协议规范](protocol.zh-CN.md)和 [JSON Schema](../device-sdk/schemas/)实现可互操作的线上报文。
