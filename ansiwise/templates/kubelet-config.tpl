# THE KUBELET'S CONFIGURATION FILE, for one setting the flags cannot carry: imageMaximumGCAge, which
# collects an image no pod has used for that long (Kubernetes v1.35.6, GA and locked on). 36 h lets a
# nightly job keep its image between runs; every other unused image goes within a day and a half.
# The kubelet keeps its image records in memory and collects by age only once the age has passed
# since it started (pkg/kubelet/images/image_gc_manager.go:291-304, :430-433), so the 36 h count
# from the last kubelite restart, and every redeploy starts them again.
#
# A --config file brings the v1beta1 defaults, which differ from the flag defaults in four fields
# (cmd/kubelet/app/options/options.go applyLegacyDefaults). MicroK8s sets three of them as flags in
# args/kubelet, and flags win over this file. The fourth it leaves to the flag default, so it is
# restated here at today's value: without it the kubelet's API authorization would turn from
# AlwaysAllow to Webhook unnoticed. Nothing else belongs in this file.
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
authorization:
  mode: AlwaysAllow
imageMaximumGCAge: 36h
