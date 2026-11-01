#!/usr/bin/env python3
"""Manual Linux Controller lifecycle. No firewall, SSH, systemd, or autostart changes."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time

ALLOWED_ENV = {
    'CONTROLLER_TRANSPORT', 'PUBLIC_CONTROLLER_URL', 'HOST', 'PORT', 'TLS_KEY', 'TLS_CERT',
    'CONTROLLER_API_TOKEN_FILE', 'GELATO_PAIRING_STORE', 'GELATO_STREAM_DIR',
    'TASK_ARTIFACT_DIR', 'TINODE_WS_URL', 'TINODE_API_KEY',
}


def private_file(filename):
    value = Path(filename).resolve(strict=True)
    info = value.stat()
    if not value.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError(f'{value} must be a private file owned by the current user')
    return value


def identity(pid, cwd, node):
    process = Path('/proc') / str(pid)
    try:
        arguments = process.joinpath('cmdline').read_bytes().rstrip(b'\0').split(b'\0')
        if arguments != [os.fsencode(node), b'server.mjs'] or process.joinpath('cwd').resolve() != cwd:
            return None
        return process.joinpath('stat').read_text().rsplit(')', 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['check', 'start', 'status', 'stop', 'reload-tls'])
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    if os.getuid() == 0:
        raise ValueError('Run as an unprivileged service user; use a port >= 1024')
    if not Path('/proc/self/stat').exists():
        raise ValueError('This lifecycle helper targets the Linux production host')
    config_path = private_file(args.config)
    if config_path.parent.stat().st_uid != os.getuid() or config_path.parent.stat().st_mode & 0o077:
        raise ValueError('Session configuration must live in a private directory owned by the current user')
    config = json.loads(config_path.read_text())
    cwd = Path(config['controllerDirectory']).resolve(strict=True)
    node = str(Path(config['node']).resolve(strict=True))
    # Do not inherit an operator shell's credentials, proxy routing, Node hooks,
    # or NODE_TLS_REJECT_UNAUTHORIZED=0 into a production device controller.
    env = {key: value for key, value in os.environ.items()
           if key in {'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ'}}
    for filename in config.get('envFiles', []):
        for line in private_file(filename).read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            key, value = line.split('=', 1)
            if key not in ALLOWED_ENV:
                raise ValueError(f'Unsupported environment field {key}')
            env[key] = value
    for key, value in config['environment'].items():
        if key not in ALLOWED_ENV or not isinstance(value, str):
            raise ValueError(f'Invalid configuration field {key}')
        env[key] = value
    env['NODE_ENV'] = 'production'
    if env.get('CONTROLLER_TRANSPORT') != 'direct' or int(env.get('PORT', '0')) < 1024:
        raise ValueError('Use direct TLS transport on an unprivileged port >= 1024')
    state_file = config_path.with_name(config_path.stem + '.session.json')
    lock_file = config_path.with_name(config_path.stem + '.lock')
    if lock_file.exists():
        private_file(lock_file)
    with lock_file.open('a') as lock:
        os.chmod(lock_file, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = json.loads(private_file(state_file).read_text()) if state_file.exists() else None
        running = previous and identity(previous['pid'], cwd, node) == previous['startTicks']
        if args.operation == 'status':
            print(json.dumps({'running': bool(running), 'pid': previous['pid'] if running else None,
                              'publicOrigin': env.get('PUBLIC_CONTROLLER_URL')}))
            return
        if args.operation in {'stop', 'reload-tls'}:
            if not running:
                if previous and Path('/proc', str(previous['pid'])).exists():
                    raise ValueError('Recorded PID belongs to another process; refusing to signal it')
                print('Controller is not running')
                return
            if args.operation == 'reload-tls':
                subprocess.run([node, 'scripts/check-production-config.mjs'], cwd=cwd, env=env, check=True)
                os.kill(previous['pid'], signal.SIGHUP)
                print('Requested validated TLS reload; device sessions are not restarted')
                return
            os.kill(previous['pid'], signal.SIGTERM)
            for _ in range(100):
                if identity(previous['pid'], cwd, node) is None:
                    print('Stopped only this manually started Controller')
                    return
                time.sleep(.1)
            raise RuntimeError('Controller has not exited; inspect it instead of force-killing')
        subprocess.run([node, 'scripts/check-production-config.mjs'], cwd=cwd, env=env, check=True)
        if args.operation == 'check':
            return
        if running:
            raise ValueError('This Controller session is already running')
        for key in ['GELATO_STREAM_DIR', 'TASK_ARTIFACT_DIR']:
            destination = Path(env[key])
            if not destination.is_absolute():
                raise ValueError(f'{key} must be absolute')
            destination.mkdir(parents=True, mode=0o700, exist_ok=True)
            info = destination.stat()
            if info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError(f'{key} must be private and writable by the service user')
        pairing = Path(env['GELATO_PAIRING_STORE'])
        if not pairing.is_absolute() or not pairing.parent.is_dir():
            raise ValueError('Pairing store must use an existing absolute private directory')
        info = pairing.parent.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Pairing store parent must be private and owned by the service user')
        if pairing.exists():
            private_file(pairing)
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', int(env['PORT']))) == 0:
                raise ValueError('Port already in use; refusing to replace its owner')
        log_file = config_path.with_name(config_path.stem + '.log')
        if log_file.exists():
            private_file(log_file)
        with log_file.open('ab') as log:
            os.chmod(log_file, 0o600)
            child = subprocess.Popen([node, 'server.mjs'], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=log, start_new_session=True)
        started = identity(child.pid, cwd, node)
        for _ in range(30):
            if started:
                break
            if child.poll() is not None:
                raise RuntimeError(f'Controller failed; inspect private log {log_file}')
            time.sleep(.1)
            started = identity(child.pid, cwd, node)
        if not started:
            raise RuntimeError('Could not verify the newly started process identity')
        with tempfile.NamedTemporaryFile(mode='w', dir=config_path.parent, prefix='.controller-state-', delete=False) as output:
            json.dump({'pid': child.pid, 'startTicks': started, 'startedAt': time.time()}, output)
            output.flush()
            os.fsync(output.fileno())
            temporary_state = output.name
        os.replace(temporary_state, state_file)
        time.sleep(.3)
        if child.poll() is not None:
            raise RuntimeError(f'Controller exited; inspect private log {log_file}')
        print(json.dumps({'started': True, 'pid': child.pid, 'publicOrigin': env['PUBLIC_CONTROLLER_URL']}))


if __name__ == '__main__':
    main()
