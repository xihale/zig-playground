#!/usr/bin/env bash
# Server-side deploy job for zp.xihale.top — started by scripts/server/webhook.mjs
# (or manually: ssh zzy_hk, then `sudo -u zig-ci bash ~/zig-playground/scripts/server/deploy.sh`).
#
# Mirrors the retired .github/workflows/deploy.yml:
#   1. shallow-fetch the pushed branch into the persistent clone
#   2. fill public/compilers/<id>/ from the public `compilers` release
#      (incremental: ids with meta.json are never re-downloaded;
#      falls back to a source build via build-compilers.mjs if an id
#      is missing from the release — hostZig lives in ~/.local/share/zvm)
#   3. npm ci + vite build + assemble dist
#   4. pre-gzip wasm, rsync to /srv/zig-playground (Caddy serves it);
#      hashed /assets/ retire into ~/zp-attic for ~7d (outlives shell TTL)
set -Eeuo pipefail
umask 022

REF="${1:-refs/heads/master}"
BRANCH="${REF#refs/heads/}"
REPO=/home/zig-ci/zig-playground
DEST=/srv/zig-playground
LOCK=/home/zig-ci/.deploy.lock
RERUN=/home/zig-ci/.deploy-rerun
RELEASE_TAG="${COMPILERS_RELEASE:-compilers}"
REPO_URL="https://github.com/xihale/zig-playground"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { say "FATAL: $*"; exit 1; }

cd "$REPO"

# One deploy at a time; a push that lands mid-deploy queues exactly one rerun
# (latest commit wins — the queued rerun fetches the newest sha anyway).
exec 9>"$LOCK"
if ! flock -n 9; then
  touch "$RERUN"
  say "deploy already running — queued one rerun"
  exit 0
fi

say "=== deploy start (${BRANCH}, sha=${ZP_PUSH_SHA:-unknown}) ==="

# Snapshot the running script BEFORE the fetch: bash keeps executing the old
# inode across the checkout, but $0 is just a path and resolves to the new
# file afterwards — path-to-path comparison can never detect the change.
SELF_SNAP=$(mktemp)
cat "$0" > "$SELF_SNAP"

git fetch --depth=1 origin "$BRANCH"
git checkout -q -B "$BRANCH" FETCH_HEAD
# untracked caches (public/compilers, node_modules, .zig-version-cache) survive on purpose

# We were spawned from the pre-fetch checkout; if deploy.sh itself changed,
# re-exec so the new revision's logic publishes this push. After the re-exec
# the snapshot equals the file, so this fires at most once.
if ! cmp -s "$SELF_SNAP" "$REPO/scripts/server/deploy.sh"; then
  rm -f "$SELF_SNAP"
  say "deploy.sh changed in ${BRANCH} — re-execing from new checkout"
  exec /bin/bash "$REPO/scripts/server/deploy.sh" "$@"
fi
rm -f "$SELF_SNAP"

