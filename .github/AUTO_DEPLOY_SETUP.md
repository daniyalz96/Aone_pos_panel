# Auto-deploy from GitHub - one time setup

The workflow at `.github/workflows/deploy.yml` runs on every push to `main`.
It builds backend (`tsc`) and frontend (`nuxt build`) on a GitHub runner,
rsyncs the artifacts to `/opt/aone-pos`, runs migrations, and reloads PM2.

## Step 1: Add four secrets in GitHub

Go to: **Repo Settings -> Secrets and variables -> Actions -> New repository secret**

| Secret name           | Value                                                                 |
|-----------------------|-----------------------------------------------------------------------|
| `DEPLOY_HOST`         | `62.169.21.178`                                                       |
| `DEPLOY_USER`         | `root`                                                                |
| `DEPLOY_SSH_KEY`      | The private key shown in chat (full block, including BEGIN/END lines) |
| `DEPLOY_KNOWN_HOSTS`  | `62.169.21.178 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOJAP4lM+IjTBrlBtI08bPL90PKTK1poF9pIfGa3ThAy` |

Paste each value exactly. For `DEPLOY_SSH_KEY`, include the
`-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----`
lines. GitHub stores it encrypted and never shows it again.

The server-side public key is already installed in `/root/.ssh/authorized_keys`
with the comment `github-actions-aone-pos`, so you can identify and revoke it
later with `sed -i '/github-actions-aone-pos/d' /root/.ssh/authorized_keys`.

## Step 2: Push the workflow

```bash
git add .github/workflows/deploy.yml .github/AUTO_DEPLOY_SETUP.md
git commit -m "ci: auto-deploy to production on push to main"
git push origin main
```

The first push will trigger the workflow. Watch it in the repo's
**Actions** tab.

## What the workflow does

1. Checks out the repo on a fresh Ubuntu runner.
2. Sets up Node 20 with npm cache keyed on both lockfiles.
3. `npm ci` + `tsc` in `backend/`. Produces `backend/dist/`.
4. `npm ci` + `npx nuxt build` in `frontend/`. Produces `frontend/.output/`.
5. Rsyncs `backend/` (excluding `node_modules` and `.env`) and
   `frontend/.output/` (plus the lockfile) to the server.
6. SSHs in, runs `npm ci --omit=dev` (no-op when nothing changed),
   `npm run migrate:prod`, then `pm2 reload` on both processes.
7. Curls `/login` and `/api/v1/health` from the runner as a smoke test.

The whole pipeline serializes on `concurrency: deploy-prod`, so two pushes
in quick succession will queue rather than race.

## What it does NOT do

- It does not touch `/opt/aone-pos/backend/.env` or
  `/opt/aone-pos/frontend/.env`. Those are server-owned and survive deploys.
- It does not run `seed.ts` (only `migrate.ts`). If you ever need to seed
  again, run it manually on the server.
- It does not run tests, lint, or typecheck before deploying. Add those as
  separate jobs (or steps before the build steps) when the project grows.

## Triggering a deploy without pushing code

In the **Actions** tab, pick the "Deploy to production" workflow, then
click "Run workflow" on the `main` branch. The `workflow_dispatch` trigger
is already wired up for this.

## Rolling back

GitHub Actions keeps the build artifacts per run. To roll back:

1. Go to **Actions**.
2. Find the older "Deploy to production" run that was good.
3. Click "Re-run all jobs". It will rebuild that commit and ship it.

If you want true point-in-time rollback (no rebuild), tell me and I'll
switch the workflow to upload artifacts + add a separate "deploy artifact"
step you can replay.
