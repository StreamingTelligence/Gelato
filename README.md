<p align="center">
  <img src="docs/assets/streamingtelligence-logo.png" alt="StreamingTelligence logo" width="132">
</p>

# Gelato

Gelato is an ecosystem project of **StreamingTelligence Lab**. Its name is inspired by Galatea, the statue brought to life in Greek mythology. In that spirit, we aim to bring streaming intelligence to all kinds of devices and reshape how people interact with them: devices become both sensors through which streaming intelligence perceives the world and environments in which it can respond to people and interact with the real world. Gelato v1 is the common protocol connecting these devices to a Controller. This repository provides the specification, SDKs, and a minimum viable implementation (MVP) for each supported device.

[Documentation](docs/README.md) · [Device protocol](docs/protocol.md) · [Model interface](model_interface/README.md) · [Get started](docs/getting-started.md) · [简体中文](README.zh-CN.md)

## Demo video

https://github.com/user-attachments/assets/5811c155-1fd8-4fdc-9f51-a381bf7f0e6c

Watch the [Gelato demo (1:46, MP4)](docs/assets/gelato-demo-v7.mp4): wireless iPhone control, a kettle notification, and real-time assistance through Rokid glasses.

## Design principles

- **Wireless interaction.** Pair and control Android phones, iPhones, and other devices over the network without depending on debugging cables. Gelato pairing and control require no physical connection.
- **Minimal intrusion.** Gelato is not limited to a device form factor and does not require expensive on-device compute or specialized hardware. Its open protocol can bring even a device with only a camera and Wi-Fi into a streaming-intelligence system; each device advertises only the capabilities it actually has.
- **Openness and privacy.** The device SDKs, server SDKs, and MVP for each supported device are open-source building blocks that let developers add new devices quickly. Gelato is not tied to any model provider, including StreamingTelligence. It respects the privacy of local devices and can work locally without cloning a user's account information or working environment in the cloud.

See [architecture](docs/architecture.md) for details.

## What makes up Gelato v1

| Part | Contract |
| --- | --- |
| Local prerequisite checks | Device-specific, offline-capable checks and guidance before pairing and control |
| Pairing and session | One-use code, issued device identity and connection credential, authenticated reconnect |
| Connection and state | Device-initiated WebSocket, leases, presence, and capability snapshots |
| Input and reply | Device instructions/observations (`input.publish`) and server content replies (`reply.deliver`) |
| Control | Versioned `command.request`, progress, result/error, deadline, and cancellation |
| Media | Separate authenticated streams for binary data referenced by messages or results |

The wire identifier is `gelato.v1`. Read the [protocol specification](docs/protocol.md) for message rules and [Implement a device](docs/implementing-a-device.md) for the minimum device contract.

## Supported model runtimes

Model inference is optional and separate from device pairing and control. A Controller can connect to a model runtime through the `gelato.model.v1` [model session specification](model_interface/protocol.md). Device inputs can become model input; model content can become a device reply. An `action.propose` is only a proposal: the Controller routes it through the current device session, and the device retains execution authority. The model never receives device-pairing credentials.

The [`model_interface/`](model_interface/README.md) directory contains the protocol, schema, and provider-neutral Controller adapter. The [Controller MVP](examples/server/control-room/) connects to either of these integrations:

| Model runtime | How it is connected and what it supports | MVP implementation |
| --- | --- | --- |
| Qwen Live Harness | An in-process adapter uses the pinned `qwen-live-harness` package for text/PCM audio turns, live Rokid audio and 1 fps JPEG input, and audio replies. It does not propose device actions. | [`qwenLiveEndpoint.ts`](model_interface/src/qwenLiveEndpoint.ts) |
| Codex | An independent `gelato.model.v1` WebSocket endpoint drives Codex app-server for text/image turns and device-action proposals. It does not ingest audio or continuous 1 fps video. | [Codex model plugin](model_interface/gelato-codex-model/) |

See the [model interface README](model_interface/README.md) for setup and exact modality boundaries. A one-shot HTTP adapter is also available, but it does not implement a `gelato.model.v1` session.

## Supported hardware and MVPs

These are the implementations **in this repository**, not a claim that every capability works on every device. Each uses the same Gelato v1 wire protocol while retaining its own local driver and onboarding.

| Hardware | Capabilities | Where the device-side code runs | MVP code | Setup guide |
| --- | --- | --- | --- | --- |
| Android phone (Android 8+; Android 11+ for Wireless Debugging pairing) | Phone GUI control, camera and screen observation, voice assistant | On the phone | [`examples/device/android-app/`](examples/device/android-app/) | [Android](examples/device/android-app/README.md) |
| iPhone (iOS 27 for wireless pairing) | Phone GUI control, camera and screen observation, voice assistant | On the phone, with iOS extensions | [`examples/device/ios-app/`](examples/device/ios-app/) | [iOS](examples/device/ios-app/README.md) |
| Rokid BOLON glasses | 1 fps camera observation, microphone input, audio reply playback, and latest-frame capture | On the glasses; USB for first installation, Wi-Fi thereafter | [`rokid-native-app/`](examples/device/rokid-native-app/) | [Rokid native](examples/device/rokid-native-app/README.md) |
| Seeed XIAO ESP32S3 Sense camera | Camera observation | On the headless board; USB installs firmware, Wi-Fi handles setup and pairing | [`device-sdk/esp32s3-xiao-camera/GelatoXiaoCamera/`](device-sdk/esp32s3-xiao-camera/GelatoXiaoCamera/) | [XIAO](device-sdk/esp32s3-xiao-camera/README.md) |

The companion Controller MVP is [`examples/server/control-room/`](examples/server/control-room/). Device SDK implementations are in [`device-sdk/`](device-sdk/README.md); reusable Controller code is in [`server-sdk/`](server-sdk/README.md). The XIAO implementation is board-specific firmware, not a generic ESP32 library.

## Run the Controller MVP

With Node.js 22+:

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:8090`. In another terminal, run `npm run token` and enter its output in the console. Create a one-use pairing link and follow the guide for your device. A remote device needs a reachable HTTPS Controller with WebSocket upgrades; loopback HTTP is only for local development. See the [walkthrough](docs/getting-started.md) and [server configuration](examples/server/control-room/README.md).

## Documentation and repository map

| Start here | For |
| --- | --- |
| [Documentation index](docs/README.md) | Reading path by role |
| [Getting started](docs/getting-started.md) | Local Controller and first device |
| [Architecture](docs/architecture.md) | Device side, Controller, and optional integrations |
| [Protocol specification](docs/protocol.md) and [JSON schemas](device-sdk/schemas/) | Gelato v1 wire and conformance rules |
| [Implement a device](docs/implementing-a-device.md) | Connect new hardware |
| [Device SDKs](device-sdk/README.md) and [server SDKs](server-sdk/README.md) | Source modules and platform-specific guides |
| [Model interface](model_interface/README.md) | Model protocol, Qwen adapter, and Codex plugin |

The example Controller selects a model connection through `@gelato/model-interface`; see [server configuration](examples/server/control-room/README.md).

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). Gelato is licensed under the [Apache License 2.0](LICENSE). Third-party components retain their own licenses.
