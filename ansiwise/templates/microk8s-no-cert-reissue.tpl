# A lock MicroK8s' own apiserver-kicker reads: while this file stands at
# ${SNAP_DATA}/var/lock/no-cert-reissue the daemon does not re-render csr.conf, re-sign server.crt
# and restart kubelite when an address appears on or leaves the host. deploy-cluster writes it as
# soon as the snap runs, so it stands before any address changes. What it holds is not read; the
# daemon asks only whether it exists.
#
# WHY. Joining the private network puts 100.64.x.x on tailscale0, and the daemon answers that
# address with a full control-plane restart: "cert change detected. Reconfiguring the
# kube-apiserver", then stop kubelite, restart containerd, start kubelite. On a master the join is
# the last program, so the restart lands under the running platform: coredns and the reconciler
# restart, the Manager is killed by its own probe and answers 502 for minutes, and the first login
# fails (hostyour-deploy#25, measured on apps1, 2026-09-08 00:21 UTC).
#
# WHAT STILL RE-SIGNS. A slave's certificate has to carry its tailnet address, because the
# master's reconciler dials it there. The stamp row of tailnet-rejoin and of the Manager's slave
# deploy re-signs explicitly through `microk8s refresh-certs`, which does not read this lock, and
# on a slave it runs before that machine's platform boots.
