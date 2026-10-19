# The access both credential producers load by path: one deadline, the cluster commands, the Forgejo
# pod with its API and its temporary administrator, the shell exec in Plane's API pod and the Plane
# targets the deployed release Pipeline names. A producer's stdout is the engine's one JSON object,
# so nothing here prints but the producer's answer.
import base64
import contextlib
import fcntl
import ipaddress
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

PORT = 3000
POD_WAIT_SECONDS = 30
# Five times the measured 4.8 to 5.8 s of a Django start in Plane's API pod at its 500m CPU limit.
PLANE_EXEC_SECONDS = 30
# The engine kills a producer after 120 s. Past this deadline only the removal of the temporary
# administrator still runs, three cluster commands of 10 s each, so the worst case ends at 115 s.
DEADLINE = time.monotonic() + 85
# A Plane exec writes this mark before its one JSON answer; Django or Plane may write other lines.
MARK = 'forgejo-plane-access answer '
# --no-imports empties the shell's namespace before Django writes anything, and -v 0 keeps every
# other message of the command off stdout.
PLANE_SHELL = ['-n', 'plane', 'exec', '-i', 'deploy/plane-api-wl', '-c', 'plane-api', '--',
               'python', 'manage.py', 'shell', '--no-imports', '-v', '0', '-c']
# Placed after a snippet's first line, which names it: the snippet's arguments and its one answer.
PRELUDE = '''import base64, json, sys
ARGUMENTS = json.loads(base64.b64decode(%r).decode())
def answer(value):
    sys.stdout.write(%r + json.dumps(value) + chr(10))
    sys.stdout.flush()
'''

NAME = None
APPLY = False
KUBE = []
NAMESPACE = SELECTOR = CONTAINER = BOOTSTRAP = None
POD = None
ORIGIN = None


class Refused(Exception):
    pass


def refuse(message):
    raise Refused(message)


def cancelled(signum, frame):
    refuse(NAME + ' was cancelled')


def start(name, namespace, selector, container, bootstrap=None):
    """Reads the engine's invocation and names the Forgejo pod; answers whether this run applies. A
    producer that creates no temporary administrator names no bootstrap user."""
    global NAME, APPLY, KUBE, NAMESPACE, SELECTOR, CONTAINER, BOOTSTRAP
    NAME, NAMESPACE, SELECTOR, CONTAINER, BOOTSTRAP = name, namespace, selector, container, bootstrap
    signal.signal(signal.SIGINT, cancelled)
    signal.signal(signal.SIGTERM, cancelled)
    if len(sys.argv) < 4 or sys.argv[1] not in ('--check', '--apply') or sys.argv[2] != '--':
        sys.exit(name + ' expects --check or --apply and the cluster invocation')
    APPLY = sys.argv[1] == '--apply'
    KUBE = sys.argv[3:]
    return APPLY


def finish(exchange, lock_path=None):
    """Runs the exchange, under the lock where it applies, and prints its one JSON object. A producer
    that changes nothing in Forgejo names no lock."""
    lock = None
    try:
        if APPLY and lock_path is not None:
            lock = os.open(lock_path, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(exchange()))
    except Refused as error:
        sys.exit(str(error))
    except Exception:
        sys.exit(NAME + ' could not complete; exception details withheld')
    finally:
        if lock is not None:
            os.close(lock)


def timeout(seconds, cleanup=False):
    remaining = DEADLINE - time.monotonic()
    if not cleanup and remaining <= 0:
        refuse(NAME + ' exceeded its deadline')
    return seconds if cleanup else min(seconds, remaining)


def kube(args, namespace=None, cleanup=False, what='the Forgejo pod command'):
    # input='' so no command inherits the producer's stdin, which carried the held entry.
    try:
        result = subprocess.run(KUBE + ['--request-timeout=10s', '-n', namespace or NAMESPACE] + args,
                                input='', capture_output=True, text=True, timeout=timeout(10, cleanup))
    except (OSError, subprocess.SubprocessError):
        refuse(what + ' could not be read within its deadline')
    if result.returncode != 0:
        refuse(what + ' was refused; output withheld')
    return result.stdout


def cli(args, cleanup=False):
    return kube(['exec', POD, '-c', CONTAINER, '--', 'forgejo', 'admin', 'user'] + args, cleanup=cleanup)


def object_json(text, name):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        refuse(name + ' returned unreadable JSON; output withheld')


