# iOS server SDK

The Node package depends only on the shared core, WebSocket and ID utilities.
Install a native host separately when needed:
[Linux](linux-host/) · [macOS Appium/WDA](macos-host/).

```ts
import { IosDeviceDriver } from '@gelato/server-ios';

const ios = new IosDeviceDriver(gateway.commands, gateway.devices);
await ios.tap(deviceId, 100, 200);
await ios.wdaHttpRequest(deviceId, 'GET', '/status');
```

`gateway` is a connected [GelatoServer](../core/). `showPairingPin`,
`confirmPairing` and `requireUpdate` expose the device setup/update commands.
`PacketOverlayHub` provides the optional authenticated iOS/host packet relay;
the [control room](../../examples/server/control-room/) wires its WebSocket route.
