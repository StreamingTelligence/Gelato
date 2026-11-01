# Getting started

[简体中文](getting-started.zh-CN.md)

This guide uses the runnable Controller MVP. Its local loopback mode lets you inspect the console and build the code; a phone, native glasses app, or XIAO board connecting from another machine needs a reachable HTTPS origin.

## 1. Build and start the Controller

Install Node.js 22+ and run from the repository root:

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:8090`. In a second terminal, run `npm run token` and enter the token in the console. Keep tokens, TLS keys, account credentials, and captured media out of the repository.

For a device outside the Controller host, set up a trusted HTTPS origin and WebSocket upgrades before creating its pairing link. The Controller supports direct TLS or a loopback reverse proxy; configure `PUBLIC_CONTROLLER_URL` and the matching transport as described in the [Control room guide](../examples/server/control-room/README.md). Do not publish the default loopback server directly or put device connection credentials in URLs.

## 2. Pick a device MVP

| Hardware | Start here | Local requirement |
| --- | --- | --- |
| Android phone | [Android example](../examples/device/android-app/README.md) | Complete the phone's permission and pairing flow |
| iPhone | [iOS example](../examples/device/ios-app/README.md) | Apple signing and required extensions |
| Rokid BOLON glasses | [Native glasses example](../examples/device/rokid-native-app/README.md) | Commission over USB/ADB once; the app connects directly over Wi-Fi afterward |
| Seeed XIAO ESP32S3 Sense | [XIAO firmware](../device-sdk/esp32s3-xiao-camera/README.md) | Flash firmware once; configure and pair on its temporary Wi-Fi page |

The same Controller MVP serves all four, but device-local preflight and available commands differ. The XIAO firmware needs a Sense camera expansion board and 2.4 GHz Wi-Fi.

## 3. Pair, then allow control

1. Create a one-use device pairing link or code in the Controller.
2. Review the local prerequisite checks on the device. `unknown` does not block pairing; a confirmed failed required condition needs recovery first. A pairing link may stage configuration, but it does not grant permissions or silently begin first pairing.
3. Confirm pairing locally. The device-side implementation saves its issued credential and reconnects with it on subsequent sessions.
4. Confirm the Controller sees a fresh device snapshot and the capabilities the driver actually advertises.
5. If you want remote actions, enable control **on the device**. This choice is separate from pairing. For the headless XIAO, use its password-protected local Wi-Fi page.

Start with `device.describe@1`. Then try a capability that appears in that device's current snapshot, such as `camera.capture@1` on a camera-ready XIAO. Results that contain media refer to a separate authenticated stream, not inline base64. If the device is paired but a driver is not ready, follow the device-specific guide rather than assuming a protocol failure.

## Next steps

- Read the [architecture](architecture.md) to understand where a driver ends and the protocol begins.
- Use [Implement a device](implementing-a-device.md) to add new hardware.
- Use the [specification](protocol.md) and [JSON schemas](../device-sdk/schemas/) for interoperable wire messages.
