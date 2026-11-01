from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

from .autohost import AutomaticHostConfig, run_automatic_host
from .doctor import print_doctor_report
from .overlay import OverlayBridge, TunDevice, build_websocket_url
from .pairing import load_or_create_identity, serve_overlay_pairable_host
from .api import LinuxDeviceHubHost, serve
from .constants import DEFAULT_AGENT_BUNDLE_ID
from .enrollment import (
    ControllerStatusSource,
    EnrollmentPortal,
    OtaPackage,
    serve_enrollment_portal,
)
from .bootstrap import (
    BootstrapConfig,
    BootstrapManager,
    BootstrapPortal,
    serve_bootstrap_portal,
)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="galatea-ios-host")
    commands = root.add_subparsers(dest="command", required=True)

    doctor = commands.add_parser("doctor", help="check Linux host prerequisites")
    doctor.set_defaults(handler=run_doctor)


    overlay = commands.add_parser("overlay", help="bridge a Linux TUN to the Controller packet overlay")
    overlay.add_argument("--websocket-url")
    overlay.add_argument("--controller-url")
    overlay.add_argument("--device-id")
    overlay.add_argument("--token", default=os.environ.get("GALATEA_PACKET_OVERLAY_TOKEN"))
    overlay.add_argument("--interface", default="sc-ios0")
    overlay.set_defaults(handler=run_overlay)

    pair_host = commands.add_parser("pair-host", help="accept iOS 27 device-initiated pairing")
    pair_host.add_argument("--state-dir", type=Path, default=Path("/var/lib/galatea-ios-host"))
    pair_host.add_argument("--name")
    pair_host.add_argument("--model", default="Mac17,7")
    pair_host.add_argument("--port", type=int, default=0)
    pair_host.add_argument("--timeout", type=float)
    pair_host.set_defaults(handler=run_pair_host)

    host = commands.add_parser("serve", help="run the complete Linux iOS 27 Device Hub host")
    host.add_argument("--websocket-url")
    host.add_argument("--controller-url")
    host.add_argument("--device-id")
    host.add_argument("--token", default=os.environ.get("GALATEA_PACKET_OVERLAY_TOKEN"))
    host.add_argument("--state-dir", type=Path, default=Path("/var/lib/galatea-ios-host"))
    host.add_argument("--interface", default="sc-ios0")
    host.add_argument("--udid")
    host.add_argument("--agent-bundle-id", default=DEFAULT_AGENT_BUNDLE_ID)
    host.add_argument("--wda-package", type=Path)
    host.add_argument("--bind", default="127.0.0.1")
    host.add_argument("--port", type=int, default=8181)
    host.set_defaults(handler=run_host)

    auto_host = commands.add_parser(
        "auto-serve", help="renew first-pairing links and start the Linux host automatically"
    )
    auto_host.add_argument("--controller-url", required=True)
    auto_host.add_argument("--controller-api-url")
    auto_host.add_argument("--controller-token-file", type=Path, required=True)
    auto_host.add_argument("--pairing-url-file", type=Path)
    auto_host.add_argument("--pairing-ttl-seconds", type=int, default=1800)
    auto_host.add_argument("--poll-interval", type=float, default=2.0)
    auto_host.add_argument("--device-id")
    auto_host.add_argument(
        "--state-dir", type=Path, default=Path("/var/lib/galatea-ios-host")
    )
    auto_host.add_argument("--interface", default="sc-ios0")
    auto_host.add_argument("--udid")
    auto_host.add_argument("--agent-bundle-id", default=DEFAULT_AGENT_BUNDLE_ID)
    auto_host.add_argument("--wda-package", type=Path)
    auto_host.add_argument("--required-client-build")
    auto_host.add_argument("--required-configuration-revision", type=int)
    auto_host.add_argument("--required-network-mode")
    auto_host.add_argument("--bind", default="127.0.0.1")
    auto_host.add_argument("--port", type=int, default=8181)
    auto_host.set_defaults(handler=run_auto_host)

    enroll = commands.add_parser(
        "enroll-serve", help="serve one-time network registration and OTA installation"
    )
    enroll.add_argument("--public-base-url", required=True)
    enroll.add_argument("--state-dir", type=Path, required=True)
    enroll.add_argument("--certificate", type=Path, required=True)
    enroll.add_argument("--private-key", type=Path, required=True)
    enroll.add_argument("--certificate-chain", type=Path)
    enroll.add_argument("--tls-certificate", type=Path)
    enroll.add_argument("--ipa", type=Path)
    enroll.add_argument("--bundle-id")
    enroll.add_argument("--bundle-version", default="1")
    enroll.add_argument("--title", default="Galatea")
    pairing_source = enroll.add_mutually_exclusive_group()
    pairing_source.add_argument("--pairing-url")
    pairing_source.add_argument("--pairing-url-file", type=Path)
    enroll.add_argument("--controller-api-url")
    enroll.add_argument("--controller-token-file", type=Path)
    enroll.add_argument("--bind", default="127.0.0.1")
    enroll.add_argument("--port", type=int, default=8282)
    enroll.add_argument("--direct-tls", action="store_true")
    enroll.set_defaults(handler=run_enrollment_portal)

    setup = commands.add_parser(
        "setup-serve", help="run the localhost-only Linux build setup portal"
    )
    setup.add_argument("--state-dir", type=Path, required=True)
    setup.add_argument("--xtool", type=Path, required=True)
    setup.add_argument("--ipsw", type=Path, required=True)
    setup.add_argument("--swift", type=Path, required=True)
    setup.add_argument("--project-dir", type=Path, required=True)
    setup.add_argument("--build-script", type=Path, required=True)
    setup.add_argument("--enrollment-record", type=Path, required=True)
    setup.add_argument("--toolset-archive", type=Path, required=True)
    setup.add_argument("--toolset-sha256", required=True)
    setup.add_argument("--bundle-id", default=DEFAULT_AGENT_BUNDLE_ID)
    setup.add_argument("--bind", default="127.0.0.1")
    setup.add_argument("--port", type=int, default=0)
    setup.set_defaults(handler=run_setup_portal)
    return root


