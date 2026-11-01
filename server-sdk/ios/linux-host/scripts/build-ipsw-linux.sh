#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../../.." && pwd)"
if [[ -n "${GALATEA_TOOLCHAIN_ROOT:-}" ]]; then
  toolchain_root="$GALATEA_TOOLCHAIN_ROOT"
elif [[ "$(id -u)" == "0" ]]; then
  toolchain_root="/opt/galatea-toolchain"
else
  toolchain_root="${XDG_CACHE_HOME:-$HOME/.cache}/galatea/toolchain"
fi

readonly ipsw_commit="ecd48673f0e85aed8d57dbe3410bcbbbd2904c51"
readonly ipsw_version="v3.1.705"
readonly go_version="1.26.5"
readonly go_sha256="5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053"
readonly automation_patch="$repo_root/server-sdk/ios/linux-host/patches/ipsw-automation-stdin.patch"
readonly encrypted_session_patch="$repo_root/server-sdk/ios/linux-host/patches/ipsw-encrypted-session-only.patch"
readonly session_reuse_patch="$repo_root/server-sdk/ios/linux-host/patches/ipsw-session-reuse-hardening.patch"

fail() {
  printf 'ipsw Linux build failed: %s\n' "$1" >&2
  exit 1
}

case "$toolchain_root" in
  "" | /) fail "refusing unsafe GALATEA_TOOLCHAIN_ROOT" ;;
esac
[[ "$(uname -m)" == "x86_64" ]] || fail "this pinned bootstrap currently requires x86_64 Linux"
[[ -f "$automation_patch" ]] || fail "missing pinned ipsw automation patch"
[[ -f "$encrypted_session_patch" ]] || fail "missing encrypted session-only patch"
[[ -f "$session_reuse_patch" ]] || fail "missing encrypted session reuse hardening patch"
for command in curl git sha256sum tar; do
  command -v "$command" >/dev/null || fail "required build command is missing: $command"
done

tools_dir="$toolchain_root/tools"
build_root="$toolchain_root/build/ipsw"
bin_dir="$toolchain_root/bin"
go_archive="$tools_dir/go$go_version.linux-amd64.tar.gz"
go_root="$tools_dir/go-$go_version"
mkdir -p "$tools_dir" "$bin_dir"

if [[ ! -f "$go_archive" ]]; then
  temporary_archive="$go_archive.tmp"
  rm -f "$temporary_archive"
  curl -fL --retry 3 "https://go.dev/dl/go$go_version.linux-amd64.tar.gz" \
    -o "$temporary_archive"
  printf '%s  %s\n' "$go_sha256" "$temporary_archive" | sha256sum -c -
  mv "$temporary_archive" "$go_archive"
fi
printf '%s  %s\n' "$go_sha256" "$go_archive" | sha256sum -c -
rm -rf "$go_root"
mkdir -p "$go_root"
tar -xzf "$go_archive" --strip-components=1 -C "$go_root"
export PATH="$go_root/bin:$PATH"
[[ "$(go version)" == "go version go$go_version linux/amd64" ]] ||
  fail "the pinned Go toolchain could not be activated"

rm -rf "$build_root"
if [[ -n "${IPSW_SOURCE_DIR:-}" ]]; then
  [[ -d "$IPSW_SOURCE_DIR/.git" ]] || fail "IPSW_SOURCE_DIR is not a Git checkout"
  git clone --no-hardlinks "$IPSW_SOURCE_DIR" "$build_root"
else
  git clone --filter=blob:none --no-checkout https://github.com/blacktop/ipsw.git "$build_root"
fi
git -C "$build_root" fetch --depth 1 origin "$ipsw_commit" 2>/dev/null || true
git -C "$build_root" -c advice.detachedHead=false checkout "$ipsw_commit"
[[ "$(git -C "$build_root" rev-parse HEAD)" == "$ipsw_commit" ]] ||
  fail "ipsw did not resolve to its pinned commit"

git -C "$build_root" apply --check "$automation_patch"
git -C "$build_root" apply "$automation_patch"
git -C "$build_root" apply --check "$encrypted_session_patch"
git -C "$build_root" apply "$encrypted_session_patch"
git -C "$build_root" apply --check "$session_reuse_patch"
git -C "$build_root" apply "$session_reuse_patch"
gofmt -w \
  "$build_root/cmd/ipsw/cmd/download/download_dev.go" \
  "$build_root/internal/download/dev_portal.go"
git -C "$build_root" diff --check

(
  cd "$build_root"
  go mod download
  CGO_ENABLED=1 go build \
    -trimpath \
    -ldflags "-s -w -X github.com/blacktop/ipsw/cmd/ipsw/cmd.AppVersion=$ipsw_version -X github.com/blacktop/ipsw/cmd/ipsw/cmd.AppBuildCommit=${ipsw_commit:0:7}" \
    -o "$build_root/ipsw" \
    ./cmd/ipsw
)

ipsw_bin="$bin_dir/ipsw"
install -m 0755 "$build_root/ipsw" "$ipsw_bin"
grep -Fq "$ipsw_version" <<<"$("$ipsw_bin" version)" ||
  fail "installed ipsw has an unexpected version"
help="$("$ipsw_bin" download dev --help)"
for option in --credentials-stdin --automation-quiet --latest-matching; do
  grep -Fq -- "$option" <<<"$help" || fail "installed ipsw is missing $option"
done
invalid_output="$build_root/invalid-credentials.out"
if printf '{}\n' | "$ipsw_bin" download dev \
  --more \
  --credentials-stdin \
  --automation-quiet \
  --latest-matching 'Xcode 27' \
  --output "$build_root" >"$invalid_output" 2>&1; then
  fail "invalid stdin credentials were accepted"
fi
grep -Fq "invalid credentials JSON on standard input" "$invalid_output" ||
  fail "invalid stdin credentials did not fail through the expected gate"
dependencies="$(ldd "$ipsw_bin")"
grep -q "not found" <<<"$dependencies" && fail "ipsw has unresolved dynamic libraries"

sha256sum "$ipsw_bin"
printf 'Built verified Linux ipsw: %s\n' "$ipsw_bin"
