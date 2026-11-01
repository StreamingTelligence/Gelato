# Server SDKs

Each platform is a separate package and depends only on the shared core.

| Package | Contents |
| --- | --- |
| [core](core/) | Protocol, pairing, device registry, commands and media |
| [android](android/) | Android input, shell/logcat and App automation |
| [ios](ios/) | iOS input, WDA, packet overlay and Linux/macOS hosts |

From the repository root:

```sh
npm ci
npm run build:server
```

Import only the platform package you need. Python, TUN, Appium and Xcode are
needed only for the corresponding iOS host, not for Android or the Rokid glasses-local example.
The [control-room example](../examples/server/control-room/) combines the
packages into a complete web controller.
