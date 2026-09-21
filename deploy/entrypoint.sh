#!/usr/bin/env bash
# Put the app's memory on the volume before the app looks for it.
#
# Every stateful file this backend keeps sits next to the module that writes
# it, in services/automation/. That is fine on a desk and wrong in a
# container, where the filesystem is thrown away on every deploy. Mounting the
# volume over services/automation would take the code with it.
#
# So: the volume holds the state under /data, and each name is symlinked back
# into services/automation before uvicorn starts. A name that exists in the
# image but not yet on the volume is moved across once, so the first boot
# inherits whatever was baked in rather than starting empty.
set -euo pipefail

DATA="${MAPJOB_DATA:-/data}"
HOME_DIR=/app/services/automation

# Files and directories the app writes to. Adding a new one is a one-line
# change here; forgetting to add it means losing it on the next deploy.
NAMES=(
  applications.jsonl          # the outcome ledger
  automation_vault.db
  outreach.db
  verify_cache.db
  profile.json
  profiles                    # one folder per account
  agent_profile.json
  portal_accounts.json
  mailboxes.json
  geocode_cache.json
  cookies_vault.json
  cookies_vault.prev.json
  saved_cookies.json
  browser_use_cache.json
  cloud_account.json
  documents                   # generated letters, Deckblätter, tailored CVs
  cv_master
  user_data
  screenshots
)

mkdir -p "$DATA"

for name in "${NAMES[@]}"; do
  target="$DATA/$name"
  link="$HOME_DIR/$name"

  # First boot with something baked into the image: carry it over, once.
  if [ ! -e "$target" ] && [ -e "$link" ] && [ ! -L "$link" ]; then
    mv "$link" "$target"
  fi

  # Nothing anywhere: make an empty one, so the app finds a path and not a
  # dangling link. A name with a dot is a file; the rest are directories.
  if [ ! -e "$target" ]; then
    case "$name" in
      *.*) : > "$target" ;;
      *)   mkdir -p "$target" ;;
    esac
  fi

  rm -rf "$link"
  ln -s "$target" "$link"
done

# An empty file is not valid JSON, and several modules read theirs at import.
for name in profile.json agent_profile.json portal_accounts.json mailboxes.json \
            geocode_cache.json cookies_vault.json browser_use_cache.json \
            cloud_account.json cookies_vault.prev.json; do
  [ -s "$DATA/$name" ] || printf '{}' > "$DATA/$name"
done
# ...and this one is read as a list.
[ -s "$DATA/saved_cookies.json" ] || printf '[]' > "$DATA/saved_cookies.json"

exec "$@"

