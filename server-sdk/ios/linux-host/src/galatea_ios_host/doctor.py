from __future__ import annotations

import importlib
import importlib.metadata
import json
import os
import shutil
import ssl
import sys
from pathlib import Path


def doctor_report() -> dict:
    checks = {
        "linux": os.uname().sysname == "Linux",
        "root": os.geteuid() == 0,
        "tun": Path("/dev/net/tun").is_char_device(),
        "ip": shutil.which("ip") is not None,
        "iptables": shutil.which("iptables") is not None,
        "ip6tables": shutil.which("ip6tables") is not None,
        "python313": sys.version_info >= (3, 13),
        "tlsPskClientCallback": hasattr(
            ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT),
            "set_psk_client_callback",
        ),
    }
    versions = {}
    for package in ("pymobiledevice3", "websockets"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            checks[package] = False
        else:
            checks[package] = True
    try:
        importlib.import_module("pymobiledevice3.cli.developer.core_device")
    except Exception as error:
        checks["coreDeviceDisplayCli"] = False
        versions["coreDeviceDisplayCliError"] = f"{type(error).__name__}: {error}"
    else:
        checks["coreDeviceDisplayCli"] = True
    return {"ready": all(checks.values()), "checks": checks, "versions": versions}


def print_doctor_report() -> bool:
    report = doctor_report()
    print(json.dumps(report, indent=2, sort_keys=True))
    return bool(report["ready"])
