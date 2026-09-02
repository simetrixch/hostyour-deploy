# The management accounts of a cluster another cluster's manager drives — created on THE MACHINE
# BEING ADDED, before its GitOps exists, which is why they are a rendered manifest here and not a
# chart: the chart tree only reaches this cluster THROUGH the registration these accounts make
# possible.
#
# Two accounts, and the split is the privilege boundary:
#
#   argocd-manager        what the per-cluster reconciler instance on the master deploys and prunes
#                         through — cluster-admin, exactly like the in-cluster reconciler on a full
#                         cluster. Its token becomes the registration's bearerToken
#                         (apps/slave/templates/externalsecret-cluster-slave.yaml).
#   vault-token-reviewer  what the master's secret store validates THIS cluster's logins as:
#                         TokenReview (system:auth-delegator) PLUS read on namespaces and service
#                         accounts — the store GETs the calling account's namespace to evaluate a
#                         label-bound role, and reads the account itself to lift its
#                         alias-metadata annotations into the login. Without the reader grant every
#                         label-bound login dies with "namespace not authorized ... failed to get
#                         namespace", cluster-wide.
#
# The token Secrets are the LEGACY long-lived kind on purpose: a registration and a reviewing
# credential must not expire, and only the annotated Secret the token controller populates has that
# property. The ClusterRole vault-namespace-reader is declared ONLY by the GitOps chart
# clusters/inventories/vault-rbac. This file declares just the BINDING, because the reviewer account
# needs the grant before that chart has synced onto the cluster. Declaring the role here as well
# gives one object two owners, and the chart's apply carries labels this file's apply does not — a
# diff against the live object then reports a change nobody made, and the apply behind it fails.
#
# The names are contracts, not choices: argocd-manager-token and vault-token-reviewer-token are
# what the emit program harvests, and slave-mgmt-vault-token-reviewer-namespaces is the binding
# clusters/inventories/vault-rbac names as the imperative twin.
apiVersion: v1
kind: ServiceAccount
metadata:
  name: argocd-manager
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: slave-mgmt-argocd-manager
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: argocd-manager
    namespace: kube-system
---
apiVersion: v1
kind: Secret
metadata:
  name: argocd-manager-token
  namespace: kube-system
  annotations:
    kubernetes.io/service-account.name: argocd-manager
type: kubernetes.io/service-account-token
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: vault-token-reviewer
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: slave-mgmt-vault-token-reviewer
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:auth-delegator
subjects:
  - kind: ServiceAccount
    name: vault-token-reviewer
    namespace: kube-system
---
# THE ROLE IS THE vault-rbac CHART'S, and only the binding below is this file's. The chart runs on
# every cluster (clusters/inventories/vault-rbac/app.yaml states runsOn: every-cluster) and its own
# header says the split: the ClusterRole is its, the binding for kube-system:vault-token-reviewer
# "stays imperative on the slaves".
#
# DECLARING IT HERE AS WELL LOOKED FREE and is not. The chart's header reasons that the two
# declarations are "identical-content ... so there is no ArgoCD/imperative fight", and the RULES are
# indeed identical — but ArgoCD's tracking annotation and Helm's labels are not. Every apply from
# here strips them, ArgoCD puts them back, and `kubectl diff` compares the whole object: it never
# reads clean again, so the step that applies this file can never see the state it produces. A slave
# deployment stopped on exactly that, sixteen steps in, once the chart began reaching slaves too.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: slave-mgmt-vault-token-reviewer-namespaces
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: vault-namespace-reader
subjects:
  - kind: ServiceAccount
    name: vault-token-reviewer
    namespace: kube-system
---
apiVersion: v1
kind: Secret
metadata:
  name: vault-token-reviewer-token
  namespace: kube-system
  annotations:
    kubernetes.io/service-account.name: vault-token-reviewer
type: kubernetes.io/service-account-token
