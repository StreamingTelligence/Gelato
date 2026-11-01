#!/usr/bin/env python3
"""Create a private Controller env file using an existing Tinode configuration.

Run manually with Docker access. Does not start services, change account data,
or reset token-signing keys. API-key generation uses Tinode's own keygen binary.
"""
import argparse
import io
import json
import os
import re
import subprocess
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument('--container', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--url', default='ws://127.0.0.1:16060/v0/channels')
args = parser.parse_args()
if not re.fullmatch(r'[a-zA-Z0-9_.-]+', args.container):
    raise SystemExit('Invalid container name')
archive = subprocess.check_output(['docker', 'cp', args.container + ':/opt/tinode/working.config', '-'])
with tarfile.open(fileobj=io.BytesIO(archive)) as files:
    config = json.load(files.extractfile('working.config'))
generated = subprocess.check_output(['docker', 'exec', args.container, '/opt/tinode/keygen',
                                     '-salt', config['api_key_salt'], '-sequence', '8'], text=True)
key = re.search(r'API key v\d+ seq\d+ \[ordinary\]: ([A-Za-z0-9_=-]+)', generated)
if not key:
    raise SystemExit('Tinode keygen did not return an ordinary application key')
if not re.fullmatch(r'wss?://[a-zA-Z0-9.:/_-]+', args.url):
    raise SystemExit('Invalid Tinode URL')
# Exclusive creation prevents silently replacing another deployment's secrets.
descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, 'w') as output:
    output.write('TINODE_WS_URL=' + args.url + '\nTINODE_API_KEY=' + key[1] + '\n')
print('Private Tinode Controller configuration created; no account database changes.')
