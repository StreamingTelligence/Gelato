#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

APP_GROUP = "group.dev.galatea.agent"
MAIN_BUNDLE_ID = "dev.galatea.agent"
EXPECTED_BUNDLES = {
    "Payload/MobileAgent.app": MAIN_BUNDLE_ID,
    "Payload/MobileAgent.app/PlugIns/PacketTunnel.appex": f"{MAIN_BUNDLE_ID}.PacketTunnel",
    "Payload/MobileAgent.app/PlugIns/ScreenBroadcast.appex": f"{MAIN_BUNDLE_ID}.ScreenBroadcast",
    "Payload/MobileAgent.app/PlugIns/ScreenBroadcastSetup.appex":
        f"{MAIN_BUNDLE_ID}.ScreenBroadcastSetupUI",
}
EXPECTED_EXTENSION_POINTS = {
    f"{MAIN_BUNDLE_ID}.PacketTunnel": "com.apple.networkextension.packet-tunnel",
    f"{MAIN_BUNDLE_ID}.ScreenBroadcast": "com.apple.broadcast-services-upload",
    f"{MAIN_BUNDLE_ID}.ScreenBroadcastSetupUI": "com.apple.broadcast-services-setupui",
}
REQUIRED_BONJOUR_SERVICES = {
    "_remotepairing-pairable-host._tcp",
    "_remotepairing._tcp",
}
PROJECT_FILE = (
    Path(__file__).resolve().parents[4]
    / "examples"
    / "device"
    / "ios-app"
    / "MobileAgent.xcodeproj"
    / "project.pbxproj"
)


def fail(message: str) -> None:
    raise SystemExit(f"IPA verification failed: {message}")


def decode_profile(profile: Path) -> dict:
    result = subprocess.run(
        ["openssl", "smime", "-verify", "-inform", "DER", "-noverify", "-in", str(profile)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        fail(f"cannot decode provisioning profile at {profile}")
    try:
        return plistlib.loads(result.stdout)
    except (plistlib.InvalidFileException, TypeError, ValueError):
        fail(f"provisioning profile at {profile} has no property list")


def require_entitlement(entitlements: dict, key: str, value: str, bundle_id: str) -> None:
    actual = entitlements.get(key)
    values = actual if isinstance(actual, list) else [actual]
    if value not in values:
        fail(f"{bundle_id} profile is missing {key}={value}")


def require_string_list(value: object, description: str) -> list[str]:
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(item, str) and item for item in value)
    ):
        fail(f"{description} must be a non-empty string list")
    return value


def expected_project_versions() -> tuple[str, str]:
    try:
        project = PROJECT_FILE.read_text(encoding="utf-8")
    except OSError:
        fail(f"cannot read Xcode project metadata at {PROJECT_FILE}")
    build_versions = set(
        re.findall(r"CURRENT_PROJECT_VERSION = ([^;]+);", project)
    )
    marketing_versions = set(
        re.findall(r"MARKETING_VERSION = ([^;]+);", project)
    )
    if len(build_versions) != 1 or len(marketing_versions) != 1:
        fail("Xcode project targets do not share one build and marketing version")
    return (
        next(iter(marketing_versions)).strip().strip('"'),
        next(iter(build_versions)).strip().strip('"'),
    )


