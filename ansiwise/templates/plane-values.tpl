# What Plane is told about this installation.
#
# WRITTEN PER INSTALLATION BECAUSE HELM CANNOT WRITE IT. The chart writes ingress.appHost and
# ingress.ingress_annotations as they stand, without tpl, so an address or an issuer spelled there as
# a Helm expression would reach the cluster as its own text. The host is also the address Plane hands
# out as its web address, served over https with the certificate the issuer below signs.
#
# THE ANNOTATIONS ARE A MAP, so Helm merges this one into the entrypoint and the forward auth the
# inventory's own values set.
plane-ce:
  ingress:
    appHost: plane.<fqdn>
    ingress_annotations:
      cert-manager.io/cluster-issuer: <cluster-issuer>
