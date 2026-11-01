#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../../.." && pwd)"
project_dir="${1:-$repo_root/device-sdk/ios}"
project_dir="$(cd "$project_dir" && pwd)"
xtool_bin="${XTOOL_BIN:-xtool}"

fail() {
  printf 'Linux iOS build failed: %s\n' "$1" >&2
  exit 1
}

for command in "$xtool_bin" swift ipsw openssl; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done

xtool_help="$("$xtool_bin" dev build --help)"
grep -Fq -- "--sign" <<<"$xtool_help" ||
  fail "xtool does not support independent dev build --sign"

swift_version="$(swift --version)"
grep -Eq 'Swift version 6\.4([ .-]|$)' <<<"$swift_version" ||
  fail "Swift 6.4 is required for the Xcode 27 SDK"

sdk_status="$("$xtool_bin" sdk status 2>&1)" ||
  fail "xtool could not inspect the Darwin SDK"
grep -Fq "Not installed" <<<"$sdk_status" &&
  fail "xtool Darwin SDK is not installed"

swift_sdks="$(swift sdk list 2>&1)" || fail "swift sdk list failed"
grep -Eiq 'darwin' <<<"$swift_sdks" ||
  fail "the installed Swift SDK list has no Darwin SDK"

sdk_configuration="$(swift sdk configure darwin arm64-apple-ios --show-configuration 2>&1)" ||
  fail "Swift could not configure the Darwin SDK"
sdk_root="$(sed -n 's/^sdkRootPath: //p' <<<"$sdk_configuration" | head -n 1)"
case "$sdk_root" in
  */Developer/Platforms/*)
    export DEVELOPER_DIR="${sdk_root%%/Platforms/*}"
    ;;
  *)
    fail "Darwin SDK returned an invalid iPhoneOS SDK root"
    ;;
esac
[[ -f "$DEVELOPER_DIR/Platforms/iPhoneOS.platform/Info.plist" ]] ||
  fail "Darwin SDK is missing Swift 6.4 Apple platform metadata"

cd "$project_dir"
"$xtool_bin" dev build --configuration release --sign --ipa
"$script_dir/verify-ios-ipa.py" "$project_dir/xtool/MobileAgent.ipa"
