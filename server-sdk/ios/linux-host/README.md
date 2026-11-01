# Linux iOS host

Requires Linux, Python 3.13+, `/dev/net/tun` and privileges to create/configure TUN.

```sh
python3.13 -m venv .venv
.venv/bin/pip install -e server-sdk/ios/linux-host
.venv/bin/galatea-ios-host doctor
sudo .venv/bin/galatea-ios-host auto-serve \
  --controller-url https://your-controller.example \
  --controller-token-file /absolute/private/operator-token \
  --state-dir /absolute/private/ios-state
```

The host manages first-pairing links, overlay/TUN, RemotePairing, RemoteXPC,
CoreDevice screen/HID control, and optional WDA package staging. Pass
`--wda-package /absolute/path/to/signed-wda.ipa` when using WDA.
Do not expose its loopback diagnostics listener publicly.

## Linux build and install

The pinned build toolchain requires x86_64 Ubuntu 22.04. Run from the repository root:

```sh
export GALATEA_TOOLCHAIN_ROOT="$HOME/.cache/galatea/toolchain"
sudo env INSTALL_SYSTEM_DEPS=1 INSTALL_SYSTEM_DEPS_ONLY=1 \
  server-sdk/ios/linux-host/scripts/build-xtool-linux.sh
server-sdk/ios/linux-host/scripts/install-swift-linux.sh
export PATH="$GALATEA_TOOLCHAIN_ROOT/swift/swift-6.4.x-DEVELOPMENT-SNAPSHOT-2026-07-17-a/usr/bin:$GALATEA_TOOLCHAIN_ROOT/bin:$PATH"
server-sdk/ios/linux-host/scripts/build-xtool-linux.sh
server-sdk/ios/linux-host/scripts/build-ipsw-linux.sh
xtool sdk --help
xtool auth --help
```

Install a Darwin SDK with `xtool sdk`, authenticate with `xtool auth`, and supply
Apple signing credentials locally. Then build the device UI and signed IPA:

```sh
npm ci
npm run build:device-ui
server-sdk/ios/linux-host/scripts/build-ios.sh
```

`galatea-ios-host enroll-serve --help` and `galatea-ios-host setup-serve --help` describe
the signed OTA enrollment/bootstrap servers. Use `auto-serve --help` for
state, device-ID, WDA and client-update options.
