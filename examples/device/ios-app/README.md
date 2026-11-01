# iPhone

Build shared UI assets with `npm ci && npm run build:device-ui` at the root.

For Xcode builds, prepare the two FFI libraries using the scripts in
[`device-sdk/ios/scripts`](../../../device-sdk/ios/scripts/), then open:

```sh
open examples/device/ios-app/MobileAgent.xcodeproj
```

Set your signing team for the app and all three extensions. Bundle IDs, App Group
and provisioning profiles must agree with the SDK's entitlements and configuration.
Build and install `MobileAgent`.

The remote iPhone control path requires iOS 27+, Developer Mode, a device-signed
WebDriverAgent runner, and the Packet Tunnel permission. The app checks what it
can; a check that iOS does not expose remains `unknown`, not complete or blocking.
After system pairing, the controller can stage the signed WDA package over the
device channel. The app shows an explicit missing/installation status when the
driver reports one.

Set `GALATEA_BASE_BUNDLE_ID`, `GALATEA_APP_GROUP` and
`GALATEA_WDA_RUNNER_BUNDLE_ID` in Xcode when using different identities.
Updating an existing install requires its original bundle ID, App Group and signing team.

Complete the app's local permission checklist, then enter the controller's HTTPS
root address and request pairing. Approve the matching device and request suffix
in the controller's **Pairing requests** panel; the app completes pairing
automatically. Then enable access and follow any remaining notification,
local-network, VPN and system-pairing steps. Start a
[Linux iOS host](../../../server-sdk/ios/linux-host/README.md) for the remote pairing/control path.
On iOS 27+, use the system ScreenCaptureKit picker to approve full-display
sharing. The app sends a bounded 1 fps JPEG preview while control is enabled;
the controller can read its latest fresh frame without issuing a screenshot
command. Sharing stops when access is disabled or the app is stopped.

For a Linux build/sign/install workflow, use the Linux host's build and enrollment commands.
