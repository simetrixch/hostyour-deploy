[Unit]
Description=Have the secret store read its TLS pair again once a day

[Timer]
# The unit this starts is the service of the same base name. Daily, because cert-manager renews a
# third of the leaf's life before it ends; Persistent, so a day the machine was down is caught up at
# its next start instead of skipped.
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
