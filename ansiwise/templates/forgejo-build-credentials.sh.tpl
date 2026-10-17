#!/usr/bin/env bash
# The installer captures both streams as secret output; only this process holds issued values.
set -euo pipefail
exec python3 -I -B -c "$(cat <<'PY'
import hashlib
import importlib.util
import json
import re
import sys
import urllib.parse
import uuid

try:
    spec = importlib.util.spec_from_file_location('forgejo_plane_access', '<forgejo-plane-access-module>')
    access = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(access)
except Exception:
    sys.exit('the Forgejo and Plane access module could not be loaded')
refuse = access.refuse

USER = '<forgejo-user>'
TOKEN_NAME = '<forgejo-token-name>'
BOOTSTRAP = '<forgejo-bootstrap-user>'
# The engine drops the slot's line where the row names no repository, and forgejo-build then may
# write to none.
REPOSITORIES = []
REPOSITORIES = '<forgejo-repositories?>'.split(',')
LOCK = '<forgejo-credential-lock>'
# write:repository sets statuses and creates releases; read:user lets the token show its own account,
# its own scopes and its rights (GET /user, /users/forgejo-build/tokens, /user/repos), so a check
# needs no administrator and stays read-only.
SCOPES = 'write:repository,read:user'
# The Plane key the Task plane-update-status spends belongs to a Plane bot of the same name, which
# signs in nowhere, and carries the Task's name as its label.
PLANE_EMAIL = USER + '@hostyour.invalid'
PLANE_LABEL = 'plane-update-status'
# Plane's role Member: the least that lets the Task write work items, modules and states.
MEMBER = 15
APPLY = access.start('Forgejo credential provisioning', '<forgejo-namespace>', '<forgejo-pod-selector>',
                     '<forgejo-container>', BOOTSTRAP)

