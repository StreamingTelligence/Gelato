# Device SDKs

| Device | Modules |
| --- | --- |
| [Android](android/README.md) | Protocol client, embedded ADB phone runtime, MediaProjection and account/UI bridge |
| [iOS](ios/README.md) | App runtime, Packet Tunnel, RemotePairing/RemoteXPC and ReplayKit |
| [Rokid BOLON native](rokid-native/) | Glasses-local Camera2 driver; [headless example](../examples/device/rokid-native-app/README.md) handles USB commissioning and Wi-Fi operation |
| [XIAO ESP32S3 Sense camera](esp32s3-xiao-camera/README.md) | Headless wireless pairing, local-page consent and JPEG capture |

All use Gelato v1 (`gelato.v1` on the wire). Devices require local owner consent before control.
[Schemas](schemas/) · [Protocol](../docs/protocol.md)
