[Unit]
Description=Ask the secret store every minute whether it is sealed, and feed the quorum back where it is
# WHY A SCHEDULE AND NOT AN EVENT. The condition this answers is "the store is sealed", and nothing
# on this machine changes when that becomes true: the store is a pod on the cluster, it seals inside
# its own container, and no file here is written and no signal here is raised. There is therefore
# nothing for a path unit or a condition to watch, and the only way to follow the state is to ask —
# which is exactly what hostyour-vault-unseal.service does, because the step it runs reads the seal
# state before it does anything.
#
# WHAT ONE FIRING COSTS: one question to the store, measured at 12.4 MB peak and 69 ms, and on an
# unsealed store nothing else at all.

[Timer]
# The unit this starts is the service of the same base name. The service manager derives it, so no
# key here names it and the two cannot drift apart.
#
# ONCE, ONE SECOND AFTER THIS TIMER IS STARTED — which is every boot, and the moment
# deploy-platform-services enables it. That is what puts the first run of the service in front of
# the operator who installed it, instead of at some later minute nobody is watching.
OnActiveSec=1s
# AND THEN AT EVERY MINUTE, FOR EVER. NOTHING COUNTS ATTEMPTS AND NOTHING GIVES UP: a store that is
# sealed at ten and still sealed at noon is unsealed at noon. The cost is bounded by this interval
# and not by a counter, and a machine whose store never answers writes one refused attempt a minute
# into the journal, where `systemctl list-timers` and `journalctl -u hostyour-vault-unseal` both
# show it. A unit that gives up after a fixed number of tries is the shape that leaves an
# installation sealed with nothing running.
OnCalendar=minutely
# WITHOUT THIS THE SERVICE MANAGER MAY HOLD A FIRING BACK BY UP TO A MINUTE, so that it wakes the
# machine once for several timers. On an interval of one minute that doubles the worst case a sealed
# store waits.
AccuracySec=1s

[Install]
# What makes the machine arm this timer on its way up. Without it the timer file is installed and
# the machine never starts it, which is the whole of what this exists for.
WantedBy=timers.target
