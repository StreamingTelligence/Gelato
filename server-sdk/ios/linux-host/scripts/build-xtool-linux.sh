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
jobs="${JOBS:-$(nproc)}"
xtool_patch="$repo_root/server-sdk/ios/linux-host/patches/xtool-network-extension-entitlement.patch"
preserve_identifiers_patch="$repo_root/server-sdk/ios/linux-host/patches/xtool-preserve-bundle-identifiers.patch"
signing_info_reuse_patch="$repo_root/server-sdk/ios/linux-host/patches/xtool-signing-info-reuse.patch"
nested_entitlements_patch="$repo_root/server-sdk/ios/linux-host/patches/xtool-nested-entitlements.patch"
zsign_nested_entitlements_patch="$repo_root/server-sdk/ios/linux-host/patches/zsign-nested-entitlements.patch"
device_registration_patch="$repo_root/server-sdk/ios/linux-host/patches/xtool-network-device-registration.patch"
sdk_extraction_patch="$repo_root/server-sdk/ios/linux-host/patches/xtool-selective-sdk-extraction.patch"
swift64_platform_patch="$repo_root/server-sdk/ios/linux-host/patches/xtool-swift-6.4-platform-metadata.patch"
swift64_native_build_patch="$repo_root/server-sdk/ios/linux-host/patches/xtool-swift-6.4-native-build.patch"
local_toolset_patch="$repo_root/server-sdk/ios/linux-host/patches/xtool-local-toolset-archive.patch"
unxip_patch="$repo_root/server-sdk/ios/linux-host/patches/unxip-public-erased-sequence.patch"
automatic_team_patch="$repo_root/server-sdk/ios/linux-host/patches/xtool-automatic-paid-team.patch"
xdg_config_patch="$repo_root/server-sdk/ios/linux-host/patches/xtool-xdg-config-home.patch"
reuse_auth_patch="$repo_root/server-sdk/ios/linux-host/patches/xtool-reuse-matching-auth.patch"

readonly xtool_commit="697adae78b765ee6f8ed5458d600444c972993ea"
readonly libplist_commit="cf5897a71ea412ea2aeb1e2f6b5ea74d4fabfd8c"
readonly glue_commit="aef2bf0f5bfe961ad83d224166462d87b1df2b00"
readonly libusbmuxd_commit="2387d8e5820ee4621494e20434c0017aba6bea71"
readonly libtatsu_commit="42329cb756682535c7c0f087987b78d1dd5b16c8"
readonly libimobiledevice_commit="149f7623c672c1fa73122c7119a12bfc0012f2ac"
readonly xadi_commit="61c02708c9cb046100f500878863fd2122b0d7e3"
readonly ldc_version="1.42.0"
readonly ldc_sha256="a7bc9c956138f558cadf9c962352f59d41c80df6eb3ae3f8039f25be14a69303"

fail() {
  printf 'xtool Linux build failed: %s\n' "$1" >&2
  exit 1
}

case "$toolchain_root" in
  "" | /) fail "refusing unsafe GALATEA_TOOLCHAIN_ROOT" ;;
esac

[[ "$(uname -m)" == "x86_64" ]] || fail "this pinned bootstrap currently requires x86_64 Linux"
[[ -f "$xtool_patch" ]] || fail "missing pinned xtool Network Extension patch"
[[ -f "$preserve_identifiers_patch" ]] || fail "missing pinned exact bundle identifier patch"
[[ -f "$signing_info_reuse_patch" ]] || fail "missing pinned signing info reuse patch"
[[ -f "$nested_entitlements_patch" ]] || fail "missing pinned nested entitlement forwarding patch"
[[ -f "$zsign_nested_entitlements_patch" ]] || fail "missing pinned zsign nested entitlement patch"
[[ -f "$device_registration_patch" ]] || fail "missing pinned network device registration patch"
[[ -f "$sdk_extraction_patch" ]] || fail "missing pinned selective SDK extraction patch"
[[ -f "$swift64_platform_patch" ]] || fail "missing pinned Swift 6.4 platform metadata patch"
[[ -f "$swift64_native_build_patch" ]] || fail "missing pinned Swift 6.4 native build patch"
[[ -f "$local_toolset_patch" ]] || fail "missing pinned local Darwin toolset patch"
[[ -f "$unxip_patch" ]] || fail "missing pinned unxip API patch"
[[ -f "$automatic_team_patch" ]] || fail "missing pinned automatic team patch"
[[ -f "$xdg_config_patch" ]] || fail "missing pinned XDG config directory patch"
[[ -f "$reuse_auth_patch" ]] || fail "missing pinned matching-auth reuse patch"

