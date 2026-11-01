# Android server SDK

Depends only on `@gelato/server-core`.

```ts
import { AndroidDeviceDriver } from '@gelato/server-android';

const android = new AndroidDeviceDriver(gateway.commands, gateway.devices);
await android.tap(deviceId, 100, 200);
await android.shell(deviceId, 'getprop ro.product.model');
await android.logcat(deviceId, 200);
```

`gateway` is a connected [GelatoServer](../core/). The device must advertise
the requested capability and allow control. `askAiApp` and `runAiTask` invoke
the phone's existing App automation adapters.
