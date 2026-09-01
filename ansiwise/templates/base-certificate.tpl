# GENERATED ON EVERY RUN, and that is the point of this file existing as a template at all.
#
# This was the ONE certificate on the cluster whose authority was typed into a tracked file by hand,
# while every other one reads it out of the values chain. That exception is what made the certificate
# switch unturnable: a stamp fills a placeholder ONCE, at a branch's birth, so an installation that
# later named a different authority kept the old name in this file and the certificate service — which
# watches the name a certificate is issued BY and nothing else — re-issued nothing. Measured on apps5
# on 2026-09-01: the config said platform-acme, this file said platform-local, and the cluster went on
# serving certificates whose root its own trust bundle no longer carried.
#
# Written from this template by deploy-branch on every run, the authority comes from the run's own
# answer each time. There is no state in which the file disagrees with the installation.
#
# ONE CERTIFICATE FOR EVERY ADDRESS THE BASE LAYER SERVES, and the store that hands it to the three
# routes Traefik terminates.
#
# WHY ONE AND NOT FOUR. Four single-name certificates spend four issuances per installation, and the
# authority's tightest limit is FIVE for one exact set of names in a rolling week — a limit on the
# NAMES A CERTIFICATE CARRIES, not on a hostname. Four names in one certificate are a different set
# from any of them alone, with a counter of their own. Measured on apps1, 2026-08-24: the fifth
# rebuild of this installation was refused with `429 too many certificates (5) already issued for
# this exact set of identifiers`, and the next attempt was twenty-three hours away. One certificate
# is one issuance, so the same weekly budget covers five REBUILDS instead of five per hostname.
#
# WHY IT STANDS IN THIS NAMESPACE AND NOT THE ROUTER'S. Vault is the one component that serves TLS
# itself: clusters/bootstrap/vault/values.yaml mounts this secret as a volume and reads tls_cert_file out of
# it, and Kubernetes does not mount a Secret across a namespace boundary. Traefik reaches across
# instead, which costs nothing — deploy-cluster runs it with
# --providers.kubernetescrd.allowCrossNamespace=true, and a route names a store by name AND
# namespace. So the file lives where the only component that needs it as a FILE can read it, and
# everything else is pointed at it.
#
# ONE SET FAILS AS ONE. A name in the list whose challenge cannot be solved fails the whole
# certificate, and all four addresses lose their TLS rather than one. Adding an address to the base
# layer means adding it here; forgetting it is a route Traefik answers with a certificate that does
# not name it, which a browser reports and nothing else does.
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: platform-tls
  namespace: vault
spec:
  secretName: platform-tls
  issuerRef:
    name: <cluster-issuer>
    kind: ClusterIssuer
  dnsNames:
  - argo.<fqdn>
  - idp.<fqdn>
  - kube.<fqdn>
  - vault.<fqdn>
---
# The three routes Traefik terminates name this store; Vault's own route needs no TLS block of its
# own for the certificate, because Traefik terminates that one too and the pod behind it presents
# the same file to the transport.
apiVersion: traefik.io/v1alpha1
kind: TLSStore
metadata:
  name: default
  namespace: vault
spec:
  defaultCertificate:
    secretName: platform-tls
