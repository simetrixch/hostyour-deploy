#!/usr/bin/env bash
# The installer calls this as `--check` or `--apply` and the cluster invocation, and reads one JSON object
# from standard output. The key it prints is Forgejo's public host key, which trusts nothing by itself:
# it becomes the known host of the release bump's SSH push, so what this scan sees is the trust root.
set -euo pipefail
exec python3 -I -B -c "$(cat <<'PY'
import base64
import binascii
import json
import re
import subprocess
import sys

PORT = '<forgejo-ssh-port>'
HOST = '<forgejo-host>'
FIELD = 'host-key'
KEY_TYPE = 'ssh-rsa'
# The wire form of an RSA public key starts with the length of its type name and the name itself.
KEY_PREFIX = b'\x00\x00\x00\x07ssh-rsa'
SCAN_SECONDS = 30


def refuse(message):
    sys.exit(message)


if not re.fullmatch(r'[0-9]{1,5}', PORT) or not re.fullmatch(r'[a-z0-9]([a-z0-9.-]*[a-z0-9])?', HOST):
    refuse('the Forgejo SSH port and the Forgejo host must be a port number and a lowercase host name')
if len(sys.argv) < 3 or sys.argv[1] not in ('--check', '--apply') or sys.argv[2] != '--':
    refuse('the Forgejo SSH host key expects --check or --apply and the cluster invocation')
APPLY = sys.argv[1] == '--apply'


def scanned():
    """The one RSA key line Forgejo's SSH port answers with, as 'ssh-rsa base64'; refuses anything else."""
    try:
        done = subprocess.run(['ssh-keyscan', '-T', '10', '-t', 'rsa', '-p', PORT, HOST], input='',
                              capture_output=True, text=True, timeout=SCAN_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        refuse('ssh-keyscan could not scan ' + HOST + ':' + PORT)
    if done.returncode != 0:
        refuse('ssh-keyscan of ' + HOST + ':' + PORT + ' failed')
    lines = [line for line in done.stdout.splitlines() if line.strip() and not line.startswith('#')]
    if not lines:
        refuse('the scan of ' + HOST + ':' + PORT + ' answered no key: this host cannot reach the Forgejo SSH port at that address')
    if len(lines) != 1:
        refuse('the scan of ' + HOST + ':' + PORT + ' answered ' + str(len(lines)) + ' key lines; exactly one ' + KEY_TYPE + ' line is expected')
    parts = lines[0].split()
    if len(parts) != 3 or parts[1] != KEY_TYPE:
        refuse('the scan of ' + HOST + ':' + PORT + ' did not answer one ' + KEY_TYPE + ' key line')
    address, key_type, blob = parts
    if address not in (HOST, '[' + HOST + ']:' + PORT):
        refuse('the scan of ' + HOST + ':' + PORT + ' answered a key for another address')
    try:
        raw = base64.b64decode(blob, validate=True)
    except (binascii.Error, ValueError):
        refuse('the ' + KEY_TYPE + ' key line of ' + HOST + ':' + PORT + ' holds no readable key')
    if not raw.startswith(KEY_PREFIX):
        refuse('the ' + KEY_TYPE + ' key line of ' + HOST + ':' + PORT + ' holds no RSA key')
    return key_type + ' ' + blob


try:
    incoming = json.load(sys.stdin)
except (ValueError, TypeError):
    refuse('the Forgejo SSH host key input is unreadable')
if not isinstance(incoming, dict):
    refuse('the Forgejo SSH host key input is not an object')
entry = incoming.get('entry') or {}
if not isinstance(entry, dict):
    refuse('the held Forgejo SSH host key entry is unreadable')
key = scanned()
# Measured and replaced every run: a check holds only while the entry is the key the port answers now.
print(json.dumps({FIELD: key} if APPLY else {'satisfied': entry == {FIELD: key}}))
PY
)" "$@"
