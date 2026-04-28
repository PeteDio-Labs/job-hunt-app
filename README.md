# job-hunt

Data plane for Pedro's Indeed-MCP-driven job application workflow.

Claude Code (running on the Mac) drives the workflow: it calls Indeed MCP for
search and `get_job_details`, picks a shortlist, drafts cover letters, and uses
Chrome MCP to apply. **All of that state — searches, listings, applications,
cover letters, status transitions, pause-gates, responses — is persisted by
this service** so nothing is lost between Claude Code sessions.

This service does not call any LLM. It does not call the Indeed MCP. It is
plain Express + Postgres.

## Stack

- **Runtime:** Bun
- **HTTP:** Express 5
- **DB:** Postgres 16 (raw `pg`, no ORM)
- **Validation:** Zod
- **Logging:** pino
- **Deploy:** Docker Compose on LXC 118 (`192.168.50.118:3014`), CI via
  `PeteDio-Labs/job-hunt-app` self-hosted runner on LXC 116.

## Local development

```bash
bun install
cp deploy/.env.example deploy/.env   # then fill in POSTGRES_PASSWORD + JOB_HUNT_API_TOKEN
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d job-hunt-db

POSTGRES_PASSWORD=... JOB_HUNT_API_TOKEN=... \
  bun run src/db/migrate.ts
POSTGRES_PASSWORD=... JOB_HUNT_API_TOKEN=... \
  bun --watch src/index.ts

curl http://localhost:3014/health
```

## API

All routes are under `/api/v1`. Auth is **off by default** for single-user
local mode — leave `JOB_HUNT_API_TOKEN` unset and you can `curl` directly.
Set the env var to require `Authorization: Bearer <token>` on every request
(do this before sharing the API with anyone).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/searches` | Persist an Indeed search + its result listings (upsert). |
| `GET`  | `/api/v1/searches` | List recent searches. |
| `GET`  | `/api/v1/searches/:id` | Search + its ranked listings. |
| `GET`  | `/api/v1/listings/:indeed_job_id` | Cache check for a listing. |
| `PATCH`| `/api/v1/listings/:indeed_job_id` | Save full description from `get_job_details`. |
| `POST` | `/api/v1/applications` | Create application in `drafting` status (refs listing by `indeed_job_id`). |
| `GET`  | `/api/v1/applications?status=...` | Funnel view. |
| `GET`  | `/api/v1/applications/:id` | App + events + cover letters. |
| `POST` | `/api/v1/applications/:id/cover-letters` | Save a new cover letter version. |
| `PATCH`| `/api/v1/applications/:id/status` | Move along the status machine. |
| `POST` | `/api/v1/applications/:id/events` | Log a pause-gate / note / response. |
| `GET`  | `/api/v1/reports/funnel` | Counts by status + last-30d throughput. |
| `GET`  | `/health` | Liveness + db check. |

## Status machine

```
drafting ─► pending_review ─► submitted ─► responded ─► offer
   │            │                │            │           │
   │            └────► drafting  │            ├──► rejected
   │                             │            │
   └─► withdrawn                 └─► rejected └──► withdrawn
                                 └─► withdrawn
```

Terminal: `rejected`, `withdrawn` (and `offer` once accepted/declined externally).
Every transition writes a `status_change` event row.

## Deploy

1. Lock in static IP: `ansible-playbook playbooks/lxc-118-static-ip.yml`
2. Provision (one-time): `ansible-playbook playbooks/provision-job-hunt-lxc.yml -e "@vars/job-hunt.vault.yml" --ask-vault-pass`
3. Subsequent deploys: `git push` to `main` on `PeteDio-Labs/job-hunt-app`.
