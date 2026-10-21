[Unit]
Description=Read the running kernel's version at boot and every hour

[Timer]
# The unit this starts is the service of the same base name.
#
# ONCE, ONE SECOND AFTER THIS TIMER IS STARTED, which is every boot and the moment deploy-host
# enables it, so the first reading stands before anyone looks for it.
OnActiveSec=1s
# AND THEN HOURLY, counted from the end of the last firing. A machine that reboots into another
# kernel is read at that boot; the hour is only for a file that was removed.
OnUnitActiveSec=1h

[Install]
WantedBy=timers.target
