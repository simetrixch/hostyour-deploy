#!/usr/bin/env bash
# The installer calls this as `--check` or `--apply` and the cluster invocation, which it ignores because it runs no
# cluster command, and reads one JSON object from standard output. It captures both streams as secret output; only
# this process holds the App's private key and the token signed with it.
set -euo pipefail
exec python3 -I -B -c "$(cat <<'PY'
import base64
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

SECRETS_FILE = '<secrets-directory>/secrets.<stage>'
GITHUB_API = '<github-api>'
# The fields of the entry and the keys of the hand-filled secrets file that hold them, in the entry's order.
FIELDS = (
    ('app-id', 'GITHUB_APP_ID'),
    ('installation-id', 'GITHUB_APP_INSTALLATION_ID'),
    ('private-key', 'GITHUB_APP_PRIVATE_KEY'),
    ('owner', 'GITHUB_APP_OWNER'),
)
LOGIN = re.compile(r'[A-Za-z0-9-]+')
DIGITS = re.compile(r'[0-9]+')
PLAIN_LINE = re.compile(r'[ -~]*[!-~][ -~]*')
REQUEST_SECONDS = 30


def refuse(message, code=65):
    """The message reaches the run log: it holds literal text, the path of the secrets file, the names of its keys,
    digits of an installation id and account logins checked against GitHub's alphabet, and never a value of the file,
    a response body or the output of openssl."""
    if PLAIN_LINE.fullmatch(message) is None:
        message = 'the reason is not one plain line; reason withheld'
    sys.stderr.write('refused: ' + message + '\n')
    sys.exit(code)


def held_entry():
    """The entry Vault holds, or None where it holds none, as the step hands it on standard input."""
    try:
        document = json.loads(sys.stdin.read())
    except ValueError:
        refuse('the GitHub App credential exchange input is unreadable')
    if not isinstance(document, dict):
        refuse('the GitHub App credential exchange input is not an object')
    entry = document.get('entry')
    if entry is not None and not isinstance(entry, dict):
        refuse('the held GitHub App credential entry is unreadable')
    return entry


def unquoted(value):
    if len(value) >= 2 and value[0] in '"\'' and value.endswith(value[0]):
        return value[1:-1]
    return value


def assignments(content):
    """The installer's reading of a hand-filled file: nothing is run and no escape is processed."""
    values = {}
    for raw in content.split('\n'):
        line = raw.strip()
        if line.startswith('export '):
            line = line[7:]
        if not line or line.startswith('#'):
            continue
        equals = line.find('=')
        if equals <= 0:
            continue
        name = line[:equals].strip()
        if name:
            values[name] = unquoted(line[equals + 1:].strip())
    return values


def read_credentials():
    """The four values of the secrets file; refuses everything the installer would refuse, before any call."""
    try:
        with open(SECRETS_FILE, encoding='utf-8', newline='') as handle:
            content = handle.read()
    except (OSError, ValueError):
        refuse(SECRETS_FILE + ' cannot be read')
    if '\r' in content:
        refuse(SECRETS_FILE + ' carries a carriage return, and a credential read out of it would carry one too; '
               'rewrite the file with unix line endings before this runs again')
    held = assignments(content)
    values, wrong = {}, []
    for field, key in FIELDS:
        value = held.get(key, '')
        if not value:
            wrong.append(key + ' is missing or empty in ' + SECRETS_FILE)
        elif '<' in value and '>' in value:
            wrong.append(key + ' in ' + SECRETS_FILE + ' still holds the text that marks it unfilled')
        elif field == 'installation-id' and DIGITS.fullmatch(value) is None:
            wrong.append(key + ' in ' + SECRETS_FILE + ' is not all digits')
        elif field == 'owner' and LOGIN.fullmatch(value) is None:
            wrong.append(key + ' in ' + SECRETS_FILE + ' is not a GitHub account login (letters, digits and hyphens only)')
        values[field] = value
    if wrong:
        refuse('; '.join(wrong))
    return values


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def signed_token(app_id, private_key):
    """The App's own JWT: RS256 over iat, exp and iss, dated a minute into the past because GitHub refuses a token
    ahead of its own clock, and nine minutes long under GitHub's ten-minute ceiling. The key lives in a private
    directory for the time openssl signs, whatever way this ends."""
    now = int(time.time())
    header = b64url(json.dumps({'alg': 'RS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    payload = b64url(json.dumps({'iat': now - 60, 'exp': now + 540, 'iss': app_id}, separators=(',', ':')).encode())
    signing_input = header + '.' + payload
    work = tempfile.mkdtemp()
    try:
        key_file = os.path.join(work, 'app.pem')
        with os.fdopen(os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as handle:
            handle.write(private_key.replace('\\n', '\n'))
        signed = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', key_file], input=signing_input.encode(),
                                capture_output=True)
    finally:
        shutil.rmtree(work)
    if signed.returncode != 0 or not signed.stdout:
        refuse('GITHUB_APP_PRIVATE_KEY in ' + SECRETS_FILE + ' is not a private key openssl can sign with')
    return signing_input + '.' + b64url(signed.stdout)


def installation_account(token, installation):
    """The login of the account the installation belongs to, as GitHub names it."""
    request = urllib.request.Request(
        GITHUB_API + '/app/installations/' + installation,
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_SECONDS) as response:
            status, body = response.status, response.read()
    except urllib.error.HTTPError as error:
        refuse('GitHub answered HTTP ' + str(error.code) + ' for the installation ' + installation, 69)
    except (OSError, http.client.HTTPException):
        refuse('GitHub could not be reached for the installation ' + installation, 69)
    if status != 200:
        refuse('GitHub answered HTTP ' + str(status) + ' for the installation ' + installation, 69)
    try:
        login = json.loads(body)['account']['login']
    except (ValueError, KeyError, TypeError):
        login = None
    if not isinstance(login, str) or LOGIN.fullmatch(login) is None:
        refuse("GitHub's answer for the installation " + installation + ' carries no account login', 69)
    return login


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ('--check', '--apply') or sys.argv[2] != '--':
        sys.exit('the GitHub App credential expects --check or --apply and the cluster invocation')
    entry = held_entry()
    values = read_credentials()
    installation, owner = values['installation-id'], values['owner']
    login = installation_account(signed_token(values['app-id'], values['private-key']), installation)
    if login.lower() != owner.lower():
        refuse('GITHUB_APP_OWNER in ' + SECRETS_FILE + ' is ' + owner + ', and the installation ' + installation
               + ' belongs to ' + login + '; correct GITHUB_APP_OWNER in that file')
    print(json.dumps(values if sys.argv[1] == '--apply' else {'satisfied': entry == values}))


try:
    main()
except Exception:
    sys.exit('the GitHub App credential could not be completed; exception details withheld')
PY
)" "$@"
