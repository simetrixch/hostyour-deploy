# hostyour-deploy

The programs that put a hostyour-cloud installation on a machine. Eighteen of them, read by
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

A machine clones this repository to `/srv/ansiwise-catalog` and stands it on `master` before every
run. Nothing here is secret: the programs name secrets, and a machine reads the VALUES out of its
own settings files, never out of this tree.

## Reading one

```
ansiwise/programs/          the eighteen, one file per program
ansiwise/templates/         what a program renders and writes onto a machine
ansiwise/boot-programs/     what runs before the platform is up — unsealing the secret store
ansiwise.yaml               which plugins the engine loads for the programs
ansiwise-boot.yaml          the same, for the boot programs
```

Every program is run three times against a machine — `test`, then `dry`, then `run` — and each row
reports one of proven, declared, skipped or ok. A row that cannot answer says so in a full sentence
naming what it could not read, rather than failing on it.

## Licence

Elastic License 2.0, the same as every other `hostyour-*` repository. See `LICENSE`.
