#!/usr/bin/env python3
"""Explicit, bounded Certbot HTTP-01 window; never touches SSH or installs services.

Run manually as root after authorization of public TCP 80 validation. Uses an
existing isolated, root-owned Certbot installation. It does not publish keys
to the Controller, start the Controller, or install renewal/autostart timers.
"""
import argparse
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time

ENV = {key: value for key, value in os.environ.items() if key in {'PATH', 'HOME'}}
ENV.update(PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG='C', LC_ALL='C')


def checked(command):
    return subprocess.check_output(command, env=ENV, text=True, stderr=subprocess.STDOUT, timeout=30)


def private_root_path(path, directory=False):
    value = Path(path).resolve(strict=True)
    info = value.stat()
    if info.st_uid != 0 or info.st_mode & 0o077 or (directory and not value.is_dir()):
        raise ValueError('ACME state must be private and owned by root')
    return value


def process_identity(pid):
    try:
        return Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def remove_rule(state):
    # Never remove a pre-existing rule merely because its port is also 80.
    current = checked(['ufw', 'status'])
    if state['tag'] in current:
        checked(['ufw', '--force', 'delete', *state['rule']])


def watch(filename):
    path = private_root_path(filename)
    state = json.loads(path.read_text())
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        if path.with_suffix('.done').exists():
            return
        if process_identity(state['parentPid']) != state['parentStartTicks']:
            break
        time.sleep(1)
    # Permit an already executing ufw command to finish before removing it.
    time.sleep(2)
    remove_rule(state)
    path.with_suffix('.watchdog-cleaned').write_text(str(time.time()))


def verified_certbot(filename):
    executable = Path(filename).resolve(strict=True)
    # Certbot may read root-held ACME account keys: do not execute a user-writable installation.
    for item in [executable, *executable.parents]:
        info = item.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Certbot installation must be root-owned and not group/world writable')
    return executable


def issue(args):
    if os.getuid() != 0 or not args.authorize_public_http01:
        raise ValueError('Requires root and explicit --authorize-public-http01 for this invocation')
    address = ipaddress.IPv4Address(args.ip)
    if not address.is_global:
        raise ValueError('Use the actual public IPv4 address of this host')
    base = private_root_path(args.state_directory, directory=True)
    executable = verified_certbot(args.certbot)
    version = checked([str(executable), '--version']).strip()
    if version != 'certbot 5.8.0':
        raise ValueError('This deployment is verified with Certbot 5.8.0; review upgrades explicitly')
    with (base/'issuance.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if checked(['ss', '-H', '-lnt', '( sport = :80 )']).strip():
            raise ValueError('Port 80 is occupied; refusing to stop or replace its owner')
        before = checked(['ufw', 'status'])
        if not before.startswith('Status: active'):
            raise ValueError('Expected an already-active UFW policy; refusing to change its defaults')
        if any(str(address) in line and '80' in line for line in before.splitlines()):
            raise ValueError('Existing address-specific port-80 rule must be reviewed, not overwritten')
        session = base/('session-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(4))
        session.mkdir(mode=0o700)
        tag = 'controller-acme-' + secrets.token_hex(6)
        rule = ['allow', 'from', 'any', 'to', str(address), 'port', '80', 'proto', 'tcp', 'comment', tag]
        state = {'parentPid': os.getpid(), 'parentStartTicks': process_identity(os.getpid()),
                 'tag': tag, 'rule': rule, 'environment': args.environment}
        state_path = session/'state.json'
        state_path.write_text(json.dumps(state))
        state_path.chmod(0o600)
        (session/'ufw-before.txt').write_text(before)
        with (session/'watchdog.log').open('x') as log:
            watcher = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--watch', str(state_path)],
                                       env=ENV, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        certbot = None
        result = {'success': False, 'session': str(session), 'environment': args.environment}
        try:
            checked(['ufw', *rule])
            if tag not in checked(['ufw', 'status']):
                raise ValueError('Tagged temporary rule was not installed')
            deployment = base/args.environment
            deployment.mkdir(mode=0o700, exist_ok=True)
            name = 'controller-ip-' + str(address).replace('.', '-')
            command = [str(executable), 'certonly', '--standalone', '--non-interactive', '--agree-tos',
                       '--register-unsafely-without-email', '--preferred-profile', 'shortlived',
                       '--preferred-challenges', 'http', '--http-01-address', str(address),
                       '--ip-address', str(address), '--cert-name', name, '--keep-until-expiring',
                       '--config-dir', str(deployment/'config'), '--work-dir', str(deployment/'work'),
                       '--logs-dir', str(deployment/'logs')]
            if args.environment == 'staging':
                command.append('--staging')
            with (session/'certbot.log').open('xb') as log:
                certbot = subprocess.Popen(command, env=ENV, stdin=subprocess.DEVNULL,
                                           stdout=log, stderr=log, start_new_session=True)
                certbot.wait(timeout=240)
            if certbot.returncode:
                raise RuntimeError('Certbot failed; inspect the private certbot.log in ' + str(session))
            live = deployment/'config/live'/name
            result.update(success=True, key=str(live/'privkey.pem'), fullchain=str(live/'fullchain.pem'))
        finally:
            if certbot is not None and certbot.poll() is None:
                certbot.terminate()
                try:
                    certbot.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    certbot.kill()
                    certbot.wait(timeout=5)
            remove_rule(state)
            after = checked(['ufw', 'status'])
            (session/'ufw-after.txt').write_text(after)
            result['firewallRestored'] = after == before
            result['port80Idle'] = not checked(['ss', '-H', '-lnt', '( sport = :80 )']).strip()
            (session/'result.json').write_text(json.dumps(result))
            (base/'latest-result.json').write_text(json.dumps(result))
            state_path.with_suffix('.done').write_text(str(time.time()))
            watcher.wait(timeout=5)
            if not result['firewallRestored'] or not result['port80Idle']:
                raise RuntimeError('Post-validation audit failed; inspect the saved snapshot without resetting UFW')
        print(json.dumps(result))


def interrupted(_signal, _frame):
    raise SystemExit('Certificate window interrupted; cleaning up')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--watch', help=argparse.SUPPRESS)
    parser.add_argument('--state-directory')
    parser.add_argument('--certbot')
    parser.add_argument('--ip')
    parser.add_argument('--environment', choices=['staging', 'production'])
    parser.add_argument('--authorize-public-http01', action='store_true')
    args = parser.parse_args()
    if args.watch:
        watch(args.watch)
    else:
        if not all([args.state_directory, args.certbot, args.ip, args.environment]):
            parser.error('state-directory, certbot, ip and environment are required')
        os.umask(0o077)
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGINT, interrupted)
        issue(args)