# --- compilers: incremental fill from the public release -------------------
mkdir -p public/compilers .zig-version-cache
mapfile -t IDS < <(node --input-type=module -e '
  import { loadVersionsManifest } from "./scripts/versions-lib.mjs";
  process.stdout.write(loadVersionsManifest().versions.map(v => v.id).join("\n"));
')
missing=()
for id in "${IDS[@]}"; do
  if [ -f "public/compilers/$id/meta.json" ]; then
    say "compilers/$id: cached"
    continue
  fi
  if curl -fsSL --retry 2 -o ".zig-version-cache/$id.tar.gz" \
      "$REPO_URL/releases/download/$RELEASE_TAG/$id.tar.gz"; then
    mkdir -p "public/compilers/$id"
    tar -xzf ".zig-version-cache/$id.tar.gz" -C "public/compilers/$id"
    say "compilers/$id: fetched from release $RELEASE_TAG"
  else
    missing+=("$id")
  fi
done

# --- fallback: build missing ids from source (as deploy.yml did) -----------
if [ "${#missing[@]}" -gt 0 ]; then
  say "not in release: ${missing[*]} — rebuilding from source"
  # binaryen/jq/xz are preinstalled system-wide on the host.
  mapfile -t HOSTS < <(node --input-type=module -e '
    import { loadVersionsManifest } from "./scripts/versions-lib.mjs";
    const hosts = [...new Set(loadVersionsManifest().versions.map(v => v.hostZig).filter(Boolean))];
    process.stdout.write(hosts.join("\n"));
  ')
  mkdir -p "$HOME/.local/share/zvm"
  index=$(mktemp)
  curl -fsSL https://ziglang.org/download/index.json > "$index"
  for host in "${HOSTS[@]}"; do
    dest="$HOME/.local/share/zvm/$host"
    [ -x "$dest/zig" ] && continue
    if [ "$host" = "master" ]; then
      url=$(jq -r '.master["x86_64-linux"].tarball' "$index")
    else
      url=$(jq -r --arg v "$host" '.[$v]["x86_64-linux"].tarball // empty' "$index")
    fi
    if [ -z "$url" ] || [ "$url" = "null" ]; then
      die "no x86_64-linux tarball for hostZig=$host"
    fi
    tmp=$(mktemp -d)
    curl -fsSL "$url" | tar -xJ -C "$tmp"
    inner=$(find "$tmp" -maxdepth 1 -type d -name 'zig-*' | head -1)
    mkdir -p "$dest"
    cp -a "$inner"/. "$dest"/
    "$dest/zig" version
  done
  node scripts/build-compilers.mjs --select all --skip-existing
fi

node --input-type=module -e '
  import { loadVersionsManifest } from "./scripts/versions-lib.mjs";
  import { existsSync } from "node:fs";
  const m = loadVersionsManifest();
  const miss = m.versions.filter(v => !existsSync(`public/compilers/${v.id}/meta.json`));
  if (miss.length) { console.error("missing compiler packages:", miss.map(v => v.id).join(" ")); process.exit(1); }
  if (!existsSync(`public/compilers/${m.default}/meta.json`)) { console.error("default compiler missing:", m.default); process.exit(1); }
'

# --- frontend build + publish ----------------------------------------------
npm ci
npm run build
find dist -name "*.wasm" -exec gzip -k9 {} +

printf '{"sha":"%s","branch":"%s","deployedAt":"%s"}\n' \
  "$(git rev-parse HEAD)" "$BRANCH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > dist/deploy-meta.json

# Shells/manifests/compilers replace wholesale. Hashed UI chunks retire into
# a timestamped attic instead of being deleted: a shell cached for 5d may
# still reference them (max-age set in vite.config.js / the Caddy block —
# keep TTL < retention when changing either side). Attic dirs are pruned by
# their own age, i.e. measured from retirement, independent of deploy cadence.
# $HOME (not /srv) — web-served tree + ReadWritePaths=…/srv/zig-playground only.
ATTIC="$HOME/zp-attic"
mkdir -p "$ATTIC"
rsync -a --delete --delay-updates --exclude=/assets \
  --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
  dist/ "$DEST/"
# --checksum: dist mtimes are always fresh, so quick-check would rewrite (and
# thus --backup) every file each deploy; content comparison makes the attic
# hold only genuinely retired assets.
rsync -a --delete --checksum --backup --backup-dir="$ATTIC/$(date -u +%Y%m%dT%H%M%S)" \
  --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
  dist/assets/ "$DEST/assets/"
# GNU find rounds age up: +6 = 7 full days = 5d shell TTL + 2d margin.
find "$ATTIC" -mindepth 1 -maxdepth 1 -type d -mtime +6 -exec rm -rf {} +
say "published $(git rev-parse --short HEAD) → $DEST (attic: $(du -sh "$ATTIC" 2>/dev/null | cut -f1))"

say "=== deploy done ==="
if [ -e "$RERUN" ]; then
  rm -f "$RERUN"
  say "a newer push arrived during this deploy — running again"
  exec /bin/bash "$0" "$REF"
fi
