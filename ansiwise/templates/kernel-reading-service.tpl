[Unit]
Description=Write the running kernel's version where the cluster's metrics read it
# WHAT THIS SERVICE IS FOR. The node exporter of the master and the Alloy of a slave read every .prom
# file in the textfile directory, so the version written here reaches Prometheus as
# hostyour_kernel_info. The alert that says mongod runs without its rseq workaround on a kernel that
# needs it reads that metric, because no pod can read the kernel of the machine it runs on.
#
# WHAT STARTS IT: hostyour-kernel-reading.timer, at every boot and then every hour. The running kernel
# changes only at a reboot, so the hour only catches a file that was removed.

[Service]
Type=oneshot
# The account the textfile directory is handed to, which can write there.
User=<operator-user>
# A one-shot has no start timeout unless it is given one.
TimeoutStartSec=30s
ExecStart=<script-path> /proc/version_signature <textfile-directory>

# NO [Install] SECTION: hostyour-kernel-reading.timer is the only trigger.
