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
import urllib.parse

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
APPLY = access.start('Plane sign-in provisioning', '<forgejo-namespace>', '<forgejo-pod-selector>',
                     '<forgejo-container>', BOOTSTRAP)

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
HOST = re.compile(r'[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+')


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
        refuse('Forgejo answered the client probe with ' + second[0] + '; Plane sign-in was not changed')
    if first in (('unauthorized_client', 'invalid client secret'), ('unauthorized_client', 'unexpected redirect URI')) or \
            (first[0] == 'invalid_client' and first[1].startswith('cannot load client with client id')):
        return False
    refuse('Forgejo answered the client probe with ' + first[0] + '; Plane sign-in was not changed')


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
        if not isinstance(listed[0].get('id'), int):
            refuse('Forgejo listed the OAuth2 application plane without its id')
        _, raw = access.api('PATCH', '/user/applications/oauth2/' + str(listed[0]['id']), auth, (200,), body, sudo=USER)
    made = access.object_json(raw, 'Forgejo OAuth2 application')
    client_id, secret = made.get('client_id'), made.get('client_secret')
    if not isinstance(client_id, str) or not client_id or not isinstance(secret, str) or not secret:
        refuse('Forgejo returned the OAuth2 application plane without its client id or secret')
    return client_id, secret, True


def exchange():
    try:
        incoming = json.load(sys.stdin)
    except (ValueError, TypeError):
        refuse('the Plane sign-in exchange input is unreadable')
    if not isinstance(incoming, dict) or not isinstance(incoming.get('inputs'), dict):
        refuse('the Plane sign-in exchange input is not an object')
    entry = incoming.get('entry') or {}
    if not isinstance(entry, dict):
        refuse('the held Plane sign-in entry is unreadable')
    held = entry if sorted(entry) == ['client-id', 'client-secret'] and all(
        isinstance(v, str) and v and not any(c in v for c in '\r\n') for v in entry.values()) else None
    gitea = 'https://' + ingress_host('forgejo')
    redirect = 'https://' + ingress_host('plane', 'plane-ingress') + '/auth/gitea/callback/'
    access.ready_pod()
    people = access.users()
    person = people.get(USER)
    if person is not None and (person['email'] != EMAIL or person['admin'] or not person['active']):
        refuse('the Forgejo user plane is not the active non-admin machine user ' + EMAIL + '; Plane sign-in was not changed')
    wanted = dict(SIGN_IN_OFF, IS_GITEA_ENABLED='1', GITEA_HOST=gitea)
    if not APPLY:
        # Blind to a second application of user plane and to a redirect URI registered beside ours:
        # listing them takes a Forgejo administrator, which only apply creates.
        return {'satisfied': held is not None and person is not None and BOOTSTRAP not in people and
                confidential(held['client-id'], held['client-secret'], redirect) and
                holds(access.plane(PLANE_READ, {'keys': KEYS}),
                      dict(wanted, GITEA_CLIENT_ID=held['client-id']), held['client-secret'])}
    if BOOTSTRAP in people:
        access.remove_bootstrap()
    if person is None:
        access.cli(['create', '--username', USER, '--email', EMAIL,
                    '--restricted', '--random-password', '--must-change-password=false'])
    with access.administrator() as auth:
        client_id, secret, made = application(auth, redirect, held)
    if made and not confidential(client_id, secret, redirect):
        refuse('Forgejo does not accept the client secret of the OAuth2 application plane it returned')
    wanted['GITEA_CLIENT_ID'] = client_id
    stored = access.plane(PLANE_WRITE, {'settings': wanted, 'keys': KEYS}, stdin=secret)
    if not holds(stored, wanted, secret):
        refuse('Plane did not keep its Gitea sign-in settings')
    return {'client-id': client_id, 'client-secret': secret}


access.finish(exchange, LOCK)
PY
)" "$@"
