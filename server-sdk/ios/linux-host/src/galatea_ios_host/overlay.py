from __future__ import annotations

import asyncio
import fcntl
import ipaddress
import json
import os
import struct
import subprocess
import time
import uuid
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit, urlunsplit

import websockets

from .constants import (
    DEFAULT_INTERFACE,
    DEFAULT_MTU,
    MDNS_IPV4,
    MDNS_IPV6,
    OVERLAY_DEVICE_IPV4,
    OVERLAY_DEVICE_IPV6,
    OVERLAY_HOST_IPV4,
    OVERLAY_IPV4_CIDR,
    OVERLAY_IPV6_CIDR,
)

TUNSETIFF = 0x400454CA
IFF_TUN = 0x0001
IFF_NO_PI = 0x1000

CommandRunner = Callable[[list[str]], None]
FirewallCommandRunner = Callable[[list[str]], bool]
SysctlReader = Callable[[], bool]
SysctlWriter = Callable[[bool], None]

REMOTE_PAIRING_STREAM_MAGIC = b"SRVTCP01"
REMOTE_PAIRING_STREAM_HEADER_SIZE = len(REMOTE_PAIRING_STREAM_MAGIC) + 16 + 1
REMOTE_PAIRING_STREAM_OPEN = 1
REMOTE_PAIRING_STREAM_OPENED = 2
REMOTE_PAIRING_STREAM_DATA = 3
REMOTE_PAIRING_STREAM_CLOSE = 4
REMOTE_PAIRING_STREAM_ERROR = 5
REMOTE_PAIRING_STREAM_MAX_PAYLOAD = 32 * 1024
REMOTE_PAIRING_TARGET_MAGIC = b"SRVPORT1"
REMOTE_PAIRING_TARGET_HEADER_SIZE = len(REMOTE_PAIRING_TARGET_MAGIC) + 2
ON_DEVICE_REMOTE_XPC_HELLO = b"SRVHELLO1"
ON_DEVICE_PAIR_RECORD_MAGIC = b"SRVPAIR1"
ON_DEVICE_PAIR_RECORD_ACK = b"SRVACK01"
ON_DEVICE_PAIR_RECORD_MAX_SIZE = 4096
REMOTE_XPC_TUNNEL_MAGIC = b"SRVRPX1"
REMOTE_XPC_TUNNEL_SETUP = 1
REMOTE_XPC_TUNNEL_PACKET = 2
REMOTE_XPC_TUNNEL_RESYNC = 3
REMOTE_XPC_TUNNEL_SETUP_MAX_SIZE = 1024
TLS_RECORD_HEADER_SIZE = 5
TLS_RECORD_MAX_PAYLOAD = 18 * 1024


class TlsRecordFramer:
    """Preserve TLS record writes across an arbitrary TCP/WebSocket bridge.

    Apple's TCP RemotePairing tunnel treats each decrypted application write
    as one inner IPv6 packet. Keeping ciphertext record boundaries intact makes
    Network.framework deliver those writes independently instead of combining
    adjacent packets after a transcontinental stream proxy.
    """

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._is_tls: bool | None = None

    def feed(self, data: bytes) -> list[bytes]:
        if not data:
            return []
        if self._is_tls is False:
            return [data]
        self._buffer.extend(data)
        if self._is_tls is None:
            if len(self._buffer) < TLS_RECORD_HEADER_SIZE:
                return []
            content_type = self._buffer[0]
            major_version = self._buffer[1]
            minor_version = self._buffer[2]
            payload_length = int.from_bytes(self._buffer[3:5], "big")
            self._is_tls = (
                20 <= content_type <= 24
                and major_version == 3
                and minor_version <= 4
                and payload_length <= TLS_RECORD_MAX_PAYLOAD
            )
            if not self._is_tls:
                buffered = bytes(self._buffer)
                self._buffer.clear()
                return [buffered]

        records = []
        while len(self._buffer) >= TLS_RECORD_HEADER_SIZE:
            payload_length = int.from_bytes(self._buffer[3:5], "big")
            record_length = TLS_RECORD_HEADER_SIZE + payload_length
            if (
                payload_length > TLS_RECORD_MAX_PAYLOAD
                or len(self._buffer) < record_length
            ):
                break
            records.append(bytes(self._buffer[:record_length]))
            del self._buffer[:record_length]
        return records

    def flush(self) -> list[bytes]:
        if not self._buffer:
            return []
        buffered = bytes(self._buffer)
        self._buffer.clear()
        return [buffered]


def encode_remote_pairing_stream_frame(
    stream_id: uuid.UUID,
    opcode: int,
    payload: bytes = b"",
) -> bytes:
    if opcode not in {
        REMOTE_PAIRING_STREAM_OPEN,
        REMOTE_PAIRING_STREAM_OPENED,
        REMOTE_PAIRING_STREAM_DATA,
        REMOTE_PAIRING_STREAM_CLOSE,
        REMOTE_PAIRING_STREAM_ERROR,
    }:
        raise ValueError("unknown RemotePairing stream opcode")
    if len(payload) > REMOTE_PAIRING_STREAM_MAX_PAYLOAD:
        raise ValueError("RemotePairing stream payload is too large")
    return REMOTE_PAIRING_STREAM_MAGIC + stream_id.bytes + bytes([opcode]) + payload


