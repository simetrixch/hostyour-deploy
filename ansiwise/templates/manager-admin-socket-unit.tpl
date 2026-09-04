[Unit]
Description=Make the directory the manager binds its admin socket in
# WHAT THIS UNIT IS FOR. The manager's Deployment mounts this directory off the node as a hostPath
# with type Directory (hostyour-cloud clusters/inventories/manager/templates/deployment.yaml:440).
# A hostPath of that type is a REQUIREMENT and not a request: the kubelet refuses the mount when the
# directory is absent, the container never starts, and the pod sits in ContainerCreating with a
# FailedMount event naming the path. Nothing else on this machine makes that directory, and no step
# of any program in this catalogue makes a directory at a named path with a named owner.
#
# WHY THE KUBELET IS NOT ALLOWED TO MAKE IT ITSELF. DirectoryOrCreate would make it root-owned 0755.
# The manager container runs as uid 65532 with a read-only root filesystem, so binding a socket
# inside it answers EACCES while the pod reports Ready and the directory stays empty. The chart takes
# the loud failure on purpose, and this unit is the other half of that decision.
#
# NOTHING ORDERS THIS AHEAD OF THE CLUSTER, and nothing needs to. /var/lib is not a tmpfs, so the
# directory a first run made is still there at the next boot and the kubelet never waits on this
# unit. What the boot run answers is a machine that came back without it.
#
# ON A CLUSTER THAT IS NOT THE MASTER THE DIRECTORY STANDS EMPTY. The manager runs on one cluster of
# an installation: clusters/inventories/manager/app.yaml carries runsOn master, and the generator in
# clusters/argocd/files/platform-apps-appset.yaml selects on runsOn being either every-cluster or the
# role of the cluster it runs on. A slave therefore carries this unit and mounts the directory
# nowhere.

[Service]
Type=oneshot
# WITHOUT THIS the service manager reports the unit inactive the moment the command returns — the
# same word it uses for a unit that has never run at all. The step that installs this unit reads
# exactly that word to decide whether the unit works, and those two states must not be one answer.
RemainAfterExit=yes
# THE THREE NUMBERS BELONG TO THE MANAGER POD AND NOTHING CHECKS THEM AGAINST IT. 65532 is runAsUser
# and runAsGroup in hostyour-cloud clusters/inventories/manager/templates/deployment.yaml:45,57,
# written there as literals with no value behind them. 0770 is adminSocket.mode in
# clusters/inventories/manager/values-common.yaml:118, which is what the manager puts on the socket
# FILE; the directory holding it needs the same reach or a caller on the host cannot search into it.
# A number that drifts apart from the chart fails SILENTLY — the directory exists, the mount
# succeeds, and the pod comes up Ready with nothing in it — which is the one failure mode type
# Directory does not catch.
#
# THE GROUP IS GIVEN AS A NUMBER AND NOT AS A NAME. A file's group is stored as a number, and the
# container that writes the socket carries the number its own image runs as. The create_group row of
# deploy-platform-services puts a group of 65532 on the machine under the name nonroot, but it is
# satisfied by ANY group already carrying that number, so what the group is called on a given
# machine is not knowable here.
#
# TWO COMMANDS AND NOT ONE, because `install -o` will not take a uid that no user carries. Measured
# on the pinned Ubuntu 26.04, where this unit failed on its first run:
#
#   install: invalid user: '65532'
#
# The GROUP 65532 exists — the create_group row of deploy-platform-services put it there as nonroot —
# but no user carries that uid, and none should: it is the uid inside the manager's image, not an
# account on this machine. `install` resolves an owner through the passwd database and refuses what
# it cannot find; `chown` takes a number as a number. So the directory is made with its mode and then
# given its owner, and the second command is what the first could not do.
#
# The service manager resolves no PATH for a command, so both are written absolute.
ExecStart=/usr/bin/install -d -m 0770 /var/lib/hostyour-manager
ExecStart=/usr/bin/chown 65532:65532 /var/lib/hostyour-manager

[Install]
# What makes it run at boot: the target the service manager reaches on its way up pulls this unit in.
WantedBy=multi-user.target
