#!/bin/sh
set -eu

# Build the MIT-licensed idevice FFI directly from a reviewed revision. This
# avoids shipping an opaque third-party archive copied from another app.
IDEVICE_REVISION=201e2f00c900b5a4858db12eeac0dec042e47117
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IOS_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SOURCE_DIR="$IOS_DIR/.build/idevice-src"
VENDOR_DIR="$IOS_DIR/Vendor/idevice"
XCTEST_PATCH="$SCRIPT_DIR/idevice-on-device-xctest.patch"
RAW_CDTUNNEL_PATCH="$SCRIPT_DIR/idevice-raw-cdtunnel.patch"
JKTCP_PATCH="$SCRIPT_DIR/idevice-main-jktcp-compat.patch"

if ! command -v cargo >/dev/null 2>&1 || ! command -v rustup >/dev/null 2>&1; then
    echo "Rust is required. Install rustup, then run this script again." >&2
    exit 1
fi

if [ ! -d "$SOURCE_DIR/.git" ]; then
    mkdir -p "$(dirname -- "$SOURCE_DIR")"
    git clone --filter=blob:none https://github.com/jkcoxson/idevice.git "$SOURCE_DIR"
fi

git -C "$SOURCE_DIR" fetch --depth=1 origin "$IDEVICE_REVISION"
git -C "$SOURCE_DIR" checkout --detach "$IDEVICE_REVISION"
git -C "$SOURCE_DIR" reset --hard "$IDEVICE_REVISION"
git -C "$SOURCE_DIR" clean -fd
git -C "$SOURCE_DIR" apply --check "$XCTEST_PATCH"
git -C "$SOURCE_DIR" apply "$XCTEST_PATCH"
git -C "$SOURCE_DIR" apply --check "$RAW_CDTUNNEL_PATCH"
git -C "$SOURCE_DIR" apply "$RAW_CDTUNNEL_PATCH"
# XCTest opens three concurrent RSD services over the same software adapter.
# jktcp 0.1.1 keeps that adapter single-owner; newer cloneable handles can
# race the device socket and terminate WDA as soon as the containing app is
# backgrounded. Use the same ownership model already proven by the main-app
# bootstrap while retaining the Packet Tunnel's raw CDTunnel additions.
git -C "$SOURCE_DIR" apply --check "$JKTCP_PATCH"
git -C "$SOURCE_DIR" apply "$JKTCP_PATCH"
rustup target add aarch64-apple-ios

(
    cd "$SOURCE_DIR/ffi"
    BINDGEN_EXTRA_CLANG_ARGS="--sysroot=$(xcrun --sdk iphoneos --show-sdk-path)" \
    IPHONEOS_DEPLOYMENT_TARGET=17.0 \
    cargo build --release --target aarch64-apple-ios --features obfuscate,openssl
)

mkdir -p "$VENDOR_DIR"
cp "$SOURCE_DIR/ffi/idevice.h" "$VENDOR_DIR/idevice.h"
cp "$SOURCE_DIR/target/aarch64-apple-ios/release/libidevice_ffi.a" \
    "$VENDOR_DIR/libidevice_ffi.a"
cp "$SOURCE_DIR/LICENSE.txt" "$VENDOR_DIR/LICENSE.txt"
printf '%s\n' \
    'module idevice {' \
    '  header "idevice.h"' \
    '  export *' \
    '}' >"$VENDOR_DIR/module.modulemap"

echo "Prepared idevice FFI revision $IDEVICE_REVISION in $VENDOR_DIR"
