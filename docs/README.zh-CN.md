# Gelato 文档

[English](README.md)

Gelato 是 StreamingTelligence Lab 为流式智能构建的设备生态。它希望让设备成为智能系统的传感器和交互环境，而不依赖封闭的硬件体系。Gelato v1 规定了经用户授权的设备端如何与控制端配对、保持连接、交换输入与回复，以及执行自身声明的能力。

| 你想做什么 | 从这里开始 |
| --- | --- |
| 理解设计目标和架构边界 | [架构说明](architecture.zh-CN.md) |
| 运行示例控制端并连接已有设备 | [快速开始](getting-started.zh-CN.md) |
| 接入新硬件 | [实现一个设备](implementing-a-device.zh-CN.md) |
| 编写可互通的线上报文 | [Gelato v1 协议规范](protocol.zh-CN.md)与 [JSON Schema](../device-sdk/schemas/) |
| 接入模型运行时 | [模型端接口](../model_interface/README.zh-CN.md)与[会话规范](../model_interface/protocol.zh-CN.md) |
| 配置可运行的控制端 | [Control room 示例](../examples/server/control-room/README.md) |

## 现有实现

| 设备 | 最小可行实现（MVP） | 设备指南 |
| --- | --- | --- |
| Android 手机 | [`examples/device/android-app/`](../examples/device/android-app/) | [Android](../examples/device/android-app/README.md) |
| iPhone | [`examples/device/ios-app/`](../examples/device/ios-app/) | [iOS](../examples/device/ios-app/README.md) |
| Rokid BOLON 眼镜原生端 | [`examples/device/rokid-native-app/`](../examples/device/rokid-native-app/) | [Rokid 原生端](../examples/device/rokid-native-app/README.zh-CN.md) |
| Seeed XIAO ESP32S3 Sense 摄像头 | [`device-sdk/esp32s3-xiao-camera/GelatoXiaoCamera/`](../device-sdk/esp32s3-xiao-camera/GelatoXiaoCamera/) | [XIAO](../device-sdk/esp32s3-xiao-camera/README.md) |

控制端示例位于 [`examples/server/control-room/`](../examples/server/control-room/)。基础协议不规定 App 任务语言、模型提供商或必须使用的账号服务。
