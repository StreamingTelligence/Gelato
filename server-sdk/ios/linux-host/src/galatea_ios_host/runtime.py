from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import plistlib
import socket
import ssl
import stat
import sys
import time
import uuid
import xml.etree.ElementTree as ET
from collections.abc import Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pymobiledevice3.bonjour import Address
from pymobiledevice3.pair_records import iter_remote_paired_identifiers
from pymobiledevice3.remote.common import TunnelProtocol
from pymobiledevice3.remote.core_device.app_service import AppServiceService
from pymobiledevice3.remote.core_device.device_info import DeviceInfoService
from pymobiledevice3.remote.core_device.hid_service import (
    ASCII_TO_HID,
    KEY_LEFT_SHIFT,
    TOUCHSCREEN_STATE_CONTACT,
    TOUCHSCREEN_STATE_RELEASE,
    UniversalHIDServiceService,
    touch_session,
)
from pymobiledevice3.remote.core_device.display_service import DisplayService
from pymobiledevice3.remote.core_device.screen_capture_service import ScreenCaptureService
from pymobiledevice3.remote.core_device.screen_stream import open_media_receiver
from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
from pymobiledevice3.remote import tunnel_service as pmd3_tunnel_service
from pymobiledevice3.remote.tunnel_service import (
    RemotePairingTunnelService,
    start_tunnel,
)
from pymobiledevice3.remote.userspace_tunnel import UserspaceDialPlane
from pymobiledevice3.services.accessibilityaudit import AccessibilityAudit
from pymobiledevice3.services.installation_proxy import InstallationProxyService
from pymobiledevice3.services.mobile_image_mounter import auto_mount
from pymobiledevice3.exceptions import AlreadyMountedError
from pymobiledevice3.services.dvt.testmanaged.xcuitest import (
    TestConfig,
    XCUITestService,
)
from pymobiledevice3.services.wda import WdaClient

from .constants import (
    DEFAULT_AGENT_BUNDLE_ID,
    DEFAULT_INTERFACE,
    DEFAULT_REMOTE_PAIRING_PORT,
    OVERLAY_DEVICE_IPV4,
    OVERLAY_DEVICE_IPV6,
)
from .overlay import REMOTE_PAIRING_TARGET_MAGIC

DEFAULT_WDA_RUNNER_BUNDLE_ID = os.environ.get("GALATEA_WDA_RUNNER_BUNDLE_ID", "dev.galatea.wda.xctrunner")


@asynccontextmanager
async def userspace_touch_session(
    rsd: RemoteServiceDiscoveryService,
    local_tunnel_address: str,
):
    """Keep the media/HID gate open over a userspace RemoteXPC tunnel.

    pymobiledevice3's generic helper derives ``senderIP`` from the remote RSD
    endpoint. In the DeviceHub userspace data plane that is the iPhone address,
    while CoreDevice expects the host/client side address as ``localIP``.
    """
    display = DisplayService(rsd)
    await display.__aenter__()
    transport = None
    drain_task = None
    try:
        transport, receiver_ip = open_media_receiver(
            display,
            (1 * 1024 * 1024,),
        )

        async def drain() -> None:
            try:
                while True:
                    await transport.recv()
            except (asyncio.CancelledError, OSError):
                pass

        answer = await asyncio.wait_for(
            display.start_video_stream(
                receiver_ip=receiver_ip,
                receiver_port=transport.port,
                sender_ip=local_tunnel_address,
            ),
            timeout=10.0,
        )
        await asyncio.sleep(0.3)
        drain_task = asyncio.create_task(drain())
        async with UniversalHIDServiceService(rsd) as hid:
            yield hid
    finally:
        if drain_task is not None:
            drain_task.cancel()
            with suppress(BaseException):
                await drain_task
        if transport is not None:
            with suppress(Exception):
                session_id = answer["connection"]["options"][
                    "avcMediaStreamOptionClientSessionID"
                ]["uuid"]
                if not isinstance(session_id, uuid.UUID):
                    session_id = uuid.UUID(session_id)
                await display.stop_media_stream(session_id)
            transport.close()
        with suppress(BaseException):
            await display.__aexit__(None, None, None)


def is_overlay_address(address: Address, interface: str = DEFAULT_INTERFACE) -> bool:
    if address.iface != interface:
        return False
    value = address.ip.split("%", 1)[0]
    with suppress(ValueError):
        return ipaddress.ip_address(value) in {
            ipaddress.ip_address(OVERLAY_DEVICE_IPV4),
            ipaddress.ip_address(OVERLAY_DEVICE_IPV6),
        }
    return False


async def tcp_endpoint_reachable(address: str, port: int, timeout: float = 1.5) -> bool:
    def probe() -> bool:
        try:
            with socket.create_connection((address, port), timeout=timeout):
                return True
        except OSError:
            return False

    return await asyncio.to_thread(probe)


def persist_remote_unlock_host_key(
    record_path: Path,
    remote_unlock_host_key: str,
) -> None:
    record_stat = record_path.lstat()
    if (
        not stat.S_ISREG(record_stat.st_mode)
        or record_path.is_symlink()
        or stat.S_IMODE(record_stat.st_mode) & 0o077
    ):
        raise PermissionError("RemotePairing record has unsafe permissions")
    if not remote_unlock_host_key:
        raise ValueError("device returned an empty remote unlock host key")

    record = plistlib.loads(record_path.read_bytes())
    if not isinstance(record, dict):
        raise ValueError("RemotePairing record is not a dictionary")
    if record.get("remote_unlock_host_key"):
        return
    record["remote_unlock_host_key"] = remote_unlock_host_key

    temporary = record_path.with_name(
        f".{record_path.name}.{uuid.uuid4().hex}.tmp"
    )
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        if hasattr(os, "fchown"):
            os.fchown(descriptor, record_stat.st_uid, record_stat.st_gid)
        with os.fdopen(descriptor, "wb", closefd=False) as output:
            output.write(plistlib.dumps(record))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, record_path)
    finally:
        os.close(descriptor)
        with suppress(FileNotFoundError):
            temporary.unlink()


