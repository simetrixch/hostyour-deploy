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
# write:repository sets statuses and creates releases; read:user lets the token show its own account,
# its own scopes and its rights (GET /user, /users/forgejo-build/tokens, /user/repos), so a check
# needs no administrator and stays read-only.
SCOPES = 'write:repository,read:user'
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


def pages(path, auth):
    page = 1
    while True:
        _, raw = api('GET', path + '?limit=50&page=' + str(page), auth, (200,))
        listed = object_json(raw, 'Forgejo ' + path)
        if not isinstance(listed, list):
            refuse('Forgejo returned no list for GET ' + path)
        yield from listed
        if len(listed) < 50:
            return
        page += 1
        if page > 100:
            refuse('Forgejo ' + path + ' exceeded the page bound')


def issued_here(tokens, token):
    # Forgejo never edits a token after issuing it, so its listed scopes and repository limit are what
    # it can do: exactly SCOPES, over every repository, and so neither public-only nor narrowed.
    named = [t for t in tokens if isinstance(t, dict) and t.get('name') == TOKEN_NAME]
    return (len(named) == 1 and named[0].get('token_last_eight') == token[-8:] and
            sorted(named[0].get('scopes') or []) == sorted(SCOPES.split(',')) and
            named[0].get('repositories') is None)


def inspect(token):
    """'valid', 'ungranted' (a valid token whose user lacks a build repository's write grant) or
    'invalid'. Only GET requests with the token itself, so a check stays read-only."""
    if not isinstance(token, str) or len(token) < 8 or any(c in token for c in '\r\n'):
        return 'invalid'
    auth = 'token ' + token
    # 401: Forgejo knows no such token; 403: it lacks read:user, so it is not the one issued here.
    # Neither mints by itself: apply asks the administrator's listing first.
    status, raw = api('GET', '/user', auth, (200, 401, 403))
    if status != 200:
        return 'invalid'
    actor = object_json(raw, 'Forgejo user')
    if actor.get('login') != USER:
        refuse('the held Forgejo credential belongs to another account; no token was minted')
    if actor.get('is_admin') is not False or actor.get('restricted') is not True or actor.get('active') is not True:
        refuse('forgejo-build is not an active restricted non-admin user')
    if not issued_here(list(pages('/users/' + USER + '/tokens', auth)), token):
        return 'invalid'
    # The token reaches every repository, so this list is every repository the user has a right on.
    pushed = set()
    for repo in pages('/user/repos', auth):
        rights = repo.get('permissions') if isinstance(repo, dict) else None
        if not isinstance(rights, dict) or not isinstance(rights.get('push'), bool):
            refuse('Forgejo repository write rights are unreadable')
        if rights.get('admin') is True:
            refuse('forgejo-build has repository administration rights')
        if rights['push']:
            if repo.get('full_name') not in REPOSITORIES:
                refuse('forgejo-build has write access to an unrelated repository')
            pushed.add(repo['full_name'])
    return 'valid' if pushed == set(REPOSITORIES) else 'ungranted'


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
        if inspect(token) == 'valid':
            return token
        # The administrator's listing decides what Forgejo issued: a held token it lists as issued
        # here failed for a reason a new token cannot fix, so it is kept and the run stops.
        listed = list(pages('/users/' + USER + '/tokens', auth))
        if isinstance(token, str) and len(token) >= 8 and issued_here(listed, token):
            refuse('Forgejo lists the held credential as issued, yet it did not validate; no token was minted')
        # Forgejo 15 has no token-delete CLI. Its self/admin Basic-auth endpoint removes a
        # confirmed lost or invalid same-name token before the CLI can issue the replacement.
        if any(isinstance(held, dict) and held.get('name') == TOKEN_NAME for held in listed):
            api('DELETE', '/users/' + USER + '/tokens/' + urllib.parse.quote(TOKEN_NAME, safe=''), auth, (204,))
        issued = cli(['generate-access-token', '--username', USER, '--token-name', TOKEN_NAME,
                      '--scopes', SCOPES, '--raw']).strip()
        if inspect(issued) != 'valid':
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
    state = inspect(token) if person is not None else 'invalid'
    if not APPLY:
        return {'satisfied': state == 'valid' and BOOTSTRAP not in people and
                entry == {'forgejo-user': USER, 'forgejo-api-token': token, 'plane-api-token': plane}}
    if BOOTSTRAP in people:
        remove_bootstrap()
    if person is None:
        cli(['create', '--username', USER, '--email', USER + '@hostyour.invalid',
             '--restricted', '--random-password', '--must-change-password=false'])
    if state != 'valid':
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
