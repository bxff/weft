# Self-hosting weft

weft splits into two deployable halves plus the tablet daemon:

| Piece              | What it is                                              | Where it runs            |
| ------------------ | ------------------------------------------------------- | ------------------------ |
| **web** (`apps/web`)   | SvelteKit static SPA + prerendered docs                 | **Static host** (e.g. Cloudflare Pages or Vercel)      |
| **cloud** (`apps/cloud`) | Bun store: `bun:sqlite` + WebSockets, device-protocol API | **Bun** directly or in Docker |
| **rmsyncd** (`device/`)  | Rust sync daemon                                        | the reMarkable tablet (shipped separately, not deployed by this infra) |
| **GlitchTip**      | self-hosted, Sentry-compatible error telemetry          | **Docker** (optional telemetry Compose file)  |

## Operating it: what to look at

Three screens answer "is everything working":

1. **Uptime dashboard** — `uptime-kuma` on `127.0.0.1:3001` (ssh tunnel in).
   Add monitors for `http://cloud:8080/api/health`, your public origin and
   GlitchTip; it gives uptime history and alerting (email/webhook) for free.
2. **Errors** — the reporters speak the standard Sentry protocol, so pick
   the sink that fits your ops appetite:
   - **Recommended (zero extra ops):** a hosted Sentry free-tier project —
     set `CLOUD_SENTRY_DSN` for Compose or `SENTRY_DSN` for direct Bun, and
     `PUBLIC_SENTRY_DSN` for the web build.
   - **Fully self-hosted:** use the optional GlitchTip Compose file in step 2.
   Either way: the cloud reports route crashes + process failures, the web
   reports uncaught browser errors, and the sync engine's redacted failure
   reports land in the cloud's `failure_reports` table regardless of sink.
3. **Usage counters** — `GET /api/admin/stats` (admin users only): request /
   429 / 507 counters, per-user storage, doc counts.

To offer tablet updates from your own relay, set `WEFT_DAEMON_RELEASE` and,
if needed, `WEFT_DAEMON_RELEASE_ARMV7` to the corresponding binaries.

## HTTPS: use your tunnel or Caddy

If you use Cloudflare Tunnel for your relay, you can leave the optional
Caddy profile disabled.

For a standalone server without a tunnel, the Compose stack includes **Caddy**: set `WEFT_DOMAIN` in `.env`, point
the domain's DNS at the VPS, open ports 80/443, and run
`docker compose --profile tls up --build -d`.
Caddy fetches and renews Let's Encrypt certificates automatically and proxies
everything — WebSockets included — to the cloud container. The store's own
port 8080 binds to loopback only, so the plaintext API is never on the
internet; local dev and ssh tunnels keep working unchanged.

Rate limiting is application-level and already on by default: per-user token
buckets on every `/api` route (`WEFT_RATE_RPS`/`WEFT_RATE_BURST`, 100/500),
a per-IP bucket on `/api/login`, per-route body caps, per-user storage quotas
and a global capacity watermark. A proxy-level per-IP limit is optional
hardening, not a prerequisite.

## 1. Run the relay

The relay needs persistent SQLite storage and a process that can keep
WebSocket connections open. The supplied Docker Compose configuration uses
Clerk for sign-in. Copy the example environment and set
`CLERK_SECRET_KEY` before starting:

```sh
cp .env.example .env
docker compose up --build cloud
```

The relay listens on <http://localhost:8080>. SQLite persists in the
`cloud-data` volume at `/data/weft.db`. Starting Compose without the
`cloud` target also starts Uptime Kuma. Caddy and GlitchTip are opt-in.

### Password-based self-hosting with Bun

From the repo root, run `bun install --frozen-lockfile`. Copy `.env.example` to `.env`, clear the example `CLERK_SECRET_KEY`, and set a strong `WEFT_PASSWORD`. Leave `PUBLIC_CLERK_PUBLISHABLE_KEY` empty in the web build.

```sh
HOST=127.0.0.1 PORT=8080 CLOUD_DB=/path/to/weft.db bun --env-file=.env apps/cloud/src/server.ts
```

Set `CLOUD_STATIC_DIR` to an absolute path to the built `apps/web/build`
directory if the relay should also serve the frontend. Use a TLS reverse
proxy for public access rather than exposing the plaintext relay port.
The supplied Compose file does not pass `WEFT_PASSWORD`.

