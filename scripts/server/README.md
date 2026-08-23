# Server-side deploy (zp.xihale.top)

Deploy without a GitHub Actions runner: GitHub sends a **push webhook** to
`https://zp.xihale.top/hooks/zp-deploy`; Caddy proxies that path to a systemd
**socket-activated** receiver (`webhook.mjs`) that verifies the GitHub
HMAC-SHA256 signature and runs `deploy.sh`. Nothing runs while idle — a
receiver process exists only for the seconds a request (or deploy) takes.

## Pieces (all on zzy_hk)

| what | where |
| --- | --- |
| persistent clone | `/home/zig-ci/zig-playground` |
| webhook secret | `/home/zig-ci/.webhook-secret` (0600, zig-ci; same value as the GitHub hook) |
| deploy log | `/home/zig-ci/deploy.log` |
| receiver | `scripts/server/webhook.mjs` (from the clone) |
| deploy job | `scripts/server/deploy.sh` (from the clone) |
| socket | `/run/zig-deploy.sock` (zig-ci:caddy 0660) |
| published site | `/srv/zig-playground` (Caddy serves it) |

## Units

`/etc/systemd/system/zig-deploy.socket`:

```ini
[Unit]
Description=zig-playground deploy webhook (socket-activated)

[Socket]
# Accept=yes → template service (zig-deploy@.service), one instance per
# connection with the accepted socket as fd 0/1 (inetd-style).
Accept=yes
ListenStream=/run/zig-deploy.sock
SocketUser=zig-ci
SocketGroup=caddy
SocketMode=0660
RemoveOnStop=true

[Install]
WantedBy=sockets.target
```

`/etc/systemd/system/zig-deploy@.service` (template: one instance per
connection, `Accept=yes` passes the connection as fd 0/1):

```ini
[Unit]
Description=zig-playground webhook %i
Requires=zig-deploy.socket

[Service]
User=zig-ci
Group=zig-ci
Type=oneshot
StandardInput=socket
StandardOutput=socket
StandardError=journal
ExecStart=/usr/local/bin/node /home/zig-ci/zig-playground/scripts/server/webhook.mjs
Environment=HOME=/home/zig-ci
TimeoutStartSec=45min
# Be a good neighbor on a shared box
Nice=5
IOSchedulingClass=best-effort
IOSchedulingPriority=6
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/zig-ci /srv/zig-playground
```

Enable once (root): `systemctl daemon-reload && systemctl enable --now zig-deploy.socket`

## Caddy

Inside the `zp.xihale.top` site block (matcher next to `@short`, proxy first in
`route`):

```caddyfile
	@deployhook {
		path /hooks/zp-deploy
		method POST
	}
	route {
		reverse_proxy @deployhook unix//run/zig-deploy.sock
		…existing directives…
	}
```

## GitHub webhook (one-time)

```sh
SECRET=$(ssh zzy_hk 'cat /home/zig-ci/.webhook-secret')
gh api -X POST repos/xihale/zig-playground/hooks \
  -f url='https://zp.xihale.top/hooks/zp-deploy' \
  -f content_type='json' -f secret="$SECRET" -f 'events[]=push' -F active=true
```

## Ops

```sh
ssh zzy_hk
tail -f /home/zig-ci/deploy.log                  # deploy output
journalctl -t zig-deploy@ -e                     # receiver lifecycle (start/exit)
curl -s https://zp.xihale.top/deploy-meta.json   # what sha is live (1d cache)
# manual deploy:
sudo -u zig-ci bash /home/zig-ci/zig-playground/scripts/server/deploy.sh
```

Rollback = `git` any old sha in the clone and re-run deploy.sh. Compiler
rebuilds (new versions.json ids missing from the `compilers` release) happen
inside deploy.sh via `build-compilers.mjs` with hostZig from
`~/.local/share/zvm`.
