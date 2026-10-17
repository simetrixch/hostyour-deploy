#!/usr/bin/env bash
# The installer captures both streams as secret output; only this process holds issued values.
set -euo pipefail
exec python3 -I -B -c "$(cat <<'PY'
import json
import sys
import urllib.parse
import importlib.util

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
LOCK = '<forgejo-credential-lock>'
# The entry's fields: the token's, and the user name's where a reader wants both.
TOKEN_FIELD = '<forgejo-token-field>'
USER_FIELD = ''
USER_FIELD = '<forgejo-user-field?>'
# What the user may do: 'write' on the one repository, or 'read' on every repository of the
# organisations. The engine drops the line of a slot the row does not name.
PERMISSION = '<forgejo-permission>'
REPOSITORY = ''
REPOSITORY = '<forgejo-repository?>'
ORGANISATIONS = ''
ORGANISATIONS = '<forgejo-organisations?>'
SCOPES = PERMISSION + ':repository,read:user'
# Forgejo's team for a read-only reader of every repository of an organisation, the one way a
# restricted user sees repositories that do not exist yet.
TEAM = 'machine-readers'
APPLY = access.start('Forgejo machine user provisioning', '<forgejo-namespace>', '<forgejo-pod-selector>',
                     '<forgejo-container>', BOOTSTRAP)


def reach():
    """The repository a write user writes, and the organisations a read user reads; refuses a row
    whose answers are empty or whose slots do not fit its permission."""
    organisations = [o for o in ORGANISATIONS.split(',') if o]
    if PERMISSION == 'write' and REPOSITORY.count('/') == 1 and '' not in REPOSITORY.split('/') and not organisations:
        return REPOSITORY, []
    if PERMISSION == 'read' and not REPOSITORY and organisations:
        return None, organisations
    refuse(USER + ' needs one owner/repository to write, or organisations to read; fill its answers')


def team_of(auth, organisation):
    for team in access.pages('/orgs/' + organisation + '/teams', auth):
        if team.get('name') == TEAM:
            return team
    return None


def grant_reading(auth, organisation):
    """Makes the user a member of the organisation's read-only team over all its repositories."""
    team = team_of(auth, organisation)
    if team is None:
        access.api('POST', '/orgs/' + organisation + '/teams', auth, (201,), {
            'name': TEAM, 'description': 'Machine users that read every repository', 'permission': 'read',
            'includes_all_repositories': True, 'can_create_org_repo': False, 'units': ['repo.code']})
        team = team_of(auth, organisation)
    if team is None or team.get('permission') != 'read' or team.get('includes_all_repositories') is not True or \
            team.get('can_create_org_repo') is not False:
        refuse('the team ' + TEAM + ' of ' + organisation + ' is not a read-only team over all repositories')
    access.api('PUT', '/teams/' + str(team['id']) + '/members/' + USER, auth, (204,))


def inspect(token, repository):
    pushed = access.inspect_token(USER, TOKEN_NAME, SCOPES.split(','), token, {repository} if repository else set())
    if pushed is None:
        return 'invalid'
    return 'valid' if pushed == ({repository} if repository else set()) else 'ungranted'


def provision(token, repository, organisations):
    with access.administrator() as auth:
        if repository:
            access.grant(auth, repository, USER, 'write')
        for organisation in organisations:
            grant_reading(auth, organisation)
        if inspect(token, repository) == 'valid':
            return token
        # The administrator's listing decides what Forgejo issued: a held token it lists as issued
        # here failed for a reason a new token cannot fix, so it is kept and the run stops.
        listed = list(access.pages('/users/' + USER + '/tokens', auth))
        if isinstance(token, str) and len(token) >= 8 and access.issued_here(listed, TOKEN_NAME, token, SCOPES.split(',')):
            refuse('Forgejo lists the held credential as issued, yet it did not validate; no token was minted')
        if any(isinstance(held, dict) and held.get('name') == TOKEN_NAME for held in listed):
            access.api('DELETE', '/users/' + USER + '/tokens/' + urllib.parse.quote(TOKEN_NAME, safe=''), auth, (204,))
        issued = access.cli(['generate-access-token', '--username', USER, '--token-name', TOKEN_NAME,
                             '--scopes', SCOPES, '--raw']).strip()
        if inspect(issued, repository) != 'valid':
            refuse('the issued Forgejo credential did not validate')
        return issued


def fields(token):
    return {TOKEN_FIELD: token} if not USER_FIELD else {USER_FIELD: USER, TOKEN_FIELD: token}


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
    repository, organisations = reach()
    access.ready_pod()
    people = access.users()
    person = people.get(USER)
    if person is not None and (person['admin'] or not person['active']):
        refuse(USER + ' must be an active non-admin user')
    held = entry.get(TOKEN_FIELD) if not USER_FIELD or entry.get(USER_FIELD) == USER else None
    state = inspect(held, repository) if person is not None else 'invalid'
    if not APPLY:
        # A team is not visible to the user itself, so a check can say no more than the token's own view.
        return {'satisfied': state == 'valid' and BOOTSTRAP not in people and entry == fields(held)}
    if BOOTSTRAP in people:
        access.remove_bootstrap()
    if person is None:
        access.cli(['create', '--username', USER, '--email', USER + '@hostyour.invalid',
                    '--restricted', '--random-password', '--must-change-password=false'])
    # Every apply grants again: the grant is what a repository or an organisation created since the
    # last run needs, and Forgejo keeps an existing grant as it is.
    return fields(provision(held, repository, organisations))


access.finish(exchange, LOCK)
PY
)" "$@"
