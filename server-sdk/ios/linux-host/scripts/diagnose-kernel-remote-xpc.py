from __future__ import annotations

import asyncio
import ipaddress
import os
import struct
from contextlib import suppress
from pathlib import Path

from pymobiledevice3.remote import tunnel_service as pmd_tunnel
from pymobiledevice3.remote.common import TunnelProtocol
from pymobiledevice3.remote.remote_service_discovery import (
    RemoteServiceDiscoveryService,
)
from pymobiledevice3.remote.tunnel_service import start_tunnel

from galatea_ios_host.autohost import (
    ControllerClient,
    IosOverlayRequirements,
    read_private_text,
    resolve_device_overlay,
    select_remote_pairing_hint,
)
from galatea_ios_host.overlay import OverlayBridge, TunDevice
from galatea_ios_host.runtime import (
    FramedRemotePairingTcpTunnel,
    connect_remote_pairing_service,
    iter_remote_paired_identifiers,
)


def describe_ipv6(packet: bytes) -> str:
    if len(packet) < 40 or packet[0] >> 4 != 6:
        return f"invalid length={len(packet)}"
    source = ipaddress.IPv6Address(packet[8:24])
    destination = ipaddress.IPv6Address(packet[24:40])
    next_header = packet[6]
    detail = ""
    if next_header == 6 and len(packet) >= 60:
        detail = (
            f" tcp={int.from_bytes(packet[40:42], 'big')}>"
            f"{int.from_bytes(packet[42:44], 'big')}"
            f" flags=0x{packet[53]:02x}"
        )
    elif next_header == 58 and len(packet) >= 41:
        detail = f" icmpv6Type={packet[40]}"
    return (
        f"length={len(packet)} nextHeader={next_header} "
        f"{source}>{destination}{detail}"
    )


def enable_inner_packet_trace() -> None:
    original_send = FramedRemotePairingTcpTunnel.send_packet_to_device

    async def traced_send(
        self: FramedRemotePairingTcpTunnel,
        packet: bytes,
    ) -> None:
        print(f"inner-linux-to-ios {describe_ipv6(packet)}", flush=True)
        await original_send(self, packet)

    async def traced_receive(
        self: FramedRemotePairingTcpTunnel,
    ) -> None:
        try:
            while True:
                header = await self._reader.readexactly(40)
                payload_length = struct.unpack(">H", header[4:6])[0]
                body = await self._reader.readexactly(payload_length)
                packet = header + body
                print(f"inner-ios-to-linux {describe_ipv6(packet)}", flush=True)
                self.tun.write(pmd_tunnel.LOOPBACK_HEADER + packet)
        except asyncio.IncompleteReadError:
            return

    FramedRemotePairingTcpTunnel.send_packet_to_device = traced_send
    FramedRemotePairingTcpTunnel.sock_read_task = traced_receive


async def main() -> None:
    enable_inner_packet_trace()
    controller_url = os.environ.get("CONTROLLER_URL")
    controller_api_url = os.environ.get("CONTROLLER_API_URL")
    controller_token_file = os.environ.get("CONTROLLER_TOKEN_FILE")
    requested_device_id = os.environ.get("DEVICE_ID")
    overlay_interface = os.environ.get("OVERLAY_INTERFACE", "sc-ios-diag0")
    client = None
    bridge = None
    bridge_task = None
    service = None
    context = None
    rsd = None
    try:
        if controller_url and controller_api_url and controller_token_file:
            client = ControllerClient(
                controller_api_url,
                read_private_text(Path(controller_token_file)),
            )
            selected = await resolve_device_overlay(
                client,
                controller_url,
                requested_device_id,
                IosOverlayRequirements(
                    client_build=os.environ.get("REQUIRED_CLIENT_BUILD"),
                    configuration_revision=int(
                        os.environ["REQUIRED_CONFIGURATION_REVISION"]
                    )
                    if os.environ.get("REQUIRED_CONFIGURATION_REVISION")
                    else None,
                    network_mode=os.environ.get("REQUIRED_NETWORK_MODE"),
                ),
            )
            if selected is None:
                raise RuntimeError("no compatible connected iOS overlay")
            device_id, websocket_url = selected
            hint = select_remote_pairing_hint(
                await client.overlays(),
                device_id,
            )
            if hint is None:
                raise RuntimeError(
                    "connected iOS overlay has no device-loopback RemotePairing hint"
                )
            _service_identifier, target_port, _updated_at = hint
            paired_identifiers = list(iter_remote_paired_identifiers())
            configured_peer_id = os.environ.get("PEER_ID")
            if configured_peer_id:
                paired_identifiers = [
                    identifier
                    for identifier in paired_identifiers
                    if identifier == configured_peer_id
                ]
            if len(paired_identifiers) != 1:
                raise RuntimeError(
                    "kernel diagnostic requires exactly one Linux pairing record"
                )
            peer_id = paired_identifiers[0]
            bridge = OverlayBridge(
                websocket_url,
                TunDevice(interface=overlay_interface),
            )
            bridge_task = asyncio.create_task(
                bridge.run_forever(),
                name="kernel-diagnostic-overlay",
            )
            await asyncio.wait_for(bridge.connected.wait(), timeout=30)
            if bridge.remote_pairing_proxy_port is None:
                raise RuntimeError("diagnostic RemotePairing proxy did not start")
            address = "127.0.0.1"
            port = bridge.remote_pairing_proxy_port
            print(
                f"diagnostic-overlay=yes device={device_id} "
                f"target-port={target_port}",
                flush=True,
            )
            # Replacing the controller's mac role closes the automatic host's
            # existing control socket. Give remotepairingd time to retire that
            # session before PairVerify opens a new one.
            await asyncio.sleep(3)
        else:
            peer_id = os.environ["PEER_ID"]
            address = os.environ.get("REMOTE_PAIRING_ADDRESS", "198.18.0.2")
            port = int(os.environ.get("REMOTE_PAIRING_PORT", "49152"))
            target_port_value = os.environ.get("REMOTE_PAIRING_TARGET_PORT")
            target_port = int(target_port_value) if target_port_value else None

        for attempt in range(1, 4):
            try:
                service = await connect_remote_pairing_service(
                    peer_id,
                    address,
                    port,
                    20,
                    stream_proxy_target_port=target_port,
                )
                break
            except Exception:
                if attempt == 3:
                    raise
                print(
                    f"kernel-control-pair-verify-retry={attempt}",
                    flush=True,
                )
                await asyncio.sleep(3)
        print("kernel-control-pair-verify=yes", flush=True)
        pmd_tunnel.USE_USERSPACE_TUNNEL = False
        context = start_tunnel(service, protocol=TunnelProtocol.TCP)
        tunnel = await asyncio.wait_for(context.__aenter__(), timeout=30)
        print("kernel-dynamic-tunnel=yes", flush=True)
        rsd = RemoteServiceDiscoveryService(
            (tunnel.address, tunnel.port),
            name=tunnel.interface,
        )
        await asyncio.wait_for(
            rsd.connect(),
            timeout=float(os.environ.get("RSD_TIMEOUT", "60")),
        )
        print("kernel-remote-xpc=yes")
    finally:
        if rsd is not None:
            await rsd.close()
        if context is not None:
            await context.__aexit__(None, None, None)
        elif service is not None:
            await service.close()
        if bridge_task is not None:
            bridge_task.cancel()
            with suppress(asyncio.CancelledError):
                await bridge_task
        if client is not None:
            await client.close()
        pmd_tunnel.USE_USERSPACE_TUNNEL = False


if __name__ == "__main__":
    asyncio.run(main())
