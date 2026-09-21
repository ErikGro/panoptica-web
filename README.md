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
   `webhook-user`: it pulls `koflerlab-dist` into `/opt/panoptica-web` and runs
   `systemctl restart panoptica-server.service`.
4. Caddy serves `/opt/panoptica-web/frontend` directly, so the frontend is live immediately.
5. `panoptica-server.service` (root-owned unit, runs as the unprivileged `panoptica` account) runs
   `uv sync --frozen` and serves the new code on `127.0.0.1:8000`.

### One-time server setup

The server-side pieces — deploy script, `hooks.yaml` entry, systemd unit, polkit rule, and Caddy
snippet — all live in **`koflerlab/webhook`**, checked out on the server at `/opt/webhook-config`
(auto-synced on push), so root installs the copies straight from there. The backend runs as a
dedicated unprivileged `panoptica` **system** service; `webhook-user` restarts it through a polkit
rule scoped to that one unit (the server wiki's sanctioned pattern — restarting a root-owned, non-root
unit escalates nothing). No linger, and nothing is written to any account's home (uv's cache/venv/
Python are redirected under `/var/lib/panoptica-web`).

Run once, by a human account with sudo (after `koflerlab/webhook`'s own deploy has synced these files
to `/opt/webhook-config`):

```bash
sudo ss -tlnp | grep -E ':(8000|90)'          # confirm 127.0.0.1:8000 is free

sudo useradd --system --home-dir /var/lib/panoptica-web --shell /sbin/nologin panoptica
sudo install -d -o webhook-user -g webhook-user /opt/panoptica-web

# uv, system-wide and root-owned (the unit calls /usr/local/bin/uv). If you installed it as
# another user, just copy the binary: sudo install -m 0755 ~/.local/bin/uv /usr/local/bin/uv

sudo install -m 0644 -o root -g root /opt/webhook-config/systemd/panoptica-server.service /etc/systemd/system/
sudo install -m 0644 -o root -g root /opt/webhook-config/polkit/49-panoptica-web.rules /etc/polkit-1/rules.d/
sudo systemctl daemon-reload
sudo systemctl enable panoptica-server.service   # starts on the first deploy (needs the source)

# webhook secret (one per repo), then restart so it is picked up (env read only at start)
printf 'PANOPTICA_WEB_WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" | sudo tee -a /etc/webhook/webhook.env
sudo systemctl restart webhook.service

sudo install -m 0644 -o root -g root \
  /opt/webhook-config/caddy/panoptica.koflerlab.org.caddyfile /etc/caddy/conf.d/panoptica.koflerlab.org.caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Changed the unit, polkit rule, or Caddy file later? Push `koflerlab/webhook`; its next deploy prints
`DRIFT:` for any whose installed copy diverged — re-run that `install` line (see that repo's
"Applying privileged config").

SELinux note (AlmaLinux is enforcing): files installed to `/etc` via `install` get correct labels;
files under `/opt` do not. If Caddy returns 403 on the frontend, check `sudo ausearch -m AVC -ts recent`,
then `sudo semanage fcontext -a -t httpd_sys_content_t "/opt/panoptica-web/frontend(/.*)?" && sudo restorecon -Rv /opt/panoptica-web/frontend`.

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