# The time sources this installation states. deploy-host writes this file from the time_sources
# answer on every run, so an edit made here is gone at the next one; the answer is where a source
# is added or taken away.
#
# THEY ARE ADDED TO WHATEVER THE REST OF /etc/chrony NAMES, and a source named there that never
# answers is not free. chronyd's authselectmode defaults to `mix`, which gives every authenticated
# source the require and trust options as soon as an unauthenticated source is specified beside it,
# and chronyd then synchronises to nothing until one of those authenticated sources is selectable.
# Ubuntu names five authenticated pools in ubuntu-ntp-pools.sources, which a machine behind a
# provider that answers only its own time servers never reaches. That is why deploy-host writes
# that file empty of directives before it writes this one.
#
# iburst ON EVERY LINE. Without it chronyd sends one packet per polling interval, which starts at
# 64 seconds, so a machine whose clock is out reaches its first source minutes after this file is
# read rather than seconds after it.
#
# CHRONYD READS THIS DIRECTORY WHEN IT STARTS, and while it runs only when it is told to reload its
# sources. A file written beside a running daemon is therefore read by nothing until that daemon
# starts again.
server <time-sources?> iburst
