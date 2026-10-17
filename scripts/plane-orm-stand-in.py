# A stand-in for the part of Plane v1.4.2's Django ORM that the workspace admission snippets of
# plane-sign-in.sh.tpl use, so the test runs the snippets themselves instead of a copy of their logic.
# It is read from plane/db/models/workspace.py: the workspace has a slug; a membership and an invitation
# belong to a workspace; a membership has a member (a user with an email), a role and is_active; an
# invitation has an email, accepted, role and token, and at most one live invitation exists per email and
# workspace (the constraint workspace_member_invite_unique_email_workspace_when_deleted_at_null).
#
# Usage: python3 -I plane-orm-stand-in.py STATE_FILE < snippet. The state file is a JSON object of the
# tables workspaces, users, members and invites; the snippet's changes are written back to it when the
# snippet ends without an exception.
import json
import sys
import types

STATE = sys.argv[1]
TABLES = json.load(open(STATE))
REQUIRED = {'workspaces': ['slug'], 'users': ['email'], 'members': ['workspace_id', 'member_id', 'role'],
            'invites': ['workspace_id', 'email', 'accepted', 'role', 'token']}
FOREIGN = {'workspace': 'workspaces', 'member': 'users'}


class IntegrityError(Exception):
    pass


class Row:
    """A stored row, read and written through its attributes; a foreign key reads as the row it names."""

    def __init__(self, stored):
        object.__setattr__(self, '_stored', stored)

    def __getattr__(self, name):
        stored = self._stored
        if name in stored:
            return stored[name]
        if name in FOREIGN:
            return Row(next(r for r in TABLES[FOREIGN[name]] if r['id'] == stored[name + '_id']))
        raise AttributeError(name)

    def __setattr__(self, name, value):
        assert name in self._stored, 'a field the model does not have: ' + name
        self._stored[name] = value

    def save(self, update_fields):
        assert update_fields and all(name in self._stored for name in update_fields), 'a save names the fields it writes'


class QuerySet(list):
    def first(self):
        return self[0] if self else None

    def exists(self):
        return len(self) > 0


def matches(row, key, wanted):
    value = row
    for step in key.split('__'):
        value = getattr(value, step)
    return value._stored['id'] == wanted._stored['id'] if isinstance(wanted, Row) else value == wanted


class Manager:
    def __init__(self, table):
        self.table = table

    def filter(self, **conditions):
        return QuerySet(row for row in map(Row, TABLES[self.table])
                        if all(matches(row, key, wanted) for key, wanted in conditions.items()))

    def get(self, **conditions):
        found = self.filter(**conditions)
        if len(found) != 1:
            raise LookupError(self.table + ' matched ' + str(len(found)))
        return found[0]

    def create(self, **fields):
        stored = {(name + '_id' if isinstance(value, Row) else name): (value._stored['id'] if isinstance(value, Row) else value)
                  for name, value in fields.items()}
        assert all(name in stored for name in REQUIRED[self.table]), self.table + ' needs ' + ', '.join(REQUIRED[self.table])
        if self.table == 'invites' and any(
                r['email'] == stored['email'] and r['workspace_id'] == stored['workspace_id'] for r in TABLES['invites']):
            raise IntegrityError('workspace_member_invite_unique_email_workspace_when_deleted_at_null')
        stored['id'] = 1 + max((r['id'] for r in TABLES[self.table]), default=0)
        TABLES[self.table].append(stored)
        return Row(stored)


def model(name, table):
    return type(name, (), {'objects': Manager(table)})


class Atomic:
    def __enter__(self):
        return self

    def __exit__(self, *failure):
        return False


def module(name, **members):
    made = types.ModuleType(name)
    made.__dict__.update(members)
    sys.modules[name] = made


module('plane')
module('plane.db')
module('plane.db.models', Workspace=model('Workspace', 'workspaces'), WorkspaceMember=model('WorkspaceMember', 'members'),
       WorkspaceMemberInvite=model('WorkspaceMemberInvite', 'invites'))
module('django')
module('django.db', transaction=types.SimpleNamespace(atomic=Atomic))

exec(compile(sys.stdin.read(), 'snippet', 'exec'), {'__name__': '__main__'})
json.dump(TABLES, open(STATE, 'w'))
