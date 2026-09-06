# The time sources of this installation stand in hostyour.sources, beside this file. deploy-host
# writes that file from the time_sources answer on every run, and it writes this one, so an edit
# made here is gone at the next run.
#
# WHY THE DISTRIBUTION'S POOLS ARE NOT LEFT BESIDE THEM. Ubuntu ships this path with five
# authenticated (`nts`) pools. chronyd's authselectmode defaults to `mix`, which gives every
# authenticated source the require and trust options as soon as an unauthenticated source is
# specified beside it. On a network that answers only its own time servers those pools are required
# and unreachable at once, so chronyd logs "Can't synchronise: no required source in selectable
# sources" and never selects the servers hostyour.sources names.
#
# THE FILE IS EMPTIED RATHER THAN DELETED because this catalogue has a step that writes a file and
# none that removes one. Nothing on the machine would put it back either way: it is no conffile of
# the chrony package, chrony.postinst hands it to ucf, and ucf leaves a file the machine emptied or
# deleted alone unless UCF_FORCE_CONFFMISS is set. /etc/chrony/sources.d/README requires a name
# ending in .sources and allows only peer, pool and server directives, so comments and no directive
# at all is what a file here may say when it is to name nothing.
