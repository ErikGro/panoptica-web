# panoptica web
Interactive panoptica web app with static frontend client and server side evaluation

## Development

## Deployment

Deployment is automatic on every push to `main`, via the koflerlab webhook receiver
(`hooks.koflerlab.org`, repo `koflerlab/webhook`).

Flow:

1. Push to `main` runs `.github/workflows/deploy.yml`: it builds the frontend and force-pushes a
   prebuilt tree (built frontend + backend source) to the `koflerlab-dist` branch.
2. That push fires the GitHub webhook `https://hooks.koflerlab.org/hooks/deploy-panoptica-web`.
3. The webhook runs `deploy/panoptica-web.sh` (in `koflerlab/webhook`) as the unprivileged
   `webhook-user`: it pulls `koflerlab-dist` into `/opt/panoptica-web` and touches
   `/opt/panoptica-web/.deploy-request`.
4. Caddy serves `/opt/panoptica-web/frontend` directly, so the frontend is live immediately.
5. A `webhook-user` user-level systemd path unit sees the sentinel and restarts the backend user
   service, which runs `uv sync --frozen` and serves the new code on `127.0.0.1:8000`.

### One-time server setup

The backend runs as a **systemd user service owned by `webhook-user`** so no root/sudo/polkit is
needed at deploy time (matching the webhook repo's security rules). Run once:

```bash
# [root]
install -d -o webhook-user -g webhook-user /opt/panoptica-web
loginctl enable-linger webhook-user            # user services run without an active login

# uv, system-wide and root-owned (the units reference /usr/local/bin/uv).
# If you already ran the installer as another user, just copy the binary:
#   sudo install -m 0755 ~/.local/bin/uv /usr/local/bin/uv
# webhook-user needs a writable home for uv's cache and managed Python download
# (getent passwd webhook-user -> home must exist and be writable by it).

# as webhook-user: install the three user units from this repo
install -d ~/.config/systemd/user
install -m 0644 /opt/panoptica-web/deploy/systemd-user/*.{service,path} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now panoptica-restart.path
systemctl --user enable panoptica-server.service   # starts on first deploy (needs the source)

# [root] webhook secret (one per repo), then restart so it is picked up (env read only at start)
printf 'PANOPTICA_WEB_WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" >> /etc/webhook/webhook.env
systemctl restart webhook.service

# [root] Caddy site
install -m 0644 -o root -g root \
  /opt/panoptica-web/deploy/caddy/panoptica.koflerlab.org.caddyfile \
  /etc/caddy/conf.d/panoptica.koflerlab.org.caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
```

The user units cannot be installed by the deploy script (`webhook.service` runs with
`ProtectHome=yes`, which hides `/home` from it), so re-copy them by hand if they ever change.

### GitHub webhook

In `ErikGro/panoptica-web` → Settings → Webhooks, add
`https://hooks.koflerlab.org/hooks/deploy-panoptica-web`, content type `application/json`, the
`PANOPTICA_WEB_WEBHOOK_SECRET` value from setup, **push events only**.

## Server configuration
### caddyfile:
```
panoptica.koflerlab.org {
    handle /api/* {
        reverse_proxy 127.0.0.1:8000 # Locally exposed server socket
    }

    handle {
        root * /opt/panoptica-web/frontend
        try_files {path} /index.html
        file_server
    }
}
```