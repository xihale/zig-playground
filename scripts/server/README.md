# gx webhook deploy — shared receiver (2026-10)

Push → deploy for all five sites on gx (1.14.133.242), with **zero hand-written
receiver code**: a generic off-the-shelf receiver (adnanh/webhook) plus one
config whitelist. Replaces the five per-site `webhook.mjs` copies
(~230 lines each) and their ten systemd units.

## Path of a push

```
GitHub push
  → repo webhook  (URL https://<site>/hooks/<id>, secret in /home/<user>/.webhook-secret)
  → Caddy @deployhook  (path matcher → reverse_proxy unix//run/webhook.sock)
  → systemd socket activation  (webhook.socket, idle = 0 processes)
  → webhook 2.8.3  (user `webhook`, /etc/webhook/hooks.json)
      rules per entry: HMAC-SHA256 signature AND ref == pinned branch
  → sudo  (/etc/sudoers.d/webhook-deploy, args pinned per site)
  → /usr/local/lib/webhook-deploy  (runner: runs deploy.sh, appends ~/deploy.log,
                                    best-effort ntfy to ~/.ntfy-notify)
  → <clone>/scripts/server/deploy.sh  (fetch → build → rsync → publish)
```

## Site registry

| site | user | clone | branch | hook id |
|---|---|---|---|---|
| zp.xeed.ink | zig-ci | ~/zig-playground | master | zp-deploy |
| xeed.ink | blog-ci | ~/blog | astro | blog-deploy |
| poetry.xeed.ink | poetry-ci | ~/poetry | main | poetry-deploy |
| sched.xeed.ink | sched-ci | ~/schedmate | main | sched-deploy |
| zlg.xeed.ink | ziglings-ci | ~/ziglings-web | main | ziglings-deploy |

zig-playground's default remote is the zigcc org (`origin` = zigcc/main,
`push.default=upstream`); the deploy hook lives on the `xihale` remote, so a
deploy push is `git push xihale master:master` — a bare `git push` only goes
to zigcc.

## Files

Server (canonical; `webhook-deploy`, `webhook.socket`, `webhook.service`,
`hooks.json.example` in this directory are the repo copies of the gx assets):

- `/usr/local/bin/webhook` — upstream static binary v2.8.3 (Debian's 2.8.0
  package lacks socket activation; upgrade = swap the binary).
- `/usr/local/lib/webhook-deploy` — shared runner, owned root:root 0755.
- `/etc/webhook/hooks.json` — the whitelist. root:webhook 640; `-hotreload`
  is on, edits apply live. Regenerate with the `gen()` block in
  `hooks.json.example` (secrets are read from the per-user `.webhook-secret`
  on the server and must never leave it).
- `/etc/sudoers.d/webhook-deploy` — one line per site; pins runner path,
  deploy.sh path, ref and project (trailing `*` is the pushed sha).
- `/etc/systemd/system/webhook.{socket,service}` — socket owned
  `webhook:caddy` 0660; Caddy dials it.

Repo (`scripts/server/` in each site's repository): `deploy.sh` (the build
logic — the only thing the receiver is allowed to run) + this README.

## Adding a site

1. Server: `useradd -u <uid> -m <site>-ci`, clone the repo, `openssl rand -hex 32`
   → `~/.webhook-secret` (0600), optionally `~/.ntfy-notify` (topic + user:pass).
2. Register the GitHub hook (`config.url` must be inside `config`):
   `https://<domain>/hooks/<site>-deploy` with that secret.
3. Caddy: `@deployhook { path /hooks/<site>-deploy method POST }` +
   `reverse_proxy @deployhook unix//run/webhook.sock` first in the route.
4. `hooks.json`: append an entry (`gen()` in `hooks.json.example`) — hotreload picks it up.
5. `sudoers.d/webhook-deploy`: append the pinned line.
   No new units, no new code.

## Semantics vs the old webhook.mjs

- Unsigned request (no signature header) → 200 "hook rules were not satisfied",
  nothing runs (GitHub always signs; scanners get nothing).
- Wrong signature → 500 (before: 403).
- ping / non-deploy branch → 200, nothing runs (before: explicit pong).
- Branch **deletion** now walks into deploy.sh and fails (fetch of a dead ref)
  with a failure ntfy — the old code 200-ignored it. Rare; acceptable noise.
- After the first delivery the service stays resident (~10 MB Go process).
  `systemctl stop webhook.service` returns to 0; the socket reactivates it.
  Old units were per-request spawns (0 always) — accepted trade for deleting
  ~1200 lines.
- deploy.sh concurrency/queueing (flock + rerun), ZP_PUSH_SHA and the
  ntfy message format `[project@gx] deploy success/failure` are unchanged.

## Gotchas

- **No `command-working-directory` in hooks.json entries.** The `<site>-ci`
  homes are `0700`, so the `webhook` user cannot chdir into them; the spawn
  then fails silently while GitHub still records a 200 delivery. The runner
  ignores its cwd and every `deploy.sh` cds into its own clone.
- **Rebuilding hooks.json with `jq > .new && mv` breaks `-hotreload`** (the
  inotify watch dies with the old inode) — edits apply but replacements need
  `systemctl restart webhook.service`. Prefer in-place edits, or restart.
- Upgrading = swapping the binary at `/usr/local/bin/webhook` (currently
  2.8.3; check `webhook -version`).

## Recovery

- Receiver down: `journalctl -u webhook -u webhook.socket`; restart =
  `systemctl start webhook.socket` (service is socket-activated).
- Suspect the whitelist: `jq '.[].id' /etc/webhook/hooks.json`.
- Full rollback: Caddyfile backups live at `/etc/caddy/Caddyfile.bak-webhook-*`;
  the retired per-site units are in git history (`scripts/server/` before
  2026-10) if ever needed again.
- Manual deploy (bypasses the receiver entirely):
  `sudo -u zig-ci bash ~/zig-playground/scripts/server/deploy.sh refs/heads/master`.
