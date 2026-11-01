from __future__ import annotations

import html
import json
import plistlib
import re
import secrets
import ssl
import stat
import subprocess
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, parse_qsl, urlencode, urlparse

from aiohttp import ClientSession, ClientTimeout, web


PROFILE_MIME = "application/x-apple-aspen-config"
REQUIRED_IOS_CONFIGURATION_REVISION = 12
REQUIRED_IOS_NETWORK_MODE = "ios27-devicehub-system-pairing"
IPA_MIME = "application/octet-stream"
UDID_PATTERN = re.compile(r"^[A-Fa-f0-9-]{20,64}$")
APPLE_DEVICE_CA_PATTERN = re.compile(
    r"issuer\s*=.*Apple.*(?:iPhone|Device).*CA", re.IGNORECASE
)


def _atomic_private_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def _run_openssl(arguments: list[str]) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            ["openssl", *arguments],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
        )
    except (
        FileNotFoundError,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
    ) as error:
        raise ValueError("CMS validation failed") from error


def sign_mobileconfig(
    payload: bytes,
    certificate: Path,
    private_key: Path,
    certificate_chain: Path | None = None,
) -> bytes:
    with tempfile.TemporaryDirectory(prefix="serverized-profile-") as directory:
        root = Path(directory)
        source = root / "profile.plist"
        output = root / "profile.mobileconfig"
        source.write_bytes(payload)
        arguments = [
            "smime",
            "-sign",
            "-binary",
            "-nodetach",
            "-outform",
            "DER",
            "-in",
            str(source),
            "-signer",
            str(certificate),
            "-inkey",
            str(private_key),
            "-out",
            str(output),
        ]
        if certificate_chain is not None:
            arguments.extend(["-certfile", str(certificate_chain)])
        _run_openssl(arguments)
        return output.read_bytes()


def extract_signed_device_attributes(
    body: bytes,
    expected_challenge: str,
    *,
    require_apple_device_certificate: bool = True,
) -> dict[str, str]:
    if not body or len(body) > 512 * 1024:
        raise ValueError("invalid CMS body size")

    with tempfile.TemporaryDirectory(prefix="serverized-device-reply-") as directory:
        root = Path(directory)
        envelope = root / "reply.der"
        content = root / "reply.plist"
        envelope.write_bytes(body)
        _run_openssl(
            [
                "smime",
                "-verify",
                "-binary",
                "-inform",
                "DER",
                "-noverify",
                "-in",
                str(envelope),
                "-out",
                str(content),
            ]
        )
        certificates = _run_openssl(
            ["pkcs7", "-inform", "DER", "-in", str(envelope), "-print_certs", "-noout"]
        ).stdout.decode("utf-8", errors="replace")
        if require_apple_device_certificate and not APPLE_DEVICE_CA_PATTERN.search(
            certificates
        ):
            raise ValueError("reply was not signed by an Apple device identity")

        try:
            raw = plistlib.loads(content.read_bytes())
        except (plistlib.InvalidFileException, ValueError) as error:
            raise ValueError("signed reply did not contain a property list") from error

    if not isinstance(raw, dict):
        raise ValueError("signed reply property list was not a dictionary")
    attributes = {str(key).upper(): str(value) for key, value in raw.items()}
    if not secrets.compare_digest(attributes.get("CHALLENGE", ""), expected_challenge):
        raise ValueError("device challenge did not match")
    udid = attributes.get("UDID", "")
    if not UDID_PATTERN.fullmatch(udid):
        raise ValueError("device reply did not contain a valid UDID")
    return attributes


@dataclass(frozen=True)
class OtaPackage:
    ipa: Path
    bundle_id: str
    bundle_version: str
    title: str = "Serverized Controller"
    pairing_url: str | None = None
    pairing_url_file: Path | None = None

    def __post_init__(self) -> None:
        if self.pairing_url is not None and self.pairing_url_file is not None:
            raise ValueError("provide pairing_url or pairing_url_file, not both")
        if self.pairing_url is not None:
            self._validate_pairing_url(self.pairing_url)

    @staticmethod
    def _validate_pairing_url(value: str) -> str:
        parsed = urlparse(value)
        query = parse_qs(parsed.query)
        if (
            parsed.scheme != "galatea"
            or parsed.netloc != "pair"
            or not query.get("controllerUrl")
            or not query.get("pairingCode")
        ):
            raise ValueError("pairing URL must be a complete galatea pair URL")
        return value

    def resolved_pairing_url(self) -> str | None:
        if self.pairing_url is not None:
            return self.pairing_url
        if self.pairing_url_file is None or not self.pairing_url_file.is_file():
            return None
        if stat.S_IMODE(self.pairing_url_file.stat().st_mode) & 0o077:
            raise PermissionError("pairing URL file must not be accessible by group or others")
        value = self.pairing_url_file.read_text(encoding="utf-8").strip()
        return self._validate_pairing_url(value)

    def system_pairing_status_file(self) -> Path | None:
        if self.pairing_url_file is None:
            return None
        return self.pairing_url_file.with_name(
            self.pairing_url_file.name + ".system-pairing.json"
        )


