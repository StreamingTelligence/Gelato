# Gelato documentation

[简体中文](README.zh-CN.md)

Gelato is StreamingTelligence Lab's device ecosystem for streaming intelligence. The aim is to make devices available as sensors and interaction environments without requiring a proprietary hardware stack. Gelato v1 defines how a user-authorized device pairs with a Controller, stays connected, exchanges input and replies, and executes capabilities it advertises.

| If you want to… | Read |
| --- | --- |
| Understand the design and its boundaries | [Architecture](architecture.md) |
| Run the example Controller and connect an existing device | [Getting started](getting-started.md) |
| Connect new hardware | [Implement a device](implementing-a-device.md) |
| Build interoperable wire messages | [Gelato v1 specification](protocol.md) and [JSON schemas](../device-sdk/schemas/) |
| Integrate a model runtime | [Model interface](../model_interface/README.md) and [session specification](../model_interface/protocol.md) |
| Configure the runnable Controller | [Control room](../examples/server/control-room/README.md) |

## Existing implementations

| Device | Minimum viable implementation | Device guide |
| --- | --- | --- |
| Android phone | [`examples/device/android-app/`](../examples/device/android-app/) | [Android](../examples/device/android-app/README.md) |
| iPhone | [`examples/device/ios-app/`](../examples/device/ios-app/) | [iOS](../examples/device/ios-app/README.md) |
| Rokid BOLON glasses | [`examples/device/rokid-native-app/`](../examples/device/rokid-native-app/) | [Rokid native](../examples/device/rokid-native-app/README.md) |
| Seeed XIAO ESP32S3 Sense camera | [`device-sdk/esp32s3-xiao-camera/GelatoXiaoCamera/`](../device-sdk/esp32s3-xiao-camera/GelatoXiaoCamera/) | [XIAO](../device-sdk/esp32s3-xiao-camera/README.md) |

The example Controller is in [`examples/server/control-room/`](../examples/server/control-room/). The base protocol does not include an App-task vocabulary, a particular model, or a required account provider.
