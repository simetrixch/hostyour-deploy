# What Forgejo is told about this installation.
#
# WRITTEN PER INSTALLATION BECAUSE HELM CANNOT WRITE IT. The chart puts gitea.config and gitea.oauth
# into app.ini and into its start script as they stand, without tpl, so an address spelled there as
# a Helm expression would reach Forgejo as its own text.
#
# THE SIGN-IN LIST STANDS HERE WHOLE. Helm replaces a list instead of merging it, and the source's
# discovery address names this installation's identity provider. Its client secret comes from the
# Secret forgejo-oauth, and the group admins makes a site administrator.
forgejo:
  gitea:
    config:
      server:
        DOMAIN: forgejo.<fqdn>
        SSH_DOMAIN: forgejo.<fqdn>
        ROOT_URL: https://forgejo.<fqdn>/
        SSH_PORT: <forgejo-ssh-port>
    oauth:
      - name: authentik
        provider: openidConnect
        existingSecret: forgejo-oauth
        autoDiscoverUrl: https://idp.<fqdn>/application/o/forgejo/.well-known/openid-configuration
        scopes: openid email profile groups
        groupClaimName: groups
        adminGroup: admins