## 2. Get a GlitchTip DSN and wire it in

1. Set `GLITCHTIP_POSTGRES_PASSWORD` and `GLITCHTIP_SECRET_KEY` (use hex strings
   from `openssl rand -hex 32`), then run
   the command below and open <http://localhost:8000>. Keep using both
   files for telemetry operations. Include `--profile tls` if you also
   use Caddy.
   ```sh
   docker compose -f docker-compose.yml -f docker-compose.telemetry.yml up -d
   ```
2. Register the first account with the local service. Organization creation
   is initially enabled. After creating your organization, set
   `GLITCHTIP_OPEN_REGISTRATION=False` and rerun the Compose command to
   disable creation of additional organizations. This is not a sign-up gate.
3. Create an **Organization** → **Project** (one for the cloud server, one for
   the web app if you want them separated). Each project gives you a **DSN**.
4. Feed the DSNs back in:
   - Cloud server: set `CLOUD_SENTRY_DSN=<server-project-dsn>` in `.env`, then
     recreate the relay with `up -d cloud`. With direct Bun, set
     `SENTRY_DSN` instead and restart the relay.
   - Web app: set `PUBLIC_SENTRY_DSN=<web-project-dsn>` in the web build environment (it's a public, browser-safe DSN baked into the static bundle).

GlitchTip is published on loopback only. Set `GLITCHTIP_DOMAIN` to the
origin that your browser and relay can reach (via your proxy if needed);
it is used in emails and generated DSNs. This file targets fresh installs.
For an existing GlitchTip database, back up and follow the
[GlitchTip 7 upgrade notes](https://glitchtip.com/blog/2026-11-09-glitchtip-7-0-release/#for-self-hosted-users)
before starting it. Do not delete your existing volumes.

---

## 3. Deploy the static web app

Set these variables in `apps/web/.env` or in the frontend build environment. Do not put relay secrets such as `WEFT_PASSWORD` or `CLERK_SECRET_KEY` there:

- `PUBLIC_CLOUD_URL`: the public relay origin, e.g. `https://cloud.weft.example.com`.
- `PUBLIC_CLERK_PUBLISHABLE_KEY`: the publishable key if you use Clerk.
- `PUBLIC_TLDRAW_LICENSE_KEY`: a valid SDK key for the editor domain.
- `PUBLIC_SENTRY_DSN`: optional browser telemetry.

From the repo root, run `bun run --cwd apps/web build` and publish
`apps/web/build` on a static host. Configure the host to serve the SPA
shell for client routes such as `/app/…`. `vercel.json` provides one
example. Changes to the public web settings require a new deployment.

For Cloudflare Pages, configure your own project and domain. Set
`PUBLIC_CLOUD_URL`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_PAGES_PROJECT`
in the environment before running `scripts/deploy-cf.sh`. Use local Wrangler
authentication or a secret supplied outside Git.

Once the relay and editor are reachable, connect a tablet from the web setup
page or follow the [tablet installer guide](device/installer/README.md).

## 4. Deploy the cloud server (production)

Build from the **repo root** (workspace packages live in `packages/*`):

```sh
docker build -f apps/cloud/Dockerfile -t weft-cloud .
docker run -p 127.0.0.1:8080:8080 \
  -e CLERK_SECRET_KEY=sk_live_... \
  -e SENTRY_DSN=... \
  -v weft-data:/data \
  weft-cloud
```

Then set the web app's `PUBLIC_CLOUD_URL` to this server's public origin.

> **Workspace-in-Docker note:** the cloud imports `@weft/*` packages that
> export raw TypeScript (no build step), so the Dockerfile copies the whole
> workspace and runs them directly with Bun. That's why the build **must** use
> the repo root as its context — `docker-compose.yml` already sets
> `context: .` for you.

## 5. Ops runbook: storage, capacity, backup (#57)

These variables are read by the relay process. The supplied Compose file does
not forward the optional quota, rate-limit, or backup variables. Add them to
the `cloud` service environment in an override file, and mount a backup
volume if you enable backups. In direct Bun mode, the relay reads them from
the environment or the env file you explicitly pass.

### Layout: put the data dir on its own volume

Mount a dedicated volume and point
the container's `/data` at it. Even if that volume hits 100%, the OS, SSH,
and the process keep running — disk-full degrades into HTTP errors, never
an outage.

### Capacity protection (set these on a public deploy)

```bash
WEFT_CAPACITY_BYTES=<bytes provisioned for user data>  # e.g. 200 GB of a 256 GB volume
WEFT_ADMIN_USERS=<user id>[,<user id>…]                # enables /api/admin/* for those users
```

At 80% of capacity new accounts are refused (503); at 85% all
storage-growing writes answer 507 `reason:"capacity"` while reads and
existing sync keep working. `GET /api/admin/stats` (admins only) reports the
used fraction, per-user storage, and refusal counters.

### Per-user quotas (two classes)

```bash
WEFT_QUOTA_CREATED_BYTES=1073741824   # notes/ink/history — default 1 GiB, 0 = unlimited
WEFT_QUOTA_SOURCES_BYTES=3221225472   # PDF/EPUB source files — default 3 GiB, 0 = unlimited
```

Notes always sync; a full sources budget just leaves the coldest PDFs
tablet-only (they upload when the user opens them again). Give one user
more space without a redeploy:

```bash
curl -X PUT "$CLOUD/api/admin/quota" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"userId":"user_…","class":"sources","bytes":10737418240}'   # bytes null = back to default
```

Add a cron disk alert at 70% so you act before users ever see a 503:

```bash
# /etc/cron.hourly/weft-disk-alert
use=$(df --output=pcent /data | tail -1 | tr -dc 0-9)
[ "$use" -ge 70 ] && echo "weft data volume at ${use}%" | mail -s "weft disk" you@example.com
```

### Expanding storage (the whole "scaling" story)

1. Attach or grow a block-storage volume through your hosting provider.
2. Stop the container, `rsync -a /data/ /newdata/`, remount, start.
3. Raise `WEFT_CAPACITY_BYTES`.

Blobs are plain files and the DB is one SQLite file, so this is the entire
procedure. There is no application-level storage tiering to operate.

### Backup (single-provider baseline)

Two layers, both provider-local (add an off-site replica later if you want
to survive provider-level loss):

1. **Built-in snapshots**: set `WEFT_BACKUP_DIR=/backup` (a SECOND volume)
   and the server writes a `VACUUM INTO` DB snapshot + blob-tree copy every
   `WEFT_BACKUP_INTERVAL_MIN` (60), keeping `WEFT_BACKUP_KEEP` (24).
   Alternatively run Litestream against the SQLite file with a `file://`
   replica on that volume for continuous WAL streaming.
2. **Host snapshots**: your hosting provider’s VPS snapshots, on a schedule.

Restore = stop container, copy the newest snapshot pair back into /data,
start. Test it once before launch, not during an incident.

### Optional tablet recovery checkpoints

Normal tablet sync does not write recovery checkpoints. To capture editable
checkpoints on a tablet you control, set `WEFT_TABLET_RECOVERY=1` in the
`weft.service` environment and restart the daemon. Both the tablet and relay
need recovery support. Backfill proceeds in batches and a page with a missing
or conflicting resource is not reported as protected.

Checkpoints under `/home/root/weft/recovery-v1` can contain the full native
page, editable browser overlay, and image data. This local copy is not
encrypted by Weft. The daemon allows up to 256 MiB across all link identities
and defers additional capture rather than evicting existing checkpoints.
Disabling capture, changing the link, or deleting data from the relay does
not delete local backups. To remove them, stop the daemon and delete the
recovery directory deliberately; ordinary notebook and sync state are
separate. Recovery is supplementary, not a replacement for a separate backup.

### Explicit GitHub release install

Once a stable tablet release is published, opt in from a computer with a
trusted, signed-in GitHub CLI:

```sh
bunx @bxff/weft setup --release tablet-vMAJOR.MINOR.PATCH --no-auto-reinstall
```

This checks the exact binary's GitHub provenance, architecture, release tag
and source commit before uploading it. Verified installs use the manual
rollback path and reject older verified releases or a moved tag previously
installed at the same version. The first verified install establishes the
version floor; legacy deployments have no verified version receipt. Plain
`setup` still uses the existing source/relay install path.
