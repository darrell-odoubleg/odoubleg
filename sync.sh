#!/bin/bash
# Pull each app's local commits into its folder here, then push to GitHub.
set -euo pipefail
cd /srv/odoubleg
declare -A APPS=(
  [events]=/var/www/events-odoubleg
  [mist]=/var/www/mist-odoubleg
  [sitenotes]=/var/www/sitenotes-odoubleg
)
for prefix in "${!APPS[@]}"; do
  src=${APPS[$prefix]}
  branch=$(git -C "$src" branch --show-current)
  if [ -d "$prefix" ]; then
    git subtree pull --prefix="$prefix" "$src" "$branch" -m "Sync $prefix from $src"
  else
    git subtree add --prefix="$prefix" "$src" "$branch" -m "Add $prefix from $src"
  fi
done
git push origin main
