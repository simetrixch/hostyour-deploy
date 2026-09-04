# What this cluster is — the ONE place an installation's answers are written down.
#
# Written by the run that generated this branch, and read by everything that has to tell one
# installation from another. There is no second file: this one is both the PARAMETERS the
# ApplicationSet generators select on and the VALUES Helm resolves through. Until this file absorbed
# it, installation/profile.yaml carried six of these same answers a second time in a second
# spelling, with nothing holding the two against each other.
#
# TWO BLOCKS, AND THE RULE BETWEEN THEM IS NOT TASTE. ArgoCD's `selector.matchLabels` matches FLAT,
# TOP-LEVEL keys and can address nothing nested — so what a generator selects on has to stand at the
# top. Helm shares only `global:` with subcharts, and every chart of this platform reads
# `.Values.global.*` — so everything a chart reads has to stand under it. A template read, on either
# side, may be nested and therefore decides nothing here.
#
#   top level   what a generator SELECTS on, and the one key a step reads line by line
#   global:     everything a chart reads
#
# ONE VALUE STANDS IN BOTH, AND IT IS FORCED: `booksCluster`. The slaves generator selects on it and
# the charts read it, and neither position can move. It is written from ONE slot of THIS template,
# so nothing can write the two apart — which is exactly what two files could never promise. The
# spelling is identical on both sides on purpose: a reader comparing them by eye should not have to
# know a mapping to see that they agree.
stage: <stage>
role: <role>
booksCluster: <books-cluster>
# THE PIN. The release this cluster stands on, in the one release grammar. A regeneration reads
# this line off the map and hands it back as the ref it merges, so the field and the branch state
# are one statement and "this cluster runs platform X" is a question with an answer.
#
# WRITTEN AT BIRTH AND NEVER CARRIED. Both runs that render this file are answered with the state
# they bring the branch to — deploy-branch fetches and merges it into the branch it has just cut,
# regenerate-branch into the branch that already stands — so the run that writes this line is the
# run that made it true. The slot is required: a map naming no release is one the Manager cannot
# regenerate and cannot give a slave, and the run that would leave it empty is refused instead.
release: <release>