async def ensure_remote_unlock_host_key(
    service: RemotePairingTunnelService,
    timeout: float,
) -> None:
    record = service.pair_record
    if not isinstance(record, dict):
        raise RuntimeError("verified RemotePairing service has no pair record")
    if record.get("remote_unlock_host_key"):
        return

    await asyncio.wait_for(service._create_remote_unlock(), timeout=timeout)
    remote_unlock_host_key = service.remote_unlock_host_key
    if not isinstance(remote_unlock_host_key, str):
        raise RuntimeError("device returned an invalid remote unlock host key")
    persist_remote_unlock_host_key(
        service.pair_record_path,
        remote_unlock_host_key,
    )


class CancellableTcpRemotePairingTunnelService(RemotePairingTunnelService):
    def __init__(
        self,
        remote_identifier: str,
        hostname: str,
        port: int,
        tcp_connect_timeout: float,
        stream_proxy_target_port: int | None = None,
    ) -> None:
        super().__init__(remote_identifier, hostname, port)
        self.tcp_connect_timeout = tcp_connect_timeout
        if (
            stream_proxy_target_port is not None
            and not 0 < stream_proxy_target_port <= 65535
        ):
            raise ValueError("RemotePairing stream proxy target port is invalid")
        self.stream_proxy_target_port = stream_proxy_target_port

    @staticmethod
    def _stream_proxy_header(target_port: int) -> bytes:
        return REMOTE_PAIRING_TARGET_MAGIC + target_port.to_bytes(2, "big")

    async def connect(self, autopair: bool = True) -> None:
        del autopair
        connect_task = asyncio.create_task(
            asyncio.open_connection(self.hostname, self.port)
        )
        try:
            self._reader, self._writer = await asyncio.wait_for(
                connect_task,
                timeout=self.tcp_connect_timeout,
            )
            if self.stream_proxy_target_port is not None:
                self._writer.write(
                    self._stream_proxy_header(self.stream_proxy_target_port)
                )
                await self._writer.drain()
            await self._attempt_pair_verify()
            if not await self._validate_pairing():
                raise pmd3_tunnel_service.ConnectionTerminatedError()
            self._init_client_server_main_encryption_keys()
        except BaseException as error:
            if not connect_task.done():
                connect_task.cancel()
                with suppress(asyncio.CancelledError):
                    await connect_task
            with suppress(BaseException):
                await asyncio.shield(self.close())
            raise

    @asynccontextmanager
    async def start_tcp_tunnel(self):
        parameters = await self.create_tcp_listener()
        target_port = int(parameters["port"])
        connect_port = (
            self.port
            if self.stream_proxy_target_port is not None
            else target_port
        )
        family = (
            socket.AF_INET6
            if ipaddress.ip_address(self.hostname.split("%", 1)[0]).version == 6
            else socket.AF_INET
        )
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.setblocking(False)
        try:
            await asyncio.wait_for(
                asyncio.get_running_loop().sock_connect(
                    sock,
                    (self.hostname, connect_port),
                ),
                timeout=self.tcp_connect_timeout,
            )
            if self.stream_proxy_target_port is not None:
                await asyncio.wait_for(
                    asyncio.get_running_loop().sock_sendall(
                        sock,
                        self._stream_proxy_header(target_port),
                    ),
                    timeout=self.tcp_connect_timeout,
                )
            pmd3_tunnel_service.OSUTIL.set_keepalive(sock)
            if sys.version_info >= (3, 13):
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                context.minimum_version = ssl.TLSVersion.TLSv1_2
                context.maximum_version = ssl.TLSVersion.TLSv1_2
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                self._set_psk_ciphers(context)
                context.set_psk_client_callback(
                    lambda _hint: (None, self.encryption_key)
                )
            else:
                context = pmd3_tunnel_service.SSLPSKContext(ssl.PROTOCOL_TLSv1_2)
                context.psk = self.encryption_key
                self._set_psk_ciphers(context)
            reader, writer = await asyncio.open_connection(
                sock=sock,
                ssl=context,
                server_hostname="",
            )
        except BaseException:
            sock.close()
            raise

        tunnel = FramedRemotePairingTcpTunnel(reader, writer)
        try:
            handshake_response = await tunnel.request_tunnel_establish()
            await tunnel.start_tunnel(
                handshake_response["clientParameters"]["address"],
                handshake_response["clientParameters"]["mtu"],
                interface_name=(
                    f"{pmd3_tunnel_service.DEFAULT_INTERFACE_NAME}-"
                    f"{self.remote_identifier}"
                ),
            )
        except BaseException:
            with suppress(BaseException):
                await asyncio.shield(tunnel.stop_tunnel())
            raise

        try:
            yield pmd3_tunnel_service.TunnelResult(
                tunnel.tun.name,
                handshake_response["serverAddress"],
                handshake_response["serverRSDPort"],
                TunnelProtocol.TCP,
                tunnel,
            )
        finally:
            await tunnel.stop_tunnel()


class FramedRemotePairingTcpTunnel(
    pmd3_tunnel_service.RemotePairingTcpTunnel
):
    """Read only the CDTunnel handshake frame, preserving queued IPv6 packets.

    ``RemotePairingTcpTunnel`` currently calls ``StreamReader.read(16000)`` for
    the short handshake response. On a high-latency overlay, iOS can place the
    handshake and its first tunnel packets in the same receive buffer. The
    broad read consumes those packets as ignored trailing bytes and can leave
    the stream between IPv6 packet boundaries. USB rarely exposes this because
    the handshake is delivered before iOS starts transferring packets.
    """

    async def request_tunnel_establish(self) -> dict:
        if self._writer is None or self._reader is None:
            return await super().request_tunnel_establish()
        payload = self._encode_cdtunnel_packet(
            {
                "type": "clientHandshakeRequest",
                "mtu": self.REQUESTED_MTU,
            }
        )
        self._writer.write(payload)
        await self._writer.drain()
        header = await self._reader.readexactly(10)
        payload_length = int.from_bytes(header[8:10], "big")
        packet = header + await self._reader.readexactly(payload_length)
        return json.loads(
            pmd3_tunnel_service.CDTunnelPacket.parse(packet).body
        )


