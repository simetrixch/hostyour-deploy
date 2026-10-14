[Unit]
Description=Have the secret store read its TLS pair again, so its listener serves the renewed leaf
# WHAT THIS SERVICE IS FOR. The store reads its pair from the Secret platform-tls, mounted without a
# subPath (hostyour-cloud clusters/bootstrap/vault/values.yaml), so cert-manager's renewal reaches the
# files; the listener keeps the leaf it loaded until the server is sent SIGHUP. Nothing outside shows
# it: Traefik terminates with the same Secret and does not verify the store's own leaf, so the old one
# serves inside the cluster until it expires, about thirty days after a renewal.
#
# WHAT STARTS IT: hostyour-vault-reload.timer, once a day. cert-manager renews at two thirds of the
# leaf's life, so a day's delay costs nothing, and a pair caught in the middle of its swap fails the
# store's reload, which keeps the old leaf until the next day.
#
# NOTHING ELSE IS DONE. No restart, which would seal the store; no comparison of leaves, because a
# reload of an unchanged pair changes nothing.

[Service]
Type=oneshot
# The account deploy-cluster puts into the microk8s group, which the service manager reads at start.
User=<operator-user>
# A one-shot has no start timeout unless it is given one; an exec that hangs ends here.
TimeoutStartSec=60s
# SIGHUP TO THE OLDEST PROCESS NAMED vault IN CONTAINER vault OF POD vault-0, which is the server:
# the chart's `sh -ec` wrapper and dumb-init come before it under other names, and a readiness
# probe's `vault status` is younger. `$$` because the service manager expands `$`; the container's
# shell receives `$(pgrep -o -x vault)`. Where no server runs, kill is given no process and the unit
# fails in the journal.
ExecStart=/snap/bin/microk8s kubectl -n vault exec vault-0 -c vault -- sh -c 'kill -HUP $$(pgrep -o -x vault)'

# NO [Install] SECTION: hostyour-vault-reload.timer is the only trigger.
