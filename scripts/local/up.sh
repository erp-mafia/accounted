#!/usr/bin/env bash
# npm run local:up: see scripts/local/up.ts, which does the work.
#
# This wrapper gives the checkout a node_modules that tsx can run from,
# Turbopack accepts and package-lock.json describes. A worktree has either none
# or a symlink to the main checkout's install, and Turbopack refuses that
# symlink ("points out of the filesystem root"). A hard-linked copy of the main
# checkout's install takes seconds and no extra disk, then npm fetches only
# what the lockfile names and the copy lacks. The copy shares file contents
# with the main checkout, so never patch a file under it in place.
set -euo pipefail

# Next.js loads these next to the env file local:up writes, so their keys
# (production ones, in .env.local's case) would reach the dev server. Checked
# before anything here changes.
for file in .env .env.local .env.development; do
  if [ -e "$file" ]; then
    echo "local:up: $file exists here and next dev would load its keys. Run local:up from a worktree without it (git worktree add ../wt/<name> origin/main)." >&2
    exit 1
  fi
done

if [ ! -d node_modules ] || [ -L node_modules ]; then
  main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
  if [ "$main" = "$(pwd)" ] || [ ! -d "$main/node_modules" ]; then
    echo "local:up: node_modules is missing: run npm ci" >&2
    exit 1
  fi
  if [ "$(uname)" != "Linux" ]; then
    echo "local:up: node_modules must be a real install (Turbopack refuses a symlink): run npm ci" >&2
    exit 1
  fi
  echo "Hard-linking node_modules from $main"
  # Only ever a symlink or nothing here: a real directory skipped this block.
  rm -f node_modules
  cp -al "$main/node_modules" node_modules
fi

# Bring the install to exactly what package-lock.json names: a copy can lag
# main by whole packages. Only the difference is fetched (seconds). npm
# rewrites its hidden lockfile in place, so the copy gets its own first.
if [ "$(stat -c %h node_modules/.package-lock.json 2>/dev/null || echo 1)" != "1" ]; then
  rm node_modules/.package-lock.json
fi
npm_flags=(--no-save --no-audit --no-fund)
# npm 12 refuses dependencies fetched from a URL unless allowed (xlsx comes from its CDN).
if [ "$(npm --version | cut -d. -f1)" -ge 12 ]; then npm_flags+=(--allow-remote=root); fi
npm install "${npm_flags[@]}"

exec node_modules/.bin/tsx --conditions react-server scripts/local/up.ts "$@"
