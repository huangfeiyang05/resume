#!/usr/bin/env bash
# Run as root on the existing single-process server:
#   activate-release.sh RELEASE_ID EXPECTED_PREVIOUS_RELEASE_PATH GIT_COMMIT
# EXPECTED_PREVIOUS may also be a release ID. This script changes only the
# current symlink, service state and a new restricted backup directory. It never
# installs configuration, restores old data, or copies credentials from a release.
set -Eeuo pipefail
umask 077

readonly APP_ROOT=/opt/resume-youfang
readonly RELEASES_ROOT=/opt/resume-youfang/releases
readonly CURRENT=/opt/resume-youfang/current
readonly STATE_DIR=/var/lib/resume-youfang/.data
readonly DATA_FILE=/var/lib/resume-youfang/.data/resumes.json
readonly CATALOG_FILE=/var/lib/resume-youfang/.data/career-catalog.json
readonly COMPANY_FILE=/var/lib/resume-youfang/.data/company-catalog.json
readonly COMPANY_BATCHES=/var/lib/resume-youfang/.data/company-batches
readonly CAREER_FILES=/var/lib/resume-youfang/.data/career-files
readonly BACKUP_ROOT=/var/backups/resume-youfang
readonly NODE=/opt/nodejs/bin/node
readonly SERVICE=resume-youfang
readonly APP_USER=resume-youfang
readonly LOCK=/run/lock/resume-youfang-deploy.lock

