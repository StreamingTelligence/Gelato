# iOS SDK

Requires iOS 27+. The Swift package provides four targets:
`MobileAgent`, `PacketTunnel`, `ScreenBroadcast` and `ScreenBroadcastSetup`.
They include local prerequisite checks, independent connection and control
switches, persistent pairing, RemoteXPC/WDA control,
Packet Tunnel recovery, and H.264 ReplayKit broadcasting.
The device-side preflight reports WDA installation as passed only after a
RemoteXPC/WDA signal; if the runner is absent, the app guides the owner to
have the controller stage a device-signed WDA package. An unobservable check
remains `unknown` and does not block first pairing.

```sh
npm run build:device-ui
open examples/device/ios-app/MobileAgent.xcodeproj
```

Select your signing team for all targets. Register the app/extension bundle IDs
and App Group declared in the project and entitlements.

Physical-device Xcode builds need the idevice FFI libraries. From this directory,
run `scripts/prepare-idevice-main-ffi.sh` and `scripts/prepare-idevice-ffi.sh` with
Rust, the iOS Rust target and Xcode installed. The libraries are built from the
pinned source and patches in `scripts/`; generated archives are not committed.

[Device example](../../examples/device/ios-app/README.md) ·
[Linux pairing/control and build host](../../server-sdk/ios/linux-host/README.md)
