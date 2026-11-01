# Implement a device

[简体中文](implementing-a-device.zh-CN.md)

A new device needs to implement the Gelato v1 contract; it does not need an additional standalone component. Device-side code may run on the hardware itself or in a companion authorized to access it. To make it easier for the Gelato team to include your device, provide at least one runnable MVP.

## Minimum contract

1. **Local prerequisite checks.** Present an offline-capable, device-specific checklist for `before-pairing` and `before-control` conditions, reporting evidence and state according to the [prerequisite schema](../device-sdk/schemas/preflight.schema.json). If a condition cannot be reliably checked, report `unknown` with `done: false` without blocking progress; only a confirmed failed required condition blocks its phase. Permissions require explicit local actions; an incoming link cannot bypass them. A headless device may use a temporary, locally authenticated setup page instead of a screen.
2. **Identity and pairing.** Send `pairing.request` with a one-use code. Persist both returned wire identifiers (`agentId` and `deviceId`) and the credential in appropriate protected storage. Reconnect with `session.hello`; do not send the credential in a URL.
3. **Connection and state.** Initiate the outbound control WebSocket, renew the lease, and send a fresh `device.snapshot` after every accepted session. Advertise `device.describe@1`, driver readiness, hardware state, and only capabilities that actually work.
4. **Owner control.** Keep pairing, connection enablement, and remote-control consent separate. The device owner can disable the connection or pause commands without losing the pairing. Report consent as `hardware.controlAllowed`.
5. **Exchange and commands.** Support `input.publish` for instructions/observations; accept `reply.deliver` as content and acknowledge it. Execute only advertised `command.request` capabilities and return one terminal result or error. Handle deadlines, duplicate IDs, and cancellation.
6. **Media when supported.** Use authenticated typed streams for binary payloads. Declare content type and limits, sequence frames, and verify the final byte count and SHA-256. A device with no camera or microphone does not need to invent those capabilities.

The [specification](protocol.md) is authoritative for the wire protocol; the [schemas](../device-sdk/schemas/) define message shapes. App-specific workflows and model policies are not part of this checklist.

## Choose a starting point

| Implementation | Reuse it for | Watch for |
| --- | --- | --- |
| [Android protocol client](../device-sdk/android/README.md) | Another Android-hosted hardware driver | Implement `DeviceAgentDriver`; keep vendor permissions local |
| [iOS SDK](../device-sdk/ios/README.md) | iOS device-side app or extensions | Signing, entitlements, and iOS lifecycle |
| [Rokid BOLON native](../examples/device/rokid-native-app/README.md) | Headless AI glasses, device-local camera and audio | First USB/ADB commissioning, Wi-Fi, camera, microphone and background permission checks |
| [XIAO camera firmware](../device-sdk/esp32s3-xiao-camera/README.md) | Custom AI hardware | Its pinout and firmware are board-specific, not portable ESP32 defaults |

The matching runnable MVPs are listed in the [documentation index](README.md). A Controller implementation can use the [server core](../server-sdk/core/README.md) and add device-specific helpers without changing the wire protocol.

## Before claiming compatibility

Check first pairing, credential reconnect, a fresh snapshot, local control pause, `device.describe@1`, one advertised command's terminal result, and any media stream's complete byte count and digest. Also verify that the device remains safe when permissions are denied, the server is unreachable, or a command is cancelled.
