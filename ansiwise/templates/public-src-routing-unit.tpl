[Unit]
Description=Steer replies to traffic that arrived on the public address
# The rules are installed on the interfaces, so nothing may run before they are up.
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=<script-path>
# Stopping the service is what takes the rules out of the kernel. Deleting the files does
# not, because by then the kernel is holding them.
ExecStop=-/usr/sbin/nft destroy table inet <table-name>
ExecStop=-/usr/sbin/ip -4 rule del from all fwmark <mark>/<mark> lookup <table> priority <priority>

[Install]
WantedBy=multi-user.target