async def connect_remote_pairing_service(
    identifier: str,
    address: str,
    port: int,
    timeout: float,
    stream_proxy_target_port: int | None = None,
) -> RemotePairingTunnelService:
    service = CancellableTcpRemotePairingTunnelService(
        identifier,
        address,
        port,
        tcp_connect_timeout=timeout,
        stream_proxy_target_port=stream_proxy_target_port,
    )
    try:
        await asyncio.wait_for(service.connect(autopair=False), timeout=timeout)
        await ensure_remote_unlock_host_key(service, timeout)
        return service
    except BaseException:
        # pymobiledevice3 currently catches Exception around pair-verify, while
        # asyncio cancellation derives from BaseException. Without this
        # explicit close, a timed-out attempt leaves an ESTABLISHED control
        # socket on 49152 and starves every subsequent retry.
        with suppress(Exception):
            await service.close()
        raise


def normalize_coordinate(value: float, extent: float) -> int:
    if extent <= 0:
        raise ValueError("display extent must be positive")
    return max(0, min(65535, round(value * 65535 / extent)))


def display_dimensions(payload: dict[str, Any]) -> tuple[int, int]:
    displays = payload.get("displays")
    if not isinstance(displays, list) or not displays:
        raise ValueError("CoreDevice display info has no displays")
    display = next(
        (
            candidate
            for candidate in displays
            if isinstance(candidate, dict) and candidate.get("primary") is True
        ),
        displays[0],
    )
    if not isinstance(display, dict):
        raise ValueError("CoreDevice display info has no usable primary display")
    mode = display.get("currentMode", {})
    if not isinstance(mode, dict):
        raise ValueError("CoreDevice display info has no usable currentMode")
    size = mode.get("size", {})
    if isinstance(size, dict):
        width = int(size.get("width", 0))
        height = int(size.get("height", 0))
    elif isinstance(size, (list, tuple)) and len(size) >= 2:
        width = int(size[0])
        height = int(size[1])
    else:
        width = height = 0
    if width <= 0 or height <= 0:
        raise ValueError("CoreDevice display info has no usable currentMode.size")
    return width, height


@dataclass
class InnerTcpTrace:
    tx_packets: int = 0
    rx_packets: int = 0
    tx_payload_bytes: int = 0
    rx_payload_bytes: int = 0
    tx_syn: int = 0
    rx_syn_ack: int = 0
    tx_fin: int = 0
    rx_fin: int = 0
    tx_rst: int = 0
    rx_rst: int = 0
    tx_bad_checksum: int = 0
    rx_bad_checksum: int = 0
    tx_syn_flow: str | None = None
    tx_syn_hop_limit: int | None = None
    tx_syn_window: int | None = None
    tx_syn_options: str | None = None

    @staticmethod
    def _tcp_checksum_valid(packet: bytes, payload_length: int) -> bool:
        tcp = packet[40 : 40 + payload_length]
        pseudo_header = (
            packet[8:24]
            + packet[24:40]
            + payload_length.to_bytes(4, "big")
            + b"\x00\x00\x00"
            + bytes([packet[6]])
        )
        value = pseudo_header + tcp
        if len(value) % 2:
            value += b"\x00"
        total = sum(
            int.from_bytes(value[offset : offset + 2], "big")
            for offset in range(0, len(value), 2)
        )
        while total >> 16:
            total = (total & 0xFFFF) + (total >> 16)
        return total == 0xFFFF

    def observe(self, direction: str, packet: bytes) -> None:
        if packet and packet[0] >> 4 != 6 and len(packet) > 4:
            packet = packet[4:]
        if len(packet) < 60 or packet[0] >> 4 != 6 or packet[6] != 6:
            return
        payload_length = int.from_bytes(packet[4:6], "big")
        tcp = packet[40 : 40 + payload_length]
        if len(tcp) < 20:
            return
        header_length = (tcp[12] >> 4) * 4
        if header_length < 20 or header_length > len(tcp):
            return
        flags = tcp[13]
        payload_bytes = max(0, len(tcp) - header_length)
        if direction == "tx":
            self.tx_packets += 1
            self.tx_payload_bytes += payload_bytes
            self.tx_syn += int(bool(flags & 0x02))
            self.tx_fin += int(bool(flags & 0x01))
            self.tx_rst += int(bool(flags & 0x04))
            self.tx_bad_checksum += int(
                not self._tcp_checksum_valid(packet, payload_length)
            )
            if flags & 0x02 and not flags & 0x10:
                source = str(ipaddress.IPv6Address(packet[8:24]))
                destination = str(ipaddress.IPv6Address(packet[24:40]))
                source_port = int.from_bytes(tcp[0:2], "big")
                destination_port = int.from_bytes(tcp[2:4], "big")
                self.tx_syn_flow = (
                    f"[{source}]:{source_port}>"
                    f"[{destination}]:{destination_port}"
                )
                self.tx_syn_hop_limit = packet[7]
                self.tx_syn_window = int.from_bytes(tcp[14:16], "big")
                self.tx_syn_options = tcp[20:header_length].hex()
        else:
            self.rx_packets += 1
            self.rx_payload_bytes += payload_bytes
            self.rx_syn_ack += int(bool(flags & 0x02 and flags & 0x10))
            self.rx_fin += int(bool(flags & 0x01))
            self.rx_rst += int(bool(flags & 0x04))
            self.rx_bad_checksum += int(
                not self._tcp_checksum_valid(packet, payload_length)
            )

    def summary(self) -> str:
        return (
            "innerTcp="
            f"txPackets:{self.tx_packets},txBytes:{self.tx_payload_bytes},"
            f"txSyn:{self.tx_syn},txFin:{self.tx_fin},txRst:{self.tx_rst},"
            f"txBadChecksum:{self.tx_bad_checksum},"
            f"txSynFlow:{self.tx_syn_flow or '-'},"
            f"txSynHopLimit:{self.tx_syn_hop_limit},"
            f"txSynWindow:{self.tx_syn_window},"
            f"txSynOptions:{self.tx_syn_options or '-'},"
            f"rxPackets:{self.rx_packets},rxBytes:{self.rx_payload_bytes},"
            f"rxSynAck:{self.rx_syn_ack},rxFin:{self.rx_fin},rxRst:{self.rx_rst},"
            f"rxBadChecksum:{self.rx_bad_checksum}"
        )


