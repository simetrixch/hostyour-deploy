#!/bin/sh
# Loads the marking rules and installs the rule the network configuration cannot express.
#
# The mask is required. A reply also carries the network agent's own mark, so a match on the
# bare value would never fire — it would read correctly and steer nothing.
set -e

nft -f <rules-path>

# Every rule already at this number goes first, in a loop: adding without removing leaves a
# second identical rule on every run, and removing once leaves whatever ran twice before.
while ip -4 rule del priority <priority> 2>/dev/null; do :; done
ip -4 rule add from all fwmark <mark>/<mark> lookup <table> priority <priority>
