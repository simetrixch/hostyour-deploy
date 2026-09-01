# Every certificate on this cluster is issued by this. The account key lives in the secret
# named below, and it decides whether a rebuilt issuer registers again or carries on with
# the registration it already has.
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: <name>
spec:
  acme:
    server: <acme-server>
    email: <email>
    privateKeySecretRef:
      name: <name>
    solvers:
      - http01:
          ingress:
            ingressClassName: <ingress-class>