@dataclass(frozen=True)
class ControllerStatusSource:
    api_url: str
    token_file: Path

    def __post_init__(self) -> None:
        parsed = urlparse(self.api_url)
        loopback = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.query
            or parsed.fragment
            or (parsed.scheme != "https" and not loopback)
        ):
            raise ValueError("Controller API URL must use HTTPS or loopback HTTP")

    def token(self) -> str:
        if not self.token_file.is_file():
            raise FileNotFoundError("Controller API token file is unavailable")
        if stat.S_IMODE(self.token_file.stat().st_mode) & 0o077:
            raise PermissionError("Controller API token file must be private")
        token = self.token_file.read_text(encoding="utf-8").strip()
        if len(token) < 20:
            raise ValueError("Controller API token is invalid")
        return token

    @staticmethod
    def summarize(
        devices_payload: dict[str, Any],
        overlays_payload: dict[str, Any],
        expected_build: str | None,
    ) -> dict[str, Any]:
        devices = devices_payload.get("devices")
        agent_online = any(
            isinstance(device, dict)
            and isinstance(device.get("os"), dict)
            and device["os"].get("family") == "ios"
            and isinstance(device.get("connection"), dict)
            and device["connection"].get("online") is True
            for device in (devices if isinstance(devices, list) else [])
        )
        overlays = overlays_payload.get("overlays")
        connected = [
            overlay
            for overlay in (overlays if isinstance(overlays, list) else [])
            if isinstance(overlay, dict) and overlay.get("iosConnected") is True
        ]
        matching = [
            overlay
            for overlay in connected
            if expected_build is not None
            and str(overlay.get("iosClientBuild")) == expected_build
        ]
        candidates = matching or connected
        active = max(
            candidates,
            key=lambda overlay: int(overlay.get("iosConnectedAt") or 0),
            default=None,
        )
        active_build = (
            str(active.get("iosClientBuild"))
            if active is not None and active.get("iosClientBuild") is not None
            else None
        )
        vpn_connected = active is not None
        active_device_id = active.get("deviceId") if active is not None else None
        active_device = next(
            (
                device
                for device in (devices if isinstance(devices, list) else [])
                if isinstance(device, dict)
                and device.get("deviceId") == active_device_id
            ),
            None,
        )
        pairing_state = (
            active_device.get("hardware", {}).get("pairingState")
            if isinstance(active_device, dict)
            and isinstance(active_device.get("hardware"), dict)
            else None
        )
        pairing_proxy_state = active.get("iosPairingProxyState") if active else None
        proxy_updated_at = active.get("iosPairingProxyUpdatedAt") if active else None
        remote_pairing_state = active.get("iosRemotePairingState") if active else None
        remote_pairing_updated_at = (
            active.get("iosRemotePairingUpdatedAt") if active else None
        )
        ios_connected_at = active.get("iosConnectedAt") if active else None
        pairing_proxy_fresh = (
            pairing_proxy_state == "bonjourReady"
            and isinstance(proxy_updated_at, (int, float))
            and isinstance(ios_connected_at, (int, float))
            and proxy_updated_at >= ios_connected_at
        )
        expected_configuration_online = bool(
            active
            and active.get("iosConfigurationRevision")
            == REQUIRED_IOS_CONFIGURATION_REVISION
            and active.get("iosNetworkMode") == REQUIRED_IOS_NETWORK_MODE
        )
        pairing_session_active = isinstance(pairing_state, str) and pairing_state in {
            "PAIRING_SYSTEM_UI_READY",
            "PAIRING_SYSTEM_UI_OPENING",
            "PAIRING_SYSTEM_UI_OPENED",
        }
        expected_build_online = bool(
            vpn_connected
            and expected_build is not None
            and active_build == expected_build
        )
        linux_host_connected = bool(active and active.get("linuxConnected"))
        return {
            "liveStatusAvailable": True,
            "agentOnline": agent_online or vpn_connected,
            "vpnConnected": vpn_connected,
            "linuxHostConnected": linux_host_connected,
            "agentBuild": active_build,
            "expectedBuildOnline": expected_build_online,
            "configurationRevision": (
                active.get("iosConfigurationRevision") if active else None
            ),
            "networkMode": active.get("iosNetworkMode") if active else None,
            "expectedConfigurationOnline": expected_configuration_online,
            "pairingProxyState": pairing_proxy_state,
            "pairingProxyFresh": pairing_proxy_fresh,
            "remotePairingState": remote_pairing_state,
            "remotePairingFresh": bool(
                remote_pairing_state == "ready"
                and isinstance(remote_pairing_updated_at, (int, float))
                and time.time() * 1000 - remote_pairing_updated_at < 120_000
            ),
            "pairingState": pairing_state,
            "pairingSessionActive": pairing_session_active,
            "readyForSystemPairing": bool(
                expected_build_online
                and expected_configuration_online
                and linux_host_connected
                and pairing_proxy_fresh
                and pairing_session_active
            ),
        }

    async def status(self, expected_build: str | None) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {self.token()}"}
        base = self.api_url.rstrip("/")
        timeout = ClientTimeout(total=3)
        async with ClientSession(headers=headers, timeout=timeout) as session:
            async with session.get(f"{base}/api/devices") as response:
                response.raise_for_status()
                devices = await response.json()
            async with session.get(f"{base}/api/packet-overlays") as response:
                response.raise_for_status()
                overlays = await response.json()
        if not isinstance(devices, dict) or not isinstance(overlays, dict):
            raise ValueError("Controller status response is invalid")
        return self.summarize(devices, overlays, expected_build)


