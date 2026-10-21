#!/usr/bin/env bash
# The installer captures both streams as secret output; only this process holds the client secret.
set -euo pipefail
exec python3 -I -B -c "$(cat <<'PY'
import hashlib
import importlib.util
import json
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

try:
    spec = importlib.util.spec_from_file_location('forgejo_plane_access', '<forgejo-plane-access-module>')
    access = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(access)
except Exception:
    sys.exit('the Forgejo and Plane access module could not be loaded')
refuse = access.refuse

# Forgejo has no instance-wide OAuth2 application, so a machine user that signs in nowhere owns
# Plane's; one owned by forgejo-build would be listed to the build token's read:user.
USER = 'plane'
EMAIL = USER + '@hostyour.invalid'
APPLICATION = 'plane'
BOOTSTRAP = '<forgejo-bootstrap-user>'
LOCK = '<forgejo-credential-lock>'
# The two accounts of the sign-in proof (digita-testkit cases/plane-sign-in.spec.ts). Plane admits an
# address it has never seen only where an invitation for it exists, so the first is invited and the
# second is the account Plane must refuse.
INVITED = '<plane-test-account-email>'
UNINVITED = '<plane-test-uninvited-email>'
TEST_EMAILS = (INVITED, UNINVITED)
# Plane's workspace roles (plane/db/models/workspace.py ROLE_CHOICES in v1.4.2).
ROLES = {'admin': 20, 'member': 15, 'guest': 5}
# The people the installation names beside its administrator, one per line as an address and a role, in a file
# the deployment writes: the installation's own answer fills it, and no address of a person stands in a repository.
# It is read as data and never as part of this program.
FURTHER_PEOPLE_FILE = '<plane-further-people-file>'
# The administrator of the platform is akadmin, the account of Authentik's own bootstrap that its out-of-box flow
# gives an address, so Plane's administrator is invited by that address. The API token is the one the deployment
# keeps for the books cluster's Authentik.
AUTHENTIK = 'https://idp.<books-fqdn>'
AUTHENTIK_TOKEN_FILE = '<authentik-token-file>'
# Forgejo creates an account at its first sign-in with its global defaults, which the accounts of the
# platform's own people share, so these two are limited afterwards, one by one.
LIMITS = {'max_repo_creation': 0, 'allow_create_organization': False}

