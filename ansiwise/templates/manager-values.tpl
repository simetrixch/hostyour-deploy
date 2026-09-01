# What this installation's own Manager is told about the machine it runs on.
#
# WRITTEN PER INSTALLATION, and it has to be: every value below names THIS machine — the account
# that operates it and the address it answers on inside the network it shares with the clusters of
# this installation. The chart that ships to every installation says of all four that they belong
# here and leaves them out, because a shipped file naming one machine is wrong on every other.
#
# WITHOUT THIS FILE CONSUMER ONBOARDING IS OFF, and the Manager says so in the only terms it has.
# It registers the consumer onboarding family where its own deployment carries BOTH the gate address
# and the platform repository credential. The chart renders the credential only where master.sshUser
# is set and the gate address only from onboarding.gatemanagerAddr, so with this file absent the
# mutating consumer routes answer 501 "onboarding is not configured on this manager" — which is
# true about the Manager and says nothing about which file of the installation was supposed to
# carry the settings. This is that file.
master:
  # The account the Manager reaches this machine as, over SSH to its own host. Setting it is what
  # turns on the self-registration that seeds the one role=master row and this control host's own
  # cluster row, and it is also what renders GITHUB_REPO and GITHUB_WRITE_PAT — the platform
  # repository half of the onboarding gate.
  sshUser: <operator-user>
  # The address this machine answers on inside the cluster network. The Manager keeps it on the
  # master row and reads it to work out the cluster LAN a slave's pod network may not overlap.
  lanHost: <lan-host>

onboarding:
  # The Manager's OWN address as it listens on this machine: its pod runs on the node's own
  # network and serves 8484 there, which is the same fact the onboard-manager program states from
  # the machine's side in its manager_url answer.
  #
  # WHAT IT IS FOR. Before the fenced chart-validation pod validates anything it PROVES, from inside
  # the fence, that it cannot reach the Manager. AN ADDRESS AND NEVER A NAME: the probe counts a
  # connection it could not make as a block, so a name that does not resolve inside the fence would
  # attest a fence that was never tested.
  gatemanagerAddr: '<lan-host>:8484'
  # The second must-fail probe: this cluster's own API server, which the fence carves out along with
  # every other private address. It is a target that IS listening, which is what makes the block it
  # proves worth proving — the Manager's own address is probed separately and needs no entry here.
  gateFenceMustFail: '<lan-host>:16443'
