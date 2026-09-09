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
            # THE SOLVER'S SERVICE IS A ClusterIP, AND SAYING SO HERE IS WHAT LETS A UNIT HOLD A
            # CERTIFICATE AT ALL. cert-manager makes a Service of its own to answer the challenge,
            # and its default is a NodePort. A platform namespace admits that; a UNIT namespace does
            # not — the per-unit fence holds every Service in it to ClusterIP, because a NodePort
            # reaches past the ingress its host clauses just pinned and past the NetworkPolicy that
            # follows the namespace. So the solver's own Service was refused, its pod ran with
            # nothing routed to it, and the Certificate stood at Ready: False with no event on it
            # and the refusal visible only on the Challenge (simetrixch/hostyour-deploy#31).
            #
            # NOTHING IS LOST BY IT. The challenge is answered over the ingress class named on the
            # line above, so the Service never needs to be reachable from outside the cluster — the
            # NodePort default exists for installations that have no ingress to answer over, and
            # this one does. The fence therefore stays absolute, with no exemption for anybody to
            # stamp a label into.
            serviceType: ClusterIP
