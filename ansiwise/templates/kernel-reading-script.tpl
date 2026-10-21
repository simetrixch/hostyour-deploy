#!/bin/sh
# Writes the running kernel's version where the cluster's metrics read it.
#
# WHY /proc/version_signature AND NOT uname -r. Ubuntu reports 7.0.0-31-generic for every 7.0 kernel
# it ships, so uname -r cannot tell the patch level that decides whether mongod needs its rseq
# workaround. The signature file holds one line, "package release upstream", and its third field is
# the upstream version the kernel is built from.
#
# WHAT A WRONG READING DOES. A signature that is missing, empty or not of that shape removes the file
# an earlier run wrote and ends non-zero, so a reading that cannot be trusted never stands beside a
# good one and the alert that reads it fires on the absence.
#
# Two arguments: the signature file, and the directory the node exporter's textfile collector reads.
set -eu

signature_file=$1
directory=$2
reading="$directory/hostyour_kernel.prom"
# A name the collector does not match, so it never reads a half-written file.
partial="$directory/.hostyour_kernel.prom.$$"
trap 'rm -f "$partial"' EXIT

refuse() {
  rm -f "$reading"
  echo "hostyour-kernel-reading: $1" >&2
  exit 1
}

package=''
release=''
upstream=''
extra=''
read -r package release upstream extra < "$signature_file" || true
[ -n "$package" ] && [ -n "$release" ] && [ -n "$upstream" ] && [ -z "$extra" ] \
  || refuse "$signature_file does not hold one line of three fields, package release upstream"
printf '%s\n' "$release" | grep -Eq '^[0-9A-Za-z.+_-]+$' \
  || refuse "the release field of $signature_file has characters a metric label cannot carry"
printf '%s\n' "$upstream" | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+$' \
  || refuse "the upstream field of $signature_file is not three numbers separated by dots"

{
  echo '# HELP hostyour_kernel_info The running kernel, read from /proc/version_signature.'
  echo '# TYPE hostyour_kernel_info gauge'
  printf 'hostyour_kernel_info{release="%s",upstream="%s"} 1\n' "$release" "$upstream"
} > "$partial"
chmod 0644 "$partial"
mv -f "$partial" "$reading"
