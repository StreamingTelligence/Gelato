#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${GALATEA_TOOLCHAIN_ROOT:-}" ]]; then
  toolchain_root="$GALATEA_TOOLCHAIN_ROOT"
elif [[ "$(id -u)" == "0" ]]; then
  toolchain_root="/opt/galatea-toolchain"
else
  toolchain_root="${XDG_CACHE_HOME:-$HOME/.cache}/galatea/toolchain"
fi

readonly snapshot="swift-6.4.x-DEVELOPMENT-SNAPSHOT-2026-07-17-a"
readonly archive_name="$snapshot-ubuntu22.04.tar.gz"
readonly archive_sha256="9991d195cdf81f232e789fc6cda3f80fbc0ae053679c1b51b49da7292a526f8a"
readonly signing_fingerprint="E813C892820A6FA13755B268F167DF1ACF9CE069"
readonly download_root="https://download.swift.org/swift-6.4.x-branch/ubuntu2204/$snapshot"
readonly signing_key_url="https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x$signing_fingerprint"

fail() {
  printf 'Swift Linux install failed: %s\n' "$1" >&2
  exit 1
}

case "$toolchain_root" in
  "" | /) fail "refusing unsafe GALATEA_TOOLCHAIN_ROOT" ;;
esac
[[ "$(uname -m)" == "x86_64" ]] || fail "the pinned Swift toolchain requires x86_64 Linux"
[[ -r /etc/os-release ]] || fail "/etc/os-release is required"
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "22.04" ]] ||
  fail "the pinned Swift toolchain requires Ubuntu 22.04"
for command in curl gpg sha256sum tar; do
  command -v "$command" >/dev/null || fail "required command is missing: $command"
done

cache_dir="$toolchain_root/cache"
install_dir="$toolchain_root/swift/$snapshot"
archive="$cache_dir/$archive_name"
signature="$archive.sig"
gnupg_home="$toolchain_root/swift-gnupg"
mkdir -p "$cache_dir" "$toolchain_root/swift" "$gnupg_home"
chmod 0700 "$gnupg_home"

download() {
  local url="$1"
  local destination="$2"
  local temporary="$destination.tmp"
  curl -fL --retry 3 --retry-all-errors "$url" -o "$temporary"
  mv "$temporary" "$destination"
}

if [[ ! -f "$archive" ]]; then
  download "$download_root/$archive_name" "$archive"
fi
printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum -c -

if [[ ! -f "$signature" ]]; then
  download "$download_root/$archive_name.sig" "$signature"
fi
signing_key="$cache_dir/swift-signing-key.asc"
download "$signing_key_url" "$signing_key"
gpg --batch --homedir "$gnupg_home" --import "$signing_key" >/dev/null 2>&1
gpg --batch --homedir "$gnupg_home" --list-keys "$signing_fingerprint" >/dev/null 2>&1 ||
  fail "the pinned Swift signing key is missing"
verification="$(
  gpg --batch --homedir "$gnupg_home" --status-fd 1 \
    --verify "$signature" "$archive" 2>/dev/null
)" || fail "Swift archive signature verification failed"
grep -Fq "[GNUPG:] VALIDSIG $signing_fingerprint " <<<"$verification" ||
  fail "Swift archive was signed by an unexpected key"

if [[ ! -x "$install_dir/usr/bin/swift" ]]; then
  temporary_dir="$(mktemp -d "$toolchain_root/swift/.install.XXXXXX")"
  trap 'rm -rf "$temporary_dir"' EXIT
  tar -xzf "$archive" -C "$temporary_dir"
  extracted=("$temporary_dir"/*)
  [[ "${#extracted[@]}" == "1" && -d "${extracted[0]}" ]] ||
    fail "Swift archive has an unexpected top-level layout"
  rm -rf "$install_dir"
  mv "${extracted[0]}" "$install_dir"
fi

version="$($install_dir/usr/bin/swift --version)"
grep -Eq '^Swift version 6\.4([ .-]|$)' <<<"$version" ||
  fail "the installed compiler is not Swift 6.4"
printf 'Installed verified Swift toolchain: %s\n' "$install_dir/usr/bin/swift"
