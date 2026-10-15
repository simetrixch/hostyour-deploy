#!/usr/bin/env bash
# The installer captures both streams as secret output; only this process holds issued values.
set -euo pipefail
exec python3 -c "$(cat <<'PY'
import base64
import fcntl
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

USER = '<forgejo-user>'
TOKEN_NAME = '<forgejo-token-name>'
BOOTSTRAP = '<forgejo-bootstrap-user>'
NAMESPACE = '<forgejo-namespace>'
SELECTOR = '<forgejo-pod-selector>'
CONTAINER = '<forgejo-container>'
REPOSITORIES = '<forgejo-repositories>'.split(',')
LOCK = '<forgejo-credential-lock>'
PORT = 3000
POD_WAIT_SECONDS = 30


class Refused(Exception):
    pass


def refuse(message):
    raise Refused(message)


def cancelled(signum, frame):
    refuse('Forgejo credential provisioning was cancelled')


signal.signal(signal.SIGINT, cancelled)
signal.signal(signal.SIGTERM, cancelled)
if len(sys.argv) < 4 or sys.argv[1] not in ('--check', '--apply') or sys.argv[2] != '--':
    sys.exit('Forgejo credential producer expects --check or --apply and the cluster invocation')
APPLY = sys.argv[1] == '--apply'
KUBE = sys.argv[3:]
DEADLINE = time.monotonic() + 100
POD = None
URL = None


def timeout(cleanup=False):
    remaining = DEADLINE - time.monotonic()
    if not cleanup and remaining <= 0:
        refuse('Forgejo credential provisioning exceeded its deadline')
    return 10 if cleanup else min(10, remaining)


def kube(args, cleanup=False):
    try:
        result = subprocess.run(KUBE + ['--request-timeout=10s', '-n', NAMESPACE] + args,
                                capture_output=True, text=True, timeout=timeout(cleanup))
    except (OSError, subprocess.SubprocessError):
        refuse('the Forgejo pod command could not be read within its deadline')
    if result.returncode != 0:
        refuse('the Forgejo pod command was refused; output withheld')
    return result.stdout


def cli(args, cleanup=False):
    return kube(['exec', POD, '-c', CONTAINER, '--', 'forgejo', 'admin', 'user'] + args, cleanup)


def object_json(text, name):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        refuse(name + ' returned unreadable JSON; output withheld')


def ready_pod():
    global POD, URL
    until = time.monotonic() + POD_WAIT_SECONDS
    while True:
        result = object_json(kube(['get', 'pods', '-l', SELECTOR, '-o', 'json']), 'Forgejo')
        if not isinstance(result, dict) or not isinstance(result.get('items'), list):
            refuse('the Forgejo pod list could not be read')
        ready = [p for p in result['items'] if p.get('status', {}).get('podIP') and
                 any(c.get('type') == 'Ready' and c.get('status') == 'True'
                     for c in p.get('status', {}).get('conditions', []))]
        if len(ready) == 1:
            POD = ready[0]['metadata']['name']
            address = ready[0]['status']['podIP']
            # A Kubernetes pod address is an IP, never an API-provided URL or redirect target.
            import ipaddress
            address = str(ipaddress.ip_address(address))
            URL = 'http://' + ('[' + address + ']' if ':' in address else address) + ':' + str(PORT) + '/api/v1'
            return
        if len(ready) > 1:
            refuse('Forgejo has multiple ready pods; no credential was changed')
        if time.monotonic() >= until:
            refuse('the Forgejo pod was not ready before its deadline')
        time.sleep(min(1, POD_WAIT_SECONDS))