# What the read and the write exec in Plane's API pod both know of forgejo-build. No key leaves the
# pod in a read: a key is judged by its SHA-256 under the test Plane's API middleware applies.
PLANE_STATE = r'''
import hashlib
from django.db.models import Q
from django.utils import timezone
from plane.db.models import APIToken, Project, ProjectMember, User, Workspace, WorkspaceMember
from plane.license.models import InstanceAdmin


def accepted(tokens):
    # The test of plane/api/middleware/api_authentication.py, without the last_used it writes.
    return tokens.filter(Q(expired_at__gt=timezone.now()) | Q(expired_at__isnull=True),
                         is_active=True, user__is_active=True)


def role(member):
    return None if member is None else {'role': member.role, 'is_active': member.is_active}


def instance_admin(user):
    return user.is_superuser or InstanceAdmin.objects.filter(user=user).exists()


def seen():
    workspace = Workspace.objects.filter(slug=ARGUMENTS['workspace']).first()
    projects = [] if workspace is None else [
        str(p.id) for p in Project.objects.filter(workspace=workspace, id__in=ARGUMENTS['projects'])]
    user = User.objects.filter(email=ARGUMENTS['email']).first()
    if user is None:
        return {'workspace': workspace is not None, 'projects': projects, 'user': None}
    labeled = APIToken.objects.filter(user=user, label=ARGUMENTS['label'])
    return {'workspace': workspace is not None, 'projects': projects, 'user': {
        'is_bot': user.is_bot, 'is_active': user.is_active, 'instance_admin': instance_admin(user),
        'workspace': None if workspace is None else
            role(WorkspaceMember.objects.filter(workspace=workspace, member=user).first()),
        'projects': {p: role(ProjectMember.objects.filter(project_id=p, member=user).first()) for p in projects},
        'labeled': labeled.count(),
        'accepted': [hashlib.sha256(t.token.encode()).hexdigest() for t in accepted(labeled)]}}
'''
PLANE_READ = '# forgejo-build read' + PLANE_STATE + r'''
answer(seen())
'''
# Makes forgejo-build a Member of the workspace and of each project, and issues its key or keeps the
# one it holds, as the producer decided. It commits first, then calls Plane's API with the key.
PLANE_WRITE = '# forgejo-build write' + PLANE_STATE + r'''
import os
import urllib.error
import urllib.request
import uuid
from django.db import transaction
from plane.db.models import Profile, ProjectUserProperty


def member(model, user, **where):
    held = model.objects.filter(member=user, **where).first()
    if held is None:
        return model.objects.create(member=user, role=15, **where)
    if held.role > 15:
        raise RuntimeError('forgejo-build holds a role above Member')
    if held.role != 15 or not held.is_active:
        held.role, held.is_active = 15, True
        held.save()
    return held


with transaction.atomic():
    workspace = Workspace.objects.get(slug=ARGUMENTS['workspace'])
    projects = list(Project.objects.filter(workspace=workspace, id__in=ARGUMENTS['projects']))
    if len(projects) != len(ARGUMENTS['projects']):
        raise RuntimeError('a target project is missing')
    user = User.objects.filter(email=ARGUMENTS['email']).first()
    if user is None:
        # As Plane's sign-up creates a user and its Profile (plane/authentication/adapter/base.py),
        # as a bot without a usable password.
        user = User(email=ARGUMENTS['email'], username=uuid.uuid4().hex, is_bot=True, is_password_autoset=True)
        user.set_unusable_password()
        user.save()
        Profile.objects.create(user=user)
    elif not user.is_bot or not user.is_active or instance_admin(user):
        raise RuntimeError('forgejo-build is not an active bot without instance administration')
    member(WorkspaceMember, user, workspace=workspace)
    for project in projects:
        member(ProjectMember, user, project=project)
        # As plane/db/management/commands/create_project_member.py completes a project member.
        ProjectUserProperty.objects.get_or_create(user=user, project=project)
    labeled = APIToken.objects.filter(user=user, label=ARGUMENTS['label'])
    if ARGUMENTS['issue']:
        if labeled.exists():
            raise RuntimeError('forgejo-build already holds a labeled key')
        # As Plane's own token view issues a key (plane/app/views/api.py), of a bot.
        token = APIToken.objects.create(label=ARGUMENTS['label'], description='', user=user, user_type=1,
                                        expired_at=None)
    elif labeled.count() == 1:
        token = accepted(labeled).get()
    else:
        raise RuntimeError('forgejo-build holds no single labeled key to keep')
# Leaving the block committed its rows. Gunicorn answers these calls on its own database connection,
# which sees no uncommitted row, so a call inside the block would find no key.
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
statuses = {}
for project in projects:
    url = ('http://127.0.0.1:' + os.environ.get('PORT', '8000') + '/api/v1/workspaces/' + workspace.slug +
           '/projects/' + str(project.id) + '/issues/')
    try:
        with opener.open(urllib.request.Request(url, headers={'X-Api-Key': token.token}), timeout=5) as response:
            statuses[str(project.id)] = response.status
    except urllib.error.HTTPError as error:
        statuses[str(project.id)] = error.code
    except OSError:
        statuses[str(project.id)] = None
if all(status == 200 for status in statuses.values()):
    answer({'statuses': statuses, 'key': token.token})
else:
    answer({'statuses': statuses})
'''


