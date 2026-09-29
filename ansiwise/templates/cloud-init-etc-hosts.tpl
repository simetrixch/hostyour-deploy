# Keeps cloud-init from rewriting /etc/hosts at boot.
#
# WHY. deploy-platform-services points the secret store's host name at a private address in
# /etc/hosts (set_host_address), because the store's route refuses the public address. Where
# cloud-init manages the file, it renders it again from its own template at every boot, and the
# entry is gone: the unseal service that runs at boot then reaches the store by its public address
# and is refused, so the store stays sealed. A machine where cloud-init is off ignores this file.
#
# A file in cloud.cfg.d is system configuration; user data that sets manage_etc_hosts still wins.
manage_etc_hosts: false