def users(cleanup=False):
    result = {}
    lines = cli(['list'], cleanup).splitlines()
    if not lines or lines[0].split() != ['ID', 'Username', 'Email', 'IsActive', 'IsAdmin', '2FA']:
        refuse('the Forgejo user list could not be read')
    for line in lines[1:]:
        if not line.strip():
            continue
        cells = line.split()
        if len(cells) != 6 or not cells[0].isdigit() or cells[3] not in ('true', 'false') or cells[4] not in ('true', 'false'):
            refuse('the Forgejo user list could not be read')
        result[cells[1]] = {'email': cells[2], 'active': cells[3] == 'true', 'admin': cells[4] == 'true'}
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def api(method, path, authorization, expected, body=None):
    headers = {'Authorization': authorization, 'Accept': 'application/json'}
    data = None if body is None else json.dumps(body).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(URL + path, method=method, headers=headers, data=data)
    try:
        with HTTP.open(request, timeout=timeout()) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    except (OSError, ValueError):
        refuse('Forgejo API could not be read within its deadline')
    if status not in expected:
        refuse('Forgejo API refused ' + method + ' ' + path + ' with HTTP ' + str(status) + '; body withheld')
    return status, raw


def permission_path(repo, user):
    return '/repos/' + repo + '/collaborators/' + user + '/permission'


def inspect(token):
    if not isinstance(token, str) or not token or any(c in token for c in '\r\n'):
        return False
    auth = 'token ' + token
    for repo in REPOSITORIES:
        status, raw = api('GET', permission_path(repo, USER), auth, (200, 401, 403, 404))
        if status == 403:
            refuse('Forgejo credential permissions could not be read; no token was minted')
        if status != 200:
            return False
        permission = object_json(raw, 'Forgejo permission')
        person = permission.get('user', {})
        if person.get('login') != USER or person.get('is_admin') is not False or person.get('restricted') is not True or person.get('active') is not True:
            refuse('forgejo-build is not an active restricted non-admin user')
        if permission.get('permission') != 'write':
            refuse('forgejo-build must have write permission without repository administration')
        # With write:repository, /user needs an ungranted read:user scope. This self-only endpoint
        # plus the refused owner lookup identifies the actor without adding that scope.
        status, _ = api('GET', permission_path(repo, repo.split('/')[0]), auth, (200, 401, 403, 404))
        if status != 403:
            refuse('the standing Forgejo credential has broader identity rights than forgejo-build')
    page = 1
    while True:
        _, raw = api('GET', '/user/repos?limit=50&page=' + str(page), auth, (200,))
        repositories = object_json(raw, 'Forgejo repository permissions')
        if not isinstance(repositories, list):
            refuse('Forgejo repository permissions are unreadable')
        for repo in repositories:
            rights = repo.get('permissions')
            if not isinstance(rights, dict) or not isinstance(rights.get('push'), bool):
                refuse('Forgejo repository write rights are unreadable')
            if rights.get('admin') is True:
                refuse('forgejo-build has repository administration rights')
            if rights['push'] and repo.get('full_name') not in REPOSITORIES:
                refuse('forgejo-build has write access to an unrelated repository')
        if len(repositories) < 50:
            return True
        page += 1
        if page > 100:
            refuse('Forgejo repository permissions exceeded the page bound')


def remove_bootstrap():
    held = users(cleanup=True).get(BOOTSTRAP)
    if held is None:
        return
    if held['email'] != BOOTSTRAP + '@hostyour.invalid':
        refuse('the reserved Forgejo provisioner name is held by an unrelated account')
    cli(['delete', '--username', BOOTSTRAP], cleanup=True)
    if BOOTSTRAP in users(cleanup=True):
        refuse('the temporary Forgejo provisioner was not removed')