if [[ "${INSTALL_SYSTEM_DEPS:-0}" == "1" ]]; then
  [[ "$(id -u)" == "0" ]] || fail "INSTALL_SYSTEM_DEPS=1 requires root"
  command -v apt-get >/dev/null || fail "apt-get is required to install system dependencies"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    autoconf \
    automake \
    build-essential \
    ca-certificates \
    curl \
    g++-12 \
    git \
    gnupg \
    libcurl4-openssl-dev \
    libicu-dev \
    liblzma-dev \
    libssl-dev \
    libstdc++-12-dev \
    libtool-bin \
    libxml2 \
    libxml2-dev \
    libz3-dev \
    pkg-config \
    unzip \
    xz-utils \
    zip \
    zlib1g-dev
fi

if [[ "${INSTALL_SYSTEM_DEPS_ONLY:-0}" == "1" ]]; then
  [[ "${INSTALL_SYSTEM_DEPS:-0}" == "1" ]] ||
    fail "INSTALL_SYSTEM_DEPS_ONLY=1 requires INSTALL_SYSTEM_DEPS=1"
  printf 'Installed xtool Linux system dependencies\n'
  exit 0
fi

for command in autoconf automake curl g++ git make pkg-config swift tar unzip xz zip; do
  command -v "$command" >/dev/null || fail "required build command is missing: $command"
done
grep -Eq 'Swift version 6\.4([ .-]|$)' <<<"$(swift --version)" || fail "Swift 6.4 is required"
[[ -f /usr/include/c++/12/memory ]] ||
  fail "GCC 12 C++ headers are required (install g++-12 and libstdc++-12-dev)"

build_root="$toolchain_root/build"
prefix="$toolchain_root/imobiledevice"
tools_dir="$toolchain_root/tools"
bin_dir="$toolchain_root/bin"
rm -rf "$build_root" "$prefix"
mkdir -p "$build_root" "$prefix" "$tools_dir" "$bin_dir"

export PKG_CONFIG_PATH="$prefix/lib/pkgconfig:/usr/lib/x86_64-linux-gnu/pkgconfig"
export LD_LIBRARY_PATH="$prefix/lib"
export LDFLAGS="-Wl,-rpath,$prefix/lib"

clone_exact() {
  local name="$1"
  local url="$2"
  local commit="$3"
  local destination="$build_root/$name"
  git clone --filter=blob:none --no-checkout "$url" "$destination"
  git -C "$destination" fetch --depth 1 origin "$commit"
  git -C "$destination" -c advice.detachedHead=false checkout "$commit"
  [[ "$(git -C "$destination" rev-parse HEAD)" == "$commit" ]] ||
    fail "$name did not resolve to its pinned commit"
}

build_autotools() {
  local name="$1"
  local url="$2"
  local commit="$3"
  shift 3
  clone_exact "$name" "$url" "$commit"
  (
    cd "$build_root/$name"
    ./autogen.sh --prefix="$prefix" "$@"
    make -j"$jobs"
    make install
  )
}

build_autotools \
  libplist https://github.com/libimobiledevice/libplist.git "$libplist_commit" \
  --without-cython --without-tests
build_autotools \
  libimobiledevice-glue https://github.com/libimobiledevice/libimobiledevice-glue.git \
  "$glue_commit"
build_autotools \
  libusbmuxd https://github.com/libimobiledevice/libusbmuxd.git "$libusbmuxd_commit"
build_autotools \
  libtatsu https://github.com/libimobiledevice/libtatsu.git "$libtatsu_commit"
build_autotools \
  libimobiledevice https://github.com/libimobiledevice/libimobiledevice.git \
  "$libimobiledevice_commit" --without-cython --with-openssl

