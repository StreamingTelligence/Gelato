# Android SDK

Requires JDK 21 and Android SDK 35.

| Module | Purpose |
| --- | --- |
| This directory | `DeviceAgentClient`, protocol/driver interfaces and encrypted credentials |
| `app-bridge/` | Capacitor native bridge, account vault and permission onboarding |
| `phone/` | Embedded ADB, wireless pairing, phone actions, MediaProjection, App automation and background services |

The root Gradle project exposes `:device-sdk`, `:android-app` and `:android-phone`.
Include `:android-phone` for the complete phone runtime; include only `:device-sdk`
to supply a custom `DeviceAgentDriver`. `AgentRuntime.init(context)` and
`AgentRuntime.get().protocolClient()` expose the phone protocol client.

Build shared UI assets with `npm run build:device-ui` before building an app.
[Phone example](../../examples/device/android-app/README.md)
