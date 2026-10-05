# THE DASHBOARD ROUTE THE INGRESS ADDON INSTALLS, named so deploy-cluster can take it off. The MicroK8s
# addon installs Traefik with `ingressRoute.dashboard.enabled: true` on the `web` entrypoint and
# `Host(dashboard.localhost)`, to api@internal. A Host header is anybody's to send, so every cluster
# address served Traefik's dashboard and its whole routing table over plain http, to anyone.
#
# Only kind, name and namespace decide what is removed. The label is what the removal holds the live
# object against: the addon's Helm release marks it so, and an IngressRoute of this name without it
# is somebody else's and is refused rather than deleted.
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: traefik-dashboard
  namespace: ingress
  labels:
    app.kubernetes.io/instance: traefik-ingress