class EnrollmentPortal:
    def __init__(
        self,
        public_base_url: str,
        state_dir: Path,
        certificate: Path,
        private_key: Path,
        certificate_chain: Path | None = None,
        ota_package: OtaPackage | None = None,
        controller_status_source: ControllerStatusSource | None = None,
    ) -> None:
        parsed = urlparse(public_base_url)
        if (
            parsed.scheme != "https"
            or not parsed.netloc
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(
                "public base URL must be an HTTPS URL without a query or fragment"
            )
        if not parsed.path or parsed.path == "/":
            raise ValueError("public base URL must include an unguessable path")
        self.public_base_url = public_base_url.rstrip("/")
        self.route_prefix = parsed.path.rstrip("/")
        self.state_dir = state_dir
        self.certificate = certificate
        self.private_key = private_key
        self.certificate_chain = certificate_chain
        self.ota_package = ota_package
        self.controller_status_source = controller_status_source
        self.challenge_path = state_dir / "challenge"
        self.device_path = state_dir / "device.json"
        self.ota_state_path = state_dir / "ota-download.json"
        self.challenge = self._load_or_create_challenge()

    def _load_or_create_challenge(self) -> str:
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_dir.chmod(0o700)
        if self.challenge_path.exists():
            challenge = self.challenge_path.read_text(encoding="ascii").strip()
            if len(challenge) >= 32:
                return challenge
        challenge = secrets.token_urlsafe(32)
        self.challenge_path.write_text(challenge + "\n", encoding="ascii")
        self.challenge_path.chmod(0o600)
        return challenge

    def device(self) -> dict[str, Any] | None:
        if not self.device_path.exists():
            return None
        value = json.loads(self.device_path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None

    def profile(self) -> bytes:
        payload = {
            "PayloadContent": {
                "URL": f"{self.public_base_url}/device",
                "DeviceAttributes": ["UDID", "VERSION", "PRODUCT", "DEVICE_NAME"],
                "Challenge": self.challenge,
            },
            "PayloadOrganization": "Serverized Controller",
            "PayloadDisplayName": "Serverized Controller Device Registration",
            "PayloadVersion": 1,
            "PayloadUUID": str(uuid.uuid4()).upper(),
            "PayloadIdentifier": "com.galatea.device-registration",
            "PayloadDescription": "Registers this device for a private test build.",
            "PayloadType": "Profile Service",
        }
        return sign_mobileconfig(
            plistlib.dumps(payload, fmt=plistlib.FMT_XML, sort_keys=False),
            self.certificate,
            self.private_key,
            self.certificate_chain,
        )

    def manifest(self) -> bytes:
        package = self.ota_package
        if package is None or not package.ipa.is_file():
            raise FileNotFoundError("signed IPA is not available")
        payload = {
            "items": [
                {
                    "assets": [
                        {
                            "kind": "software-package",
                            "url": self.versioned_ota_url("agent.ipa"),
                        }
                    ],
                    "metadata": {
                        "bundle-identifier": package.bundle_id,
                        "bundle-version": package.bundle_version,
                        "kind": "software",
                        "title": package.title,
                    },
                }
            ]
        }
        return plistlib.dumps(payload, fmt=plistlib.FMT_XML, sort_keys=False)

    def versioned_ota_url(self, resource: str) -> str:
        package = self.ota_package
        if package is None:
            raise FileNotFoundError("signed IPA is not available")
        return (
            f"{self.public_base_url}/{resource}?"
            + urlencode({"build": package.bundle_version})
        )

    @staticmethod
    def no_cache_headers() -> dict[str, str]:
        return {
            "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
            "Pragma": "no-cache",
        }

    def status_payload(self) -> dict[str, Any]:
        device = self.device()
        return {
            "registered": device is not None,
            "product": device.get("product") if device else None,
            "version": device.get("version") if device else None,
            "otaReady": bool(
                device is not None
                and self.ota_package is not None
                and self.ota_package.ipa.is_file()
            ),
            **self.ota_download_status(),
        }

    def ota_download_status(self) -> dict[str, Any]:
        empty = {
            "otaStage": "ready",
            "otaManifestRequestedAt": None,
            "otaPackageRequestedAt": None,
        }
        package = self.ota_package
        if package is None:
            return empty
        try:
            if (
                not self.ota_state_path.is_file()
                or stat.S_IMODE(self.ota_state_path.stat().st_mode) & 0o077
            ):
                return empty
            payload = json.loads(self.ota_state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return empty
        if (
            not isinstance(payload, dict)
            or payload.get("build") != package.bundle_version
        ):
            return empty
        stage = payload.get("stage")
        if stage not in {"manifest-requested", "package-requested"}:
            return empty
        return {
            "otaStage": stage,
            "otaManifestRequestedAt": payload.get("manifestRequestedAt"),
            "otaPackageRequestedAt": payload.get("packageRequestedAt"),
        }

    def record_ota_stage(self, stage: str) -> None:
        package = self.ota_package
        if package is None or stage not in {"manifest-requested", "package-requested"}:
            return
        previous = self.ota_download_status()
        now = time.time()
        payload = {
            "build": package.bundle_version,
            "stage": stage,
            "manifestRequestedAt": (
                previous["otaManifestRequestedAt"]
                if previous["otaManifestRequestedAt"] is not None
                else now
            ),
            "packageRequestedAt": (
                now
                if stage == "package-requested"
                else previous["otaPackageRequestedAt"]
            ),
        }
        _atomic_private_json(self.ota_state_path, payload)

    @staticmethod
    def is_system_ota_request(request: web.Request | None) -> bool:
        if request is None:
            return False
        user_agent = request.headers.get("User-Agent", "").lower()
        came_through_public_relay = bool(
            request.headers.get("CF-Connecting-IP")
            or request.headers.get("X-Forwarded-For")
        )
        return came_through_public_relay and any(
            marker in user_agent
            for marker in ("appstored", "itunesstored", "mobileasset", "itunes")
        )

    def system_pairing_status(self) -> dict[str, Any]:
        empty = {
            "systemPairingState": None,
            "systemPairingPin": None,
            "systemPairingPinExpiresAt": None,
        }
        package = self.ota_package
        path = package.system_pairing_status_file() if package is not None else None
        if path is None:
            return empty
        try:
            if (
                not path.is_file()
                or stat.S_IMODE(path.stat().st_mode) & 0o077
            ):
                return empty
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return empty
        if not isinstance(payload, dict):
            return empty
        state = payload.get("state")
        if not isinstance(state, str):
            return empty
        result = {**empty, "systemPairingState": state}
        pin = payload.get("pin")
        expires_at = payload.get("expiresAt")
        if (
            state == "pin-ready"
            and isinstance(pin, str)
            and re.fullmatch(r"\d{6}", pin)
            and isinstance(expires_at, (int, float))
            and expires_at > time.time()
        ):
            result["systemPairingPin"] = pin
            result["systemPairingPinExpiresAt"] = expires_at
        elif state == "pin-ready":
            result["systemPairingState"] = "pin-expired"
        return result

    async def live_status_payload(self) -> dict[str, Any]:
        state = {
            **self.status_payload(),
            **self.system_pairing_status(),
            "liveStatusAvailable": False,
            "agentOnline": False,
            "vpnConnected": False,
            "linuxHostConnected": False,
            "agentBuild": None,
            "expectedBuildOnline": False,
            "configurationRevision": None,
            "networkMode": None,
            "expectedConfigurationOnline": False,
            "pairingProxyState": None,
            "pairingProxyFresh": False,
            "remotePairingState": None,
            "remotePairingFresh": False,
            "pairingState": None,
            "pairingSessionActive": False,
            "readyForSystemPairing": False,
        }
        source = self.controller_status_source
        if source is None:
            return state
        expected_build = (
            self.ota_package.bundle_version if self.ota_package is not None else None
        )
        try:
            state.update(await source.status(expected_build))
        except Exception:
            pass
        if state["expectedBuildOnline"]:
            state["otaStage"] = "agent-online"
        state.update(self.system_pairing_status())
        return state

    async def index(self, _request: web.Request) -> web.Response:
        state = await self.live_status_payload()
        registered = bool(state["registered"])
        ota_ready = bool(state["otaReady"])
        if ota_ready:
            assert self.ota_package is not None
            build = html.escape(self.ota_package.bundle_version)
            install_url = html.escape(
                "itms-services://?"
                + urlencode(
                    {
                        "action": "download-manifest",
                        "url": self.versioned_ota_url("manifest.plist"),
                    }
                ),
                quote=True,
            )
            actions = [
                f'<a id="install-action" class="action" href="{install_url}">'
                f'安装 Gelato <span>Build {build}</span></a>'
            ]
            pairing_target = (
                self.ota_package.resolved_pairing_url()
                if self.ota_package is not None
                else None
            )
            if pairing_target:
                launch_url = html.escape(
                    f"{self.public_base_url}/open-agent?"
                    + urlencode({"build": self.ota_package.bundle_version}),
                    quote=True,
                )
                actions.append(
                    f'<a id="pair-action" class="action secondary" href="{launch_url}">'
                    "打开 Gelato 并配置 VPN</a>"
                )
            action = '<div class="actions">' + "".join(actions) + "</div>"
            guide = (
                '<ol id="first-run-guide">'
                "<li>安装 Gelato，并先尝试打开一次。</li>"
                "<li>若系统提示 Developer Mode Required：进入“设置 → 隐私与安全性 → "
                "开发者模式”，开启后按系统要求重启并再次确认，然后重新打开 Gelato。</li>"
                "<li>在 Gelato 中允许 VPN 配置，等待前三项预检完成。</li>"
                "<li>再进入“设置 → 隐私与安全性 → 开发者模式 → 其他设备”，选择 "
                "Linux 主机。</li>"
                "<li>回到本页查看并输入当次 6 位配对码。</li>"
                "</ol>"
            )
            if state["readyForSystemPairing"]:
                headline = "远程配对已就绪"
                detail = f"Build {build} · 本轮全部网络预检通过"
            elif (
                state["expectedBuildOnline"]
                and state["vpnConnected"]
                and state["linuxHostConnected"]
            ):
                headline = "Gelato 已安装并连接"
                detail = f"Build {build} · 正在完成远程配对预检"
            elif state["agentOnline"]:
                headline = "Gelato 已打开"
                detail = f"Build {build} · 正在等待 VPN 与 Linux Host"
            else:
                headline = "设备已登记"
                detail = f"签名安装包已就绪 · Build {build}"
        elif registered:
            action = '<button class="action" disabled>等待签名安装包</button>'
            guide = ""
            headline = "设备已登记"
            detail = "Linux 正在生成设备专属签名包"
        else:
            action = '<a class="action" href="profile.mobileconfig">登记此设备</a>'
            guide = ""
            headline = "真机网络登记"
            detail = "Serverized Controller"
        page = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>{headline}</title>
<style>
body{{margin:0;min-height:100vh;display:grid;place-items:center;font:17px -apple-system,BlinkMacSystemFont,sans-serif;background:#f2f2f7;color:#111}}
main{{width:min(88vw,420px);text-align:center}}h1{{font-size:28px;letter-spacing:0;margin:0 0 8px}}p{{margin:0 0 28px;color:#64646b}}
.action{{display:block;width:100%;box-sizing:border-box;border:0;border-radius:8px;padding:15px 18px;background:#0066cc;color:white;text-decoration:none;font:600 17px/1.4 -apple-system,BlinkMacSystemFont,sans-serif}}
.action span{{display:block;margin-top:2px;font-size:13px;font-weight:500;opacity:.78}}.action.busy{{background:#5856d6}}
.action+.action{{margin-top:12px}}.action.secondary{{background:#38383a}}
.action:disabled{{background:#8e8e93}}#live-status{{min-height:42px;margin:16px 0 0;font-size:14px;line-height:1.5}}
#pairing-code{{margin:18px 0 0;padding:14px;border-radius:10px;background:#e5e5ea;font:700 34px/1.1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.18em}}
.ota-progress{{margin:16px 0 0;padding:14px;border-radius:12px;background:#fff;text-align:left}}
.ota-track{{height:7px;overflow:hidden;border-radius:999px;background:#d1d1d6}}
.ota-fill{{height:100%;width:18%;border-radius:999px;background:#0a84ff;transition:width .35s ease}}
.ota-fill.active{{animation:ota-pulse 1.1s ease-in-out infinite alternate}}
.ota-label{{margin-top:9px;font-size:13px;line-height:1.45;color:#3a3a3c}}
@keyframes ota-pulse{{from{{opacity:.55}}to{{opacity:1}}}}
#first-run-guide{{margin:20px 0 0;padding:16px 16px 16px 38px;border-radius:12px;background:#fff;text-align:left;font-size:14px;line-height:1.55;color:#3a3a3c}}
#first-run-guide li+li{{margin-top:8px}}
@media(prefers-color-scheme:dark){{body{{background:#000;color:#fff}}p{{color:#aaa}}}}
</style></head><body><main><h1 id="headline">{headline}</h1><p id="detail">{detail}</p>{action}<div id="ota-progress" class="ota-progress" hidden><div class="ota-track"><div id="ota-fill" class="ota-fill active"></div></div><div id="ota-label" class="ota-label"></div></div>{guide}<div id="pairing-code" hidden></div><p id="live-status" role="status" aria-live="polite"></p></main>
<script>
const installAction=document.getElementById("install-action");
const pairAction=document.getElementById("pair-action");
const pairingCode=document.getElementById("pairing-code");
const liveStatus=document.getElementById("live-status");
const headline=document.getElementById("headline");
const detail=document.getElementById("detail");
const otaProgress=document.getElementById("ota-progress");
const otaFill=document.getElementById("ota-fill");
const otaLabel=document.getElementById("ota-label");
const expectedBuild={json.dumps(self.ota_package.bundle_version if self.ota_package else None)};
const requestKey="serverized-install-request-"+expectedBuild;
let latestState={{}};
if(installAction){{installAction.addEventListener("click",event=>{{
  event.preventDefault();
  const target=installAction.getAttribute("href");
  installAction.classList.add("busy");
  installAction.textContent="正在请求系统安装…";
  liveStatus.textContent="等待 iOS 安装确认";
  window.localStorage.setItem(requestKey,String(Date.now()));
  renderOtaStage({{}});
  window.location.href=target;
  window.setTimeout(()=>{{liveStatus.textContent="安装完成后先尝试打开一次；若系统要求 Developer Mode，请按下方第 2 步开启并重启";}},1800);
}});}}
if(pairAction){{pairAction.addEventListener("click",()=>{{
  pairAction.classList.add("busy");
  pairAction.textContent="正在打开 Gelato…";
  liveStatus.textContent="正在读取最新配对链接";
}});}}
function renderOtaStage(state){{
  const localRequestedAt=Number(window.localStorage.getItem(requestKey)||0);
  const serverStage=state.otaStage||"ready";
  const stage=serverStage!=="ready"?serverStage:(localRequestedAt?"install-requested":"ready");
  if(stage==="ready"){{
    otaProgress.hidden=true;
    return;
  }}
  otaProgress.hidden=false;
  let startedAt=Number(state.otaPackageRequestedAt||state.otaManifestRequestedAt||localRequestedAt||0);
  if(startedAt>100000000000)startedAt/=1000;
  const elapsed=startedAt?Math.max(0,Math.floor(Date.now()/1000-startedAt)):0;
  if(stage==="agent-online"){{
    otaFill.style.width="100%";
    otaFill.classList.remove("active");
    otaLabel.textContent="Build "+expectedBuild+" 已启动并由 Controller 验证";
  }}else if(stage==="package-requested"){{
    otaFill.style.width="68%";
    otaFill.classList.add("active");
    otaLabel.textContent="iOS 已请求安装包 · "+elapsed+" 秒。正在下载、校验或安装；系统不向网页提供字节百分比，请同时查看主屏幕图标";
  }}else if(stage==="manifest-requested"){{
    otaFill.style.width="38%";
    otaFill.classList.add("active");
    otaLabel.textContent="iOS 已读取安装清单 · "+elapsed+" 秒，等待系统请求安装包";
  }}else{{
    otaFill.style.width="18%";
    otaFill.classList.add("active");
    otaLabel.textContent="安装请求已提交给 iOS · "+elapsed+" 秒，等待系统安装服务响应";
  }}
}}
function renderStatus(state){{
  latestState=state;
  renderOtaStage(state);
  pairingCode.hidden=true;
  if(state.expectedBuildOnline&&state.remotePairingFresh){{
    headline.textContent="Linux 控制通道已就绪";
    detail.textContent="RemoteXPC 已由后台 Packet Tunnel 保持";
    liveStatus.textContent="现在可以离开 Gelato，控制不会依赖 App 前台运行";
    if(pairAction){{pairAction.classList.remove("busy");pairAction.textContent="打开 Gelato 查看状态";}}
    return;
  }}
  if(!state.expectedBuildOnline&&state.agentBuild&&String(state.agentBuild)!==String(expectedBuild)){{
    headline.textContent="检测到旧版 Gelato";
    detail.textContent="当前 Build "+state.agentBuild+" · 目标 Build "+expectedBuild;
    liveStatus.textContent="旧版 VPN 在线不代表 Build "+expectedBuild+" 已安装；请继续查看上方 OTA 阶段";
    if(pairAction){{pairAction.classList.remove("busy");pairAction.textContent="安装后打开 Build "+expectedBuild;}}
    return;
  }}
  if(state.systemPairingState==="paired"){{
    headline.textContent="Linux 远程配对完成";
    detail.textContent="系统配对记录已由 Linux 保存";
    liveStatus.textContent="正在建立 RemoteXPC 并验证跨 App 控制";
    if(pairAction){{pairAction.classList.remove("busy");pairAction.textContent="重新打开 Gelato";}}
    return;
  }}
  if(state.systemPairingPin){{
    headline.textContent="在系统设置中输入配对码";
    detail.textContent="在“隐私与安全性 → 开发者模式 → 其他设备”选择 Linux 主机";
    pairingCode.textContent=state.systemPairingPin;
    pairingCode.hidden=false;
    liveStatus.textContent="配对码仅用于当前系统配对会话，5 分钟后失效";
    return;
  }}
  if(state.readyForSystemPairing){{
    headline.textContent="远程配对已就绪";
    detail.textContent="Build "+expectedBuild+" · 本轮全部网络预检通过";
    liveStatus.textContent="请进入“设置 → 隐私与安全性 → 开发者模式 → 其他设备”，选择 Linux 主机";
    if(pairAction){{pairAction.classList.remove("busy");pairAction.textContent="重新打开 Gelato";}}
    return;
  }}
  if(state.expectedBuildOnline&&state.vpnConnected&&state.linuxHostConnected){{
    headline.textContent="Gelato 已安装并连接";
    detail.textContent="Build "+expectedBuild+" · 正在完成远程配对预检";
    liveStatus.textContent="等待当次 Bonjour 代理与系统配对会话";
    return;
  }}
  if(state.agentOnline){{
    headline.textContent="Gelato 已打开";
    detail.textContent="Build "+(state.agentBuild||"未知")+" · 正在等待 VPN 与 Linux Host";
    liveStatus.textContent=state.vpnConnected?"VPN 已连接，等待 Linux Host":"Gelato 已上线，正在配置 VPN";
    return;
  }}
  if(window.localStorage.getItem(requestKey)){{
    liveStatus.textContent="尚未检测到 Build "+expectedBuild+" 在线（这不代表未安装）。请查看主屏幕安装图标；安装后先尝试打开 Gelato";
  }}
}}
async function refreshStatus(){{
  try{{
    const response=await fetch("status",{{cache:"no-store"}});
    if(response.ok)renderStatus(await response.json());
  }}catch(_error){{}}
}}
refreshStatus();
window.setInterval(refreshStatus,2000);
window.setInterval(()=>renderOtaStage(latestState),1000);
window.addEventListener("pageshow",refreshStatus);
</script></body></html>"""
        return web.Response(
            text=page,
            content_type="text/html",
            headers=self.no_cache_headers(),
        )

    async def download_profile(self, _request: web.Request) -> web.Response:
        if self.device() is not None:
            raise web.HTTPGone(text="device registration is already complete")
        return web.Response(
            body=self.profile(),
            content_type=PROFILE_MIME,
            headers={
                "Content-Disposition": 'attachment; filename="register.mobileconfig"'
            },
        )

    async def register_device(self, request: web.Request) -> web.Response:
        if self.device() is not None:
            raise web.HTTPConflict(text="device registration is already complete")
        attributes = extract_signed_device_attributes(
            await request.read(), self.challenge
        )
        record = {
            "udid": attributes["UDID"],
            "product": attributes.get("PRODUCT"),
            "version": attributes.get("VERSION"),
            "deviceName": attributes.get("DEVICE_NAME"),
            "registeredAt": time.time(),
            "source": "ios-profile-service-over-https",
            "cmsSignatureVerified": True,
            "challengeVerified": True,
        }
        _atomic_private_json(self.device_path, record)
        raise web.HTTPMovedPermanently(location=f"{self.public_base_url}/")

    async def status(self, _request: web.Request) -> web.Response:
        return web.json_response(
            await self.live_status_payload(), headers=self.no_cache_headers()
        )

    async def open_agent(self, _request: web.Request) -> web.Response:
        if self.ota_package is None:
            raise web.HTTPServiceUnavailable(text="Gelato iOS package is unavailable")
        target = self.ota_package.resolved_pairing_url()
        if target is None:
            raise web.HTTPServiceUnavailable(text="Pairing link is unavailable")
        parsed = urlparse(target)
        query = [
            item
            for item in parse_qsl(parsed.query, keep_blank_values=True)
            if item[0] not in {"requiredBuild", "updateManifestUrl"}
        ]
        query.extend(
            [
                ("requiredBuild", self.ota_package.bundle_version),
                ("updateManifestUrl", self.versioned_ota_url("manifest.plist")),
            ]
        )
        return web.Response(
            status=302,
            headers={
                "Location": parsed._replace(query=urlencode(query)).geturl(),
                **self.no_cache_headers(),
            },
        )

    async def manifest_response(self, request: web.Request) -> web.Response:
        if self.device() is None:
            raise web.HTTPForbidden(text="device registration is incomplete")
        try:
            manifest = self.manifest()
        except FileNotFoundError as error:
            raise web.HTTPServiceUnavailable(text=str(error)) from error
        if self.is_system_ota_request(request):
            self.record_ota_stage("manifest-requested")
        return web.Response(
            body=manifest,
            content_type="text/xml",
            headers=self.no_cache_headers(),
        )

    async def ipa_response(self, request: web.Request) -> web.StreamResponse:
        if self.device() is None or not self.status_payload()["otaReady"]:
            raise web.HTTPForbidden(text="signed package is not available")
        assert self.ota_package is not None
        if self.is_system_ota_request(request):
            self.record_ota_stage("package-requested")
        return web.FileResponse(
            self.ota_package.ipa,
            headers={
                "Content-Type": IPA_MIME,
                "Content-Disposition": 'attachment; filename="Gelato.ipa"',
                **self.no_cache_headers(),
            },
        )

    def app(self) -> web.Application:
        application = web.Application(client_max_size=512 * 1024)
        route = self.route_prefix
        application.add_routes(
            [
                web.get(f"{route}/", self.index),
                web.get(f"{route}/profile.mobileconfig", self.download_profile),
                web.post(f"{route}/device", self.register_device),
                web.get(f"{route}/status", self.status),
                web.get(f"{route}/open-agent", self.open_agent),
                web.get(f"{route}/manifest.plist", self.manifest_response),
                web.get(f"{route}/agent.ipa", self.ipa_response),
            ]
        )
        return application


def serve_enrollment_portal(
    portal: EnrollmentPortal,
    bind: str,
    port: int,
    direct_tls: bool = False,
    tls_certificate: Path | None = None,
) -> None:
    ssl_context = None
    if direct_tls:
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_context.minimum_version = ssl.TLSVersion.TLSv1_2
        ssl_context.load_cert_chain(
            tls_certificate or portal.certificate, portal.private_key
        )
    web.run_app(
        portal.app(),
        host=bind,
        port=port,
        print=None,
        access_log=None,
        ssl_context=ssl_context,
    )