def trace_userspace_tun(tun: Any, trace: InnerTcpTrace) -> None:
    original_write = tun.write
    original_async_read = tun.async_read
    original_async_read_batch = getattr(tun, "async_read_batch", None)

    def traced_write(packet: bytes) -> Any:
        trace.observe("rx", packet)
        return original_write(packet)

    async def traced_async_read() -> bytes:
        packet = await original_async_read()
        trace.observe("tx", packet)
        return packet

    tun.write = traced_write
    tun.async_read = traced_async_read
    if original_async_read_batch is not None:
        async def traced_async_read_batch() -> list[bytes]:
            packets = await original_async_read_batch()
            for packet in packets:
                trace.observe("tx", packet)
            return packets

        tun.async_read_batch = traced_async_read_batch


def accessibility_xml(elements: list[dict[str, Any]], udid: str) -> str:
    root = ET.Element("ServerizedAccessibility", {"udid": udid, "source": "AccessibilityAudit"})
    for index, element in enumerate(elements):
        attributes = {"index": str(index)}
        for source, target in (
            ("platform_identifier", "platformIdentifier"),
            ("estimated_uid", "uid"),
            ("caption", "caption"),
            ("spoken_description", "spokenDescription"),
        ):
            value = element.get(source)
            if value is not None:
                attributes[target] = str(value)
        ET.SubElement(root, "Element", attributes)
    return ET.tostring(root, encoding="unicode")


@dataclass
class RuntimeProof:
    connected_via_overlay: bool = False
    screenshot_verified: bool = False
    cross_app_input_verified: bool = False
    last_cross_app_bundle_id: str | None = None
    last_control_at: float | None = None


@dataclass(frozen=True)
class RemotePairingHint:
    service_identifier: str
    port: int
    updated_at: float

    @property
    def fresh(self) -> bool:
        return time.time() - self.updated_at < 120


