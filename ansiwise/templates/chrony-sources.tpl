# The time sources this installation states. deploy-host writes this file from the time_sources
# answer on every run, so an edit made here is gone at the next one; the answer is where a source
# is added or taken away.
#
# THEY ARE ASKED IN ADDITION to whatever /etc/chrony/chrony.conf names. A file in this directory
# adds sources and removes none, so a distribution pool that never answers stays in the list and
# costs nothing but the packets it never gets a reply to.
#
# iburst ON EVERY LINE. Without it chronyd sends one packet per polling interval, which starts at
# 64 seconds, so a machine whose clock is out reaches its first source minutes after this file is
# read rather than seconds after it.
#
# CHRONYD READS THIS DIRECTORY WHEN IT STARTS, and while it runs only when it is told to reload its
# sources. A file written beside a running daemon is therefore read by nothing until that daemon
# starts again.
server <time-sources?> iburst