def decode_remote_pairing_stream_frame(
    message: bytes,
) -> tuple[uuid.UUID, int, bytes] | None:
    if not message.startswith(REMOTE_PAIRING_STREAM_MAGIC):
        return None
    if len(message) < REMOTE_PAIRING_STREAM_HEADER_SIZE:
        return None
    stream_id = uuid.UUID(
        bytes=message[
            len(REMOTE_PAIRING_STREAM_MAGIC) : len(REMOTE_PAIRING_STREAM_MAGIC) + 16
        ]
    )
    opcode = message[REMOTE_PAIRING_STREAM_HEADER_SIZE - 1]
    if opcode not in {
        REMOTE_PAIRING_STREAM_OPEN,
        REMOTE_PAIRING_STREAM_OPENED,
        REMOTE_PAIRING_STREAM_DATA,
        REMOTE_PAIRING_STREAM_CLOSE,
        REMOTE_PAIRING_STREAM_ERROR,
    }:
        return None
    payload = message[REMOTE_PAIRING_STREAM_HEADER_SIZE:]
    if len(payload) > REMOTE_PAIRING_STREAM_MAX_PAYLOAD:
        return None
    return stream_id, opcode, payload


@dataclass
class OverlayTcpStream:
    writer: asyncio.StreamWriter
    opened: asyncio.Event = field(default_factory=asyncio.Event)
    remote_error: str | None = None


def build_websocket_url(controller_url: str, device_id: str) -> str:
    parsed = urlsplit(controller_url.strip())
    if not parsed.scheme or not parsed.netloc:
        raise ValueError("controller URL must include a scheme and host")
    if parsed.scheme not in {"http", "https", "ws", "wss"}:
        raise ValueError("controller URL must use http, https, ws, or wss")
    scheme = {"https": "wss", "http": "ws"}.get(parsed.scheme, parsed.scheme)
    base_path = parsed.path.rstrip("/")
    path = f"{base_path}/packet-overlay/{quote(device_id, safe='')}"
    query = urlencode({"role": "linux"})
    return urlunsplit((scheme, parsed.netloc, path, query, ""))


def tun_setup_commands(interface: str = DEFAULT_INTERFACE, mtu: int = DEFAULT_MTU) -> list[list[str]]:
    return [
        ["ip", "link", "set", "dev", interface, "mtu", str(mtu), "multicast", "on", "up"],
        ["ip", "addr", "replace", OVERLAY_IPV4_CIDR, "dev", interface],
        ["ip", "route", "replace", f"{OVERLAY_DEVICE_IPV4}/32", "dev", interface],
        ["ip", "route", "replace", f"{MDNS_IPV4}/32", "dev", interface],
        ["ip", "-6", "addr", "replace", OVERLAY_IPV6_CIDR, "dev", interface],
        ["ip", "-6", "route", "replace", f"{OVERLAY_DEVICE_IPV6}/128", "dev", interface],
        ["ip", "-6", "route", "replace", f"{MDNS_IPV6}/128", "dev", interface],
    ]


def firewall_rule_commands(interface: str, operation: str) -> list[list[str]]:
    if operation not in {"check", "add", "delete"}:
        raise ValueError(f"unknown firewall operation: {operation}")
    action = {"check": "-C", "add": "-I", "delete": "-D"}[operation]
    commands = []
    for executable, source in (
        ("iptables", f"{OVERLAY_DEVICE_IPV4}/32"),
        ("ip6tables", f"{OVERLAY_DEVICE_IPV6}/128"),
    ):
        command = [executable, "-w", action, "INPUT"]
        if operation == "add":
            command.append("1")
        command.extend(
            [
                "-i",
                interface,
                "-s",
                source,
                "-m",
                "comment",
                "--comment",
                f"galatea-ios-host:{interface}",
                "-j",
                "ACCEPT",
            ]
        )
        commands.append(command)
    return commands


def forwarding_rule_commands(interface: str, operation: str) -> list[list[str]]:
    if operation not in {"check", "add", "delete"}:
        raise ValueError(f"unknown firewall operation: {operation}")
    action = {"check": "-C", "add": "-I", "delete": "-D"}[operation]
    position = ["1"] if operation == "add" else []
    comment = f"serverized-ios-forward:{interface}"
    return [
        [
            "iptables",
            "-w",
            action,
            "FORWARD",
            *position,
            "-i",
            interface,
            "-s",
            f"{OVERLAY_DEVICE_IPV4}/32",
            "-m",
            "comment",
            "--comment",
            comment,
            "-j",
            "ACCEPT",
        ],
        [
            "iptables",
            "-w",
            action,
            "FORWARD",
            *position,
            "-o",
            interface,
            "-d",
            f"{OVERLAY_DEVICE_IPV4}/32",
            "-m",
            "conntrack",
            "--ctstate",
            "ESTABLISHED,RELATED",
            "-m",
            "comment",
            "--comment",
            comment,
            "-j",
            "ACCEPT",
        ],
        [
            "iptables",
            "-w",
            "-t",
            "nat",
            action,
            "POSTROUTING",
            *position,
            "-s",
            f"{OVERLAY_DEVICE_IPV4}/32",
            "-m",
            "comment",
            "--comment",
            comment,
            "-j",
            "MASQUERADE",
        ],
    ]


def is_ip_packet(packet: bytes) -> bool:
    return bool(packet) and packet[0] >> 4 in {4, 6}


@dataclass(frozen=True)
class RemoteXpcTunnelEndpoint:
    client_address: str
    server_address: str
    mtu: int
    rsd_port: int

    def status(self) -> dict[str, object]:
        return {
            "clientAddress": self.client_address,
            "serverAddress": self.server_address,
            "mtu": self.mtu,
            "rsdPort": self.rsd_port,
        }


