# macOS iOS host

Optional Appium/WDA host for iOS simulators and physical devices. Requires macOS,
Xcode, Node.js 22+ and an available simulator or paired iPhone.

```sh
cd server-sdk/ios/macos-host
npm install
npm exec -- appium driver install --source=local ./node_modules/appium-xcuitest-driver
npm start
```

The host listens on `127.0.0.1:8181`. List targets at `GET /api/lab/devices`.
Create a session with `POST /api/lab/sessions` and JSON
`{"udid":"<device-udid>","bundleId":"com.apple.Preferences"}`.
Session routes under `/api/lab/sessions/<id>` provide `tap`, `swipe`, `launch`,
`screenshot`, `source`, and `DELETE` to close the session.

For physical devices, set `LAB_ALLOW_PHYSICAL=1`, `LAB_IOS_DEVELOPMENT_TEAM`
and `LAB_WDA_BUNDLE_ID` to your signing identities. Use `LAB_CONTROLLER_URL`
and `LAB_OVERLAY_DEVICE_ID` for the controller/overlay path. Alternatively set
`LAB_PHYSICAL_MODE=appium` and `LAB_TUNNEL_REGISTRY_PORT` for an existing
Appium RemoteXPC tunnel registry. Set `LAB_WDA_PROJECT` to override the WDA project.
Keep this listener local; it does not implement public API authentication.
