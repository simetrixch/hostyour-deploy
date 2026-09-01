# Replies to traffic that arrived on <device> (<address>) leave by
# <gateway> rather than by the default route of another interface.
#
# Keyed on the same hardware address and name as the installer's own file, so
# this folds into the one declaration of <device> instead of becoming a second.
#
# The four exceptions come before the catch-all, and the numbers are what decide it: a lower
# number wins in the kernel, so every range that must stay on the main table is numbered
# below the rule that sends everything else out the public gateway. The carrier-grade range
# is among them because the certificate service checks its own answer over exactly that path.
network:
  version: 2
  ethernets:
    <device>:
      match:
        macaddress: "<mac>"
      set-name: <device>
      routing-policy:
        - from: <address>/32
          to: 10.0.0.0/8
          table: 254
          priority: 9000
        - from: <address>/32
          to: 100.64.0.0/10
          table: 254
          priority: 9001
        - from: <address>/32
          to: 172.16.0.0/12
          table: 254
          priority: 9002
        - from: <address>/32
          to: 192.168.0.0/16
          table: 254
          priority: 9003
        - from: <address>/32
          table: <table>
          priority: 10000
      routes:
        - to: 0.0.0.0/0
          via: <gateway>
          on-link: true
          table: <table>
