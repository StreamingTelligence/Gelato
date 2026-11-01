from __future__ import annotations

import asyncio
import base64
import json
import os
import platform
import plistlib
import secrets
import socket
import stat
import uuid
from contextlib import suppress
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

from pymobiledevice3.bonjour import MDNSResponder, REMOTEPAIRING_PAIRABLE_HOST_SERVICE_NAME
from pymobiledevice3.remote.tunnel_service import PairableHost, PairableHostInfo, PairableHostResult

from .constants import OVERLAY_HOST_IPV4, OVERLAY_HOST_IPV6


class DeviceHubMDNSResponder(MDNSResponder):
    """Advertise often enough for iOS discovery over a packet-tunnel relay."""

    ANNOUNCE_INTERVAL_SECONDS = 2.0

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._periodic_announce_task: asyncio.Task | None = None

    def _send_to_all(self, packet: bytes) -> None:
        # RFC 6762 packets use a TTL/hop limit of 255. Apple's mDNSResponder
        # rejects packets that look as if they crossed a routed boundary.
        for _transport, sock in self._transports:
            if sock.family == socket.AF_INET:
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
            elif sock.family == socket.AF_INET6:
                sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_MULTICAST_HOPS, 255)
        super()._send_to_all(packet)

    async def _periodic_announce(self) -> None:
        while True:
            await asyncio.sleep(self.ANNOUNCE_INTERVAL_SECONDS)
            self._announce()

    async def __aenter__(self) -> DeviceHubMDNSResponder:
        await super().__aenter__()
        self._periodic_announce_task = asyncio.create_task(
            self._periodic_announce(),
            name="devicehub-mdns-announcer",
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        if self._periodic_announce_task is not None:
            self._periodic_announce_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._periodic_announce_task
            self._periodic_announce_task = None
        await super().__aexit__(exc_type, exc_val, exc_tb)


@dataclass(frozen=True)
class PersistentHostIdentity:
    name: str
    model: str
    udid: str
    identifier: str
    alt_irk: str

    def to_pairable_host(self) -> PairableHostInfo:
        return PairableHostInfo(
            name=self.name,
            model=self.model,
            udid=self.udid,
            identifier=self.identifier,
            alt_irk=base64.b64decode(self.alt_irk, validate=True),
        )


def _new_identity(name: str | None, model: str) -> PersistentHostIdentity:
    return PersistentHostIdentity(
        name=name or platform.node(),
        model=model,
        # iOS stores this value as remotepairing_udid in the peer identity.
        # An empty value can complete pair-setup/pair-verify but is not a
        # complete CoreDevice host identity for the subsequent RSD session.
        udid=str(uuid.uuid4()).upper(),
        identifier=str(uuid.uuid4()).upper(),
        alt_irk=base64.b64encode(secrets.token_bytes(16)).decode("ascii"),
    )


def _write_identity(path: Path, identity: PersistentHostIdentity) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps(asdict(identity), indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def load_or_create_identity(
    state_dir: Path,
    name: str | None = None,
    model: str = "Mac17,7",
) -> PersistentHostIdentity:
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / "pairable-host.json"
    if path.exists():
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("udid"):
            return PersistentHostIdentity(**payload)

        # Early iOS 27 pairable-host builds advertised an empty
        # remotepairing_udid. Keep that identity recoverable, but rotate the
        # identifier/IRK once so the phone performs a fresh pair-setup instead
        # of silently reusing the incomplete peer entry.
        legacy = state_dir / "pairable-host.legacy-no-udid.json"
        if not legacy.exists():
            os.link(path, legacy)
            os.chmod(legacy, 0o600)
        identity = _new_identity(name or payload.get("name"), model)
        _write_identity(path, identity)
        return identity

    identity = _new_identity(name, model)
    _write_identity(path, identity)
    return identity


def secure_pair_record(path: Path | str) -> Path:
    record_path = Path(path)
    descriptor = os.open(record_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RuntimeError("RemotePairing record is not a regular file")
        os.fchmod(descriptor, 0o600)
    finally:
        os.close(descriptor)
    return record_path


def on_device_pair_record_bytes(path: Path | str) -> bytes:
    """Convert the Linux RemotePairing record to idevice's on-device schema."""
    record_path = secure_pair_record(path)
    record = plistlib.loads(record_path.read_bytes())
    public_key = record.get("public_key")
    private_key = record.get("private_key")
    identifier = record.get("host_identifier")
    # RpPairingFile.alt_irk is the paired device's alternate IRK.  The Linux
    # record also contains the host IRK, but forwarding that value makes the
    # on-device client identify the wrong side of the pairing.
    alt_irk = record.get("peer_alt_irk")
    if (
        not isinstance(public_key, bytes)
        or len(public_key) != 32
        or not isinstance(private_key, bytes)
        or len(private_key) != 32
        or not isinstance(identifier, str)
        or not identifier
        or not isinstance(alt_irk, bytes)
        or len(alt_irk) != 16
    ):
        raise ValueError("Linux RemotePairing record is incomplete")
    return plistlib.dumps(
        {
            "public_key": public_key,
            "private_key": private_key,
            "identifier": identifier,
            "alt_irk": alt_irk,
        },
        fmt=plistlib.FMT_BINARY,
        sort_keys=True,
    )


async def serve_overlay_pairable_host(
    identity: PersistentHostIdentity,
    port: int = 0,
    timeout: float | None = None,
    event_callback: Callable[[dict[str, object]], None] | None = None,
) -> PairableHostResult:
    host_info = identity.to_pairable_host()
    paired: asyncio.Future[PairableHostResult] = asyncio.get_running_loop().create_future()

    def pin_callback(pin: str) -> None:
        emit({"event": "pin", "pin": pin})

    def emit(event: dict[str, object]) -> None:
        logged = {"event": "pin-generated"} if event.get("event") == "pin" else event
        print(json.dumps(logged), flush=True)
        if event_callback is not None:
            event_callback(event)

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if paired.done():
            writer.close()
            return
        host = PairableHost(reader, writer, host_info)
        try:
            # A device can abandon the system pairing sheet without closing
            # the relayed TCP stream. Do not let that stale session own the
            # only advertised host indefinitely.
            peer_device = await asyncio.wait_for(host.accept(pin_callback), timeout=360)
            record_path = secure_pair_record(host.save_pair_record())
            if not paired.done():
                paired.set_result(PairableHostResult(peer_device=peer_device, record_path=record_path))
        except Exception as error:
            if not paired.done():
                paired.set_exception(error)
        finally:
            try:
                await asyncio.wait_for(host.close(), timeout=3)
            except (TimeoutError, OSError):
                writer.transport.abort()
                emit({"event": "pair-host-connection-cleanup-timeout"})

    ipv4_server = await asyncio.start_server(handle, host=OVERLAY_HOST_IPV4, port=port)
    bound_port = ipv4_server.sockets[0].getsockname()[1]
    servers = [ipv4_server]
    addresses: list[tuple[int, str]] = [(socket.AF_INET, OVERLAY_HOST_IPV4)]
    try:
        ipv6_server = await asyncio.start_server(handle, host=OVERLAY_HOST_IPV6, port=bound_port)
        servers.append(ipv6_server)
        addresses.append((socket.AF_INET6, OVERLAY_HOST_IPV6))
    except OSError:
        pass

    responder = DeviceHubMDNSResponder(
        REMOTEPAIRING_PAIRABLE_HOST_SERVICE_NAME,
        host_info.identifier,
        bound_port,
        host_info.mdns_txt_records(),
        addresses=addresses,
    )
    emit(
        {
            "event": "pair-host-ready",
            "name": host_info.name,
            "identifier": host_info.identifier,
            "addresses": [address for _, address in addresses],
            "port": bound_port,
        }
    )
    try:
        async with responder:
            if timeout is None:
                return await paired
            return await asyncio.wait_for(asyncio.shield(paired), timeout)
    finally:
        for server in servers:
            server.close()
        for server in servers:
            try:
                await asyncio.wait_for(server.wait_closed(), timeout=3)
            except TimeoutError:
                # Python 3.13 waits for accepted connections here too. A
                # broken relay must not prevent the next advertisement.
                emit({"event": "pair-host-server-cleanup-timeout"})