def encode_remote_xpc_tunnel_packet(packet: bytes) -> bytes:
    if len(packet) < 40 or len(packet) > 65535 or packet[0] >> 4 != 6:
        raise ValueError("RemoteXPC tunnel packet must be a valid-sized IPv6 packet")
    payload_length = int.from_bytes(packet[4:6], "big")
    if len(packet) != 40 + payload_length:
        raise ValueError("RemoteXPC tunnel IPv6 payload length is inconsistent")
    return REMOTE_XPC_TUNNEL_MAGIC + bytes([REMOTE_XPC_TUNNEL_PACKET]) + packet


def decode_remote_xpc_tunnel_frame(
    message: bytes,
) -> tuple[int, RemoteXpcTunnelEndpoint | bytes] | None:
    if not message.startswith(REMOTE_XPC_TUNNEL_MAGIC):
        return None
    header_size = len(REMOTE_XPC_TUNNEL_MAGIC) + 1
    if len(message) <= header_size:
        return None
    opcode = message[len(REMOTE_XPC_TUNNEL_MAGIC)]
    payload = message[header_size:]
    if opcode == REMOTE_XPC_TUNNEL_PACKET:
        if len(payload) < 40 or len(payload) > 65535 or payload[0] >> 4 != 6:
            return None
        payload_length = int.from_bytes(payload[4:6], "big")
        if len(payload) != 40 + payload_length:
            return None
        return opcode, payload
    if opcode != REMOTE_XPC_TUNNEL_SETUP or len(payload) > REMOTE_XPC_TUNNEL_SETUP_MAX_SIZE:
        return None
    try:
        metadata = json.loads(payload)
        client = ipaddress.IPv6Address(metadata["clientAddress"])
        server = ipaddress.IPv6Address(metadata["serverAddress"])
        mtu = int(metadata["mtu"])
        rsd_port = int(metadata["rsdPort"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None
    if (
        client == server
        or client.is_unspecified
        or server.is_unspecified
        or client.is_multicast
        or server.is_multicast
        or client.is_loopback
        or server.is_loopback
        or not 1280 <= mtu <= 65535
        or not 0 < rsd_port <= 65535
    ):
        return None
    return opcode, RemoteXpcTunnelEndpoint(
        client_address=str(client),
        server_address=str(server),
        mtu=mtu,
        rsd_port=rsd_port,
    )


def remote_xpc_packet_matches(
    packet: bytes,
    endpoint: RemoteXpcTunnelEndpoint,
) -> bool:
    if len(packet) < 40 or packet[0] >> 4 != 6:
        return False
    source_ip = ipaddress.IPv6Address(packet[8:24])
    destination_ip = ipaddress.IPv6Address(packet[24:40])
    source = str(source_ip)
    destination = str(destination_ip)
    tunnel_addresses = {
        endpoint.client_address,
        endpoint.server_address,
    }
    # IPv6 neighbor discovery and router discovery use multicast destinations.
    # The authenticated CDTunnel is already device-scoped, so an inner packet
    # belongs to it when either endpoint is one of its negotiated addresses.
    return (
        source in tunnel_addresses
        or destination in tunnel_addresses
        or source_ip.is_link_local
        or destination_ip.is_link_local
    )


def remote_xpc_packet_summary(packet: bytes) -> dict[str, object]:
    summary: dict[str, object] = {
        "source": str(ipaddress.IPv6Address(packet[8:24])),
        "destination": str(ipaddress.IPv6Address(packet[24:40])),
        "nextHeader": packet[6],
        "hopLimit": packet[7],
        "length": len(packet),
    }
    if packet[6] == 6 and len(packet) >= 60:
        summary.update(
            {
                "sourcePort": int.from_bytes(packet[40:42], "big"),
                "destinationPort": int.from_bytes(packet[42:44], "big"),
                "tcpFlags": packet[53],
            }
        )
    elif packet[6] == 58 and len(packet) >= 48:
        summary["icmpv6Type"] = packet[40]
    return summary


def run_command(command: list[str]) -> None:
    subprocess.run(command, check=True)


def run_firewall_command(command: list[str]) -> bool:
    return subprocess.run(
        command,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def install_overlay_firewall(
    interface: str,
    runner: FirewallCommandRunner = run_firewall_command,
) -> None:
    checks = firewall_rule_commands(interface, "check")
    additions = firewall_rule_commands(interface, "add")
    try:
        for check, addition in zip(checks, additions, strict=True):
            if not runner(check) and not runner(addition):
                raise RuntimeError(f"failed to install overlay firewall rule: {addition[0]}")
    except BaseException:
        remove_overlay_firewall(interface, runner)
        raise


def remove_overlay_firewall(
    interface: str,
    runner: FirewallCommandRunner = run_firewall_command,
) -> None:
    checks = firewall_rule_commands(interface, "check")
    deletions = firewall_rule_commands(interface, "delete")
    for check, deletion in zip(checks, deletions, strict=True):
        while runner(check):
            if not runner(deletion):
                raise RuntimeError(f"failed to remove overlay firewall rule: {deletion[0]}")


def install_overlay_forwarding(
    interface: str,
    runner: FirewallCommandRunner = run_firewall_command,
) -> None:
    checks = forwarding_rule_commands(interface, "check")
    additions = forwarding_rule_commands(interface, "add")
    try:
        for check, addition in zip(checks, additions, strict=True):
            if not runner(check) and not runner(addition):
                raise RuntimeError(f"failed to install overlay forwarding rule: {addition}")
    except BaseException:
        remove_overlay_forwarding(interface, runner)
        raise


def remove_overlay_forwarding(
    interface: str,
    runner: FirewallCommandRunner = run_firewall_command,
) -> None:
    checks = forwarding_rule_commands(interface, "check")
    deletions = forwarding_rule_commands(interface, "delete")
    for check, deletion in zip(checks, deletions, strict=True):
        while runner(check):
            if not runner(deletion):
                raise RuntimeError(f"failed to remove overlay forwarding rule: {deletion}")


def read_ipv4_forwarding() -> bool:
    return Path("/proc/sys/net/ipv4/ip_forward").read_text(encoding="ascii").strip() == "1"


def write_ipv4_forwarding(enabled: bool) -> None:
    Path("/proc/sys/net/ipv4/ip_forward").write_text(
        "1\n" if enabled else "0\n",
        encoding="ascii",
    )


@dataclass
class TunDevice:
    interface: str = DEFAULT_INTERFACE
    mtu: int = DEFAULT_MTU
    runner: CommandRunner = run_command
    firewall_runner: FirewallCommandRunner = run_firewall_command
    sysctl_reader: SysctlReader = read_ipv4_forwarding
    sysctl_writer: SysctlWriter = write_ipv4_forwarding
    fd: int | None = None
    _firewall_installed: bool = field(default=False, init=False)
    _forwarding_installed: bool = field(default=False, init=False)
    _restore_ipv4_forwarding: bool = field(default=False, init=False)
    _remote_xpc_endpoint: RemoteXpcTunnelEndpoint | None = field(
        default=None,
        init=False,
    )

    def open(self) -> None:
        if self.fd is not None:
            return
        fd = os.open("/dev/net/tun", os.O_RDWR | os.O_NONBLOCK)
        request = struct.pack("16sH", self.interface.encode("ascii"), IFF_TUN | IFF_NO_PI)
        try:
            response = fcntl.ioctl(fd, TUNSETIFF, request)
            self.interface = response[:16].split(b"\0", 1)[0].decode("ascii")
            for command in tun_setup_commands(self.interface, self.mtu):
                self.runner(command)
            install_overlay_firewall(self.interface, self.firewall_runner)
            self._firewall_installed = True
            if not self.sysctl_reader():
                self.sysctl_writer(True)
                self._restore_ipv4_forwarding = True
            install_overlay_forwarding(self.interface, self.firewall_runner)
            self._forwarding_installed = True
        except BaseException:
            if self._forwarding_installed:
                remove_overlay_forwarding(self.interface, self.firewall_runner)
                self._forwarding_installed = False
            if self._restore_ipv4_forwarding:
                self.sysctl_writer(False)
                self._restore_ipv4_forwarding = False
            if self._firewall_installed:
                remove_overlay_firewall(self.interface, self.firewall_runner)
                self._firewall_installed = False
            os.close(fd)
            raise
        self.fd = fd

    def close(self) -> None:
        if self.fd is None:
            return
        self.clear_remote_xpc()
        os.close(self.fd)
        self.fd = None
        try:
            if self._forwarding_installed:
                remove_overlay_forwarding(self.interface, self.firewall_runner)
                self._forwarding_installed = False
            if self._firewall_installed:
                remove_overlay_firewall(self.interface, self.firewall_runner)
                self._firewall_installed = False
        finally:
            if self._restore_ipv4_forwarding:
                self.sysctl_writer(False)
                self._restore_ipv4_forwarding = False

    def configure_remote_xpc(self, endpoint: RemoteXpcTunnelEndpoint) -> None:
        if self.fd is None:
            raise RuntimeError("TUN device is not open")
        previous = self._remote_xpc_endpoint
        commands = [
            [
                "ip",
                "link",
                "set",
                "dev",
                self.interface,
                "mtu",
                str(endpoint.mtu),
            ],
            [
                "ip",
                "-6",
                "addr",
                "replace",
                f"{endpoint.client_address}/64",
                "dev",
                self.interface,
            ],
            [
                "ip",
                "-6",
                "route",
                "replace",
                f"{endpoint.server_address}/128",
                "dev",
                self.interface,
                "src",
                endpoint.client_address,
            ],
        ]
        for command in commands:
            self.runner(command)
        self._remote_xpc_endpoint = endpoint
        if (
            previous is not None
            and previous.server_address != endpoint.server_address
        ):
            self.firewall_runner(
                [
                    "ip",
                    "-6",
                    "route",
                    "del",
                    f"{previous.server_address}/128",
                    "dev",
                    self.interface,
                ]
            )
        if (
            previous is not None
            and previous.client_address != endpoint.client_address
        ):
            self.firewall_runner(
                [
                    "ip",
                    "-6",
                    "addr",
                    "del",
                    f"{previous.client_address}/64",
                    "dev",
                    self.interface,
                ]
            )

    def clear_remote_xpc(self) -> None:
        endpoint = self._remote_xpc_endpoint
        if endpoint is None:
            return
        self._remote_xpc_endpoint = None
        self.firewall_runner(
            [
                "ip",
                "-6",
                "route",
                "del",
                f"{endpoint.server_address}/128",
                "dev",
                self.interface,
            ]
        )
        self.firewall_runner(
            [
                "ip",
                "-6",
                "addr",
                "del",
                f"{endpoint.client_address}/64",
                "dev",
                self.interface,
            ]
        )
        self.firewall_runner(
            [
                "ip",
                "link",
                "set",
                "dev",
                self.interface,
                "mtu",
                str(self.mtu),
            ]
        )

    def write(self, packet: bytes) -> None:
        if self.fd is None:
            raise RuntimeError("TUN device is not open")
        if not is_ip_packet(packet):
            return
        os.write(self.fd, packet)

    async def packets(self, max_queue: int = 1024):
        if self.fd is None:
            raise RuntimeError("TUN device is not open")
        fd = self.fd
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=max_queue)

        def ready() -> None:
            while True:
                try:
                    packet = os.read(fd, 65535)
                except BlockingIOError:
                    return
                if not packet:
                    return
                if queue.full():
                    with suppress(asyncio.QueueEmpty):
                        queue.get_nowait()
                queue.put_nowait(packet)

        loop.add_reader(fd, ready)
        try:
            while True:
                yield await queue.get()
        finally:
            loop.remove_reader(fd)


class OverlayBridge:
    def __init__(
        self,
        websocket_url: str,
        tun: TunDevice,
        reconnect_delay: float = 2.0,
        token: str | None = None,
    ) -> None:
        self.websocket_url = websocket_url
        self.token = token
        self.tun = tun
        self.reconnect_delay = reconnect_delay
        self.connected = asyncio.Event()
        self.on_device_remote_xpc_ready = asyncio.Event()
        self.on_device_pair_record_acknowledged = asyncio.Event()
        self.on_device_remote_xpc_sequence = 0
        self.remote_xpc_tunnel_ready = asyncio.Event()
        self.remote_xpc_tunnel_sequence = 0
        self.remote_xpc_endpoint: RemoteXpcTunnelEndpoint | None = None
        self.remote_xpc_packets_from_ios = 0
        self.remote_xpc_packets_to_ios = 0
        self.remote_xpc_last_packet_from_ios: dict[str, object] | None = None
        self.packets_from_controller = 0
        self.packets_to_controller = 0
        self.bytes_from_controller = 0
        self.bytes_to_controller = 0
        self.connection_sequence = 0
        self.connected_at: float | None = None
        self.current_packets_from_controller = 0
        self.current_packets_to_controller = 0
        self.current_bytes_from_controller = 0
        self.current_bytes_to_controller = 0
        self.last_packet_from_controller_at: float | None = None
        self.last_packet_to_controller_at: float | None = None
        self.last_packet_at: float | None = None
        self.remote_pairing_proxy_port: int | None = None
        self._tcp_proxy_server: asyncio.Server | None = None
        self._websocket = None
        self._websocket_send_lock: asyncio.Lock | None = None
        self._remote_xpc_userspace_tun = None
        self._remote_xpc_pending_packets: list[bytes] = []
        self._remote_xpc_pending_bytes = 0
        self._remote_xpc_send_task: asyncio.Task | None = None
        self._tcp_streams: dict[uuid.UUID, OverlayTcpStream] = {}
        self.remote_pairing_stream_frames_sent = 0
        self.remote_pairing_stream_frames_received = 0
        self.remote_pairing_stream_opened = 0
        self.remote_pairing_stream_errors = 0

    async def run_forever(self) -> None:
        self.tun.open()
        self._tcp_proxy_server = await asyncio.start_server(
            self._accept_remote_pairing_stream,
            "127.0.0.1",
            0,
        )
        sockets = self._tcp_proxy_server.sockets or []
        if not sockets:
            self._tcp_proxy_server.close()
            await self._tcp_proxy_server.wait_closed()
            self._tcp_proxy_server = None
            self.tun.close()
            raise RuntimeError("RemotePairing stream proxy has no listening socket")
        self.remote_pairing_proxy_port = int(sockets[0].getsockname()[1])
        try:
            while True:
                try:
                    await self._bridge_once()
                    await asyncio.sleep(self.reconnect_delay)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self.connected.clear()
                    print(f"overlay disconnected: {type(error).__name__}: {error}", flush=True)
                    await asyncio.sleep(self.reconnect_delay)
        finally:
            self.connected.clear()
            self.on_device_remote_xpc_ready.clear()
            self.on_device_pair_record_acknowledged.clear()
            self.remote_xpc_tunnel_ready.clear()
            self.remote_xpc_endpoint = None
            await self.detach_remote_xpc_userspace_tun()
            self._websocket = None
            self._websocket_send_lock = None
            await self._close_remote_pairing_streams("packet overlay stopped")
            self.remote_pairing_proxy_port = None
            if self._tcp_proxy_server is not None:
                self._tcp_proxy_server.close()
                await self._tcp_proxy_server.wait_closed()
                self._tcp_proxy_server = None
            self.tun.close()

    async def _bridge_once(self) -> None:
        async with websockets.connect(
            self.websocket_url,
            additional_headers=(
                {"Authorization": f"Bearer {self.token}"} if self.token else None
            ),
            max_size=None,
            ping_interval=10,
            ping_timeout=30,
            open_timeout=30,
        ) as websocket:
            self._websocket = websocket
            self._websocket_send_lock = asyncio.Lock()
            self.on_device_remote_xpc_ready.clear()
            self.on_device_pair_record_acknowledged.clear()
            self.remote_xpc_tunnel_ready.clear()
            self.remote_xpc_endpoint = None
            await self.detach_remote_xpc_userspace_tun()
            self.connection_sequence += 1
            self.connected_at = time.time()
            self.current_packets_from_controller = 0
            self.current_packets_to_controller = 0
            self.current_bytes_from_controller = 0
            self.current_bytes_to_controller = 0
            self.last_packet_from_controller_at = None
            self.last_packet_to_controller_at = None
            self.connected.set()
            print(
                f"overlay connected: interface={self.tun.interface} "
                f"host={OVERLAY_HOST_IPV4} device={OVERLAY_DEVICE_IPV4}",
                flush=True,
            )
            try:
                send_task = asyncio.create_task(self._send_packets(websocket))
                receive_task = asyncio.create_task(self._receive_packets(websocket))
                resync_task = asyncio.create_task(
                    self._request_remote_xpc_resync(websocket)
                )
                tasks = {send_task, receive_task, resync_task}
                try:
                    done, _pending = await asyncio.wait(
                        tasks, return_when=asyncio.FIRST_COMPLETED
                    )
                    for task in done:
                        task.result()
                finally:
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
            finally:
                self.connected.clear()
                self.on_device_remote_xpc_ready.clear()
                self.on_device_pair_record_acknowledged.clear()
                self.remote_xpc_tunnel_ready.clear()
                self.remote_xpc_endpoint = None
                await self.detach_remote_xpc_userspace_tun()
                if self._websocket is websocket:
                    self._websocket = None
                    self._websocket_send_lock = None
                await self._close_remote_pairing_streams("packet overlay reconnected")

    async def _send_packets(self, websocket) -> None:
        async for packet in self.tun.packets():
            if is_ip_packet(packet):
                endpoint = self.remote_xpc_endpoint
                message = (
                    encode_remote_xpc_tunnel_packet(packet)
                    if endpoint is not None
                    and remote_xpc_packet_matches(packet, endpoint)
                    else packet
                )
                await self._send_websocket_message(websocket, message)
                if message is not packet:
                    self.remote_xpc_packets_to_ios += 1
                self.packets_to_controller += 1
                self.bytes_to_controller += len(packet)
                self.current_packets_to_controller += 1
                self.current_bytes_to_controller += len(packet)
                now = time.time()
                self.last_packet_to_controller_at = now
                self.last_packet_at = now

    async def _request_remote_xpc_resync(self, websocket) -> None:
        request = REMOTE_XPC_TUNNEL_MAGIC + bytes([REMOTE_XPC_TUNNEL_RESYNC])
        while True:
            if (
                not self.remote_xpc_tunnel_ready.is_set()
                and not self.on_device_pair_record_acknowledged.is_set()
            ):
                await self._send_websocket_message(websocket, request)
            await asyncio.sleep(5)

    async def _receive_packets(self, websocket) -> None:
        async for message in websocket:
            if isinstance(message, bytes):
                if message == ON_DEVICE_REMOTE_XPC_HELLO:
                    self.on_device_remote_xpc_sequence += 1
                    self.on_device_remote_xpc_ready.set()
                    continue
                if message == ON_DEVICE_PAIR_RECORD_ACK:
                    self.on_device_pair_record_acknowledged.set()
                    continue
                stream_frame = decode_remote_pairing_stream_frame(message)
                if stream_frame is not None:
                    await self._receive_remote_pairing_stream_frame(*stream_frame)
                    continue
                raw_tunnel_frame = decode_remote_xpc_tunnel_frame(message)
                if raw_tunnel_frame is not None:
                    opcode, payload = raw_tunnel_frame
                    if (
                        opcode == REMOTE_XPC_TUNNEL_SETUP
                        and isinstance(payload, RemoteXpcTunnelEndpoint)
                    ):
                        await self.detach_remote_xpc_userspace_tun()
                        self.remote_xpc_endpoint = payload
                        self.remote_xpc_tunnel_sequence += 1
                        self.remote_xpc_tunnel_ready.set()
                    elif (
                        opcode == REMOTE_XPC_TUNNEL_PACKET
                        and isinstance(payload, bytes)
                        and self.remote_xpc_endpoint is not None
                    ):
                        # This binary subchannel is already authenticated by
                        # RemotePairing/TLS-PSK and the device-scoped overlay.
                        # CDTunnel may legitimately emit link-local or
                        # unspecified-source IPv6 control packets before ULA
                        # traffic, so do not apply a second address whitelist.
                        userspace_tun = self._remote_xpc_userspace_tun
                        if userspace_tun is not None:
                            userspace_tun.write(payload)
                        elif (
                            len(self._remote_xpc_pending_packets) < 1024
                            and self._remote_xpc_pending_bytes + len(payload)
                            <= 8 * 1024 * 1024
                        ):
                            self._remote_xpc_pending_packets.append(payload)
                            self._remote_xpc_pending_bytes += len(payload)
                        self.remote_xpc_packets_from_ios += 1
                        self.remote_xpc_last_packet_from_ios = (
                            remote_xpc_packet_summary(payload)
                        )
                        self._record_packet_from_controller(len(payload))
                    continue
                self.tun.write(message)
                self._record_packet_from_controller(len(message))

    def _record_packet_from_controller(self, length: int) -> None:
        self.packets_from_controller += 1
        self.bytes_from_controller += length
        self.current_packets_from_controller += 1
        self.current_bytes_from_controller += length
        now = time.time()
        self.last_packet_from_controller_at = now
        self.last_packet_at = now

    async def open_remote_xpc_userspace_tun(self):
        from pymobiledevice3.remote.userspace_tunnel import UserspaceTun

        endpoint = self.remote_xpc_endpoint
        websocket = self._websocket
        sequence = self.remote_xpc_tunnel_sequence
        if (
            endpoint is None
            or websocket is None
            or not self.remote_xpc_tunnel_ready.is_set()
        ):
            raise ConnectionError("raw RemoteXPC tunnel is unavailable")
        await self.detach_remote_xpc_userspace_tun(preserve_pending=True)
        tun = UserspaceTun(f"{self.tun.interface}-remotexpc")
        tun.addr = endpoint.client_address
        tun.mtu = endpoint.mtu
        try:
            await tun.up()
            tun.set_peer(endpoint.server_address)
            if (
                websocket is not self._websocket
                or endpoint != self.remote_xpc_endpoint
                or sequence != self.remote_xpc_tunnel_sequence
            ):
                raise ConnectionError("raw RemoteXPC tunnel changed during setup")
            self._remote_xpc_userspace_tun = tun
            pending = self._remote_xpc_pending_packets
            self._remote_xpc_pending_packets = []
            self._remote_xpc_pending_bytes = 0
            for packet in pending:
                tun.write(packet)
            task = asyncio.create_task(
                self._send_remote_xpc_userspace_packets(
                    websocket,
                    tun,
                    sequence,
                ),
                name="raw-remotexpc-userspace-egress",
            )
            task.add_done_callback(self._consume_remote_xpc_send_result)
            self._remote_xpc_send_task = task
            return tun
        except BaseException:
            with suppress(Exception):
                await tun.close()
            raise

    async def detach_remote_xpc_userspace_tun(
        self,
        tun=None,
        preserve_pending: bool = False,
    ) -> None:
        if (
            tun is not None
            and self._remote_xpc_userspace_tun is not tun
        ):
            return
        self._remote_xpc_userspace_tun = None
        task = self._remote_xpc_send_task
        self._remote_xpc_send_task = None
        if task is not None and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        if not preserve_pending:
            self._remote_xpc_pending_packets = []
            self._remote_xpc_pending_bytes = 0

    @staticmethod
    def _consume_remote_xpc_send_result(task: asyncio.Task) -> None:
        if not task.cancelled():
            with suppress(Exception):
                task.result()

    async def _send_remote_xpc_userspace_packets(
        self,
        websocket,
        tun,
        sequence: int,
    ) -> None:
        try:
            while (
                websocket is self._websocket
                and tun is self._remote_xpc_userspace_tun
                and sequence == self.remote_xpc_tunnel_sequence
            ):
                packets = await tun.async_read_batch()
                for packet in packets:
                    await self._send_websocket_message(
                        websocket,
                        encode_remote_xpc_tunnel_packet(packet),
                    )
                    self.remote_xpc_packets_to_ios += 1
                    self.packets_to_controller += 1
                    self.bytes_to_controller += len(packet)
                    self.current_packets_to_controller += 1
                    self.current_bytes_to_controller += len(packet)
                    now = time.time()
                    self.last_packet_to_controller_at = now
                    self.last_packet_at = now
        except asyncio.CancelledError:
            raise
        except Exception:
            with suppress(Exception):
                await websocket.close(code=1011, reason="raw RemoteXPC send failed")
            raise

    async def _send_websocket_message(self, websocket, message: bytes) -> None:
        lock = self._websocket_send_lock
        if websocket is not self._websocket or lock is None:
            raise ConnectionError("packet overlay WebSocket is unavailable")
        async with lock:
            if websocket is not self._websocket:
                raise ConnectionError("packet overlay WebSocket was replaced")
            await websocket.send(message)
            if message.startswith(REMOTE_PAIRING_STREAM_MAGIC):
                self.remote_pairing_stream_frames_sent += 1

    async def send_on_device_pair_record(self, record: bytes) -> None:
        if not record or len(record) > ON_DEVICE_PAIR_RECORD_MAX_SIZE:
            raise ValueError("on-device RemotePairing record has invalid size")
        websocket = self._websocket
        if (
            websocket is None
            or not self.connected.is_set()
            or not self.on_device_remote_xpc_ready.is_set()
        ):
            raise ConnectionError(
                "packet overlay client does not advertise on-device RemoteXPC"
            )
        await self._send_websocket_message(
            websocket,
            ON_DEVICE_PAIR_RECORD_MAGIC + record,
        )

    async def _accept_remote_pairing_stream(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        stream_id = uuid.uuid4()
        stream = OverlayTcpStream(writer=writer)
        self._tcp_streams[stream_id] = stream
        try:
            websocket = self._websocket
            if websocket is None or not self.connected.is_set():
                raise ConnectionError("packet overlay is not connected")
            try:
                target_header = await asyncio.wait_for(
                    reader.readexactly(REMOTE_PAIRING_TARGET_HEADER_SIZE),
                    timeout=2,
                )
                if not target_header.startswith(REMOTE_PAIRING_TARGET_MAGIC):
                    raise ConnectionError(
                        "RemotePairing stream target header is invalid"
                    )
                target_port = struct.unpack(">H", target_header[-2:])[0]
                if target_port == 0:
                    raise ConnectionError(
                        "RemotePairing stream target port is invalid"
                    )
                initial_payload = await asyncio.wait_for(
                    reader.read(REMOTE_PAIRING_STREAM_MAX_PAYLOAD - 2),
                    timeout=2,
                )
            except TimeoutError:
                initial_payload = b""
            if not initial_payload:
                return
            framer = TlsRecordFramer()
            initial_chunks = framer.feed(initial_payload)
            while not initial_chunks:
                try:
                    payload = await asyncio.wait_for(
                        reader.read(REMOTE_PAIRING_STREAM_MAX_PAYLOAD),
                        timeout=2,
                    )
                except TimeoutError:
                    payload = b""
                if not payload:
                    initial_chunks = framer.flush()
                    break
                initial_chunks.extend(framer.feed(payload))
            if not initial_chunks:
                return
            await self._send_websocket_message(
                websocket,
                encode_remote_pairing_stream_frame(
                    stream_id,
                    REMOTE_PAIRING_STREAM_OPEN,
                    struct.pack(">H", target_port) + initial_chunks[0],
                ),
            )
            for payload in initial_chunks[1:]:
                await self._send_websocket_message(
                    websocket,
                    encode_remote_pairing_stream_frame(
                        stream_id,
                        REMOTE_PAIRING_STREAM_DATA,
                        payload,
                    ),
                )
            while True:
                payload = await reader.read(REMOTE_PAIRING_STREAM_MAX_PAYLOAD)
                if not payload:
                    break
                if stream.remote_error is not None:
                    raise ConnectionError(stream.remote_error)
                websocket = self._websocket
                if websocket is None:
                    raise ConnectionError("packet overlay disconnected")
                for framed_payload in framer.feed(payload):
                    await self._send_websocket_message(
                        websocket,
                        encode_remote_pairing_stream_frame(
                            stream_id,
                            REMOTE_PAIRING_STREAM_DATA,
                            framed_payload,
                        ),
                    )
            websocket = self._websocket
            if websocket is not None:
                for framed_payload in framer.flush():
                    await self._send_websocket_message(
                        websocket,
                        encode_remote_pairing_stream_frame(
                            stream_id,
                            REMOTE_PAIRING_STREAM_DATA,
                            framed_payload,
                        ),
                    )
        except (ConnectionError, TimeoutError, OSError):
            pass
        finally:
            if self._tcp_streams.get(stream_id) is stream:
                self._tcp_streams.pop(stream_id, None)
            websocket = self._websocket
            if websocket is not None:
                with suppress(Exception):
                    await self._send_websocket_message(
                        websocket,
                        encode_remote_pairing_stream_frame(
                            stream_id,
                            REMOTE_PAIRING_STREAM_CLOSE,
                        ),
                    )
            writer.close()
            with suppress(Exception):
                await writer.wait_closed()

    async def _receive_remote_pairing_stream_frame(
        self,
        stream_id: uuid.UUID,
        opcode: int,
        payload: bytes,
    ) -> None:
        stream = self._tcp_streams.get(stream_id)
        if stream is None:
            return
        self.remote_pairing_stream_frames_received += 1
        if opcode == REMOTE_PAIRING_STREAM_OPENED:
            self.remote_pairing_stream_opened += 1
            stream.opened.set()
            return
        if opcode == REMOTE_PAIRING_STREAM_DATA:
            if not stream.opened.is_set():
                return
            stream.writer.write(payload)
            try:
                await stream.writer.drain()
            except (ConnectionError, OSError):
                stream.writer.close()
            return
        if opcode == REMOTE_PAIRING_STREAM_ERROR:
            self.remote_pairing_stream_errors += 1
            stream.remote_error = payload.decode("utf-8", errors="replace")[:256]
        elif opcode != REMOTE_PAIRING_STREAM_CLOSE:
            return
        stream.opened.set()
        stream.writer.close()

    async def _close_remote_pairing_streams(self, reason: str) -> None:
        streams = list(self._tcp_streams.values())
        self._tcp_streams.clear()
        for stream in streams:
            stream.remote_error = reason
            stream.opened.set()
            stream.writer.close()
        for stream in streams:
            with suppress(Exception):
                await stream.writer.wait_closed()

    def status(self) -> dict[str, object]:
        return {
            "connected": self.connected.is_set(),
            "interface": self.tun.interface,
            "connectionSequence": self.connection_sequence,
            "connectedAt": self.connected_at,
            "packetsFromController": self.packets_from_controller,
            "packetsToController": self.packets_to_controller,
            "bytesFromController": self.bytes_from_controller,
            "bytesToController": self.bytes_to_controller,
            "currentPacketsFromController": self.current_packets_from_controller,
            "currentPacketsToController": self.current_packets_to_controller,
            "currentBytesFromController": self.current_bytes_from_controller,
            "currentBytesToController": self.current_bytes_to_controller,
            "lastPacketFromControllerAt": self.last_packet_from_controller_at,
            "lastPacketToControllerAt": self.last_packet_to_controller_at,
            "lastPacketAt": self.last_packet_at,
            "remotePairingStreamFramesSent": self.remote_pairing_stream_frames_sent,
            "remotePairingStreamFramesReceived": self.remote_pairing_stream_frames_received,
            "remotePairingStreamOpened": self.remote_pairing_stream_opened,
            "remotePairingStreamErrors": self.remote_pairing_stream_errors,
            "remotePairingProxyPort": self.remote_pairing_proxy_port,
            "remoteXpcTunnelReady": self.remote_xpc_tunnel_ready.is_set(),
            "remoteXpcTunnelSequence": self.remote_xpc_tunnel_sequence,
            "remoteXpcPacketsFromIos": self.remote_xpc_packets_from_ios,
            "remoteXpcPacketsToIos": self.remote_xpc_packets_to_ios,
            "remoteXpcLastPacketFromIos": self.remote_xpc_last_packet_from_ios,
            "remoteXpcEndpoint": (
                self.remote_xpc_endpoint.status()
                if self.remote_xpc_endpoint is not None
                else None
            ),
        }
