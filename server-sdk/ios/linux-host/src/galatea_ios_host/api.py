from __future__ import annotations

import asyncio
import json
import signal
import socket
import stat
import time
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import Any

from aiohttp import web

from .constants import DEFAULT_AGENT_BUNDLE_ID, DEFAULT_INTERFACE
from .overlay import OverlayBridge, TunDevice
from .pairing import (
    load_or_create_identity,
    on_device_pair_record_bytes,
    serve_overlay_pairable_host,
)
from .runtime import (
    DEFAULT_WDA_RUNNER_BUNDLE_ID,
    DeviceHubRuntime,
    DeviceSession,
)


def free_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


class LinuxDeviceHubHost:
    def __init__(
        self,
        websocket_url: str,
        state_dir: Path,
        interface: str = DEFAULT_INTERFACE,
        udid: str | None = None,
        agent_bundle_id: str = DEFAULT_AGENT_BUNDLE_ID,
        pairing_event_callback: Callable[[dict[str, object]], None] | None = None,
        overlay_token: str | None = None,
        wda_package_path: Path | None = None,
    ) -> None:
        self.state_dir = state_dir
        self.agent_bundle_id = agent_bundle_id
        self.overlay = OverlayBridge(
            websocket_url,
            TunDevice(interface=interface),
            token=overlay_token,
        )
        self.runtime = DeviceHubRuntime(
            overlay_interface=interface,
            requested_udid=udid,
            remote_pairing_proxy_port_provider=(
                lambda: self.overlay.remote_pairing_proxy_port
            ),
            # The authenticated Packet Tunnel reports its native
            # _remotepairing service immediately after the overlay opens. Give
            # that report a short head start so a cold host launch does not get
            # stuck in the much slower compatibility-port fallback first.
            remote_pairing_hint_wait_timeout=10,
        )
        self.sessions: dict[str, DeviceSession] = {}
        self.pairing_event: dict[str, object] | None = None
        self.first_pairing_verified = False
        self._restored_pairing_proof = False
        self._stale_pairing_verification_failures = 0
        self.pairing_event_callback = pairing_event_callback
        self.wda_package_path = wda_package_path
        self._wda_package_verified_rsd: object | None = None
        self._wda_package_retry_at = 0.0
        self._tasks: list[asyncio.Task] = []
        self._restore_pairing_proof()

    def _restore_pairing_proof(self) -> None:
        proof = self.state_dir / "first-pairing-proof.json"
        try:
            if (
                not proof.is_file()
                or stat.S_IMODE(proof.stat().st_mode) & 0o077
            ):
                return
            payload = json.loads(proof.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                return
            udid = payload.get("udid")
            record_value = payload.get("recordPath")
            record_path = Path(record_value) if isinstance(record_value, str) else None
            if (
                payload.get("event") != "paired"
                or payload.get("pairingIdentityVersion") != 2
                or not isinstance(udid, str)
                or not 20 <= len(udid) <= 64
                or not all(character.isalnum() or character == "-" for character in udid)
                or record_path is None
                or record_path.name != f"remote_{udid}.plist"
                or not record_path.is_file()
                or stat.S_IMODE(record_path.stat().st_mode) & 0o077
            ):
                return
        except (OSError, json.JSONDecodeError):
            return
        self.first_pairing_verified = True
        self._restored_pairing_proof = True
        self.runtime.requested_udid = udid
        self.pairing_event = {
            **payload,
            "restored": True,
        }

    async def start(self) -> None:
        self._tasks = [
            asyncio.create_task(self.overlay.run_forever(), name="packet-overlay"),
            asyncio.create_task(self._pair_once(), name="pair-host"),
            asyncio.create_task(
                self._sync_on_device_pair_record(),
                name="on-device-pair-record",
            ),
            asyncio.create_task(self._runtime_loop(), name="devicehub-runtime"),
        ]

    async def close(self) -> None:
        # Stop discovery/connect loops before closing the resources they own.
        # Otherwise a RemoteXPC attempt can race close() and keep shutdown
        # waiting indefinitely inside an in-flight tunnel handshake.
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with suppress(asyncio.CancelledError):
                await task
        for session in list(self.sessions.values()):
            await session.close()
        self.sessions.clear()
        await self.runtime.close()

    def _on_pairing_event(self, event: dict[str, object]) -> None:
        self.pairing_event = {"event": "pin-forwarded"} if event.get("event") == "pin" else event
        if self.pairing_event_callback is not None:
            self.pairing_event_callback(event)

    async def _recover_rejected_restored_pairing(self, error: Exception) -> None:
        """Re-advertise only when both fresh overlay paths reject a saved pair record.

        A local proof file says that pairing once succeeded, not that iOS still
        trusts this host. Keep the old proof recoverable and leave the pair
        record intact until a new system pairing actually succeeds.
        """
        if (not self._restored_pairing_proof or self.runtime.connected
                or not self.overlay.connected.is_set()):
            return
        failures = [part.strip() for part in str(error).split(";")]
        rejected = len(failures) >= 2 and all(
            "stage=remote-pair-verify: ConnectionTerminatedError" in part
            for part in failures
        )
        if not rejected:
            self._stale_pairing_verification_failures = 0
            return
        self._stale_pairing_verification_failures += 1
        if self._stale_pairing_verification_failures < 2:
            return

        proof = self.state_dir / "first-pairing-proof.json"
        backup = self.state_dir / f"first-pairing-proof.stale-{time.time_ns()}.json"
        try:
            proof.rename(backup)
        except OSError as backup_error:
            print(
                json.dumps({
                    "event": "stale-pairing-proof-backup-error",
                    "errorType": type(backup_error).__name__,
                }),
                flush=True,
            )
            return

        self._restored_pairing_proof = False
        self._stale_pairing_verification_failures = 0
        self.first_pairing_verified = False
        self.runtime.requested_udid = None
        self.pairing_event = {"event": "pairing-required", "reason": "saved-pair-rejected"}
        if self.pairing_event_callback is not None:
            self.pairing_event_callback(self.pairing_event)
        print(json.dumps({"event": "stale-pairing-proof-recovered"}), flush=True)
        self._tasks.append(asyncio.create_task(self._pair_once(), name="pair-host-retry"))

    async def _pair_once(self) -> None:
        await self.overlay.connected.wait()
        if self.first_pairing_verified:
            if self.pairing_event_callback is not None:
                self.pairing_event_callback(
                    {
                        "event": "paired",
                        "name": self.pairing_event.get("name")
                        if self.pairing_event is not None
                        else "iPhone",
                        "model": self.pairing_event.get("model")
                        if self.pairing_event is not None
                        else None,
                        "restored": True,
                    }
                )
            return
        identity = load_or_create_identity(self.state_dir)
        while not self.first_pairing_verified:
            try:
                result = await serve_overlay_pairable_host(
                    identity,
                    event_callback=self._on_pairing_event,
                )
                self.first_pairing_verified = True
                self._restored_pairing_proof = False
                self._stale_pairing_verification_failures = 0
                self.runtime.requested_udid = result.peer_device.udid
                self.pairing_event = {
                    "event": "paired",
                    "pairingIdentityVersion": 2,
                    "name": result.peer_device.name,
                    "model": result.peer_device.model,
                    "udid": result.peer_device.udid,
                    "recordPath": str(result.record_path),
                }
                proof = self.state_dir / "first-pairing-proof.json"
                proof.write_text(
                    json.dumps(self.pairing_event, indent=2) + "\n",
                    encoding="utf-8",
                )
                proof.chmod(0o600)
                if self.pairing_event_callback is not None:
                    self.pairing_event_callback(
                        {
                            "event": "paired",
                            "name": result.peer_device.name,
                            "model": result.peer_device.model,
                        }
                    )
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.pairing_event = {
                    "event": "pairing-error",
                    "error": str(error),
                }
                if self.pairing_event_callback is not None:
                    self.pairing_event_callback(self.pairing_event)
                await asyncio.sleep(1)

    async def _runtime_loop(self) -> None:
        await self.overlay.connected.wait()
        connected_raw_tunnel_sequence = 0
        while True:
            await self._ensure_wda_package()
            if not self.first_pairing_verified:
                await asyncio.sleep(1)
                continue
            endpoint = self.overlay.remote_xpc_endpoint
            if (
                self.overlay.remote_xpc_tunnel_ready.is_set()
                and endpoint is not None
            ):
                sequence = self.overlay.remote_xpc_tunnel_sequence
                if (
                    not self.runtime.connected
                    or connected_raw_tunnel_sequence != sequence
                ):
                    if self.runtime.connected:
                        await self.overlay.detach_remote_xpc_userspace_tun()
                        await self.runtime.close()
                    tun = None
                    try:
                        tun = await self.overlay.open_remote_xpc_userspace_tun()
                        await self.runtime.connect_userspace_cdtunnel(
                            tun,
                            endpoint.client_address,
                            endpoint.server_address,
                            endpoint.rsd_port,
                        )
                        connected_raw_tunnel_sequence = sequence
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:
                        if tun is not None:
                            await self.overlay.detach_remote_xpc_userspace_tun(
                                tun
                            )
                        raw_error = (
                            "raw CDTunnel PyTCP RSD: "
                            f"{type(error).__name__}: {error}"
                        )
                        # The Gelato device app can also proxy the RemotePairing control
                        # socket and its dynamically-created TLS/CDTunnel
                        # listener as byte streams.  That path keeps Linux as
                        # the protocol peer and avoids injecting inner IPv6
                        # packets from the Network Extension.  A raw-capable
                        # The device app used to suppress this compatibility path
                        # forever, even after the device had demonstrably
                        # discarded every injected SYN.
                        try:
                            await self.runtime.connect(timeout=15)
                        except asyncio.CancelledError:
                            raise
                        except Exception as proxy_error:
                            self.runtime.last_error = (
                                f"{raw_error}; RemotePairing stream fallback: "
                                f"{type(proxy_error).__name__}: {proxy_error}"
                            )
                            await self._recover_rejected_restored_pairing(proxy_error)
                        else:
                            connected_raw_tunnel_sequence = 0
                await asyncio.sleep(3)
                continue

            if (
                self.runtime.connected
                and self.runtime.endpoint is not None
                and str(
                    self.runtime.endpoint.get("discoverySource", "")
                ).startswith("packet-tunnel-raw-cdtunnel")
            ):
                await self.overlay.detach_remote_xpc_userspace_tun()
                await self.runtime.close()
                connected_raw_tunnel_sequence = 0

            # Advertising raw-CDTunnel capability is not proof that the raw
            # tunnel became usable. iOS 27 can accept its inner RSD SYN and
            # then hold the return path in NECP indefinitely. Keep trying the
            # Linux-terminated RemotePairing byte-stream path until an actual
            # raw setup frame arrives; that path has a separate stream ID and
            # is safe to establish in parallel.
            if self.overlay.connected.is_set() and not self.runtime.connected:
                try:
                    await self.runtime.connect(timeout=15)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self.runtime.last_error = str(error)
                    await self._recover_rejected_restored_pairing(error)
            await asyncio.sleep(3)

    async def _ensure_wda_package(self) -> None:
        package = self.wda_package_path
        rsd = self.runtime.rsd
        if package is None or rsd is None:
            self._wda_package_verified_rsd = None
            return
        if self._wda_package_verified_rsd is rsd:
            return
        now = time.monotonic()
        if now < self._wda_package_retry_at:
            return
        try:
            installed = await self.runtime.ensure_developer_app(
                DEFAULT_WDA_RUNNER_BUNDLE_ID,
                package,
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._wda_package_retry_at = now + 5
            print(
                json.dumps(
                    {
                        "event": "wda-package-install-error",
                        "errorType": type(error).__name__,
                        "error": str(error)[:240],
                    }
                ),
                flush=True,
            )
            return
        self._wda_package_verified_rsd = rsd
        self._wda_package_retry_at = 0
        print(
            json.dumps(
                {
                    "event": "wda-package-installed"
                    if installed
                    else "wda-package-already-installed",
                    "bundleId": DEFAULT_WDA_RUNNER_BUNDLE_ID,
                }
            ),
            flush=True,
        )

    async def _sync_on_device_pair_record(self) -> None:
        sent_capability_sequence = 0
        while True:
            await self.overlay.connected.wait()
            await self.overlay.on_device_remote_xpc_ready.wait()
            sequence = self.overlay.on_device_remote_xpc_sequence
            if sequence == sent_capability_sequence:
                await asyncio.sleep(1)
                continue
            pairing_event = self.pairing_event
            record_value = (
                pairing_event.get("recordPath")
                if pairing_event is not None
                else None
            )
            if not self.first_pairing_verified or not isinstance(record_value, str):
                await asyncio.sleep(1)
                continue
            try:
                record = on_device_pair_record_bytes(Path(record_value))
                await self.overlay.send_on_device_pair_record(record)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                print(
                    f"on-device pair record sync failed: "
                    f"{type(error).__name__}: {error}",
                    flush=True,
                )
                await asyncio.sleep(2)
                continue
            sent_capability_sequence = sequence
            print("on-device pair record synced", flush=True)

    async def create_session(self, udid: str, bundle_id: str) -> DeviceSession:
        if not self.runtime.connected:
            raise web.HTTPServiceUnavailable(text="RemoteXPC is not connected through the project overlay")
        if udid and udid != self.runtime.udid:
            raise web.HTTPNotFound(text=f"overlay device {udid} is not connected")
        session = DeviceSession(
            self.runtime,
            bundle_id,
            free_local_port(),
            agent_bundle_id=self.agent_bundle_id,
        )
        self.sessions[session.id] = session
        try:
            await session.start()
        except Exception:
            self.sessions.pop(session.id, None)
            await session.close()
            raise
        return session

    def require_session(self, request: web.Request) -> DeviceSession:
        session = self.sessions.get(request.match_info["session_id"])
        if session is None:
            raise web.HTTPNotFound(text="session not found")
        return session

    def acceptance(self) -> dict[str, Any]:
        overlay = self.overlay.status()
        now = time.time()
        connected_at = overlay["connectedAt"]
        from_controller_at = overlay["lastPacketFromControllerAt"]
        to_controller_at = overlay["lastPacketToControllerAt"]
        overlay_fresh = (
            bool(overlay["connected"])
            and connected_at is not None
            and int(overlay["currentPacketsFromController"]) > 0
            and int(overlay["currentPacketsToController"]) > 0
            and from_controller_at is not None
            and to_controller_at is not None
            and float(from_controller_at) >= float(connected_at)
            and float(to_controller_at) >= float(connected_at)
            and now - float(from_controller_at) < 120
            and now - float(to_controller_at) < 120
        )
        gates = {
            "firstPairingOnLinux": self.first_pairing_verified,
            "overlayBidirectionalFresh": overlay_fresh,
            "remoteXpcViaOverlay": self.runtime.connected and self.runtime.proof.connected_via_overlay,
            "coreDeviceScreenshot": self.runtime.proof.screenshot_verified,
            "crossAppInputChangedScreen": self.runtime.proof.cross_app_input_verified,
        }
        blockers = [name for name, passed in gates.items() if not passed]
        return {
            "mode": "linux-ios27-devicehub",
            "productReady": not blockers,
            "gates": gates,
            "blockers": blockers,
            "overlay": overlay,
            "pairing": self.pairing_event,
            "runtime": {
                "connected": self.runtime.connected,
                "udid": self.runtime.udid,
                "endpoint": self.runtime.endpoint,
                "lastError": self.runtime.last_error,
                "proof": vars(self.runtime.proof),
            },
        }


def json_response(payload: Any, status: int = 200) -> web.Response:
    return web.json_response(payload, status=status, dumps=lambda value: json.dumps(value, default=str))


def create_app(host: LinuxDeviceHubHost) -> web.Application:
    app = web.Application(client_max_size=1024 * 1024)

    async def health(_request: web.Request) -> web.Response:
        return json_response({"ok": True, "mode": "linux-ios27-devicehub", "sessions": len(host.sessions)})

    async def acceptance(_request: web.Request) -> web.Response:
        return json_response(host.acceptance())

    async def devices(_request: web.Request) -> web.Response:
        physical = [await host.runtime.info()] if host.runtime.connected else []
        return json_response(
            {
                "mode": "linux-ios27-devicehub",
                "allowRealDevices": True,
                "requireNonWired": True,
                "driverMode": "coredevice-display-hid",
                "acceptanceReady": host.acceptance()["productReady"],
                "realDevices": physical,
                "simulators": [],
            }
        )

    async def sessions(_request: web.Request) -> web.Response:
        return json_response({"sessions": [session.public() for session in host.sessions.values()]})

    async def create_session(request: web.Request) -> web.Response:
        body = await request.json()
        bundle_id = str(body.get("bundleId") or "com.apple.Preferences")
        session = await host.create_session(str(body.get("udid") or ""), bundle_id)
        return json_response({"session": session.public()}, status=201)

    async def close_session(request: web.Request) -> web.Response:
        session = host.require_session(request)
        host.sessions.pop(session.id, None)
        await session.close()
        return json_response({"closed": True})

    async def launch(request: web.Request) -> web.Response:
        session = host.require_session(request)
        body = await request.json()
        bundle_id = str(body.get("bundleId") or body.get("appId") or "")
        result = await session.launch(bundle_id)
        return json_response({"result": {"type": "launchApp", "bundleId": bundle_id, "value": result}})

    async def tap(request: web.Request) -> web.Response:
        session = host.require_session(request)
        body = await request.json()
        await session.tap(float(body["x"]), float(body["y"]))
        return json_response({"result": {"type": "tap", "output": "ok"}})

    async def swipe(request: web.Request) -> web.Response:
        session = host.require_session(request)
        body = await request.json()
        await session.swipe(
            float(body["fromX"]),
            float(body["fromY"]),
            float(body["toX"]),
            float(body["toY"]),
            int(body.get("durationMs", 450)),
        )
        return json_response({"result": {"type": "swipe", "output": "ok"}})

    async def type_text(request: web.Request) -> web.Response:
        session = host.require_session(request)
        body = await request.json()
        await session.type_text(str(body.get("text") or ""))
        return json_response({"result": {"type": "typeText", "output": "ok"}})

    async def screenshot(request: web.Request) -> web.Response:
        session = host.require_session(request)
        return web.Response(body=await session.screenshot(), content_type="image/png")

    async def source(request: web.Request) -> web.Response:
        session = host.require_session(request)
        return web.Response(text=await session.source(), content_type="application/xml")

    app.add_routes(
        [
            web.get("/health", health),
            web.get("/api/driver/acceptance", acceptance),
            web.get("/api/driver/devices", devices),
            web.get("/api/driver/sessions", sessions),
            web.post("/api/driver/sessions", create_session),
            web.delete("/api/driver/sessions/{session_id}", close_session),
            web.post("/api/driver/sessions/{session_id}/launch", launch),
            web.post("/api/driver/sessions/{session_id}/tap", tap),
            web.post("/api/driver/sessions/{session_id}/swipe", swipe),
            web.post("/api/driver/sessions/{session_id}/type", type_text),
            web.get("/api/driver/sessions/{session_id}/screenshot", screenshot),
            web.get("/api/driver/sessions/{session_id}/source", source),
        ]
    )
    return app


async def serve(
    host: LinuxDeviceHubHost,
    bind: str,
    port: int,
    stop: asyncio.Event | None = None,
) -> None:
    await host.start()
    runner = web.AppRunner(create_app(host))
    await runner.setup()
    site = web.TCPSite(runner, bind, port)
    await site.start()
    print(f"Linux iOS Device Hub Host listening on http://{bind}:{port}", flush=True)
    owns_stop_event = stop is None
    stop = stop or asyncio.Event()
    if owns_stop_event:
        loop = asyncio.get_running_loop()
        for signame in ("SIGINT", "SIGTERM"):
            with suppress(NotImplementedError):
                loop.add_signal_handler(getattr(signal, signame), stop.set)
    try:
        await stop.wait()
    finally:
        await runner.cleanup()
        await host.close()
