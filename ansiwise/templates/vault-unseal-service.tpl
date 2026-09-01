[Unit]
Description=Feed the quorum back to the secret store whenever it is sealed
# WHAT THIS SERVICE IS FOR. A secret store that runs with the seal it was given a quorum for, and no
# key service behind it, comes back SEALED from every restart. While it is sealed nothing on the
# cluster materializes a secret, so every workload holding one comes up Degraded at the same moment
# with nothing on the machine naming the cause.
#
# WHAT STARTS IT, AND WHY IT IS NOT THE BOOT. hostyour-vault-unseal.timer, once a minute, and
# nothing else. The store seals when its POD restarts — an eviction, a node drain, the roll a chart
# bump triggers — and on a machine that never rebooted a unit wanted by the boot target runs on none
# of those. Measured on 2026-08-28: the store's pod restarted at 19:43:21 on a machine that stayed
# up, this unit stood at active (exited) from the morning, and eight applications were Degraded
# until somebody restarted it by hand at 19:59:01. Nothing on the machine writes a file when the
# store seals, so the state is followed by ASKING the store, which is what the step this runs does.
#
# WHAT IT RUNS, AND WHY IT IS NOT A SCRIPT. ansiwise against the one-row program unseal-vault.yaml.
# The step that feeds the keys back already exists and is already the one every deployment uses; a
# shell script here would be the same act written a second time, and the two disagree the first time
# either is corrected.
#
# NOTHING IS DONE TO AN UNSEALED STORE. The step reads the seal state first and reports itself
# satisfied where the store is already serving, so a firing on a healthy machine costs one question
# and changes nothing.
#
# The store answers over the cluster's own address, so nothing may run before an address can be
# bound and a name resolved.
After=network-online.target
Wants=network-online.target
# NO START RATE LIMIT, AND THE ZERO IS DELIBERATE. The service manager refuses to start a unit that
# was started too often inside a window, and a unit refused that way stays refused until somebody
# runs `systemctl reset-failed` on it by hand. On a unit a timer starts every minute for ever, that
# is the same failure this whole mechanism exists to remove — an unsealer that quietly stopped
# running, with nothing on the machine saying so. Zero turns the limit off rather than picking a
# burst that a shorter interval would later cross.
StartLimitIntervalSec=0

[Service]
Type=oneshot
# NO RemainAfterExit, AND EVERY FIRING DEPENDS ON THAT. The line used to stand here so the row that
# installed this unit could tell a run that finished from one that never happened; that row now
# reads the timer instead. Left here, this service would stand as `active (exited)` for ever, and a
# start of an already-active unit is a no-op — so the timer would fire every minute and nothing at
# all would run. It is also what makes `systemctl start hostyour-vault-unseal` unseal by hand
# again, which is what the platform's own VaultSealed alert tells the operator to type.
#
# WHAT STOPS AN ATTEMPT THAT NEVER RETURNS. A one-shot has NO start timeout unless it is given one,
# and while one start job is running the timer's next firing is merged into it — so a single attempt
# hanging on an address nothing answers would stop every later attempt for as long as it hangs. This
# bound is shorter than the timer's own minute, so at most one attempt is ever outstanding.
TimeoutStartSec=45s
# THE REAL RUN IS PROVEN BEFORE IT IS MADE, and nothing is waived to get there. A real run is
# admitted only where a clean dry run of the same program and the same answers stands behind it, so
# the dry run is performed here, seconds ahead of it. That is also what turns an attempt made too
# early into a retry: a store that cannot be reached fails the dry run, the second line is never
# reached, and nothing has been changed on a store nobody could ask.
#
# THE PATHS ARE ABSOLUTE AND THE WORKING DIRECTORY IS THE CATALOGUE. The programs and the
# configuration are stated in full because the service manager resolves nothing for them, and the
# catalogue is where the run stands so the commit it records is the catalogue's own.
#
# A PATH THAT IS WRONG IS NO LONGER A RED ROW AT INSTALL TIME. The row that installs this unit
# enables the timer and reads back the timer, and a timer is armed whether or not the service it
# starts can run. What is left is the journal: the timer fires this service one second after it is
# started, so a wrong path is written there while the operator's own deployment is still going.
# Measured on apps3, 2026-08-26: a machine whose catalogue stood somewhere else failed with
# status=200/CHDIR, naming the working directory below.
#
# THE ENGINE AT ITS LASTING PLACE, not the copy the first contact left in a home directory.
# A machine that has none receives one in the operating account's own home, because
# /usr/local/bin belongs to root and the account that arrives first is not root
# (hostyour-manager server/domains/runs/defs/place-ansiwise.ts:36). What stands under
# /usr/local/bin afterwards is what install_pinned_tool keeps at the pin, and it is the one
# require_cli_tool_versions asks about. This unit runs every minute, long after both, so it
# names the lasting one. Measured on an installation that was already standing: the home copy
# was not there and the unit failed at EXEC with "Unable to locate executable".
WorkingDirectory=/srv/ansiwise-catalog
ExecStart=/usr/local/bin/ansiwise unseal-vault --mode dry --programs /srv/ansiwise-catalog/ansiwise/boot-programs --config /srv/ansiwise-catalog/ansiwise-boot.yaml --answers /srv/hostyour-cloud/configs/unseal-vault-answers.json
ExecStart=/usr/local/bin/ansiwise unseal-vault --mode run --programs /srv/ansiwise-catalog/ansiwise/boot-programs --config /srv/ansiwise-catalog/ansiwise-boot.yaml --answers /srv/hostyour-cloud/configs/unseal-vault-answers.json

# NO [Install] SECTION, AND THAT IS WHAT LEAVES THE TIMER AS THE ONLY TRIGGER. A unit wanted by the
# target the machine reaches on its way up runs once at boot and never again, which is the shape
# that left a sealed store standing while the machine underneath it was fine.
# hostyour-vault-unseal.timer is what deploy-platform-services enables, and it starts this service
# a second after every boot and at every minute after that.
