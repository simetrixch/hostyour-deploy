# hostyour-deploy

The programs that put a hostyour-cloud installation on a machine. Read by
`ansiwise` and by nothing else: they bring up the host, the cluster, the platform services, a
slave's management plane, the private network, and the version stamps that tie the four together.

They are DECLARATIONS, not scripts. A row names a step, the step is implemented in the plugin
packages, and the engine that walks the rows is the ansiwise binary. What the rows deploy — the
charts, the ApplicationSets, the bootstrap manifests — lives in the platform repository, and every
`repository:` row here names that checkout on the machine.

## Always master, never a branch

The platform repository is BRANCHED PER INSTALLATION. This one never is, and that is why it stands
apart: a machine reads its cluster content from its own installation branch, deliberately frozen,
and its programs from the tip of `master` here, always current. A fix to a program reaches every
installation the moment it is pushed.

There is no version here, no tag and no release. The engine that reads these files IS pinned — the
version stands in the platform repository's `clusters/platform/versions.yaml` and is stamped into
`ansiwise/programs/deploy-cluster.yaml` by the release that builds the binary.

## Public, and read without a credential

A machine clones this repository to `/srv/ansiwise-programs` and stands it on `master` before every
run. Nothing here is secret: the programs name secrets, and a machine reads the VALUES out of its
own settings files, never out of this tree.

## Reading one

```
ansiwise/programs/          one file per program
ansiwise/templates/         what a program renders and writes onto a machine
ansiwise/boot-programs/     what runs before the platform is up — unsealing the secret store
ansiwise.yaml               which plugins the engine loads for the programs
ansiwise-boot.yaml          the same, for the boot programs
```

Every program is run three times against a machine — `test`, then `dry`, then `run` — and each row
reports one of proven, declared, skipped or ok. A row that cannot answer says so in a full sentence
naming what it could not read, rather than failing on it.

## Checks

`bash scripts/check.sh` (or `pwsh scripts/check.ps1`) parses the program YAML locally.
It names the registry binding suite as not run locally.

GitHub Actions runs those checks and `bash scripts/test.sh` on every push and pull request.
The test entry point runs `dart test test/checks/config_validity_test.dart` in the pinned
sibling `ansiwise-cli` checkout, with `ANSIWISE_INSTALLATION` set to this tree. A skipped
suite fails. `pwsh scripts/test.ps1` starts the same entry point. Run tests only on a remote runner.

## Machine-move preparation

```bash
bash scripts/move-machine.sh --cloud-dir /path/to/hostyour-cloud --books-fqdn master.old.example --from-domain old.example --to-domain new.example --fqdn apps1.old.example --ssh-user operator --dry-run
```

The PowerShell twin `pwsh scripts/move-machine.ps1` takes the identical flags.
Node, git, yq and ssh are required. The shared Cloud checkout must contain `plan-installation-domain.mjs`.

Dry run inventories cluster maps and selected machine routes, probes old/new SSH with old-name existing trust, prints deterministic JSON and changes no remote state/current config. Exit 0 means report produced; `cutoverReady` remains false.

Only `--dry-run` is available. Execution and rollback must use the reviewed Manager installation migration; existing slave rename rejects master and deletes old DNS. This repository continues to publish at master, without a version or tag.

## Licence

Elastic License 2.0, the same as every other `hostyour-*` repository. See `LICENSE`.

## Refresh tenant stage access

`refresh-tenant-stage-access` runs on the master against an existing active cluster map. Supply
`fqdn` and its installation `stage` as answers. It uses the same Vault steps and exact tenant
policies and role bindings as platform provisioning; it changes only those policies and roles.
It requires the auth mount and its reviewer configuration to stand already. It never seeds secret
values, updates an auth mount, deploys a service, or changes a cluster registration.

Start with `--mode dry`, inspect the native run record, then use `--mode run`. Give the existing
programs/config paths and pass the answer envelope through `--answers -`. This program uses no
root command, so `--without-elevation-password` states that no elevation password is supplied.
The existing Vault credential stays in the platform checkout and never enters the answer envelope.