ldc_archive="$tools_dir/ldc2-$ldc_version-linux-x86_64.tar.xz"
ldc_dir="$tools_dir/ldc2-$ldc_version-linux-x86_64"
curl -fL --retry 3 \
  "https://github.com/ldc-developers/ldc/releases/download/v$ldc_version/$(basename "$ldc_archive")" \
  -o "$ldc_archive"
printf '%s  %s\n' "$ldc_sha256" "$ldc_archive" | sha256sum -c -
rm -rf "$ldc_dir"
tar -xJf "$ldc_archive" -C "$tools_dir"
export PATH="$ldc_dir/bin:$PATH"
grep -Fq "LDC - the LLVM D compiler ($ldc_version)" <<<"$(ldc2 --version)" ||
  fail "the pinned LDC compiler could not be activated"

clone_exact xadi https://github.com/xtool-org/xadi.git "$xadi_commit"
(
  cd "$build_root/xadi"
  dub build --build=release
)
install -m 0755 "$build_root/xadi/bin/libxadi.so" "$prefix/lib/libxadi.so"

clone_exact xtool https://github.com/xtool-org/xtool.git "$xtool_commit"
git -C "$build_root/xtool" apply --check "$xtool_patch"
git -C "$build_root/xtool" apply "$xtool_patch"
git -C "$build_root/xtool" apply --check "$preserve_identifiers_patch"
git -C "$build_root/xtool" apply "$preserve_identifiers_patch"
git -C "$build_root/xtool" apply --check "$signing_info_reuse_patch"
git -C "$build_root/xtool" apply "$signing_info_reuse_patch"
git -C "$build_root/xtool" apply --check "$nested_entitlements_patch"
git -C "$build_root/xtool" apply "$nested_entitlements_patch"
git -C "$build_root/xtool" apply --check "$device_registration_patch"
git -C "$build_root/xtool" apply "$device_registration_patch"
git -C "$build_root/xtool" apply --recount --check "$sdk_extraction_patch"
git -C "$build_root/xtool" apply --recount "$sdk_extraction_patch"
git -C "$build_root/xtool" apply --check "$swift64_platform_patch"
git -C "$build_root/xtool" apply "$swift64_platform_patch"
git -C "$build_root/xtool" apply --check "$swift64_native_build_patch"
git -C "$build_root/xtool" apply "$swift64_native_build_patch"
git -C "$build_root/xtool" apply --recount --check "$local_toolset_patch"
git -C "$build_root/xtool" apply --recount "$local_toolset_patch"
git -C "$build_root/xtool" apply --recount --check "$automatic_team_patch"
git -C "$build_root/xtool" apply --recount "$automatic_team_patch"
git -C "$build_root/xtool" apply --recount --check "$xdg_config_patch"
git -C "$build_root/xtool" apply --recount "$xdg_config_patch"
git -C "$build_root/xtool" apply --recount --check "$reuse_auth_patch"
git -C "$build_root/xtool" apply --recount "$reuse_auth_patch"
git -C "$build_root/xtool" diff --check
grep -Fq "NetworkExtensionEntitlement.self," \
  "$build_root/xtool/Sources/XKit/Model/Entitlements/EntitlementTypes.swift" ||
  fail "xtool Network Extension entitlement support was not enabled"
grep -Fq 'context _: SigningContext' \
  "$build_root/xtool/Sources/XKit/Utilities/ProvisioningIdentifiers.swift" ||
  fail "xtool exact bundle identifier support was not enabled"
grep -Fq 'normalizedSerialNumber' \
  "$build_root/xtool/Sources/XKit/DeveloperServices/Certificates/DeveloperServicesFetchCertificateOperation.swift" ||
  fail "xtool signing info reuse support was not enabled"
