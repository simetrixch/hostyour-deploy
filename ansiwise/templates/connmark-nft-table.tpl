# Connections that arrived on <device> for <address> are marked, and the mark is put
# back onto the packets of the reply so the rule keyed on it can steer them out the public
# gateway. This covers the replies the source-address rules cannot: a reply handed back by a
# pod is sourced from the pod, not from <address>.
#
# The first line removes the table, so loading this again replaces it rather than adding to
# what is already there.
destroy table inet <table-name>

table inet <table-name> {
  chain prerouting {
    type filter hook prerouting priority -150; policy accept;
    iifname "<device>" ip daddr <address> ct state new ct mark set <mark>
    ct mark <mark> meta mark set ct mark
  }

  chain output {
    type route hook output priority -150; policy accept;
    ct mark <mark> meta mark set ct mark
  }
}