@dataclass
class DeviceHubRuntime:
    overlay_interface: str = DEFAULT_INTERFACE
    requested_udid: str | None = None
    remote_pairing_proxy_port_provider: Callable[[], int | None] | None = None
    remote_pairing_hint_wait_timeout: float = 0.0
    rsd: RemoteServiceDiscoveryService | None = None
    proof: RuntimeProof = field(default_factory=RuntimeProof)
    endpoint: dict[str, Any] | None = None
    last_error: str | None = None
    remote_pairing_hint: RemotePairingHint | None = None
    _tunnel_context: Any = None
    _dial_plane_context: Any = None
    _userspace_tun: Any = None
    _operation_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _display_size: tuple[int, int] | None = None

    @property
    def connected(self) -> bool:
        return self.rsd is not None

    @property
    def udid(self) -> str | None:
        return self.rsd.udid if self.rsd is not None else self.requested_udid

    async def connect(self, timeout: float = 15.0) -> None:
        if self.connected:
            return
        if timeout <= 0:
            raise ValueError("RemoteXPC connection timeout must be positive")
        identifiers = list(iter_remote_paired_identifiers())
        if self.requested_udid is not None:
            identifiers = [identifier for identifier in identifiers if identifier == self.requested_udid]
        if not identifiers:
            raise RuntimeError("no Linux RemotePairing record is available")

        hint = self.remote_pairing_hint
        if self.remote_pairing_hint_wait_timeout > 0 and (
            hint is None or not hint.fresh
        ):
            deadline = asyncio.get_running_loop().time() + min(
                timeout,
                self.remote_pairing_hint_wait_timeout,
            )
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    break
                await asyncio.sleep(min(0.25, remaining))
                hint = self.remote_pairing_hint
                if hint is not None and hint.fresh:
                    break
        if hint is None or not hint.fresh:
            raise RuntimeError(
                "fresh device-loopback RemotePairing metadata is unavailable"
            )
        stream_proxy_port = (
            self.remote_pairing_proxy_port_provider()
            if self.remote_pairing_proxy_port_provider is not None
            else None
        )
        candidates: list[
            tuple[str, int, str, str, str | None, int | None]
        ] = [
            (
                OVERLAY_DEVICE_IPV4,
                hint.port,
                self.overlay_interface,
                "external-packet-overlay",
                hint.service_identifier,
                None,
            )
        ]
        if stream_proxy_port is not None:
            candidates.append(
                (
                "127.0.0.1",
                stream_proxy_port,
                "lo",
                "packet-tunnel-device-loopback",
                hint.service_identifier,
                hint.port,
                )
            )
        errors: list[str] = []
        for (
            address,
            port,
            interface,
            discovery_source,
            service_identifier,
            stream_proxy_target_port,
        ) in candidates:
            for identifier in identifiers:
                # The authenticated WebSocket bridge is a TCP byte stream;
                # QUIC would require a separate datagram multiplexing
                # protocol and is not silently emulated here.
                tunnel_protocols = (TunnelProtocol.TCP,)
                for tunnel_protocol in tunnel_protocols:
                    service = None
                    tunnel_context = None
                    dial_plane_context = None
                    rsd = None
                    inner_tcp_trace = InnerTcpTrace()
                    stage = "remote-pair-verify"
                    try:
                        service = await connect_remote_pairing_service(
                            identifier,
                            address,
                            port,
                            timeout,
                            stream_proxy_target_port=stream_proxy_target_port,
                        )
                        stage = f"coredevice-{tunnel_protocol.value}-tunnel-start"
                        # Use pymobiledevice3's supported in-process data plane
                        # for the inner RemoteXPC tunnel. The project overlay
                        # still carries the authenticated RemotePairing socket;
                        # avoiding a second kernel TUN removes host route,
                        # checksum-offload, and namespace differences from the
                        # RSD handshake.
                        pmd3_tunnel_service.USE_USERSPACE_TUNNEL = True
                        tunnel_context = start_tunnel(
                            service,
                            protocol=tunnel_protocol,
                        )
                        tunnel = await asyncio.wait_for(
                            tunnel_context.__aenter__(),
                            timeout=timeout,
                        )
                        tun = tunnel.client.tun
                        if tun is None or not hasattr(tun, "set_peer"):
                            raise RuntimeError(
                                "pymobiledevice3 userspace tunnel was not created"
                            )
                        tun.set_peer(tunnel.address)
                        tunnel_client_address = str(
                            getattr(tun, "addr", "") or ""
                        )
                        if not tunnel_client_address:
                            raise RuntimeError(
                                "pymobiledevice3 userspace tunnel has no client address"
                            )
                        trace_userspace_tun(tun, inner_tcp_trace)
                        dial_plane_context = UserspaceDialPlane(
                            tun,
                            tunnel.address,
                        )
                        dial_plane = await dial_plane_context.__aenter__()
                        stage = f"remote-service-discovery-{tunnel_protocol.value}"
                        rsd = RemoteServiceDiscoveryService(
                            (tunnel.address, tunnel.port),
                            name=tunnel.interface,
                            open_connection=dial_plane.dial,
                        )
                        # RSD performs several request/response rounds inside the
                        # encrypted tunnel. A transcontinental packet overlay can
                        # need materially longer than the raw tunnel handshakes.
                        await asyncio.wait_for(
                            rsd.connect(),
                            timeout=max(timeout, 45.0),
                        )
                        if (
                            self.requested_udid is not None
                            and rsd.udid != self.requested_udid
                        ):
                            raise RuntimeError(
                                "RSD returned a different paired device"
                            )
                        stage = "developer-image"
                        try:
                            await asyncio.wait_for(auto_mount(rsd), timeout=300.0)
                        except AlreadyMountedError:
                            pass
                        else:
                            await rsd.close()
                            rsd = RemoteServiceDiscoveryService(
                                (tunnel.address, tunnel.port),
                                name=tunnel.interface,
                                open_connection=dial_plane.dial,
                            )
                            stage = "remote-service-discovery-after-image-mount"
                            await asyncio.wait_for(rsd.connect(), timeout=max(timeout, 45.0))
                        self.rsd = rsd
                        self._tunnel_context = tunnel_context
                        self._dial_plane_context = dial_plane_context
                        self.endpoint = {
                            "bonjourAddress": address,
                            "bonjourInterface": interface,
                            "bonjourPort": port,
                            "bonjourServiceIdentifier": service_identifier,
                            "discoverySource": discovery_source,
                            "rsdAddress": tunnel.address,
                            "rsdPort": tunnel.port,
                            "tunnelClientAddress": tunnel_client_address,
                            "tunnelInterface": tunnel.interface,
                            "tunnelProtocol": tunnel.protocol.value,
                        }
                        self.proof.connected_via_overlay = True
                        self.last_error = None
                        return
                    except Exception as error:
                        error_name = type(error).__name__
                        error_detail = str(error).strip()
                        errors.append(
                            f"paired-record@{address}:{port} stage={stage}: "
                            f"{error_name}"
                            + (f": {error_detail}" if error_detail else "")
                            + (
                                f" {inner_tcp_trace.summary()}"
                                if inner_tcp_trace.tx_packets
                                or inner_tcp_trace.rx_packets
                                else ""
                            )
                        )
                        if rsd is not None:
                            with suppress(Exception):
                                await rsd.close()
                        if dial_plane_context is not None:
                            with suppress(Exception):
                                await dial_plane_context.__aexit__(
                                    None,
                                    None,
                                    None,
                                )
                        if tunnel_context is not None:
                            with suppress(Exception):
                                await tunnel_context.__aexit__(None, None, None)
                        elif service is not None:
                            with suppress(Exception):
                                await service.close()
                        pmd3_tunnel_service.USE_USERSPACE_TUNNEL = False
        self.last_error = "; ".join(errors[-3:])
        raise RuntimeError(f"overlay RemoteXPC connection failed: {self.last_error}")

    async def connect_kernel_tunnel(
        self,
        client_address: str,
        server_address: str,
        rsd_port: int,
        timeout: float = 45.0,
    ) -> None:
        """Connect RSD through the raw CDTunnel already attached to sc-ios0.

        RemotePairing, TLS-PSK, and CDTunnel stay on the cooperating iPhone,
        while Linux's kernel owns the inner TCP connection. No USB transport or
        userspace TCP implementation participates in this path.
        """
        if self.connected:
            return
        if timeout <= 0:
            raise ValueError("RemoteXPC connection timeout must be positive")
        try:
            client = ipaddress.IPv6Address(client_address)
            server = ipaddress.IPv6Address(server_address)
        except ValueError as error:
            raise ValueError("raw RemoteXPC endpoint is not IPv6") from error
        if client == server or not 0 < rsd_port <= 65535:
            raise ValueError("raw RemoteXPC endpoint is invalid")
        scoped_server = (
            f"{server}%{self.overlay_interface}"
            if server.is_link_local
            else str(server)
        )
        rsd = RemoteServiceDiscoveryService(
            (scoped_server, rsd_port),
            name=self.overlay_interface,
        )
        try:
            await asyncio.wait_for(
                rsd.connect(),
                timeout=max(timeout, 45.0),
            )
            if (
                self.requested_udid is not None
                and rsd.udid != self.requested_udid
            ):
                raise RuntimeError("RSD returned a different paired device")
        except BaseException:
            with suppress(Exception):
                await rsd.close()
            raise
        self.rsd = rsd
        self.endpoint = {
            "discoverySource": "packet-tunnel-raw-cdtunnel",
            "rsdAddress": str(server),
            "rsdPort": rsd_port,
            "tunnelClientAddress": str(client),
            "tunnelInterface": self.overlay_interface,
            "tunnelProtocol": TunnelProtocol.TCP.value,
        }
        self.proof.connected_via_overlay = True
        self.last_error = None

    async def connect_userspace_cdtunnel(
        self,
        tun: Any,
        client_address: str,
        server_address: str,
        rsd_port: int,
        timeout: float = 45.0,
    ) -> None:
        """Terminate the raw on-device CDTunnel in Linux's PyTCP stack."""
        if self.connected:
            return
        if timeout <= 0:
            raise ValueError("RemoteXPC connection timeout must be positive")
        try:
            client = ipaddress.IPv6Address(client_address)
            server = ipaddress.IPv6Address(server_address)
        except ValueError as error:
            raise ValueError("raw RemoteXPC endpoint is not IPv6") from error
        if client == server or not 0 < rsd_port <= 65535:
            raise ValueError("raw RemoteXPC endpoint is invalid")

        inner_tcp_trace = InnerTcpTrace()
        trace_userspace_tun(tun, inner_tcp_trace)
        dial_plane_context = UserspaceDialPlane(tun, str(server))
        rsd = None
        try:
            dial_plane = await dial_plane_context.__aenter__()
            rsd = RemoteServiceDiscoveryService(
                (str(server), rsd_port),
                name=tun.name,
                open_connection=dial_plane.dial,
            )
            await asyncio.wait_for(
                rsd.connect(),
                timeout=max(timeout, 45.0),
            )
            if (
                self.requested_udid is not None
                and rsd.udid != self.requested_udid
            ):
                raise RuntimeError("RSD returned a different paired device")
        except BaseException as error:
            if rsd is not None:
                with suppress(Exception):
                    await rsd.close()
            with suppress(Exception):
                await dial_plane_context.__aexit__(None, None, None)
            with suppress(Exception):
                await tun.close()
            if isinstance(error, asyncio.CancelledError):
                raise
            if inner_tcp_trace.tx_packets or inner_tcp_trace.rx_packets:
                raise RuntimeError(inner_tcp_trace.summary())
            raise

        self.rsd = rsd
        self._dial_plane_context = dial_plane_context
        self._userspace_tun = tun
        self.endpoint = {
            "discoverySource": "packet-tunnel-raw-cdtunnel-pytcp",
            "rsdAddress": str(server),
            "rsdPort": rsd_port,
            "tunnelClientAddress": str(client),
            "tunnelInterface": tun.name,
            "tunnelProtocol": TunnelProtocol.TCP.value,
        }
        self.proof.connected_via_overlay = True
        self.last_error = None

    def update_remote_pairing_hint(
        self,
        service_identifier: str | None,
        port: int | None,
        updated_at_ms: int | float | None,
    ) -> None:
        if (
            service_identifier is None
            or port is None
            or updated_at_ms is None
            or not 0 < port <= 65535
        ):
            self.remote_pairing_hint = None
            return
        try:
            uuid.UUID(service_identifier)
        except ValueError:
            self.remote_pairing_hint = None
            return
        self.remote_pairing_hint = RemotePairingHint(
            service_identifier=service_identifier.upper(),
            port=port,
            updated_at=float(updated_at_ms) / 1000,
        )

    async def close(self) -> None:
        rsd = self.rsd
        dial_plane_context = self._dial_plane_context
        tunnel_context = self._tunnel_context
        userspace_tun = self._userspace_tun
        self.rsd = None
        self._dial_plane_context = None
        self._tunnel_context = None
        self._userspace_tun = None
        self._display_size = None
        self.endpoint = None
        self.proof.connected_via_overlay = False
        if rsd is not None:
            with suppress(Exception):
                await rsd.close()
        if dial_plane_context is not None:
            with suppress(Exception):
                await dial_plane_context.__aexit__(None, None, None)
        if tunnel_context is not None:
            with suppress(Exception):
                await tunnel_context.__aexit__(None, None, None)
        if userspace_tun is not None:
            with suppress(Exception):
                await userspace_tun.close()
        pmd3_tunnel_service.USE_USERSPACE_TUNNEL = False

    def require_rsd(self) -> RemoteServiceDiscoveryService:
        if self.rsd is None:
            raise RuntimeError("RemoteXPC is not connected through the overlay")
        return self.rsd

    async def device_relay_port(self, port: int) -> int:
        """Expose one device TCP port through the active userspace dial plane."""
        if not 0 < port <= 65535:
            raise ValueError("device relay port is invalid")
        dial_plane = self._dial_plane_context
        if dial_plane is None:
            raise RuntimeError("RemoteXPC userspace dial plane is unavailable")
        return await dial_plane._ensure_relay(port)

    async def info(self) -> dict[str, Any]:
        rsd = self.require_rsd()
        properties = (rsd.peer_info or {}).get("Properties", {})
        return {
            "identifier": rsd.udid,
            "udid": rsd.udid,
            "name": properties.get("Name") or properties.get("DeviceName") or rsd.udid,
            "osVersion": properties.get("OSVersion"),
            "productType": properties.get("ProductType") or rsd.product_type,
            "transportType": "project-overlay",
            "pairingState": "paired",
            "state": "connected",
            "reality": "physical",
            "endpoint": self.endpoint,
        }

    async def get_display_size(self) -> tuple[int, int]:
        if self._display_size is None:
            async with self._operation_lock, DeviceInfoService(self.require_rsd()) as service:
                self._display_size = display_dimensions(await service.get_display_info())
        return self._display_size

    async def launch(self, bundle_id: str) -> Any:
        if not bundle_id:
            raise ValueError("bundleId is required")
        async with self._operation_lock, AppServiceService(self.require_rsd()) as service:
            return await service.launch_application(bundle_id)

    async def ensure_developer_app(
        self,
        bundle_id: str,
        package_path: Path,
    ) -> bool:
        """Install a signed developer app through the active Linux RemoteXPC link.

        Returns True only when an installation was performed. The package stays
        on the Linux host; installation-proxy stages it over the paired RSD/AFC
        services, so this never falls back to usbmuxd or a Mac.
        """
        if not bundle_id:
            raise ValueError("bundleId is required")
        package = package_path.resolve(strict=True)
        if not package.is_file() and not package.is_dir():
            raise ValueError("developer app package must be an IPA or app directory")
        async with self._operation_lock, InstallationProxyService(
            self.require_rsd()
        ) as service:
            installed = await service.get_apps(bundle_identifiers=[bundle_id])
            if bundle_id in installed:
                return False
            await service.install_from_local(package, developer=True)
            installed = await service.get_apps(bundle_identifiers=[bundle_id])
            if bundle_id not in installed:
                raise RuntimeError(
                    f"installation-proxy completed but {bundle_id} is absent"
                )
        return True

    async def screenshot(self) -> bytes:
        async with self._operation_lock, ScreenCaptureService(self.require_rsd()) as service:
            result = await service.capture_screenshot(requested_format="png")
        image = result.get("image")
        if not isinstance(image, bytes) or not image.startswith(b"\x89PNG\r\n\x1a\n"):
            raise RuntimeError("CoreDevice screenshot service returned no PNG")
        self.proof.screenshot_verified = True
        return image

    async def source(self, max_elements: int = 512, timeout: float = 20.0) -> str:
        async def collect() -> list[dict[str, Any]]:
            found: list[dict[str, Any]] = []
            async with AccessibilityAudit(self.require_rsd()) as service:
                async for element in service.iter_elements():
                    found.append(element.to_dict())
                    if len(found) >= max_elements:
                        break
            return found

        async with self._operation_lock:
            elements = await asyncio.wait_for(collect(), timeout=timeout)
        return accessibility_xml(elements, self.require_rsd().udid)