def plane_targets():
    """The workspace and the project ids the Task plane-update-status writes to, as the deployed
    Pipeline names them, so the producer holds no second copy."""
    pipeline = access.object_json(access.kube(['get', 'pipelines.tekton.dev', 'forgejo-release', '-o', 'json'],
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


def plane_kept(seen, workspace, projects, held):
    """Refuses, before any write, a Plane state the producer must not change; answers whether the
    held key is the one labeled key of forgejo-build and every role is an active Member."""
    try:
        if seen['workspace'] is not True:
            refuse('Plane has no workspace ' + workspace + '; create it in Plane, then redeploy')
        for project in projects:
            if project not in seen['projects']:
                refuse('Plane has no project ' + project + ' in workspace ' + workspace +
                       '; create it in Plane, then redeploy')
        user = seen['user']
        if user is None:
            return False
        if user['is_bot'] is not True or user['is_active'] is not True or user['instance_admin'] is not False:
            refuse('the Plane user ' + PLANE_EMAIL + ' is not an active bot without instance administration; '
                   'Plane was not changed')
        roles = {'workspace ' + workspace: user['workspace']}
        roles.update({'project ' + p: user['projects'][p] for p in projects})
        for place, held_role in roles.items():
            if held_role is not None and held_role['role'] > MEMBER:
                refuse('forgejo-build holds a Plane role above Member in ' + place + '; Plane was not changed')
        if user['labeled'] > 1:
            refuse('Plane holds more than one key of forgejo-build labeled ' + PLANE_LABEL + '; Plane was not changed')
        if user['labeled'] == 1 and len(user['accepted']) != 1:
            refuse('the key of forgejo-build labeled ' + PLANE_LABEL + ' is inactive or expired; Plane was not changed')
        return (all(r is not None and r['role'] == MEMBER and r['is_active'] is True for r in roles.values()) and
                len(user['accepted']) == 1 and isinstance(held, str) and
                hashlib.sha256(held.encode()).hexdigest() == user['accepted'][0])
    except (KeyError, TypeError, AttributeError):
        refuse('the Plane pod answer could not be read; output withheld')


def plane_key(arguments, seen):
    """The key the write exec issued or kept, which Plane's API accepted for every target project."""
    answer = access.plane(PLANE_WRITE, dict(arguments, issue=seen['user'] is None or seen['user']['labeled'] == 0))
    statuses = answer.get('statuses')
    if not isinstance(statuses, dict) or sorted(statuses) != sorted(arguments['projects']):
        refuse('the Plane pod answer could not be read; output withheld')
    for project in arguments['projects']:
        if statuses[project] != 200:
            refuse('Plane refused the key of forgejo-build for project ' + project + ': ' +
                   ('HTTP ' + str(statuses[project]) if statuses[project] is not None else 'no answer') +
                   '; the user, the memberships and the key stay in Plane')
    key = answer.get('key')
    if not isinstance(key, str) or not key:
        refuse('the Plane pod answer could not be read; output withheld')
    return key


def inspect(token):
    """'valid', 'ungranted' (a valid token whose user lacks a build repository's write grant) or
    'invalid'."""
    pushed = access.inspect_token(USER, TOKEN_NAME, SCOPES.split(','), token, REPOSITORIES)
    if pushed is None:
        return 'invalid'
    return 'valid' if pushed == set(REPOSITORIES) else 'ungranted'


def provision(token):
    with access.administrator() as auth:
        for repo in REPOSITORIES:
            access.grant(auth, repo, USER, 'write')
        if inspect(token) == 'valid':
            return token
        # The administrator's listing decides what Forgejo issued: a held token it lists as issued
        # here failed for a reason a new token cannot fix, so it is kept and the run stops.
        listed = list(access.pages('/users/' + USER + '/tokens', auth))
        if isinstance(token, str) and len(token) >= 8 and access.issued_here(listed, TOKEN_NAME, token, SCOPES.split(',')):
            refuse('Forgejo lists the held credential as issued, yet it did not validate; no token was minted')
        # Forgejo 15 has no token-delete CLI. Its self/admin Basic-auth endpoint removes a
        # confirmed lost or invalid same-name token before the CLI can issue the replacement.
        if any(isinstance(held, dict) and held.get('name') == TOKEN_NAME for held in listed):
            access.api('DELETE', '/users/' + USER + '/tokens/' + urllib.parse.quote(TOKEN_NAME, safe=''), auth, (204,))
        issued = access.cli(['generate-access-token', '--username', USER, '--token-name', TOKEN_NAME,
                             '--scopes', SCOPES, '--raw']).strip()
        if inspect(issued) != 'valid':
            refuse('the issued Forgejo credential did not validate')
        return issued


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
    workspace, projects = plane_targets()
    arguments = {'workspace': workspace, 'projects': projects, 'email': PLANE_EMAIL, 'label': PLANE_LABEL}
    seen = access.plane(PLANE_READ, arguments)
    held_key = entry.get('plane-api-token')
    kept = plane_kept(seen, workspace, projects, held_key)
    access.ready_pod()
    people = access.users()
    person = people.get(USER)
    if person is not None and (person['admin'] or not person['active']):
        refuse('forgejo-build must be an active non-admin user')
    token = entry.get('forgejo-api-token') if entry.get('forgejo-user') == USER else None
    state = inspect(token) if person is not None else 'invalid'
    if not APPLY:
        return {'satisfied': kept and state == 'valid' and BOOTSTRAP not in people and
                entry == {'forgejo-user': USER, 'forgejo-api-token': token, 'plane-api-token': held_key}}
    # Plane first: it keeps an issued key in clear, so a later refusal in Forgejo loses nothing there.
    key = held_key if kept else plane_key(arguments, seen)
    if BOOTSTRAP in people:
        access.remove_bootstrap()
    if person is None:
        access.cli(['create', '--username', USER, '--email', USER + '@hostyour.invalid',
                    '--restricted', '--random-password', '--must-change-password=false'])
    if state != 'valid':
        token = provision(token)
    return {'forgejo-user': USER, 'forgejo-api-token': token, 'plane-api-token': key}


access.finish(exchange, LOCK)
PY
)" "$@"