def ready_pod():
    global POD, ORIGIN
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
            # A Kubernetes pod address is an IP, never an API-provided URL or redirect target.
            address = str(ipaddress.ip_address(ready[0]['status']['podIP']))
            ORIGIN = 'http://' + ('[' + address + ']' if ':' in address else address) + ':' + str(PORT)
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
        result[cells[1]] = {'id': int(cells[0]), 'email': cells[2], 'active': cells[3] == 'true', 'admin': cells[4] == 'true'}
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def request(method, path, headers, data=None):
    """The status and body of one request to the Forgejo pod; a redirect is answered, not followed."""
    try:
        with HTTP.open(urllib.request.Request(ORIGIN + path, method=method, headers=headers, data=data),
                       timeout=timeout(10)) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    except (OSError, ValueError):
        refuse('Forgejo API could not be read within its deadline')


def api(method, path, authorization, expected, body=None, sudo=None):
    headers = {'Authorization': authorization, 'Accept': 'application/json'}
    if sudo is not None:
        headers['Sudo'] = sudo
    data = None if body is None else json.dumps(body).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    status, raw = request(method, '/api/v1' + path, headers, data)
    if status not in expected:
        refuse('Forgejo API refused ' + method + ' ' + path + ' with HTTP ' + str(status) + '; body withheld')
    return status, raw


def pages(path, auth, sudo=None):
    page = 1
    while True:
        _, raw = api('GET', path + '?limit=50&page=' + str(page), auth, (200,), sudo=sudo)
        listed = object_json(raw, 'Forgejo ' + path)
        if not isinstance(listed, list):
            refuse('Forgejo returned no list for GET ' + path)
        yield from listed
        if len(listed) < 50:
            return
        page += 1
        if page > 100:
            refuse('Forgejo ' + path + ' exceeded the page bound')


def remove_bootstrap():
    held = users(cleanup=True).get(BOOTSTRAP)
    if held is None:
        return
    if held['email'] != BOOTSTRAP + '@hostyour.invalid':
        refuse('the reserved Forgejo provisioner name is held by an unrelated account')
    cli(['delete', '--username', BOOTSTRAP], cleanup=True)
    if BOOTSTRAP in users(cleanup=True):
        refuse('the temporary Forgejo provisioner was not removed')


@contextlib.contextmanager
def administrator():
    """The Basic authorization of the reserved temporary administrator, which every exit removes."""
    created = False
    try:
        # The reserved account is purpose-owned; a cancelled prior attempt must leave no admin.
        remove_bootstrap()
        created = True
        output = cli(['create', '--username', BOOTSTRAP, '--email', BOOTSTRAP + '@hostyour.invalid',
                      '--admin', '--random-password', '--must-change-password=false'])
        password = re.search(r"^generated random password is '(.*)'$", output, re.MULTILINE)
        if password is None:
            refuse('the temporary Forgejo provisioner returned no generated password; output withheld')
        yield 'Basic ' + base64.b64encode((BOOTSTRAP + ':' + password.group(1)).encode()).decode()
    finally:
        if created:
            remove_bootstrap()


def issued_here(tokens, name, token, scopes):
    # Forgejo never edits a token after issuing it, so its listed scopes and repository limit are what
    # it can do: exactly `scopes`, over every repository, and so neither public-only nor narrowed.
    named = [t for t in tokens if isinstance(t, dict) and t.get('name') == name]
    return (len(named) == 1 and named[0].get('token_last_eight') == token[-8:] and
            sorted(named[0].get('scopes') or []) == sorted(scopes) and
            named[0].get('repositories') is None)


