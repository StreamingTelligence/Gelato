#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 1 || ! -e "$1" ]]; then
  printf 'Usage: %s /dev/cu.usbmodemXXXX\n' "$0" >&2
  exit 2
fi
if ! command -v arduino-cli >/dev/null 2>&1; then
  printf 'arduino-cli is required; see README.md\n' >&2
  exit 2
fi

port="$1"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/gelato-xiao-install.XXXXXX")"
sketch="$work/GelatoXiaoCamera"
build="$work/build"
output="$work/output"
mkdir "$sketch"
cp "$here/GelatoXiaoCamera/GelatoXiaoCamera.ino" "$here/GelatoXiaoCamera/gelato_trust_anchor.h" "$sketch/"
password="${GELATO_SETUP_PASSWORD:-$(openssl rand -hex 12)}"
if [[ ! "$password" =~ ^[A-Za-z0-9]{8,63}$ ]]; then
  printf 'GELATO_SETUP_PASSWORD must contain 8–63 ASCII letters or digits.\n' >&2
  exit 2
fi
fqbn='esp32:esp32:XIAO_ESP32S3:FlashSize=8M,PSRAM=opi'

printf 'Building for %s. Build artifacts: %s\n' "$fqbn" "$work"
arduino-cli compile \
  --fqbn "$fqbn" \
  --build-property "compiler.cpp.extra_flags=-DGELATO_SETUP_PASSWORD=\"${password}\"" \
  --build-path "$build" \
  --output-dir "$output" \
  "$sketch"

printf 'Flashing firmware over USB (no pairing data is sent over USB)...\n'
arduino-cli upload --fqbn "$fqbn" --port "$port" --input-dir "$output" "$sketch"

printf '\nWireless setup network: Gelato-Camera-<last six MAC digits>\n'
printf 'WPA2 password: %s\n' "$password"
printf 'On a phone, join that network and open http://192.168.4.1/ .\n'
printf 'Save this password privately; USB is no longer needed for setup or pairing.\n'
