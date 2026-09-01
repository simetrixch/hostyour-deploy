# What this installation may send mail as.
#
# WRITTEN PER INSTALLATION, and it has to be: the relay refuses to start without it, and the domains
# it names are this installation's own. The chart that ships to every installation says so in as many
# words and leaves the value out, because a shipped file naming one installation's domains is a file
# that is wrong on every other.
#
# The relay refuses rather than defaults, which is right: a mail service that accepted any sender
# would relay for anybody who reached it.
postfix:
  config:
    general:
      ALLOWED_SENDER_DOMAINS: "<platform-domain> <unit-apex>"