def inspect_token(user, name, scopes, token, writable):
    """The set of repositories a held token of `user` may write, or None where Forgejo does not know it
    as the token issued here. Refuses a token of another account, an account that is not an active
    restricted non-admin user, administration rights anywhere, and write access outside `writable`.
    Only GET requests with the token itself, so a check stays read-only."""
    if not isinstance(token, str) or len(token) < 8 or any(c in token for c in '\r\n'):
        return None
    auth = 'token ' + token
    # 401: Forgejo knows no such token; 403: it lacks read:user, so it is not the one issued here.
    # Neither mints by itself: apply asks the administrator's listing first.
    status, raw = api('GET', '/user', auth, (200, 401, 403))
    if status != 200:
        return None
    actor = object_json(raw, 'Forgejo user')
    if actor.get('login') != user:
        refuse('the held Forgejo credential belongs to another account; no token was minted')
    if actor.get('is_admin') is not False or actor.get('restricted') is not True or actor.get('active') is not True:
        refuse(user + ' is not an active restricted non-admin user')
    if not issued_here(list(pages('/users/' + user + '/tokens', auth)), name, token, scopes):
        return None
    # The token reaches every repository, so this list is every repository the user has a right on.
    pushed = set()
    for repo in pages('/user/repos', auth):
        rights = repo.get('permissions') if isinstance(repo, dict) else None
        if not isinstance(rights, dict) or not isinstance(rights.get('push'), bool):
            refuse('Forgejo repository write rights are unreadable')
        if rights.get('admin') is True:
            refuse(user + ' has repository administration rights')
        if rights['push']:
            if repo.get('full_name') not in writable:
                refuse(user + ' has write access to an unrelated repository')
            pushed.add(repo['full_name'])
    return pushed


def grant(auth, repo, user, permission):
    """Makes `user` a collaborator of `repo` with exactly `permission`, as the administrator `auth`, once
    the account is an active restricted non-admin user."""
    # The account is read from its own route. The user block of a collaborator's permission shows the
    # account as the repository's OWNER sees it, not the administrator, so for an owner who is neither
    # an administrator nor the user, is_admin and active read false whatever the account is.
    _, raw = api('GET', '/users/' + user, auth, (200,))
    person = object_json(raw, 'Forgejo user')
    if person.get('login') != user or person.get('is_admin') is not False or person.get('restricted') is not True or person.get('active') is not True:
        refuse(user + ' is not an active restricted non-admin user')
    path = '/repos/' + repo + '/collaborators/' + user
    status, raw = api('GET', path + '/permission', auth, (200, 404))
    if status == 404 or object_json(raw, 'Forgejo collaborator').get('permission') != permission:
        api('PUT', path, auth, (204,), {'permission': permission})


def plane(snippet, arguments, stdin=''):
    """The one answer object of a fixed snippet run in Plane's API pod. The snippet carries no
    secret; a secret the snippet needs goes in on stdin, and every other exec gets an empty one."""
    name, body = snippet.split('\n', 1)
    code = name + '\n' + PRELUDE % (base64.b64encode(json.dumps(arguments).encode()).decode(), MARK) + body
    argv = KUBE + ['--request-timeout=' + str(PLANE_EXEC_SECONDS) + 's'] + PLANE_SHELL + [code]
    try:
        result = subprocess.run(argv, input=stdin, capture_output=True, text=True,
                                timeout=timeout(PLANE_EXEC_SECONDS))
    except subprocess.TimeoutExpired:
        refuse('the Plane pod did not answer within its deadline')
    except (OSError, subprocess.SubprocessError):
        refuse('the Plane pod command could not be run')
    if result.returncode != 0:
        refuse('the Plane pod command was refused; output withheld')
    lines = [line for line in result.stdout.splitlines() if line.startswith(MARK)]
    try:
        value = json.loads(lines[0][len(MARK):]) if len(lines) == 1 else None
    except ValueError:
        value = None
    if not isinstance(value, dict):
        refuse('the Plane pod answer could not be read; output withheld')
    return value


def plane_targets():
    """The workspace and the project ids the Task plane-update-status writes to, as the deployed
    Pipeline names them, so no producer holds a second copy."""
    pipeline = object_json(kube(['get', 'pipelines.tekton.dev', 'forgejo-release', '-o', 'json'],
                                namespace='forgejo-build', what='the Pipeline forgejo-release'),
                           'the Pipeline forgejo-release')
    try:
        task, = [t for t in pipeline['spec']['tasks'] if t.get('name') == 'plane']
        value, = [p['value'] for p in task['params'] if p.get('name') == 'plane-targets']
        targets = json.loads(value)
        workspace = targets['workspace']
        projects = [str(uuid.UUID(p['id'])) for p in targets['projects']]
    except (KeyError, TypeError, ValueError, AttributeError):
        refuse('the Pipeline forgejo-release names no readable plane-targets in its task plane')
    if not isinstance(workspace, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', workspace) or \
            not projects or len(set(projects)) != len(projects):
        refuse('the Pipeline forgejo-release names no readable plane-targets in its task plane')
    return workspace, projects