if [[ ${EUID} -ne 0 || $# -ne 3 ]]; then
  printf '%s\n' 'activation_failed: run as root with RELEASE_ID EXPECTED_PREVIOUS GIT_COMMIT' >&2
  exit 1
fi

release_id=$1
previous_input=$2
expected_commit=$3
if [[ ! $release_id =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$ || ! $expected_commit =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ ]]; then
  printf '%s\n' 'activation_failed: invalid release ID or full Git commit' >&2
  exit 1
fi
previous_id=${previous_input#"$RELEASES_ROOT/"}
if [[ ! $previous_id =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$ ]]; then
  printf '%s\n' 'activation_failed: expected previous must be a release ID or its absolute release path' >&2
  exit 1
fi
readonly RELEASE_DIR="$RELEASES_ROOT/$release_id"
readonly PREVIOUS_DIR="$RELEASES_ROOT/$previous_id"
readonly BACKUP_DIR="$BACKUP_ROOT/$release_id"
stage=preflight
service_touched=0
backup_created=0
temporary_link=''
temporary_link_owned=0

current_target() { readlink -f -- "$CURRENT" 2>/dev/null || true; }

atomic_switch() {
  local destination=$1
  temporary_link="$APP_ROOT/.current-$release_id-$$"
  temporary_link_owned=0
  # No force option: never overwrite a pre-existing temporary file or symlink.
  ln -s -- "$destination" "$temporary_link" >/dev/null 2>&1 || return 1
  temporary_link_owned=1
  mv -Tf -- "$temporary_link" "$CURRENT" >/dev/null 2>&1 || return 1
  temporary_link=''
  temporary_link_owned=0
}

http_status() {
  # --disable ignores a root .curlrc; these probes carry no session or credentials.
  curl --disable --silent --noproxy '*' --proto '=http' --connect-timeout 1 --max-time 2 \
    --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:3001/api/v1/$1" 2>/dev/null || true
}

wait_for_health() {
  local attempt
  for ((attempt=0; attempt<10; attempt++)); do
    if systemctl is-active --quiet "$SERVICE" && [[ $(http_status health) == 200 ]]; then return 0; fi
    sleep 1
  done
  return 1
}

failure() {
  local code=${1:-1}
  local rollback=not_needed
  local pointer
  trap - ERR HUP INT TERM
  set +e
  if [[ $temporary_link_owned == 1 && -n $temporary_link && -L $temporary_link ]]; then rm -f -- "$temporary_link" >/dev/null 2>&1; fi
  if [[ $service_touched == 1 ]]; then
    pointer=$(current_target)
    if [[ $pointer == "$RELEASE_DIR" || $pointer == "$PREVIOUS_DIR" ]]; then
      # Keep all data written by either program. A rollback switches code only.
      systemctl stop "$SERVICE" >/dev/null 2>&1
      if [[ $(current_target) == "$RELEASE_DIR" ]]; then
        if ! atomic_switch "$PREVIOUS_DIR"; then
          rollback=failed_switch
        else
          rollback=switched
        fi
      else
        rollback=switched
      fi
      if [[ $rollback == switched ]]; then
        if systemctl start "$SERVICE" >/dev/null 2>&1 && wait_for_health; then rollback=healthy; else rollback=failed_start; fi
      fi
    else
      # Another operator changed current without this lock. Do not overwrite it.
      rollback=skipped_current_changed
    fi
  fi
  if [[ $temporary_link_owned == 1 && -n $temporary_link && -L $temporary_link ]]; then rm -f -- "$temporary_link" >/dev/null 2>&1; fi
  printf 'status=failed stage=%s release=%s previous=%s backup=%s rollback=%s\n' \
    "$stage" "$release_id" "$previous_id" "$([[ $backup_created == 1 ]] && printf '%s' "$BACKUP_DIR")" "$rollback" >&2
  [[ $code -ne 0 ]] || code=1
  exit "$code"
}
trap 'failure "$?"' ERR
trap 'failure 129' HUP
trap 'failure 130' INT
trap 'failure 143' TERM

abort() { failure 1; }

for command in flock readlink runuser systemctl curl install ln mv mkdir; do
  command -v "$command" >/dev/null 2>&1 || abort
done
[[ -x $NODE ]] || abort
id -u "$APP_USER" >/dev/null 2>&1 || abort
[[ $RELEASE_DIR != "$PREVIOUS_DIR" && -d $APP_ROOT && -d $RELEASES_ROOT && -L $CURRENT ]] || abort
[[ -d $RELEASE_DIR && ! -L $RELEASE_DIR && -d $PREVIOUS_DIR && ! -L $PREVIOUS_DIR ]] || abort
[[ $(readlink -f -- "$RELEASE_DIR") == "$RELEASE_DIR" && $(readlink -f -- "$PREVIOUS_DIR") == "$PREVIOUS_DIR" ]] || abort

# The deployment lock is private and lives outside both the release and data trees.
[[ ! -L $LOCK ]] || abort
exec 9>"$LOCK"
flock -n 9 || abort
[[ $(current_target) == "$PREVIOUS_DIR" ]] || abort
[[ ! -e $BACKUP_DIR && ! -L $BACKUP_DIR && ! -L $BACKUP_ROOT ]] || abort
[[ ! -L $STATE_DIR && ( ! -e $STATE_DIR || -d $STATE_DIR ) ]] || abort
[[ ! -L $COMPANY_BATCHES && ( ! -e $COMPANY_BATCHES || -d $COMPANY_BATCHES ) ]] || abort
[[ ! -L $CAREER_FILES && ( ! -e $CAREER_FILES || -d $CAREER_FILES ) ]] || abort
for path in "$DATA_FILE" "$CATALOG_FILE" "$COMPANY_FILE"; do
  [[ ! -L $path && ( ! -e $path || -f $path ) ]] || abort
done
systemctl is-active --quiet nginx || abort
systemctl is-active --quiet "$SERVICE" || abort

stage=artifact_validation
for path in \
  release.json www/index.html api/package.json api/server/index.js api/server/store.js \
  api/server/assets/career/catalog.json api/server/assets/fonts/SourceHanSansCN-Regular.otf \
  api/node_modules/yaml/package.json api/node_modules/nodemailer/package.json \
  api/node_modules/pdfkit/package.json api/node_modules/jszip/package.json \
  www/static/resume-templates/classic-onyx.docx www/static/resume-templates/classic-onyx.jpg \
  www/static/resume-templates/blue-azurill.docx www/static/resume-templates/blue-azurill.jpg \
  www/static/resume-templates/navy-chikorita.docx www/static/resume-templates/navy-chikorita.jpg; do
  [[ -f "$RELEASE_DIR/$path" && ! -L "$RELEASE_DIR/$path" ]] || abort
done
"$NODE" --input-type=module - "$RELEASE_DIR" "$expected_commit" >/dev/null 2>&1 <<'NODE'
import { readFile } from 'node:fs/promises';
try {
  const [directory, commit] = process.argv.slice(2);
  const metadata = JSON.parse(await readFile(`${directory}/release.json`, 'utf8'));
  const runtime = JSON.parse(await readFile(`${directory}/api/package.json`, 'utf8'));
  if (metadata.gitCommit !== commit || metadata.gitDirty !== false || runtime.type !== 'module') process.exit(1);
} catch { process.exit(1); }
NODE

validate_data() {
  # JsonStore.read() validates and clones in memory; it must never write migrations.
  runuser -u "$APP_USER" -- "$NODE" --input-type=module - "$RELEASE_DIR" "$DATA_FILE" "$COMPANY_FILE" >/dev/null 2>&1 <<'NODE'
import { pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
try {
  const [directory, database, companies] = process.argv.slice(2);
  const { JsonStore } = await import(pathToFileURL(`${directory}/api/server/store.js`).href);
  const data = await new JsonStore(database).read();
  const media = { ...data.careerAttachments, ...data.careerVideos };
  if (Object.keys(media).length) {
    const { CareerFiles } = await import(pathToFileURL(`${directory}/api/server/career-files.js`).href);
    const files = new CareerFiles(database);
    const attachments = new Map(Object.values(media).map(item => [item.id, item]));
    for (const attachment of attachments.values()) {
      const { handle } = await files.file(attachment.id, attachment.format, attachment.bytes);
      await handle.close();
    }
  }
  try {
    if ((await stat(companies)).size > 20 * 1024 * 1024) process.exit(1);
    const { validateCompanyCatalog } = await import(pathToFileURL(`${directory}/api/server/company-validation.js`).href);
    validateCompanyCatalog(JSON.parse(await readFile(companies, 'utf8')));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
} catch { process.exit(1); }
NODE
}

stage=data_compatibility
validate_data
[[ $(current_target) == "$PREVIOUS_DIR" ]] || abort

stage=stop_and_backup
service_touched=1
systemctl stop "$SERVICE" >/dev/null 2>&1
[[ $(current_target) == "$PREVIOUS_DIR" ]] || abort
# Recheck the final, stopped-process snapshot rather than relying on a pre-stop read.
validate_data
install -d -m 0700 -o root -g root -- "$BACKUP_ROOT" >/dev/null 2>&1
mkdir -m 0700 -- "$BACKUP_DIR" >/dev/null 2>&1
backup_created=1
data_present=false
catalog_present=false
companies_present=false
files_present=false
if [[ -f $DATA_FILE && ! -L $DATA_FILE ]]; then
  install -m 0600 -o root -g root -- "$DATA_FILE" "$BACKUP_DIR/resumes.json" >/dev/null 2>&1
  data_present=true
fi
if [[ -f $CATALOG_FILE && ! -L $CATALOG_FILE ]]; then
  install -m 0600 -o root -g root -- "$CATALOG_FILE" "$BACKUP_DIR/career-catalog.json" >/dev/null 2>&1
  catalog_present=true
fi
if [[ -f $COMPANY_FILE && ! -L $COMPANY_FILE ]]; then
  install -m 0600 -o root -g root -- "$COMPANY_FILE" "$BACKUP_DIR/company-catalog.json" >/dev/null 2>&1
  companies_present=true
fi
if [[ -d $COMPANY_BATCHES && ! -L $COMPANY_BATCHES ]]; then
  install -d -m 0700 -o root -g root -- "$BACKUP_DIR/company-batches"
  for file in "$COMPANY_BATCHES"/*.json; do
    [[ ${file##*/} =~ ^(journal|[a-f0-9]{64})\.json$ ]] || continue
    [[ -f $file && ! -L $file ]] || abort
    install -m 0600 -o root -g root -- "$file" "$BACKUP_DIR/company-batches/${file##*/}"
  done
fi
if [[ -d $CAREER_FILES && ! -L $CAREER_FILES ]]; then
  install -d -m 0700 -o root -g root -- "$BACKUP_DIR/career-files"
  for file in "$CAREER_FILES"/*; do
    [[ ${file##*/} =~ ^[a-f0-9]{64}\.(pdf|docx|mp4)$ ]] || continue
    [[ -f $file && ! -L $file ]] || abort
    install -m 0600 -o root -g root -- "$file" "$BACKUP_DIR/career-files/${file##*/}"
  done
  files_present=true
fi
printf '{"releaseId":"%s","previous":"%s","gitCommit":"%s","dataFilePresent":%s,"catalogFilePresent":%s,"companyFilePresent":%s,"careerFilesPresent":%s}\n' \
  "$release_id" "$previous_id" "$expected_commit" "$data_present" "$catalog_present" "$companies_present" "$files_present" >"$BACKUP_DIR/manifest.json"

stage=activate
[[ $(current_target) == "$PREVIOUS_DIR" ]] || abort
atomic_switch "$RELEASE_DIR"
systemctl start "$SERVICE" >/dev/null 2>&1

stage=health_verification
wait_for_health
[[ $(current_target) == "$RELEASE_DIR" ]] || abort
[[ $(http_status resumes) == 401 && $(http_status career) == 401 && $(http_status career/companies) == 401 ]] || abort
systemctl is-active --quiet nginx || abort

trap - ERR HUP INT TERM
printf 'status=activated release=%s previous=%s gitCommit=%s backup=%s\n' \
  "$release_id" "$previous_id" "$expected_commit" "$BACKUP_DIR"