def verify_developer_certificates(profile: dict, bundle_id: str) -> None:
    certificates = profile.get("DeveloperCertificates")
    if not isinstance(certificates, list) or not certificates:
        fail(f"{bundle_id} profile has no developer certificates")
    has_unexpired_certificate = False
    for index, certificate in enumerate(certificates):
        if not isinstance(certificate, bytes) or not certificate:
            fail(f"{bundle_id} profile certificate {index} is invalid")
        parse_result = subprocess.run(
            ["openssl", "x509", "-inform", "DER", "-noout"],
            input=certificate,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if parse_result.returncode != 0:
            fail(f"{bundle_id} profile certificate {index} is invalid")
        expiry_result = subprocess.run(
            ["openssl", "x509", "-inform", "DER", "-noout", "-checkend", "0"],
            input=certificate,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        has_unexpired_certificate = (
            has_unexpired_certificate or expiry_result.returncode == 0
        )
    if not has_unexpired_certificate:
        fail(f"{bundle_id} profile has no unexpired developer certificate")


def verify_info_plist(info: dict, bundle_id: str) -> None:
    expected_marketing_version, expected_build_version = expected_project_versions()
    if info.get("CFBundleShortVersionString") != expected_marketing_version:
        fail(
            f"{bundle_id} has marketing version "
            f"{info.get('CFBundleShortVersionString')!r}, expected "
            f"{expected_marketing_version!r}"
        )
    if info.get("CFBundleVersion") != expected_build_version:
        fail(
            f"{bundle_id} has build version {info.get('CFBundleVersion')!r}, "
            f"expected {expected_build_version!r}"
        )
    if bundle_id == MAIN_BUNDLE_ID:
        if info.get("CFBundlePackageType") != "APPL":
            fail(f"{bundle_id} is not an application bundle")
        services = info.get("NSBonjourServices")
        if not isinstance(services, list) or not REQUIRED_BONJOUR_SERVICES.issubset(services):
            fail(f"{bundle_id} is missing RemotePairing Bonjour declarations")
        value = info.get("NSLocalNetworkUsageDescription")
        if not isinstance(value, str) or not value.strip():
            fail(f"{bundle_id} is missing NSLocalNetworkUsageDescription")
        if info.get("ServerizedRequiresDeveloperMode") is not True:
            fail(f"{bundle_id} must declare its development-signing launch requirement")
        return

    if info.get("CFBundlePackageType") != "XPC!":
        fail(f"{bundle_id} is not an app extension bundle")
    extension = info.get("NSExtension")
    expected = EXPECTED_EXTENSION_POINTS[bundle_id]
    if not isinstance(extension, dict) or extension.get("NSExtensionPointIdentifier") != expected:
        fail(f"{bundle_id} has the wrong NSExtensionPointIdentifier")
    if bundle_id == f"{MAIN_BUNDLE_ID}.PacketTunnel":
        services = info.get("NSBonjourServices")
        if (
            not isinstance(services, list)
            or not REQUIRED_BONJOUR_SERVICES.issubset(services)
        ):
            fail(
                f"{bundle_id} is missing bidirectional RemotePairing Bonjour declarations"
            )
        value = info.get("NSLocalNetworkUsageDescription")
        if not isinstance(value, str) or not value.strip():
            fail(f"{bundle_id} is missing NSLocalNetworkUsageDescription")


def verify_macho(bundle: Path, info: dict, required_markers: list[str]) -> None:
    executable_name = info.get("CFBundleExecutable")
    if not isinstance(executable_name, str) or not executable_name:
        fail(f"{bundle} has no CFBundleExecutable")
    executable = bundle / executable_name
    if not executable.is_file():
        fail(f"{bundle} executable is missing")
    if not (bundle / "_CodeSignature" / "CodeResources").is_file():
        fail(f"{bundle} has no CodeResources signature manifest")
    result = subprocess.run(
        ["ipsw", "macho", "info", "--sig", "--ent", str(executable)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if result.returncode != 0:
        fail(f"{bundle} has no readable Mach-O code signature")
    for marker in required_markers:
        if marker not in result.stdout:
            fail(f"{bundle} code signature is missing {marker}")


def verify_bundle(bundle: Path, bundle_id: str) -> None:
    info_path = bundle / "Info.plist"
    if not info_path.is_file():
        fail(f"{bundle} has no Info.plist")
    try:
        with info_path.open("rb") as stream:
            info = plistlib.load(stream)
    except (plistlib.InvalidFileException, TypeError, ValueError):
        fail(f"{bundle} has an invalid Info.plist")
    if info.get("CFBundleIdentifier") != bundle_id:
        fail(f"expected {bundle_id}, found {info.get('CFBundleIdentifier')!r}")
    verify_info_plist(info, bundle_id)

    profile_path = bundle / "embedded.mobileprovision"
    if not profile_path.is_file():
        fail(f"{bundle_id} has no embedded.mobileprovision")
    profile = decode_profile(profile_path)
    expiration = profile.get("ExpirationDate")
    now = dt.datetime.now(dt.timezone.utc)
    if not isinstance(expiration, dt.datetime):
        fail(f"{bundle_id} profile has no expiration date")
    if expiration.replace(tzinfo=expiration.tzinfo or dt.timezone.utc) <= now:
        fail(f"{bundle_id} profile is expired")
    devices = require_string_list(profile.get("ProvisionedDevices"), f"{bundle_id} ProvisionedDevices")
    if len(set(devices)) != len(devices):
        fail(f"{bundle_id} profile contains duplicate device identifiers")
    platforms = require_string_list(profile.get("Platform"), f"{bundle_id} Platform")
    if "iOS" not in platforms:
        fail(f"{bundle_id} profile is not provisioned for iOS")
    team_identifiers = require_string_list(profile.get("TeamIdentifier"), f"{bundle_id} TeamIdentifier")
    if len(set(team_identifiers)) != 1:
        fail(f"{bundle_id} profile has ambiguous team identifiers")
    team_identifier = team_identifiers[0]
    prefixes = require_string_list(
        profile.get("ApplicationIdentifierPrefix"),
        f"{bundle_id} ApplicationIdentifierPrefix",
    )
    verify_developer_certificates(profile, bundle_id)
    entitlements = profile.get("Entitlements")
    if not isinstance(entitlements, dict):
        fail(f"{bundle_id} profile has no entitlements")
    if entitlements.get("get-task-allow") is not True:
        fail(f"{bundle_id} is not using a development profile")
    if entitlements.get("com.apple.developer.team-identifier") != team_identifier:
        fail(f"{bundle_id} profile team entitlement does not match TeamIdentifier")
    application_identifier = entitlements.get("application-identifier")
    expected_application_identifiers = {f"{prefix}.{bundle_id}" for prefix in prefixes}
    if (
        not isinstance(application_identifier, str)
        or application_identifier not in expected_application_identifiers
    ):
        fail(f"{bundle_id} profile has the wrong application-identifier")

    required = [
        "application-identifier",
        application_identifier,
        "com.apple.developer.team-identifier",
        team_identifier,
        "get-task-allow",
    ]
    if bundle_id in {MAIN_BUNDLE_ID, f"{MAIN_BUNDLE_ID}.PacketTunnel"}:
        require_entitlement(
            entitlements,
            "com.apple.developer.networking.networkextension",
            "packet-tunnel-provider",
            bundle_id,
        )
        required.extend([
            "com.apple.developer.networking.networkextension",
            "packet-tunnel-provider",
        ])
    if bundle_id in {
        MAIN_BUNDLE_ID,
        f"{MAIN_BUNDLE_ID}.ScreenBroadcast",
        f"{MAIN_BUNDLE_ID}.ScreenBroadcastSetupUI",
    }:
        require_entitlement(entitlements, "com.apple.security.application-groups", APP_GROUP, bundle_id)
        required.extend(["com.apple.security.application-groups", APP_GROUP])
    verify_macho(bundle, info, required)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: verify-ios-ipa.py <MobileAgent.ipa>")
    ipa = Path(sys.argv[1]).resolve()
    if not ipa.is_file():
        fail(f"IPA not found: {ipa}")
    for command in ("openssl", "ipsw"):
        if shutil.which(command) is None:
            fail(f"required command is missing: {command}")

    with tempfile.TemporaryDirectory(prefix="serverized-ipa-") as directory:
        root = Path(directory)
        try:
            with zipfile.ZipFile(ipa) as archive:
                entries = archive.infolist()
                names = [entry.filename for entry in entries]
                unsafe = [name for name in names if Path(name).is_absolute() or ".." in Path(name).parts]
                if unsafe:
                    fail("IPA contains unsafe archive paths")
                if len(names) != len(set(names)):
                    fail("IPA contains duplicate archive paths")
                if any(stat.S_ISLNK(entry.external_attr >> 16) for entry in entries):
                    fail("IPA contains symbolic links")
                archive.extractall(root)
        except zipfile.BadZipFile:
            fail("IPA is not a valid zip archive")
        top_level_apps = {
            path.relative_to(root).as_posix()
            for path in root.glob("Payload/*.app")
        }
        if top_level_apps != {"Payload/MobileAgent.app"}:
            fail(f"top-level app set mismatch: {sorted(top_level_apps)}")
        actual_apps = {
            path.relative_to(root).as_posix()
            for path in root.glob("Payload/MobileAgent.app/PlugIns/*.appex")
        }
        expected_extensions = set(EXPECTED_BUNDLES) - {"Payload/MobileAgent.app"}
        if actual_apps != expected_extensions:
            fail(f"extension set mismatch: {sorted(actual_apps)}")
        for relative, bundle_id in EXPECTED_BUNDLES.items():
            verify_bundle(root / relative, bundle_id)

    print(f"Verified Linux-signed IPA: {ipa}")


if __name__ == "__main__":
    main()
