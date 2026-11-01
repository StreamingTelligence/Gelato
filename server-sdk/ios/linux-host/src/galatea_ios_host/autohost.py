from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import signal
import stat
import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from aiohttp import ClientResponseError, ClientSession, ClientTimeout

from .api import LinuxDeviceHubHost, serve
from .constants import DEFAULT_AGENT_BUNDLE_ID, DEFAULT_INTERFACE
from .overlay import build_websocket_url


def read_private_text(path: Path) -> str:
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise PermissionError(f"private file has unsafe permissions: {path}")
    value = path.read_text(encoding="utf-8").strip()
    if not value:
        raise ValueError(f"private file is empty: {path}")
    return value


def atomic_private_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    owner = path.stat() if path.exists() else path.parent.stat()
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(value.rstrip() + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    if os.geteuid() == 0:
        os.chown(temporary, owner.st_uid, owner.st_gid)
    temporary.replace(path)


def pairing_ui_status_path(pairing_url_file: Path) -> Path:
    return pairing_url_file.with_name(pairing_url_file.name + ".system-pairing.json")


def write_pairing_ui_status(path: Path, payload: dict[str, Any]) -> None:
    atomic_private_text(path, json.dumps(payload, separators=(",", ":"), sort_keys=True))


def validate_public_controller_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("controller URL must be an HTTPS URL without query or fragment")
    return value.rstrip("/")


def validate_controller_api_url(value: str) -> str:
    parsed = urlparse(value)
    loopback = parsed.hostname in {"127.0.0.1", "::1", "localhost"}
    if not parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("controller API URL must include a host without query or fragment")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise ValueError("controller API URL must use HTTPS or loopback HTTP")
    return value.rstrip("/")


def validate_pairing_url(value: str) -> str:
    parsed = urlparse(value)
    query = parse_qs(parsed.query)
    if (
        parsed.scheme != "galatea"
        or parsed.netloc != "pair"
        or not query.get("controllerUrl")
        or not query.get("pairingCode")
    ):
        raise ValueError("Controller returned an incomplete iOS pairing URL")
    return value


def select_online_ios_device(payload: dict[str, Any], requested_device_id: str | None) -> str | None:
    devices = payload.get("devices")
    if not isinstance(devices, list):
        raise ValueError("Controller devices response is malformed")
    online = []
    for device in devices:
        if not isinstance(device, dict):
            continue
        os_record = device.get("os")
        connection = device.get("connection")
        if (
            not isinstance(os_record, dict)
            or os_record.get("family") != "ios"
            or not isinstance(connection, dict)
            or connection.get("online") is not True
        ):
            continue
        device_id = device.get("deviceId")
        if isinstance(device_id, str) and device_id:
            online.append(device_id)
    if requested_device_id is not None:
        return requested_device_id if requested_device_id in online else None
    if len(online) > 1:
        raise RuntimeError("more than one online iOS device; configure --device-id")
    return online[0] if online else None


@dataclass(frozen=True)
class IosOverlayRequirements:
    client_build: str | None = None
    configuration_revision: int | None = None
    network_mode: str | None = None

    def validated(self) -> IosOverlayRequirements:
        configured = (
            self.client_build is not None,
            self.configuration_revision is not None,
            self.network_mode is not None,
        )
        if any(configured) and not all(configured):
            raise ValueError(
                "client build, configuration revision, and network mode must be required together"
            )
        if self.client_build is not None and not re.fullmatch(
            r"[A-Za-z0-9._-]{1,32}", self.client_build
        ):
            raise ValueError("required iOS client build is invalid")
        if self.configuration_revision is not None and not (
            1 <= self.configuration_revision <= 999_999
        ):
            raise ValueError("required iOS configuration revision is invalid")
        if self.network_mode is not None and not re.fullmatch(
            r"[a-z0-9-]{1,64}", self.network_mode
        ):
            raise ValueError("required iOS network mode is invalid")
        return self

    def matches(self, overlay: dict[str, Any]) -> bool:
        if self.client_build is None:
            return True
        actual_build = str(overlay.get("iosClientBuild"))
        if self.client_build.isdigit() and actual_build.isdigit():
            build_matches = int(actual_build) >= int(self.client_build)
        else:
            build_matches = actual_build == self.client_build
        return (
            build_matches
            and overlay.get("iosConfigurationRevision") == self.configuration_revision
            and overlay.get("iosNetworkMode") == self.network_mode
        )


def select_connected_ios_overlay(
    payload: dict[str, Any],
    ios_device_ids: set[str],
    requested_device_id: str | None,
    requirements: IosOverlayRequirements = IosOverlayRequirements(),
) -> str | None:
    overlays = payload.get("overlays")
    if not isinstance(overlays, list):
        raise ValueError("Controller packet overlays response is malformed")
    connected: list[tuple[str, float, int]] = []
    for overlay in overlays:
        if (
            not isinstance(overlay, dict)
            or overlay.get("iosConnected") is not True
            or not requirements.matches(overlay)
        ):
            continue
        device_id = overlay.get("deviceId")
        if isinstance(device_id, str) and device_id in ios_device_ids:
            connected_at = overlay.get("iosConnectedAt")
            revision = overlay.get("iosConfigurationRevision")
            connected.append(
                (
                    device_id,
                    float(connected_at) if isinstance(connected_at, (int, float)) else 0.0,
                    int(revision) if isinstance(revision, int) else 0,
                )
            )
    connected.sort(key=lambda item: (item[1], item[2]), reverse=True)
    if requested_device_id is not None:
        selected = next((item for item in connected if item[0] == requested_device_id), None)
        return selected[0] if selected is not None else None
    return connected[0][0] if connected else None


def select_remote_pairing_hint(
    payload: dict[str, Any],
    device_id: str,
) -> tuple[str, int, int | float] | None:
    overlays = payload.get("overlays")
    if not isinstance(overlays, list):
        return None
    candidates = [
        overlay
        for overlay in overlays
        if isinstance(overlay, dict)
        and overlay.get("deviceId") == device_id
        and overlay.get("iosConnected") is True
        and overlay.get("iosRemotePairingState") == "ready"
        and overlay.get("iosRemotePairingTransport") == "deviceLoopback"
    ]
    selected = max(
        candidates,
        key=lambda overlay: int(overlay.get("iosRemotePairingUpdatedAt") or 0),
        default=None,
    )
    if selected is None:
        return None
    identifier = selected.get("iosRemotePairingIdentifier")
    port = selected.get("iosRemotePairingPort")
    updated_at = selected.get("iosRemotePairingUpdatedAt")
    txt_record = selected.get("iosRemotePairingTxtBase64")
    if (
        not isinstance(identifier, str)
        or not isinstance(port, int)
        or isinstance(port, bool)
        or not 0 < port <= 65535
        or not isinstance(updated_at, (int, float))
        or isinstance(updated_at, bool)
        or not isinstance(txt_record, str)
        or not txt_record
    ):
        return None
    return identifier, port, updated_at


def remote_pairing_hint_from_agent_result(
    result: dict[str, Any],
) -> tuple[str, int, int | float] | None:
    services = result.get("services")
    if not isinstance(services, list):
        return None
    candidates: list[tuple[str, int, int | float]] = []
    for service in services:
        if not isinstance(service, dict):
            continue
        if service.get("serviceType") not in {
            "_remotepairing._tcp.",
            "_remotepairing._tcp",
        }:
            continue
        txt = service.get("txt")
        identifier = txt.get("identifier") if isinstance(txt, dict) else None
        port = service.get("port")
        if (
            isinstance(identifier, str)
            and isinstance(port, int)
            and not isinstance(port, bool)
            and 0 < port <= 65535
        ):
            candidates.append((identifier, port, time.time() * 1000))
    return candidates[0] if len(candidates) == 1 else None


def select_on_device_wda_state(
    payload: dict[str, Any],
    device_id: str,
) -> str | None:
    overlays = payload.get("overlays")
    if not isinstance(overlays, list):
        raise ValueError("Controller overlays response is malformed")
    matches = [
        overlay.get("iosOnDeviceRemoteXpcState")
        for overlay in overlays
        if isinstance(overlay, dict)
        and overlay.get("deviceId") == device_id
        and overlay.get("iosConnected") is True
        and isinstance(overlay.get("iosOnDeviceRemoteXpcState"), str)
    ]
    return matches[0] if len(matches) == 1 else None


@dataclass(frozen=True)
class WdaPackageArtifact:
    data: bytes
    sha256: str


def load_wda_package(path: Path | None) -> WdaPackageArtifact | None:
    if path is None or not path.is_file():
        return None
    package = path.read_bytes()
    if not package or len(package) > 32 * 1024 * 1024:
        raise ValueError("WDA IPA must contain 1 to 32 MiB")
    return WdaPackageArtifact(
        data=package,
        sha256=hashlib.sha256(package).hexdigest(),
    )


@dataclass(frozen=True)
class AutomaticHostConfig:
    controller_url: str
    controller_api_url: str
    controller_token_file: Path
    state_dir: Path
    pairing_url_file: Path | None = None
    pairing_ttl_seconds: int = 1800
    poll_interval: float = 2.0
    requested_device_id: str | None = None
    interface: str = DEFAULT_INTERFACE
    requested_udid: str | None = None
    agent_bundle_id: str = DEFAULT_AGENT_BUNDLE_ID
    wda_package_path: Path | None = None
    required_client_build: str | None = None
    required_configuration_revision: int | None = None
    required_network_mode: str | None = None
    bind: str = "127.0.0.1"
    port: int = 8181

    def validated(self) -> AutomaticHostConfig:
        validate_public_controller_url(self.controller_url)
        validate_controller_api_url(self.controller_api_url)
        if self.pairing_ttl_seconds < 120:
            raise ValueError("pairing TTL must be at least 120 seconds")
        if self.poll_interval < 0.25:
            raise ValueError("poll interval must be at least 0.25 seconds")
        if self.bind not in {"127.0.0.1", "::1", "localhost"}:
            raise ValueError("automatic Linux Host API must bind to loopback")
        if self.wda_package_path is not None:
            package = self.wda_package_path.expanduser()
            if not package.exists() or (
                not package.is_file() and not package.is_dir()
            ):
                raise ValueError("WDA package path must be an existing IPA or app directory")
        self.overlay_requirements.validated()
        return self

    @property
    def overlay_requirements(self) -> IosOverlayRequirements:
        return IosOverlayRequirements(
            client_build=self.required_client_build,
            configuration_revision=self.required_configuration_revision,
            network_mode=self.required_network_mode,
        )


class ControllerClient:
    def __init__(self, api_url: str, token: str) -> None:
        self.api_url = validate_controller_api_url(api_url)
        self._session = ClientSession(
            headers={"authorization": f"Bearer {token}"},
            timeout=ClientTimeout(total=15),
        )

    async def close(self) -> None:
        await self._session.close()

    async def _json(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        async with self._session.request(method, f"{self.api_url}{path}", json=body) as response:
            text = await response.text()
            if response.status >= 400:
                raise ClientResponseError(
                    response.request_info,
                    response.history,
                    status=response.status,
                    message=text[:500],
                    headers=response.headers,
                )
            payload = json.loads(text) if text else {}
            if not isinstance(payload, dict):
                raise ValueError(f"Controller {path} response is not an object")
            return payload

    async def devices(self) -> dict[str, Any]:
        return await self._json("GET", "/api/devices")

    async def overlays(self) -> dict[str, Any]:
        return await self._json("GET", "/api/packet-overlays")

    async def pairings(self) -> dict[str, Any]:
        return await self._json("GET", "/api/pairings")

    async def create_pairing(self, controller_url: str, ttl_seconds: int) -> str:
        payload = await self._json(
            "POST",
            "/api/pairing-sessions",
            {
                "agentKind": "ios",
                "controllerUrl": controller_url,
                "ttlMs": ttl_seconds * 1000,
            },
        )
        session = payload.get("session")
        setup_url = session.get("setupUrl") if isinstance(session, dict) else None
        if not isinstance(setup_url, str):
            raise ValueError("Controller pairing response has no setupUrl")
        return validate_pairing_url(setup_url)

    async def create_overlay(self, device_id: str, controller_url: str) -> tuple[str, str]:
        payload = await self._json(
            "POST",
            f"/api/devices/{device_id}/packet-overlay/sessions",
            {"controllerUrl": controller_url},
        )
        session = payload.get("session")
        token = session.get("sidecarToken") if isinstance(session, dict) else None
        if not isinstance(token, str) or len(token) < 20:
            raise ValueError("Controller overlay response has no valid host token")
        return build_websocket_url(controller_url, device_id), token

    async def send_command(
        self,
        device_id: str,
        command: dict[str, Any],
        timeout_ms: int = 30_000,
    ) -> dict[str, Any]:
        payload = await self._json(
            "POST",
            f"/api/devices/{device_id}/commands",
            {
                **command,
                "deadlineMs": timeout_ms,
            },
        )
        terminal = payload.get("command")
        if not isinstance(terminal, dict):
            raise ValueError("Controller command response has no terminal command")
        if terminal.get("state") != "completed":
            raise ValueError(str(terminal.get("error") or "Controller command failed"))
        result = terminal.get("result")
        return result if isinstance(result, dict) else {}

    async def ensure_wda_package(
        self,
        device_id: str,
        package: WdaPackageArtifact,
    ) -> dict[str, Any]:
        async with self._session.post(
            f"{self.api_url}/api/devices/{device_id}/streams",
            params={
                "purpose": "file",
                "contentType": "application/vnd.apple.itunes-store-archive",
            },
            data=package.data,
            headers={"content-type": "application/octet-stream"},
        ) as response:
            text = await response.text()
            if response.status >= 400:
                raise ClientResponseError(
                    response.request_info,
                    response.history,
                    status=response.status,
                    message=text[:500],
                    headers=response.headers,
                )
            payload = json.loads(text) if text else {}
        stream = payload.get("stream") if isinstance(payload, dict) else None
        if not isinstance(stream, dict):
            raise ValueError("Controller stream response is malformed")
        stream_id = stream.get("streamId")
        agent_path = stream.get("agentPath")
        stream_sha256 = stream.get("sha256")
        expected_bytes = stream.get("expectedBytes")
        if (
            not isinstance(stream_id, str)
            or not isinstance(agent_path, str)
            or stream_sha256 != package.sha256
            or expected_bytes != len(package.data)
        ):
            raise ValueError("Controller WDA stream metadata did not verify")
        return await self.send_command(
            device_id,
            {
                "capability": "vendor.apple.wda.ensure",
                "capabilityVersion": 1,
                "arguments": {
                    "packageStream": {
                        "streamId": stream_id,
                        "path": agent_path,
                        "sha256": package.sha256,
                        "sizeBytes": len(package.data),
                    }
                },
                "idempotency": "idempotent",
            },
            timeout_ms=20_000,
        )

    async def send_system_pairing_pin(
        self,
        device_id: str,
        pin: str,
        expires_at_ms: int,
    ) -> None:
        payload = await self._json(
            "POST",
            f"/api/devices/{device_id}/system-pairing-pin",
            {"pin": pin, "expiresAt": expires_at_ms},
        )
        if (
            payload.get("accepted") is not True
        ):
            raise RuntimeError("Controller did not deliver the pairing PIN")

    async def clear_system_pairing_pin(self, device_id: str) -> None:
        payload = await self._json(
            "POST",
            f"/api/devices/{device_id}/system-pairing-complete",
        )
        if payload.get("accepted") is not True:
            raise RuntimeError("Controller did not accept pairing completion")


async def confirm_system_pairing_on_agent(
    client: ControllerClient,
    device_id: str,
) -> None:
    result = await client.send_command(
        device_id,
        {
            "capability": "device.system-pairing.confirm",
            "capabilityVersion": 1,
            "arguments": {},
            "idempotency": "side-effecting",
        },
        timeout_ms=7_000,
    )
    if result.get("accepted") is not True:
        raise RuntimeError("Gelato device app did not accept the system pairing confirmation")


async def maintain_pairing_link(
    client: ControllerClient,
    controller_url: str,
    pairing_url_file: Path,
    ttl_seconds: int,
) -> None:
    retry_delay = min(10.0, ttl_seconds / 4)
    while True:
        try:
            setup_url = await client.create_pairing(controller_url, ttl_seconds)
            atomic_private_text(pairing_url_file, setup_url)
            print(json.dumps({"event": "pairing-link-renewed", "ttlSeconds": ttl_seconds}), flush=True)
            await asyncio.sleep(max(60.0, ttl_seconds / 2))
        except asyncio.CancelledError:
            raise
        except Exception as error:
            print(json.dumps({"event": "pairing-link-error", "error": str(error)}), flush=True)
            await asyncio.sleep(retry_delay)


async def wait_for_online_device(
    client: ControllerClient,
    requested_device_id: str | None,
    poll_interval: float,
) -> str:
    last_error: str | None = None
    while True:
        try:
            device_id = select_online_ios_device(await client.devices(), requested_device_id)
            if device_id is not None:
                return device_id
            last_error = None
        except asyncio.CancelledError:
            raise
        except Exception as error:
            message = str(error)
            if message != last_error:
                print(json.dumps({"event": "controller-wait-error", "error": message}), flush=True)
                last_error = message
        await asyncio.sleep(poll_interval)


async def wait_for_device_overlay(
    client: ControllerClient,
    controller_url: str,
    requested_device_id: str | None,
    poll_interval: float,
    requirements: IosOverlayRequirements = IosOverlayRequirements(),
) -> tuple[str, str, str]:
    last_error: str | None = None
    while True:
        try:
            selected = await resolve_device_overlay(
                client,
                controller_url,
                requested_device_id,
                requirements,
            )
            if selected is not None:
                return selected
            last_error = None
        except asyncio.CancelledError:
            raise
        except Exception as error:
            message = str(error)
            if message != last_error:
                print(json.dumps({"event": "controller-wait-error", "error": message}), flush=True)
                last_error = message
        await asyncio.sleep(poll_interval)


async def resolve_device_overlay(
    client: ControllerClient,
    controller_url: str,
    requested_device_id: str | None,
    requirements: IosOverlayRequirements = IosOverlayRequirements(),
) -> tuple[str, str, str] | None:
    devices_payload = await client.devices()
    devices = devices_payload.get("devices")
    ios_device_ids = {
        str(device.get("deviceId"))
        for device in devices
        if isinstance(device, dict)
        and isinstance(device.get("os"), dict)
        and device["os"].get("family") == "ios"
        and device.get("deviceId")
    } if isinstance(devices, list) else set()
    pairings = (await client.pairings()).get("pairings")
    if isinstance(pairings, list):
        ios_device_ids.update(
            str(pairing.get("deviceId"))
            for pairing in pairings
            if isinstance(pairing, dict)
            and pairing.get("agentKind") == "ios"
            and pairing.get("deviceId")
        )
    overlays_payload = await client.overlays()
    existing = select_connected_ios_overlay(
        overlays_payload,
        ios_device_ids,
        requested_device_id,
        requirements,
    )
    if existing is not None:
        websocket_url, token = await client.create_overlay(existing, controller_url)
        return existing, websocket_url, token
    overlays = overlays_payload.get("overlays")
    incompatible_connected = any(
        isinstance(overlay, dict)
        and overlay.get("iosConnected") is True
        and overlay.get("deviceId") in ios_device_ids
        and (
            requested_device_id is None
            or overlay.get("deviceId") == requested_device_id
        )
        for overlay in (overlays if isinstance(overlays, list) else [])
    )
    if incompatible_connected:
        return None
    device_id = select_online_ios_device(devices_payload, requested_device_id)
    if device_id is None:
        return None
    websocket_url, token = await client.create_overlay(device_id, controller_url)
    return device_id, websocket_url, token


async def run_automatic_host(config: AutomaticHostConfig) -> None:
    config.validated()
    wda_package = load_wda_package(config.wda_package_path)
    token = read_private_text(config.controller_token_file)
    client = ControllerClient(config.controller_api_url, token)
    pairing_task = None
    serve_task: asyncio.Task[None] | None = None
    host_stop: asyncio.Event | None = None
    current_host: LinuxDeviceHubHost | None = None
    current_device_id: str | None = None
    current_websocket_url: str | None = None
    current_overlay_token: str | None = None
    last_agent_discovery_at = 0.0
    last_wda_ensure_at = 0.0
    pairing_notification_tasks: set[asyncio.Task[None]] = set()
    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signame in ("SIGINT", "SIGTERM"):
        with suppress(NotImplementedError):
            loop.add_signal_handler(getattr(signal, signame), shutdown.set)

    async def stop_active_host() -> None:
        nonlocal serve_task, host_stop, current_host, current_device_id, current_websocket_url, current_overlay_token
        if host_stop is not None:
            host_stop.set()
        if serve_task is not None:
            with suppress(asyncio.CancelledError):
                await serve_task
        serve_task = None
        host_stop = None
        current_host = None
        current_device_id = None
        current_websocket_url = None
        current_overlay_token = None

    async def start_host(device_id: str, websocket_url: str, overlay_token: str) -> None:
        nonlocal serve_task, host_stop, current_host, current_device_id, current_websocket_url, current_overlay_token
        nonlocal last_agent_discovery_at, last_wda_ensure_at
        pairing_status_file = (
            pairing_ui_status_path(config.pairing_url_file)
            if config.pairing_url_file is not None
            else None
        )
        if pairing_status_file is not None:
            write_pairing_ui_status(
                pairing_status_file,
                {
                    "state": "waiting-for-system-settings",
                    "deviceId": device_id,
                    "updatedAt": time.time(),
                },
            )

        async def notify_agent_pairing_complete() -> None:
            try:
                await client.clear_system_pairing_pin(device_id)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                print(
                    json.dumps(
                        {
                            "event": "agent-pairing-notification-clear-error",
                            "errorType": type(error).__name__,
                        }
                    ),
                    flush=True,
                )
            try:
                await confirm_system_pairing_on_agent(client, device_id)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                print(
                    json.dumps(
                        {
                            "event": "agent-pairing-confirmation-error",
                            "errorType": type(error).__name__,
                        }
                    ),
                    flush=True,
                )
            else:
                print(
                    json.dumps({"event": "agent-pairing-confirmed"}),
                    flush=True,
                )

        async def notify_agent_pairing_pin(pin: str, expires_at: float) -> None:
            try:
                await client.send_system_pairing_pin(
                    device_id,
                    pin,
                    int(expires_at * 1000),
                )
            except asyncio.CancelledError:
                raise
            except Exception as error:
                diagnostic: dict[str, object] = {}
                if isinstance(error, ClientResponseError):
                    diagnostic["httpStatus"] = error.status
                    # The Controller may include the command failure in its
                    # response body. Keep enough to diagnose notification
                    # delivery without ever logging a six-digit pairing PIN.
                    diagnostic["detail"] = re.sub(
                        r"(?<!\d)\d{6}(?!\d)", "[redacted-pin]", error.message[:300]
                    )
                print(
                    json.dumps(
                        {
                            "event": "agent-pairing-pin-notification-error",
                            "errorType": type(error).__name__,
                            **diagnostic,
                        }
                    ),
                    flush=True,
                )
            else:
                print(
                    json.dumps({"event": "agent-pairing-pin-notified"}),
                    flush=True,
                )

        def on_pairing_event(event: dict[str, object]) -> None:
            event_name = event.get("event")
            now = time.time()
            if event_name == "pair-host-ready":
                if pairing_status_file is not None:
                    write_pairing_ui_status(
                        pairing_status_file,
                        {
                            "state": "waiting-for-system-settings",
                            "deviceId": device_id,
                            "updatedAt": now,
                        },
                    )
                return
            if event_name == "pin":
                pin = event.get("pin")
                if not (
                    isinstance(pin, str) and len(pin) == 6 and pin.isdigit()
                ):
                    return
                expires_at = now + 300
                if pairing_status_file is not None:
                    write_pairing_ui_status(
                        pairing_status_file,
                        {
                            "state": "pin-ready",
                            "pin": pin,
                            "deviceId": device_id,
                            "updatedAt": now,
                            "expiresAt": expires_at,
                        },
                    )
                print(
                    json.dumps({"event": "system-pairing-pin-ready", "deviceId": device_id}),
                    flush=True,
                )
                task = asyncio.create_task(
                    notify_agent_pairing_pin(pin, expires_at),
                    name="agent-system-pairing-pin-notification",
                )
                pairing_notification_tasks.add(task)
                task.add_done_callback(pairing_notification_tasks.discard)
                return
            if event_name not in {"paired", "pairing-error"}:
                return
            payload: dict[str, Any] = {
                "state": "paired" if event_name == "paired" else "pairing-error",
                "deviceId": device_id,
                "updatedAt": now,
            }
            if event_name == "pairing-error" and isinstance(event.get("error"), str):
                payload["error"] = event["error"]
            if pairing_status_file is not None:
                write_pairing_ui_status(pairing_status_file, payload)
            print(
                json.dumps({"event": f"system-{event_name}", "deviceId": device_id}),
                flush=True,
            )
            if event_name == "paired":
                task = asyncio.create_task(
                    notify_agent_pairing_complete(),
                    name="agent-system-pairing-confirmation",
                )
                pairing_notification_tasks.add(task)
                task.add_done_callback(pairing_notification_tasks.discard)

        host = LinuxDeviceHubHost(
            websocket_url,
            config.state_dir,
            interface=config.interface,
            udid=config.requested_udid,
            agent_bundle_id=config.agent_bundle_id,
            pairing_event_callback=on_pairing_event,
            overlay_token=overlay_token,
            wda_package_path=config.wda_package_path,
        )
        host_stop = asyncio.Event()
        current_host = host
        last_agent_discovery_at = 0.0
        last_wda_ensure_at = 0.0
        current_device_id = device_id
        current_websocket_url = websocket_url
        current_overlay_token = overlay_token
        serve_task = asyncio.create_task(
            serve(host, config.bind, config.port, stop=host_stop),
            name=f"linux-devicehub-host:{device_id}",
        )
        print(json.dumps({"event": "automatic-host-started", "deviceId": device_id}), flush=True)

    try:
        if config.pairing_url_file is not None:
            pairing_task = asyncio.create_task(
                maintain_pairing_link(
                    client,
                    validate_public_controller_url(config.controller_url),
                    config.pairing_url_file,
                    config.pairing_ttl_seconds,
                ),
                name="pairing-link-renewal",
            )
        print(json.dumps({"event": "waiting-for-online-ios-device"}), flush=True)
        last_error: str | None = None
        while not shutdown.is_set():
            try:
                selected = await resolve_device_overlay(
                    client,
                    config.controller_url,
                    config.requested_device_id,
                    config.overlay_requirements,
                )
                if serve_task is not None and serve_task.done():
                    try:
                        serve_task.result()
                    except Exception as error:
                        print(json.dumps({"event": "automatic-host-error", "error": str(error)}), flush=True)
                    serve_task = None
                    host_stop = None
                    current_host = None
                    current_device_id = None
                    current_websocket_url = None
                if selected is not None:
                    device_id, websocket_url, overlay_token = selected
                    if (
                        current_device_id != device_id
                        or current_websocket_url != websocket_url
                        or current_overlay_token != overlay_token
                    ):
                        if current_device_id is not None:
                            print(
                                json.dumps(
                                    {
                                        "event": "automatic-host-switching",
                                        "fromDeviceId": current_device_id,
                                        "toDeviceId": device_id,
                                    }
                                ),
                                flush=True,
                            )
                        await stop_active_host()
                        await start_host(device_id, websocket_url, overlay_token)
                    if current_host is not None:
                        overlays_payload = await client.overlays()
                        hint = select_remote_pairing_hint(
                            overlays_payload,
                            device_id,
                        )
                        if hint is not None:
                            current_host.runtime.update_remote_pairing_hint(*hint)
                        elif (
                            (
                                current_host.runtime.remote_pairing_hint is None
                                or not current_host.runtime.remote_pairing_hint.fresh
                            )
                            and time.time() - last_agent_discovery_at >= 10
                        ):
                            last_agent_discovery_at = time.time()
                            result = await client.send_command(
                                device_id,
                                {
                                    "capability": "network.bonjour.browse",
                                    "capabilityVersion": 1,
                                    "arguments": {
                                        "serviceTypes": ["_remotepairing._tcp."],
                                        "timeoutMs": 5_000,
                                    },
                                    "idempotency": "read-only",
                                },
                                timeout_ms=7_000,
                            )
                            fallback_hint = remote_pairing_hint_from_agent_result(result)
                            if fallback_hint is not None:
                                current_host.runtime.update_remote_pairing_hint(*fallback_hint)
                                print(
                                    json.dumps(
                                        {
                                            "event": "remote-pairing-service-discovered",
                                            "source": "foreground-agent-compatibility",
                                            "deviceId": device_id,
                                        }
                                    ),
                                    flush=True,
                                )
                        if wda_package is not None:
                            wda_state = select_on_device_wda_state(
                                overlays_payload,
                                device_id,
                            )
                            install_in_progress = wda_state in {
                                "wdaInstallRequested",
                                "wdaInstalling",
                                "wdaInstalled",
                                "wdaStarting",
                            }
                            if (
                                wda_state != "wdaReady"
                                and not install_in_progress
                                and time.time() - last_wda_ensure_at >= 30
                            ):
                                last_wda_ensure_at = time.time()
                                result = await client.ensure_wda_package(
                                    device_id,
                                    wda_package,
                                )
                                if result.get("accepted") is not True:
                                    raise RuntimeError(
                                        "Gelato device app did not stage the WDA package"
                                    )
                                print(
                                    json.dumps(
                                        {
                                            "event": "wda-package-staged-on-device",
                                            "deviceId": device_id,
                                            "bytes": result.get("bytes"),
                                            "sha256": result.get("sha256"),
                                        }
                                    ),
                                    flush=True,
                                )
                last_error = None
            except asyncio.CancelledError:
                raise
            except Exception as error:
                message = str(error)
                if message != last_error:
                    print(json.dumps({"event": "controller-watch-error", "error": message}), flush=True)
                    last_error = message
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=config.poll_interval)
            except asyncio.TimeoutError:
                pass
    finally:
        await stop_active_host()
        for task in pairing_notification_tasks:
            task.cancel()
        if pairing_notification_tasks:
            await asyncio.gather(
                *pairing_notification_tasks,
                return_exceptions=True,
            )
        if pairing_task is not None:
            pairing_task.cancel()
            with suppress(asyncio.CancelledError):
                await pairing_task
        await client.close()