(
  cd "$build_root/xtool"
  swift package resolve
)
unxip_dir="$build_root/xtool/.build/checkouts/unxip"
[[ -d "$unxip_dir" ]] || fail "SwiftPM did not resolve the pinned unxip checkout"
git -C "$unxip_dir" apply --recount --check "$unxip_patch"
git -C "$unxip_dir" apply --recount "$unxip_patch"
git -C "$unxip_dir" diff --check
zsign_dir="$build_root/xtool/.build/checkouts/zsign"
[[ -d "$zsign_dir" ]] || fail "SwiftPM did not resolve the pinned zsign checkout"
git -C "$zsign_dir" apply --ignore-space-change --recount --check \
  "$zsign_nested_entitlements_patch"
git -C "$zsign_dir" apply --ignore-space-change --recount \
  "$zsign_nested_entitlements_patch"
git -C "$zsign_dir" diff --check
grep -Fq "[Scanning XIP]" "$build_root/xtool/Sources/XToolSupport/SDKBuilder.swift" ||
  fail "xtool selective SDK extraction was not enabled"
grep -Fq '"--build-system", "native"' "$build_root/xtool/Sources/PackLib/Packer.swift" ||
  fail "xtool Swift 6.4 native build support was not enabled"
grep -Fq "XTOOL_DARWIN_TOOLSET_SHA256" "$build_root/xtool/Sources/XToolSupport/SDKBuilder.swift" ||
  fail "xtool verified local Darwin toolset support was not enabled"
grep -Fq 'environment["XDG_CONFIG_HOME"]' \
  "$build_root/xtool/Sources/XKit/Utilities/DirectoryProvider.swift" ||
  fail "xtool XDG config directory support was not enabled"
grep -Fq 'bundle.SetEntitlementMapping(entitlement_mapping)' \
  "$zsign_dir/Sources/Zupersign/signer.cpp" ||
  fail "zsign nested entitlement support was not enabled"
(
  cd "$build_root/xtool"
  XTOOL_VERSION="commit $xtool_commit" swift build \
    -c release \
    --jobs "$jobs" \
    --product xtool \
    -Xlinker -rpath \
    -Xlinker "$prefix/lib"
)
xtool_build_bin="$(cd "$build_root/xtool" && swift build -c release --show-bin-path)/xtool"
xtool_bin="$bin_dir/xtool"
install -m 0755 "$xtool_build_bin" "$xtool_bin"

version="$(env -u LD_LIBRARY_PATH "$xtool_bin" --version)"
[[ "$version" == "xtool commit $xtool_commit" ]] || fail "unexpected xtool version: $version"
grep -Fq -- "--sign" <<<"$(env -u LD_LIBRARY_PATH "$xtool_bin" dev build --help)" ||
  fail "built xtool has no independent --sign option"
grep -Fq -- "--udid" <<<"$(env -u LD_LIBRARY_PATH "$xtool_bin" ds devices add --help)" ||
  fail "built xtool has no network device registration option"
grep -Fq -- "--prefer-paid-team" <<<"$(env -u LD_LIBRARY_PATH "$xtool_bin" auth login --help)" ||
  fail "built xtool has no automatic paid-team selection"
grep -Fq -- "--credentials-stdin" <<<"$(env -u LD_LIBRARY_PATH "$xtool_bin" auth login --help)" ||
  fail "built xtool has no stdin-only credentials channel"
grep -Fq -- "--reuse-existing" <<<"$(env -u LD_LIBRARY_PATH "$xtool_bin" auth login --help)" ||
  fail "built xtool cannot safely reuse matching credentials"
dependencies="$(env -u LD_LIBRARY_PATH ldd "$xtool_bin")"
grep -q "libusbmuxd-2.0.so.7 => $prefix/lib/" <<<"$dependencies" ||
  fail "xtool did not link the isolated libusbmuxd"
grep -q "libplist-2.0.so.4 => $prefix/lib/" <<<"$dependencies" ||
  fail "xtool did not link the isolated libplist"
grep -q "libxadi.so => $prefix/lib/" <<<"$dependencies" ||
  fail "xtool did not link the isolated xadi"
grep -q "not found" <<<"$dependencies" && fail "xtool has unresolved dynamic libraries"
grep -q "libplist-2.0.so.3" <<<"$dependencies" && fail "xtool mixed the old libplist ABI"

sha256sum "$xtool_bin"
printf 'Built verified Linux xtool: %s\n' "$xtool_bin"
