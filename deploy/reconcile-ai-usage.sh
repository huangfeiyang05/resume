#!/usr/bin/env bash
# Offline only: stop the existing service first; this operation never starts/stops it itself.
set -Eeuo pipefail
umask 077
[[ ${EUID} -eq 0 && $# -eq 1 ]] || { printf '%s\n' 'Run as root with a restricted supplier-evidence JSON file.' >&2; exit 1; }
readonly evidence=$1
readonly data=/var/lib/resume-youfang/.data/resumes.json
readonly lock=/run/lock/resume-youfang-deploy.lock
readonly backup_root=/var/backups/resume-youfang
readonly current=/opt/resume-youfang/current
[[ -f $evidence && ! -L $evidence && -f $data && ! -L $data && ! -L $lock ]] || exit 1
[[ ! -L /var/lib/resume-youfang && ! -L /var/lib/resume-youfang/.data ]] || exit 1
[[ $(stat -c '%u' -- "$evidence") == 0 ]] || exit 1
evidence_mode=$(stat -c '%a' -- "$evidence")
[[ $evidence_mode == 600 || $evidence_mode == 400 ]] || { printf '%s\n' 'Evidence must be root-owned and mode 0600 or 0400.' >&2; exit 1; }
exec 9>"$lock"
flock -n 9
[[ $(systemctl show resume-youfang --property=LoadState --value) == loaded ]] || exit 1
[[ $(systemctl show resume-youfang --property=MainPID --value) == 0 ]] || exit 1
service_state=$(systemctl show resume-youfang --property=ActiveState --value)
[[ $service_state == inactive || $service_state == failed ]] || { printf '%s\n' 'Service must be stopped before offline reconciliation.' >&2; exit 1; }
[[ -L $current && -f $current/ops/reconcile-ai-usage.mjs && $(stat -c '%s' -- "$evidence") -le 8192 ]] || exit 1
[[ ! -L $backup_root ]] || exit 1
install -d -m 0700 -o root -g root -- "$backup_root"
backup=$(mktemp -d "$backup_root/quota-reconcile-XXXXXXXX")
install -m 0600 -o root -g root -- "$data" "$backup/resumes.json"
runuser -u resume-youfang -- env RESUME_QUOTA_OFFLINE=service-stopped /opt/nodejs/bin/node "$current/ops/reconcile-ai-usage.mjs" < "$evidence"
printf 'backup=%s\n' "$backup"
