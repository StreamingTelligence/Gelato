#!/usr/bin/env python3
"""Validate a CA-issued certificate and atomically publish a versioned TLS bundle.

Never changes firewall rules, system trust, or existing certificate generations.
Run as the unprivileged Controller user with readable private input files.
"""
import argparse
import datetime
import ipaddress
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
from urllib.parse import urlsplit


def checked(command, data=None):
    result = subprocess.run(command, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise ValueError('Certificate validation failed: ' + result.stderr.decode(errors='replace').strip())
    return result.stdout


def publish(key_file, cert_file, directory, origin, trust_file=None):
    key_path = Path(key_file).resolve(strict=True)
    cert_path = Path(cert_file).resolve(strict=True)
    if not key_path.is_file() or key_path.stat().st_mode & 0o077:
        raise ValueError('Private key input must have mode 0600 or 0400')
    destination = Path(directory).resolve(strict=True)
    if not destination.is_dir() or destination.stat().st_uid != os.getuid() or destination.stat().st_mode & 0o077:
        raise ValueError('TLS destination must be an existing private directory owned by the current user')
    url = urlsplit(origin)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
        raise ValueError('Origin must be an HTTPS root URL')
    key, chain = key_path.read_bytes(), cert_path.read_bytes()
    match = re.search(br'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', chain, re.S)
    if not match:
        raise ValueError('Certificate chain has no leaf certificate')
    leaf = match.group(0) + b'\n'
    public = checked(['openssl', 'x509', '-pubkey', '-noout'], leaf)
    if public != checked(['openssl', 'pkey', '-pubout'], key):
        raise ValueError('Certificate and private key do not match')
    checked(['openssl', 'x509', '-checkend', '3600', '-noout'], leaf)
    try:
        ipaddress.ip_address(url.hostname)
        verify_name = ['-verify_ip', url.hostname]
    except ValueError:
        verify_name = ['-verify_hostname', url.hostname]
    with tempfile.TemporaryDirectory(prefix='controller-cert-validation-') as temporary:
        leaf_path = Path(temporary) / 'leaf.pem'
        chain_path = Path(temporary) / 'chain.pem'
        leaf_path.write_bytes(leaf)
        chain_path.write_bytes(chain)
        command = ['openssl', 'verify', '-purpose', 'sslserver', *verify_name,
                   '-untrusted', str(chain_path)]
        if trust_file:
            # Explicit CA bundle, never a verification bypass. Intended for
            # private PKI deployments and isolated regression tests.
            command += ['-CAfile', str(Path(trust_file).resolve(strict=True))]
        checked(command + [str(leaf_path)])
    current = destination / 'current'
    if current.exists() and not current.is_symlink():
        raise ValueError('Refusing to replace a non-symlink current path')
    generation = 'cert-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + secrets.token_hex(4)
    bundle = destination / generation
    bundle.mkdir(mode=0o700)
    for name, contents in [('key.pem', key), ('fullchain.pem', chain)]:
        with (bundle / name).open('xb') as output:
            os.chmod(output.name, 0o600)
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
    pending = destination / ('.current-' + secrets.token_hex(4))
    pending.symlink_to(generation, target_is_directory=True)
    os.replace(pending, current)
    print('Published validated TLS bundle:', generation, '; previous generations retained')
    return bundle


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--key', required=True)
    parser.add_argument('--fullchain', required=True)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--ca-bundle')
    args = parser.parse_args()
    publish(args.key, args.fullchain, args.directory, args.origin, args.ca_bundle)