global:
  # This cluster's own public domain name, which is also the name of its install branch.
  domain: <fqdn>
  # The first DNS label of that domain. Everything named per cluster carries it — the Vault auth
  # mount below, the dashboard's context, a slave's ArgoCD instance.
  clusterName: <cluster-name>
  # The install branch of the cluster that keeps the books — the cluster maps and the registrations.
  # On a cluster that reads another's, this is a DIFFERENT branch from the one this file stands on.
  # The same value as the top-level `booksCluster`, from the same slot, for the reason stated above.
  booksCluster: <books-cluster>
  # The cluster that builds this one's images. `servicesLocal.registry` below is the predicate that
  # follows from it — a cluster that builds elsewhere pulls from that other cluster's registry.
  buildPlane: <build-plane>
  # The public apex units serve under: a unit's own name, then this.
  unitApex: <unit-apex>
  # This installation's business domain: the mail sender identity and the relay's own name.
  platformDomain: <platform-domain>
  # WHERE THIS INSTALLATION'S CERTIFICATES COME FROM, and the mailbox that authority writes to. The
  # same three for every cluster of one installation — a slave added later reads them here rather
  # than being asked again, which is the difference between one answer and two that may disagree.
  # The authority stands here as well as in the config, because this file is what a caller reads to
  # learn what the installation already is. A caller that cannot read it here hands the regeneration
  # nothing, the answer falls to its default of platform-local, and every certificate is reissued
  # from the cluster's own root while the run reports itself green.
  clusterIssuer: <cluster-issuer>
  letsencryptEmail: <letsencrypt-email>
  letsencryptServer: <letsencrypt-server>
  # Where this installation's platform alerts are delivered. An alert route of the observability
  # application that names no recipients of its own resolves them through this key, and the render
  # of the whole application stops where an enabled route resolves to neither. Quoted, because a
  # mailbox is one word to YAML only by accident and a plain scalar beginning with # is a comment.
  alertRecipients: ['<alert-recipients>']
  # The repository holding this installation's tenant charts, as the URL a build clones. Written
  # from the answer that names it as owner/name — the pipeline that releases a unit reads it to find
  # the charts a release is rendered against, and refuses to render at all without it.
  catalogUrl: https://github.com/<catalog-repo>.git
  # THE SAME REPOSITORY AS owner/name, WHICH IS A DIFFERENT THING TO READ. Every argocd file of
  # this platform writes the marker inside a URL of its own — `https://github.com/__CATALOG_REPO__.git`
  # — so what replaces the marker is the bare owner/name and never a URL. A cluster cutting a
  # SLAVE's branch has no answer to read it from (the manager tells that program only fqdn, stage,
  # role and operator_user), so it reads this map instead, and catalogUrl above is the wrong shape
  # for it: stamped in, it would compose https://github.com/https://github.com/... .
  catalogRepo: <catalog-repo>
  # The Vault auth mount of THIS cluster. One Vault serves several clusters, so the mount is what
  # tells two of them apart, and every policy templated on a login is written against it.
  vaultKubernetesAuthPath: kubernetes-<cluster-name>
  # The registry's two accounts, by name. The names are not secret and are not minted — a name that
  # changed on every run would lock out whatever holds the last one. THEY MUST DIFFER: they are two
  # accounts distinguished by nothing else, and the registry chart refuses to render where they are
  # equal, because the password file would carry one name twice and the second password would
  # authenticate nothing at all.
  registryPullUser: <registry-pull-user>
  registryPushUser: <registry-push-user>
  # WHERE THE MACHINES OF THIS CLUSTER CAN BE REACHED, each address on its own as a /32.
  #
  # A boundary drawn in address terms has to name the machine it is drawn around, and a cloud
  # machine's own address is a PUBLIC address — so a boundary that carves out the private ranges and
  # calls the rest of the world outside leaves the machine itself inside the allowed part. The gate
  # sandbox's fence is the reader that has to have it, and it refuses to render on an empty list
  # rather than reporting itself drawn while standing open.
  #
  # MEASURED OFF THE MACHINE AND NEVER ANSWERED. It is a fact about the machine the run is standing
  # on, and one mistyped octet is a boundary that reports itself closed while standing open. The row
  # that fills this reads it with measure_host_addresses; nobody is asked.
  #
  # A /32 and not the prefix the interface carries: a node configured 10.1.1.7/24 shares that /24
  # with every other host on the wire, and what a boundary needs is the machine, not the segment.
  nodeCidrs: [<node-cidrs>]
  # WHERE THE SHARED SERVICES ANSWER, one map and one shape per service. Each is that service plus
  # the domain of the cluster that runs it — the books-keeping cluster for everything an
  # installation has exactly one of, the build plane for the registry.
  endpoints:
    registry:
      host: zot.<build-plane>
    # Where units reach the installation's shared mail service. Optional: an installation that runs
    # no mail service has none, and a tenant's auth and report charts stop their render naming this
    # key rather than sending nowhere.
    mail: {url: <mail-url?>}
    # coredns rewrites exactly this name to the in-cluster Service, so it follows the books-keeping
    # cluster and not this one — a cluster that keeps no books would otherwise be pointed at a Vault
    # that does not run there.
    vault: {url: 'https://vault.<books-cluster>'}
    # One installation has ONE place people sign in, for the same reason. Everything that accepts a
    # browser login is told this address, and the auth mount in the store reads it from here.
    idp: {url: 'https://idp.<books-cluster>'}
    tailnet: {url: 'https://tale.<books-cluster>'}
  # WHICH OF THE SHARED SERVICES RUN HERE, keyed by the service. A chart reads its own key to decide
  # whether to reach in-cluster or over the address above.
  servicesLocal:
    registry: <holds-build-plane>
    vault: <holds-books>
    observability: <holds-books>