# Plane's Gitea sign-in through our Forgejo, and every other way into Plane off; the instance
# administrator's /god-mode sign-in reads none of these and stays.
SIGN_IN_OFF = {'ENABLE_SIGNUP': '0', 'ENABLE_EMAIL_PASSWORD': '0', 'ENABLE_MAGIC_LINK_LOGIN': '0'}
SECRET = 'GITEA_CLIENT_SECRET'
KEYS = sorted(list(SIGN_IN_OFF) + ['IS_GITEA_ENABLED', 'GITEA_HOST', 'GITEA_CLIENT_ID', SECRET])
PLANE_SETTINGS = r'''
import hashlib
from plane.license.models import InstanceConfiguration
from plane.license.utils.encryption import decrypt_data


def plain(row):
    return decrypt_data(row.value) if row.is_encrypted else (row.value or '')


def stored():
    # The client secret leaves the pod only as its SHA-256.
    return {row.key: hashlib.sha256(plain(row).encode()).hexdigest() if row.key == 'GITEA_CLIENT_SECRET' else plain(row)
            for row in InstanceConfiguration.objects.filter(key__in=ARGUMENTS['keys'])}
'''
PLANE_READ = '# plane sign-in read' + PLANE_SETTINGS + r'''
answer(stored())
'''
# Writes each setting whose stored value differs, the secret from stdin through Plane's own
# encryption, and drops Plane's cached instance answer as Plane's own settings write does
# (plane/license/api/views/configuration.py).
PLANE_WRITE = '# plane sign-in write' + PLANE_SETTINGS + r'''
import sys
from django.core.cache import cache
from django.db import transaction
from plane.license.utils.encryption import encrypt_data

wanted = dict(ARGUMENTS['settings'], GITEA_CLIENT_SECRET=sys.stdin.read())
with transaction.atomic():
    rows = {row.key: row for row in InstanceConfiguration.objects.select_for_update().filter(key__in=list(wanted))}
    if sorted(rows) != sorted(wanted) or not rows['GITEA_CLIENT_SECRET'].is_encrypted:
        raise RuntimeError('Plane holds not every sign-in setting, or keeps its client secret unencrypted')
    changed = [row for row in rows.values() if plain(row) != wanted[row.key]]
    for row in changed:
        row.value = encrypt_data(wanted[row.key]) if row.is_encrypted else wanted[row.key]
        if not row.value:
            raise RuntimeError('Plane could not encrypt a sign-in setting')
    InstanceConfiguration.objects.bulk_update(changed, ['value'])
if changed:
    cache.delete('/api/instances/')
    cache.delete('/api/instances/configurations/')
answer(stored())
'''
# Plane makes a membership of an invitation for the address at the sign-in, but only of one that is
# accepted (plane/bgtasks/workspace_project_join.py process_workspace_project_invitations). A person who is
# a member already keeps the role Plane holds for them.
PLANE_ADMISSION = r'''
from plane.db.models import Workspace, WorkspaceMember, WorkspaceMemberInvite


def admitted(workspace, person):
    member = WorkspaceMember.objects.filter(workspace=workspace, member__email=person['email'], is_active=True).exists()
    invited = WorkspaceMemberInvite.objects.filter(workspace=workspace, email=person['email'], accepted=True, role=person['role']).exists()
    return member or invited


def admission():
    workspace = Workspace.objects.filter(slug=ARGUMENTS['workspace']).first()
    if workspace is None:
        return {'workspace': False, 'admitted': False}
    return {'workspace': True, 'admitted': all([admitted(workspace, person) for person in ARGUMENTS['people']])}
'''
PLANE_ADMISSION_READ = '# plane sign-in admission read' + PLANE_ADMISSION + r'''
answer(admission())
'''
# Invites each person in their role unless they are a member or have an accepted invitation, and corrects
# an invitation of the address that is not accepted or has another role. The token is random and leaves
# the pod nowhere: it would join its holder to the workspace.
PLANE_ADMISSION_WRITE = '# plane sign-in admission write' + PLANE_ADMISSION + r'''
import secrets
from django.db import transaction

with transaction.atomic():
    if admission()['workspace']:
        workspace = Workspace.objects.get(slug=ARGUMENTS['workspace'])
        for person in ARGUMENTS['people']:
            if admitted(workspace, person):
                continue
            invite = WorkspaceMemberInvite.objects.filter(workspace=workspace, email=person['email']).first()
            if invite is None:
                WorkspaceMemberInvite.objects.create(workspace=workspace, email=person['email'], accepted=True,
                                                     role=person['role'], token=secrets.token_urlsafe(32))
            else:
                invite.accepted, invite.role = True, person['role']
                invite.save(update_fields=['accepted', 'role'])
answer(admission())
'''
HOST = re.compile(r'[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+')
# The characters RFC 5322 allows in the local part of an address without quoting.
LOCAL = re.compile(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+", re.IGNORECASE)


def is_address(text):
    local, at, domain = text.partition('@')
    return at == '@' and LOCAL.fullmatch(local) is not None and HOST.fullmatch(domain.lower()) is not None


def ingress_host(namespace, name=None):
    """The one host of the one Ingress of a namespace, or of the Ingress it names."""
    listed = access.object_json(access.kube(['get', 'ingress'] + ([name] if name else []) + ['-o', 'json'],
                                            namespace=namespace, what='the Ingress of namespace ' + namespace),
                                'the Ingress of namespace ' + namespace)
    try:
        item, = [listed] if name else listed['items']
        host, = {rule['host'] for rule in item['spec']['rules']}
    except (KeyError, TypeError, ValueError):
        host = None
    if not isinstance(host, str) or not HOST.fullmatch(host):
        refuse('namespace ' + namespace + ' holds no single Ingress with one host; Plane sign-in was not changed')
    return host


def probe(client_id, secret, redirect):
    """Forgejo's answer to an authorization code it never issued. In this order it answers an unknown
    client, a wrong secret of a confidential client, a redirect URI it does not hold, and then the
    unknown code; every step only reads (routers/web/auth/oauth.go handleAuthorizationCode)."""
    form = urllib.parse.urlencode({'grant_type': 'authorization_code', 'client_id': client_id,
                                   'client_secret': secret, 'redirect_uri': redirect,
                                   'code': secrets.token_hex(16)}).encode()
    status, raw = access.request('POST', '/login/oauth/access_token',
                                 {'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'}, form)
    try:
        answer = json.loads(raw)
        error, description = answer['error'], answer['error_description']
    except (ValueError, TypeError, KeyError):
        error = description = None
    if status != 400 or not isinstance(error, str) or not isinstance(description, str):
        refuse('Forgejo answered the client probe with HTTP ' + str(status) + '; body withheld')
    return error, description


def confidential(client_id, secret, redirect):
    """Whether Forgejo holds a confidential application with this id, this secret and this redirect
    URI. Probe 1 cannot tell a right secret from a client that takes none; probe 2 can."""
    first = probe(client_id, secret, redirect)
    if first == ('unauthorized_client', 'client is not authorized'):
        second = probe(client_id, secrets.token_urlsafe(32), redirect)
        if second == ('unauthorized_client', 'invalid client secret'):
            return True
        if second == first:
            return False
        refuse('Forgejo answered the second client probe unexpectedly; Plane sign-in was not changed')
    if first in (('unauthorized_client', 'invalid client secret'), ('unauthorized_client', 'unexpected redirect URI')) or \
            (first[0] == 'invalid_client' and first[1].startswith('cannot load client with client id')):
        return False
    refuse('Forgejo answered the client probe unexpectedly; Plane sign-in was not changed')


def holds(stored, wanted, secret):
    return (all(stored.get(key) == value for key, value in wanted.items()) and
            stored.get(SECRET) == hashlib.sha256(secret.encode()).hexdigest())


def application(auth, redirect, held):
    """The client id and secret of user plane's one application, kept where Forgejo shows it as the
    held one, created where none exists, and otherwise set and its secret regenerated by one PATCH."""
    listed = list(access.pages('/user/applications/oauth2', auth, sudo=USER))
    if len(listed) > 1 or any(not isinstance(a, dict) or a.get('name') != APPLICATION for a in listed):
        refuse('Forgejo user plane holds an OAuth2 application beside one named plane; Plane sign-in was not changed')
    body = {'name': APPLICATION, 'redirect_uris': [redirect], 'confidential_client': True}
    if not listed:
        _, raw = access.api('POST', '/user/applications/oauth2', auth, (201,), body, sudo=USER)
    elif held is not None and listed[0].get('client_id') == held['client-id'] and \
            listed[0].get('redirect_uris') == [redirect] and listed[0].get('confidential_client') is True and \
            confidential(held['client-id'], held['client-secret'], redirect):
        return held['client-id'], held['client-secret'], False
    else:
        if not access.is_identifier(listed[0].get('id')):
            refuse('Forgejo listed the OAuth2 application plane without its id')
        _, raw = access.api('PATCH', '/user/applications/oauth2/' + str(listed[0]['id']), auth, (200,), body, sudo=USER)
    made = access.object_json(raw, 'Forgejo OAuth2 application')
    client_id, secret = made.get('client_id'), made.get('client_secret')
    if not isinstance(client_id, str) or not client_id or not isinstance(secret, str) or not secret:
        refuse('Forgejo returned the OAuth2 application plane without its client id or secret')
    return client_id, secret, True


def limit(auth, accounts):
    """No repositories and no organizations for the Forgejo accounts of the test addresses. These two
    fields of the API's PATCH stand alone, so it changes nothing else of an account."""
    for name in accounts:
        access.api('PATCH', '/admin/users/' + urllib.parse.quote(name, safe=''), auth, (200,), LIMITS)


def limited_user_ids(held):
    """The Forgejo ids of the accounts whose limits an apply has set, as the held entry names them, or None
    where there is no entry or its record is no list of ids."""
    if held is None:
        return None
    try:
        ids = json.loads(held['limited-user-ids'])
    except ValueError:
        return None
    return ids if isinstance(ids, list) and all(type(i) is int for i in ids) else None


def further_people():
    """The people the installation names beside its administrator, as {address: role}."""
    try:
        with open(FURTHER_PEOPLE_FILE) as handle:
            lines = handle.read().splitlines()
    except (OSError, ValueError):
        refuse('the further people of Plane could not be read; Plane sign-in was not changed')
    named = {}
    for line in lines:
        fields = line.split()
        if not fields:
            continue
        if len(fields) != 2 or not is_address(fields[0]) or fields[1].lower() not in ROLES:
            refuse('a further person of Plane is not written as an address and a role, admin, member or guest; Plane sign-in was not changed')
        address = fields[0].lower()
        if address in named:
            refuse('a further person of Plane is named twice; Plane sign-in was not changed')
        named[address] = ROLES[fields[1].lower()]
    return named


def find_administrator():
    """The address of akadmin as (address, None), or (None, why) where Authentik has none to invite yet. Nothing
    is refused here: a provider that is still starting, or whose out-of-box flow nobody has walked, stops no
    installation, and the next run asks again."""
    try:
        with open(AUTHENTIK_TOKEN_FILE) as handle:
            token = handle.read().strip()
    except (OSError, ValueError):
        token = ''
    if not token:
        return None, 'the API token of the identity provider is not in its file yet'
    request = urllib.request.Request(AUTHENTIK + '/api/v3/core/users/?username=akadmin',
                                     headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json'})
    try:
        with access.HTTP.open(request, timeout=access.timeout(10)) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        return None, 'the identity provider answered HTTP ' + str(error.code)
    except (OSError, ValueError):
        return None, 'the identity provider could not be reached'
    try:
        account, = [found for found in json.loads(raw)['results'] if found['username'] == 'akadmin']
        active, email = account['is_active'], account['email']
    except (KeyError, TypeError, ValueError):
        return None, 'the identity provider holds no readable akadmin'
    if active is not True:
        return None, 'akadmin is not active'
    # Until the out-of-box flow sets it, akadmin has no address of a person: none, or root@localhost.
    if not isinstance(email, str) or not is_address(email):
        return None, 'akadmin has no address yet'
    return email.lower(), None


def workspace_people(administrator, named):
    """Whom Plane admits to the workspace, as [{email, role}]: the test account as a Member, the administrator of
    the identity provider as an Admin where it has an address, and the further people in their role. Plane compares
    the address lower case, so it is written lower case here."""
    wanted = {INVITED.lower(): ROLES['member']}
    if administrator is not None:
        if administrator in [address.lower() for address in TEST_EMAILS]:
            refuse('the administrator of the identity provider has the address of a Plane test account; Plane sign-in was not changed')
        wanted[administrator] = ROLES['admin']
    for address, role in named.items():
        if address in wanted or address == UNINVITED.lower():
            refuse('a further person of Plane is the test account, the administrator or a test address; Plane sign-in was not changed')
        wanted[address] = role
    return [{'email': address, 'role': role} for address, role in wanted.items()]


def exchange():
    named = further_people()
    try:
        incoming = json.load(sys.stdin)
    except (ValueError, TypeError):
        refuse('the Plane sign-in exchange input is unreadable')
    if not isinstance(incoming, dict) or not isinstance(incoming.get('inputs'), dict):
        refuse('the Plane sign-in exchange input is not an object')
    entry = incoming.get('entry') or {}
    if not isinstance(entry, dict):
        refuse('the held Plane sign-in entry is unreadable')
    held = entry if sorted(entry) == ['client-id', 'client-secret', 'limited-user-ids'] and all(
        isinstance(v, str) and v and not any(c in v for c in '\r\n') for v in entry.values()) else None
    limited = limited_user_ids(held)
    if limited is None:
        held = None
    gitea = 'https://' + ingress_host('forgejo')
    redirect = 'https://' + ingress_host('plane', 'plane-ingress') + '/auth/gitea/callback/'
    access.ready_pod()
    people = access.users()
    person = people.get(USER)
    if person is not None and (person['email'] != EMAIL or person['admin'] or not person['active']):
        refuse('the Forgejo user plane is not the active non-admin machine user ' + EMAIL + '; Plane sign-in was not changed')
    # Only an address of a test case is limited, and none of them may administer: a site administrator
    # of Forgejo is one at every sign-in of the identity provider's group `admins`, which these must not be in.
    tested = {name: account for name, account in people.items() if account['email'] in TEST_EMAILS}
    if any(account['admin'] for account in tested.values()):
        refuse('a Forgejo account of a Plane test address is a site administrator; Plane sign-in was not changed')
    workspace, _ = access.plane_targets()
    administrator, _ = find_administrator()
    admitting = {'workspace': workspace, 'people': workspace_people(administrator, named)}
    wanted = dict(SIGN_IN_OFF, IS_GITEA_ENABLED='1', GITEA_HOST=gitea)
    if not APPLY:
        # Blind to a second application of user plane and to a redirect URI registered beside ours:
        # listing them takes a Forgejo administrator, which only apply creates. Blind as well to the limits
        # themselves, which no listing of users shows: the held entry names the accounts whose limits an
        # apply has set, and an account of a test address it does not name, one that signed in since,
        # is a state apply changes. The engine runs this check again after the apply, so what apply
        # cannot change must never stand in it.
        return {'satisfied': held is not None and person is not None and BOOTSTRAP not in people and
                set(limited) >= {account['id'] for account in tested.values()} and
                confidential(held['client-id'], held['client-secret'], redirect) and
                holds(access.plane(PLANE_READ, {'keys': KEYS}),
                      dict(wanted, GITEA_CLIENT_ID=held['client-id']), held['client-secret']) and
                access.plane(PLANE_ADMISSION_READ, admitting)['admitted'] is True}
    # First, so that a workspace Plane does not have is refused before anything else is changed.
    invited = access.plane(PLANE_ADMISSION_WRITE, admitting)
    if invited.get('workspace') is not True:
        refuse('Plane has no workspace ' + workspace + '; create it in Plane, then redeploy')
    if invited.get('admitted') is not True:
        refuse('Plane did not keep the invitation of the test account or of a person of the installation')
    if BOOTSTRAP in people:
        access.remove_bootstrap()
    if person is None:
        access.cli(['create', '--username', USER, '--email', EMAIL,
                    '--restricted', '--random-password', '--must-change-password=false'])
    with access.administrator() as auth:
        limit(auth, tested)
        client_id, secret, made = application(auth, redirect, held)
    if made and not confidential(client_id, secret, redirect):
        refuse('Forgejo does not accept the client secret of the OAuth2 application plane it returned')
    wanted['GITEA_CLIENT_ID'] = client_id
    stored = access.plane(PLANE_WRITE, {'settings': wanted, 'keys': KEYS}, stdin=secret)
    if not holds(stored, wanted, secret):
        refuse('Plane did not keep its Gitea sign-in settings')
    return {'client-id': client_id, 'client-secret': secret,
            'limited-user-ids': json.dumps(sorted(account['id'] for account in tested.values()))}


if sys.argv[1:] == ['--administrator']:
    # The row after the producer asks this: the installer holds the producer's own streams as secret, so none of
    # their words reaches the run record, and this mode's do.
    address, why = find_administrator()
    if address is None:
        print('Plane has no administrator to invite yet: ' + why)
    else:
        print('administrator known')
    print('administrator state reported')
else:
    APPLY = access.start('Plane sign-in provisioning', '<forgejo-namespace>', '<forgejo-pod-selector>',
                         '<forgejo-container>', BOOTSTRAP)
    access.finish(exchange, LOCK)
PY
)" "$@"
