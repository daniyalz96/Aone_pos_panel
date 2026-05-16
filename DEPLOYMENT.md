# Aone POS Panel - Deployment Notes

## Live URL

- Panel: http://62.169.21.178
- API:   http://62.169.21.178/api/v1
- Health check: http://62.169.21.178/api/v1/health (returns 200)

## Default Admin Login (created by seed)

- Email: `admin@pos.local`
- Password: `Admin@123`

**Change this password immediately after first login.**

## Server

- Host: 62.169.21.178 (Ubuntu 24.04 LTS)
- SSH: `ssh root@62.169.21.178`
- App root: `/opt/aone-pos`
- Logs: `/var/log/aone-pos/{backend,frontend}.{out,err}.log`

## Process layout

| Service       | Bind                | Manager     | Notes                                |
|---------------|---------------------|-------------|--------------------------------------|
| Nginx         | 0.0.0.0:80          | systemd     | Reverse proxy + static cache         |
| Backend (Node)| 127.0.0.1:4000      | pm2         | `dist/server.js` (built from TS)     |
| Frontend (Nuxt)| 127.0.0.1:3000     | pm2         | `.output/server/index.mjs` (SSR)     |
| PostgreSQL 16 | 127.0.0.1:5432      | systemd     | DB `pos_db`, user `pos_app`          |

PM2 is configured to start on boot (`systemctl is-enabled pm2-root` -> enabled).

## Firewall

UFW is active: 22/tcp and 80/tcp open, everything else denied incoming.

## Previously on this server

A Frappe/ERPNext stack (gunicorn :8000, socketio :9000, MariaDB, redis :11000/:13000)
was running under supervisor. It has been stopped and disabled:

- `systemctl disable --now supervisor mariadb redis-server`
- The nginx site was moved to `/etc/nginx/conf.d.disabled/my-bench.conf`
- Frappe code at `/home/frappeuser/my-bench/` is untouched. Delete manually
  if you want the disk space back.

## Deploying updates

From your laptop, rsync the new code and rebuild:

```bash
# from the Aone_pos_panel folder
rsync -az --delete \
  --exclude=node_modules --exclude=.git --exclude=.DS_Store \
  --exclude=.nuxt --exclude=.output --exclude=dist \
  --exclude='backend/.env' --exclude='frontend/.env' \
  ./ root@62.169.21.178:/opt/aone-pos/

ssh root@62.169.21.178 'cd /opt/aone-pos/backend && npm ci && npm run build && npm run migrate:prod'
ssh root@62.169.21.178 'cd /opt/aone-pos/frontend && npm ci && npx nuxt build'
ssh root@62.169.21.178 'pm2 reload aone-pos-backend && pm2 reload aone-pos-frontend'
```

## Useful commands on the server

```bash
pm2 list                     # process status
pm2 logs aone-pos-backend    # tail backend logs
pm2 logs aone-pos-frontend   # tail frontend logs
pm2 reload all               # zero-downtime restart
nginx -t && systemctl reload nginx
sudo -u postgres psql pos_db # poke at the database
```

## Things to harden later (no domain right now, so limited options)

- Get a domain + Let's Encrypt for HTTPS. Without TLS, the JWT goes over the
  wire in plain text on every request.
- Move JWT secret + DB password into a secret manager rather than `.env` on disk.
- Set up nightly `pg_dump` to a separate location.
- The backend currently uses `cors()` with default config (any origin). When
  you have a real frontend host, lock CORS down to that origin.