def provision(token):
    bootstrap_created = False
    try:
        # The reserved account is purpose-owned; a cancelled prior attempt must leave no admin.
        remove_bootstrap()
        bootstrap_created = True
        output = cli(['create', '--username', BOOTSTRAP, '--email', BOOTSTRAP + '@hostyour.invalid',
                      '--admin', '--random-password', '--must-change-password=false'])
        password = re.search(r"^generated random password is '(.*)'$", output, re.MULTILINE)
        if password is None:
            refuse('the temporary Forgejo provisioner returned no generated password; output withheld')
        auth = 'Basic ' + base64.b64encode((BOOTSTRAP + ':' + password.group(1)).encode()).decode()
        for repo in REPOSITORIES:
            status, raw = api('GET', permission_path(repo, USER), auth, (200, 404))
            if status == 404 or object_json(raw, 'Forgejo collaborator').get('permission') != 'write':
                api('PUT', '/repos/' + repo + '/collaborators/' + USER, auth, (204,), {'permission': 'write'})
            _, raw = api('GET', permission_path(repo, USER), auth, (200,))
            person = object_json(raw, 'Forgejo collaborator').get('user', {})
            if person.get('login') != USER or person.get('is_admin') is not False or person.get('restricted') is not True or person.get('active') is not True:
                refuse('forgejo-build is not an active restricted non-admin user')
        if inspect(token):
            return token
        # Forgejo 15 has no token-delete CLI. Its self/admin Basic-auth endpoint removes a
        # confirmed lost or invalid same-name token before the CLI can issue the replacement.
        page = 1
        while True:
            _, raw = api('GET', '/users/' + USER + '/tokens?limit=50&page=' + str(page), auth, (200,))
            listed = object_json(raw, 'Forgejo token list')
            if not isinstance(listed, list):
                refuse('the Forgejo token list is unreadable')
            for held in listed:
                if held.get('name') == TOKEN_NAME:
                    api('DELETE', '/users/' + USER + '/tokens/' + urllib.parse.quote(TOKEN_NAME, safe=''), auth, (204,))
            if len(listed) < 50:
                break
            page += 1
            if page > 100:
                refuse('the Forgejo token list exceeded the page bound')
        issued = cli(['generate-access-token', '--username', USER, '--token-name', TOKEN_NAME,
                      '--scopes', 'write:repository', '--raw']).strip()
        if not inspect(issued):
            refuse('the issued Forgejo credential did not validate')
        return issued
    finally:
        if bootstrap_created:
            remove_bootstrap()


def exchange():
    try:
        incoming = json.load(sys.stdin)
    except (ValueError, TypeError):
        refuse('the Forgejo credential exchange input is unreadable')
    if not isinstance(incoming, dict) or not isinstance(incoming.get('inputs'), dict):
        refuse('the Forgejo credential exchange input is not an object')
    entry = incoming.get('entry') or {}
    if not isinstance(entry, dict):
        refuse('the held Forgejo credential entry is unreadable')
    plane = incoming['inputs'].get('plane-api-token', entry.get('plane-api-token'))
    if not isinstance(plane, str) or not plane.strip():
        refuse('plane-api-token is absent; supply the plane_api_token secret answer')
    ready_pod()
    people = users()
    person = people.get(USER)
    if person is not None and (person['admin'] or not person['active']):
        refuse('forgejo-build must be an active non-admin user')
    token = entry.get('forgejo-api-token') if entry.get('forgejo-user') == USER else None
    valid = person is not None and inspect(token)
    if not APPLY:
        return {'satisfied': valid and BOOTSTRAP not in people and
                entry == {'forgejo-user': USER, 'forgejo-api-token': token, 'plane-api-token': plane}}
    if BOOTSTRAP in people:
        remove_bootstrap()
    if person is None:
        cli(['create', '--username', USER, '--email', USER + '@hostyour.invalid',
             '--restricted', '--random-password', '--must-change-password=false'])
    if not valid:
        token = provision(token)
    return {'forgejo-user': USER, 'forgejo-api-token': token, 'plane-api-token': plane}


lock = None
try:
    if APPLY:
        lock = os.open(LOCK, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    result = exchange()
    print(json.dumps(result))
except Refused as error:
    sys.exit(str(error))
except Exception:
    sys.exit('Forgejo credential exchange could not complete; exception details withheld')
finally:
    if lock is not None:
        os.close(lock)
PY
)" "$@"