@dataclass
class DeviceSession:
    runtime: DeviceHubRuntime
    bundle_id: str
    viewer_port: int
    agent_bundle_id: str = DEFAULT_AGENT_BUNDLE_ID
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    created_at: float = field(default_factory=time.time)
    _current_bundle_id: str | None = None
    _hid: UniversalHIDServiceService | None = None
    _touch_session: Any | None = None
    _keyboard_service_id: int | None = None
    _wda_client: WdaClient | None = None
    _wda_session_id: str | None = None
    _wda_task: asyncio.Task[None] | None = None
    _input_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def viewer_url(self) -> None:
        # The RemoteXPC address belongs to the in-process userspace TCP stack
        # and cannot be handed to a viewer subprocess. Screens are exposed by
        # the session screenshot endpoint instead.
        return None

    async def start(self, timeout: float = 75.0) -> None:
        rsd = self.runtime.require_rsd()
        try:
            await self._start_wda(rsd, timeout)
            return
        except BaseException as error:
            print(
                json.dumps(
                    {
                        "event": "wda-session-start-failed",
                        "errorType": type(error).__name__,
                        "error": str(error),
                    }
                ),
                flush=True,
            )
            await self._stop_wda()

        # iOS 27 accepts the UniversalHID RemoteXPC messages but backboardd
        # silently discards them unless the host has an authenticated media
        # stream. Keep that stream and HID service in this process: the RSD
        # address is reachable only through this process's UserspaceDialPlane.
        endpoint = self.runtime.endpoint
        candidate = (
            endpoint.get("tunnelClientAddress")
            if isinstance(endpoint, dict)
            else None
        )
        local_tunnel_address = candidate if isinstance(candidate, str) else ""
        context = (
            userspace_touch_session(rsd, local_tunnel_address)
            if local_tunnel_address
            else touch_session(rsd)
        )
        stage = "hid-media-auth"
        try:
            self._hid = await context.__aenter__()
            self._touch_session = context
            stage = "launch"
            await self.launch(self.bundle_id)
        except BaseException as error:
            print(
                json.dumps(
                    {
                        "event": "device-session-start-failed",
                        "stage": stage,
                        "errorType": type(error).__name__,
                        "error": str(error),
                    }
                ),
                flush=True,
            )
            with suppress(BaseException):
                await context.__aexit__(*sys.exc_info())
            self._hid = None
            self._touch_session = None
            raise

    async def _start_wda(
        self,
        rsd: RemoteServiceDiscoveryService,
        timeout: float,
    ) -> None:
        config = await TestConfig.create_for(
            rsd,
            DEFAULT_WDA_RUNNER_BUNDLE_ID,
        )
        service = XCUITestService(rsd)
        self._wda_task = asyncio.create_task(service.run(config))
        relay_port = await self.runtime.device_relay_port(8100)
        client = WdaClient(
            base_url=f"http://127.0.0.1:{relay_port}",
            timeout=1.0,
        )
        deadline = asyncio.get_running_loop().time() + max(timeout, 1.0)
        last_error: BaseException | None = None
        while asyncio.get_running_loop().time() < deadline:
            if self._wda_task.done():
                await self._wda_task
                raise RuntimeError("WebDriverAgentRunner stopped before becoming ready")
            try:
                await asyncio.to_thread(client.get_status)
                break
            except BaseException as error:
                last_error = error
                await asyncio.sleep(0.25)
        else:
            raise TimeoutError(
                "WebDriverAgent did not become ready over the Linux tunnel"
            ) from last_error
        session_id = await asyncio.to_thread(
            client.start_session,
            self.bundle_id,
        )
        self._wda_client = client
        self._wda_session_id = session_id
        self._current_bundle_id = self.bundle_id

    async def _stop_wda(self) -> None:
        self._wda_client = None
        self._wda_session_id = None
        task = self._wda_task
        self._wda_task = None
        if task is not None:
            task.cancel()
            with suppress(BaseException):
                await task

    async def close(self) -> None:
        await self._stop_wda()
        context = self._touch_session
        self._touch_session = None
        self._hid = None
        self._keyboard_service_id = None
        if context is not None:
            with suppress(BaseException):
                await context.__aexit__(None, None, None)

    def _require_hid(self) -> UniversalHIDServiceService:
        if self._hid is None:
            raise RuntimeError("Universal HID is not connected to the active DisplayService stream")
        return self._hid

    async def _screen_digest(self) -> str:
        return hashlib.sha256(await self.screenshot()).hexdigest()

    async def screenshot(self) -> bytes:
        if self._wda_client is not None and self._wda_session_id is not None:
            image = await asyncio.to_thread(
                self._wda_client.get_screenshot,
                self._wda_session_id,
            )
            if not image.startswith(b"\x89PNG\r\n\x1a\n"):
                raise RuntimeError("WebDriverAgent returned no PNG")
            self.runtime.proof.screenshot_verified = True
            return image
        return await self.runtime.screenshot()

    async def source(self) -> str:
        if self._wda_client is not None and self._wda_session_id is not None:
            return await asyncio.to_thread(
                self._wda_client.get_source,
                self._wda_session_id,
            )
        return await self.runtime.source()

    async def _stable_screen_digest(self) -> tuple[str, bool]:
        first = await self._screen_digest()
        await asyncio.sleep(0.35)
        second = await self._screen_digest()
        return second, first == second

    async def _verify_input_changed_cross_app(self, before: str, baseline_was_stable: bool) -> None:
        await asyncio.sleep(0.5)
        after = await self._screen_digest()
        if (
            baseline_was_stable
            and before != after
            and self._current_bundle_id is not None
            and self._current_bundle_id != self.agent_bundle_id
        ):
            self.runtime.proof.cross_app_input_verified = True
            self.runtime.proof.last_cross_app_bundle_id = self._current_bundle_id
            self.runtime.proof.last_control_at = time.time()

    async def launch(self, bundle_id: str) -> Any:
        result = await self.runtime.launch(bundle_id)
        self._current_bundle_id = bundle_id
        return result

    async def tap(self, x: float, y: float) -> None:
        async with self._input_lock:
            before, baseline_was_stable = await self._stable_screen_digest()
            if self._wda_client is not None and self._wda_session_id is not None:
                await asyncio.to_thread(
                    self._wda_client._request_json,
                    "POST",
                    f"/session/{self._wda_session_id}/wda/tap/0",
                    {"x": x, "y": y},
                )
                await self._verify_input_changed_cross_app(
                    before,
                    baseline_was_stable,
                )
                return
            width, height = await self.runtime.get_display_size()
            normalized_x = normalize_coordinate(x, width)
            normalized_y = normalize_coordinate(y, height)
            hid = self._require_hid()
            await hid.send_touchscreen(TOUCHSCREEN_STATE_CONTACT, normalized_x, normalized_y)
            await asyncio.sleep(0.05)
            await hid.send_touchscreen(TOUCHSCREEN_STATE_RELEASE, normalized_x, normalized_y)
            await self._verify_input_changed_cross_app(before, baseline_was_stable)

    async def swipe(self, from_x: float, from_y: float, to_x: float, to_y: float, duration_ms: int) -> None:
        async with self._input_lock:
            before, baseline_was_stable = await self._stable_screen_digest()
            if self._wda_client is not None and self._wda_session_id is not None:
                await asyncio.to_thread(
                    self._wda_client.swipe,
                    round(from_x),
                    round(from_y),
                    round(to_x),
                    round(to_y),
                    max(duration_ms, 1) / 1000,
                    self._wda_session_id,
                )
                await self._verify_input_changed_cross_app(
                    before,
                    baseline_was_stable,
                )
                return
            width, height = await self.runtime.get_display_size()
            hid = self._require_hid()
            steps = max(2, min(120, round(duration_ms / 16)))
            for step in range(steps):
                ratio = step / (steps - 1)
                await hid.send_touchscreen(
                    TOUCHSCREEN_STATE_CONTACT,
                    normalize_coordinate(from_x + (to_x - from_x) * ratio, width),
                    normalize_coordinate(from_y + (to_y - from_y) * ratio, height),
                )
                await asyncio.sleep(duration_ms / steps / 1000)
            await hid.send_touchscreen(
                TOUCHSCREEN_STATE_RELEASE,
                normalize_coordinate(to_x, width),
                normalize_coordinate(to_y, height),
            )
            await self._verify_input_changed_cross_app(before, baseline_was_stable)

    async def type_text(self, text: str) -> None:
        async with self._input_lock:
            before, baseline_was_stable = await self._stable_screen_digest()
            if self._wda_client is not None and self._wda_session_id is not None:
                await asyncio.to_thread(
                    self._wda_client.send_keys,
                    text,
                    self._wda_session_id,
                )
                await self._verify_input_changed_cross_app(
                    before,
                    baseline_was_stable,
                )
                return
            hid = self._require_hid()
            if self._keyboard_service_id is None:
                self._keyboard_service_id = await hid.create_keyboard_service()
            for character in text:
                mapping = ASCII_TO_HID.get(character)
                if mapping is None:
                    raise ValueError(f"Universal HID currently supports printable US-layout ASCII, not {character!r}")
                usage, shifted = mapping
                usages = [KEY_LEFT_SHIFT, usage] if shifted else [usage]
                await hid.send_keyboard(self._keyboard_service_id, usages)
                await hid.send_keyboard(self._keyboard_service_id, [])
            await self._verify_input_changed_cross_app(before, baseline_was_stable)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "udid": self.runtime.udid,
            "bundleId": self.bundle_id,
            "currentBundleId": self._current_bundle_id,
            "driver": (
                "linux-wda-xcuitest"
                if self._wda_client is not None
                else "linux-coredevice-display-hid"
            ),
            "viewerUrl": self.viewer_url,
            "screenTransport": "coredevice-screenshot",
            "createdAt": self.created_at,
            "ready": self._wda_client is not None or self._hid is not None,
        }
