# The slave's OWN reconciler project on the master, named after the slave.
#
# It CANNOT be GitOps-managed, and that is why it is a rendered manifest here: the trunk must stay
# generic (no slave name may stand in clusters/argocd/apps/projects.yaml), and the per-slave chart cannot
# carry it either — the Application the slaves generator makes REFERENCES the project by the
# slave's name, and an Application whose project does not exist can never start its first sync. So
# it belongs to the same imperative per-slave surface as the auth mount, applied by the run that
# registers the slave.
#
# Shape mirrors the platform projects (clusters/argocd/apps/projects.yaml), tightened per slave: the
# destination is pinned to EXACTLY the slave's own namespace on the master, and Namespace is the
# one cluster-scoped kind (CreateNamespace=true needs it — the reconciler sub-chart renders nothing
# cluster-scoped: crds.install false, createClusterRoles false).
#
# The hostyour.cloud/slave label marks it OURS, the same convention as hostyour.cloud/consumer and
# hostyour.cloud/build: the register run refuses a name collision with an unlabeled (platform)
# project, and the remove run deletes only a labeled one. Imperative = untracked: the root
# application's automated prune never touches it.
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: <slave-cluster-name>
  namespace: argocd
  labels:
    hostyour.cloud/slave: "true"
spec:
  description: Slave <slave-cluster-name> — its namespaced reconciler instance and its materialized credentials, in its own namespace on the master.
  sourceRepos:
    - https://github.com/simetrixch/hostyour-cloud.git
    # AND THE CHART REPOSITORY THE RECONCILER ITSELF COMES FROM. clusters/slaves/slave pulls the
    # `argo-cd` chart from here as a dependency, and every project of this platform names the remote
    # chart repositories its applications pull from — core names external-secrets' OCI registry,
    # observability names prometheus-community and grafana, services names postfix's. This one named
    # none, and it is the only project whose application had never been generated, so nothing had
    # ever asked it for one.
    - https://argoproj.github.io/argo-helm
  destinations:
    - server: https://kubernetes.default.svc
      namespace: <slave-cluster-name>
  clusterResourceWhitelist:
    - group: ""
      kind: Namespace
  namespaceResourceWhitelist:
    - group: "*"
      kind: "*"
