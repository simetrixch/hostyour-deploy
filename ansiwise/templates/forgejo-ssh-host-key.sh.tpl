#!/usr/bin/env bash
# The installer calls this as `--check` or `--apply` and the cluster invocation, and reads one JSON object
# from standard output. The key it prints is Forgejo's public host key, read from the Forgejo pod itself: it
# becomes the known host of the release bump's SSH push, so it comes from the server and never from whatever
# answers a name and a port.
set -euo pipefail
exec python3 -I -B -c "$(cat <<'PY'
import base64
import binascii
import importlib.util
import json
import re
import sys

try:
    spec = importlib.util.spec_from_file_location('forgejo_plane_access', '<forgejo-plane-access-module>')
    access = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(access)
except Exception:
    sys.exit('the Forgejo and Plane access module could not be loaded')
refuse = access.refuse

FIELD = 'host-key'
KEY_TYPE = 'ssh-rsa'
# The built-in SSH server loads ssh/gitea.rsa under APP_DATA_PATH, which the chart sets to /data, and writes the
# public half beside it (Forgejo 17.0.0 modules/setting/ssh.go:65, :132-134, modules/ssh/ssh.go:389-399).
KEY_FILE = '/data/ssh/gitea.rsa.pub'
# The wire form of an RSA public key starts with the length of its type name and the name itself.
KEY_PREFIX = b'\x00\x00\x00\x07ssh-rsa'
APPLY = access.start('Forgejo SSH host key', '<forgejo-namespace>', '<forgejo-pod-selector>', '<forgejo-container>')


def served():
    """The one RSA key line of the public key file in the Forgejo pod, as 'ssh-rsa base64'; refuses anything else."""
    text = access.kube(['exec', access.POD, '-c', access.CONTAINER, '--', 'cat', KEY_FILE], what='the Forgejo SSH host key file')
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) != 1:
        refuse('the Forgejo SSH host key file holds ' + str(len(lines)) + ' lines; exactly one ' + KEY_TYPE + ' line is expected')
    parts = lines[0].split()
    if len(parts) != 2 or parts[0] != KEY_TYPE:
        refuse('the Forgejo SSH host key file holds no single ' + KEY_TYPE + ' key line')
    try:
        raw = base64.b64decode(parts[1], validate=True)
    except (binascii.Error, ValueError):
        refuse('the ' + KEY_TYPE + ' key line of the Forgejo SSH host key file holds no readable key')
    if not raw.startswith(KEY_PREFIX):
        refuse('the ' + KEY_TYPE + ' key line of the Forgejo SSH host key file holds no RSA key')
    return KEY_TYPE + ' ' + parts[1]


def exchange():
    try:
        incoming = json.load(sys.stdin)
    except (ValueError, TypeError):
        refuse('the Forgejo SSH host key input is unreadable')
    if not isinstance(incoming, dict):
        refuse('the Forgejo SSH host key input is not an object')
    entry = incoming.get('entry') or {}
    if not isinstance(entry, dict):
        refuse('the held Forgejo SSH host key entry is unreadable')
    access.ready_pod()
    key = served()
    # Measured and replaced every run: a check holds only while the entry is the key the server serves now.
    return {FIELD: key} if APPLY else {'satisfied': entry == {FIELD: key}}


access.finish(exchange)
PY
)" "$@"