def run_doctor(_args: argparse.Namespace) -> int:
    return 0 if print_doctor_report() else 1



def resolve_websocket_url(args: argparse.Namespace) -> str:
    if args.websocket_url:
        return args.websocket_url
    if not args.controller_url or not args.device_id or not args.token:
        raise SystemExit("provide --websocket-url, or --controller-url, --device-id, and --token")
    return build_websocket_url(args.controller_url, args.device_id)


def run_overlay(args: argparse.Namespace) -> int:
    bridge = OverlayBridge(
        resolve_websocket_url(args),
        TunDevice(interface=args.interface),
        token=args.token,
    )
    asyncio.run(bridge.run_forever())
    return 0


def run_pair_host(args: argparse.Namespace) -> int:
    identity = load_or_create_identity(args.state_dir, name=args.name, model=args.model)
    result = asyncio.run(
        serve_overlay_pairable_host(identity, port=args.port, timeout=args.timeout)
    )
    print(
        json.dumps(
            {
                "event": "paired",
                "name": result.peer_device.name,
                "model": result.peer_device.model,
                "udid": result.peer_device.udid,
                "recordPath": str(result.record_path),
            }
        ),
        flush=True,
    )
    return 0


def run_host(args: argparse.Namespace) -> int:
    websocket_url = resolve_websocket_url(args)
    host = LinuxDeviceHubHost(
        websocket_url,
        args.state_dir,
        interface=args.interface,
        udid=args.udid,
        agent_bundle_id=args.agent_bundle_id,
        overlay_token=args.token,
        wda_package_path=args.wda_package,
    )
    asyncio.run(serve(host, args.bind, args.port))
    return 0


def run_auto_host(args: argparse.Namespace) -> int:
    config = AutomaticHostConfig(
        controller_url=args.controller_url,
        controller_api_url=args.controller_api_url or args.controller_url,
        controller_token_file=args.controller_token_file,
        pairing_url_file=args.pairing_url_file,
        pairing_ttl_seconds=args.pairing_ttl_seconds,
        poll_interval=args.poll_interval,
        requested_device_id=args.device_id,
        state_dir=args.state_dir,
        interface=args.interface,
        requested_udid=args.udid,
        agent_bundle_id=args.agent_bundle_id,
        wda_package_path=args.wda_package,
        required_client_build=args.required_client_build,
        required_configuration_revision=args.required_configuration_revision,
        required_network_mode=args.required_network_mode,
        bind=args.bind,
        port=args.port,
    )
    asyncio.run(run_automatic_host(config))
    return 0


def run_enrollment_portal(args: argparse.Namespace) -> int:
    ota_package = None
    if args.ipa is not None:
        if not args.bundle_id:
            raise SystemExit("--bundle-id is required with --ipa")
        ota_package = OtaPackage(
            ipa=args.ipa,
            bundle_id=args.bundle_id,
            bundle_version=args.bundle_version,
            title=args.title,
            pairing_url=args.pairing_url,
            pairing_url_file=args.pairing_url_file,
        )
    if bool(args.controller_api_url) != bool(args.controller_token_file):
        raise SystemExit(
            "--controller-api-url and --controller-token-file must be provided together"
        )
    controller_status_source = (
        ControllerStatusSource(args.controller_api_url, args.controller_token_file)
        if args.controller_api_url and args.controller_token_file
        else None
    )
    portal = EnrollmentPortal(
        public_base_url=args.public_base_url,
        state_dir=args.state_dir,
        certificate=args.certificate,
        private_key=args.private_key,
        certificate_chain=args.certificate_chain,
        ota_package=ota_package,
        controller_status_source=controller_status_source,
    )
    serve_enrollment_portal(
        portal,
        args.bind,
        args.port,
        direct_tls=args.direct_tls,
        tls_certificate=args.tls_certificate,
    )
    return 0


def run_setup_portal(args: argparse.Namespace) -> int:
    config = BootstrapConfig(
        state_dir=args.state_dir,
        xtool=args.xtool,
        ipsw=args.ipsw,
        swift=args.swift,
        project_dir=args.project_dir,
        build_script=args.build_script,
        enrollment_record=args.enrollment_record,
        toolset_archive=args.toolset_archive,
        toolset_sha256=args.toolset_sha256,
        bundle_id=args.bundle_id,
    )
    asyncio.run(_run_setup_portal(config, args.bind, args.port))
    return 0


async def _run_setup_portal(config: BootstrapConfig, bind: str, port: int) -> None:
    manager = BootstrapManager(config)
    portal = BootstrapPortal(manager)
    runner, actual_port = await serve_bootstrap_portal(portal, bind, port)
    print(
        json.dumps(
            {
                "event": "setup_ready",
                "url": f"http://{bind}:{actual_port}/setup/{portal.route_token}/",
            }
        ),
        flush=True,
    )
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


def main() -> None:
    args = parser().parse_args()
    raise SystemExit(args.handler(args))


if __name__ == "__main__":
    main()
