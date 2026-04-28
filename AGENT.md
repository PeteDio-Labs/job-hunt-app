# Recruiter agent — operator guide

You (the agent) drive the job-application workflow. The **job-hunt API** is your durable storage — every search, listing, application, cover letter, status change, and pause gate gets written to it so nothing is lost between sessions and so you can resume work after a crash or restart.

You also use:
- **Indeed MCP** — `search_jobs`, `get_job_details`, `get_company_data`, `get_resume`
- **Chrome MCP** — to click "Apply with Indeed" and paste cover letters

This guide is **only** about the job-hunt API. The Indeed and Chrome MCPs are documented separately.

---

## Endpoint and auth

- Base URL: `http://192.168.50.118:3014/api/v1`
- Health: `http://192.168.50.118:3014/health`
- Auth: **none right now** (single-user local mode). If `JOB_HUNT_API_TOKEN` is later set on the server, every request needs `Authorization: Bearer <token>`.

All requests are JSON. All timestamps come back as ISO-8601 UTC. All IDs are UUIDs.

---

## Always start a session with

```bash
# 1. Health check — confirms the API and DB are up
curl -fsS http://192.168.50.118:3014/health

# 2. What's in flight that needs a decision
curl -fsS 'http://192.168.50.118:3014/api/v1/applications?status=pending_review'

# 3. Funnel pulse
curl -fsS http://192.168.50.118:3014/api/v1/reports/funnel
```

If `pending_review` is non-empty, those are applications that drafted in a previous session and are waiting on the human to OK the actual submit. Surface them first.

---

## The 7-step workflow → API mapping

| Workflow step | What you call | What the API does |
|---|---|---|
| 1. Search | `Indeed MCP search_jobs` → `POST /searches` | Logs the query + raw markdown, upserts each listing in one transaction |
| 2. Detail fetch | `GET /listings/:indeed_job_id` (cache check), then `Indeed MCP get_job_details`, then `PATCH /listings/:indeed_job_id` with the full description | Avoids re-fetching listings you've already pulled details for |
| 3. Shortlist | `POST /applications` for each (with `fit_score` and `fit_reasoning`); `POST /applications/:id/cover-letters` for each | Creates apps in `drafting` status |
| 4. Apply (browser) | `PATCH /applications/:id/status` → `pending_review` **before** clicking Submit in Chrome | Marks the human-decision boundary |
| 5. Pause gates (recaptcha, demographic, final Submit) | `POST /applications/:id/events` with `kind: "pause_gate"` | Audit trail of where you stopped |
| 6. Submit (after explicit human OK) | `PATCH /applications/:id/status` → `submitted` | Stamps `applied_at = NOW()` automatically |
| 7. Tracker | `GET /applications?status=submitted`, `GET /reports/funnel` | Replaces the Drive CSV |

If a recruiter responds, an HR rejection arrives, or you get an offer:
- `PATCH /applications/:id/status` → `responded` / `rejected` / `offer`
- Optionally `POST /applications/:id/events` with `kind: "response_received"` and the full message in `payload`

---

## Status machine (enforced server-side — illegal moves return HTTP 409)

```
drafting ──► pending_review ──► submitted ──► responded ──► offer
   │             │                  │             │            │
   │             └─► drafting       │             ├─► rejected │
   │                                │             │            │
   └─► withdrawn ◄─── any non-terminal state ────►├─► withdrawn│
                                                  └─► withdrawn
```

Terminal: `rejected`, `withdrawn`, and `offer` once accepted/declined externally.

Always read the current status before PATCHing. If you're not sure of the current state, `GET /applications/:id` first.

---

## Hard rules (read these)

1. **Listings must exist before applications.** Always `POST /searches` (which upserts listings) or `PATCH /listings/:indeed_job_id` first. Trying to create an application against an unknown `indeed_job_id` returns **404 listing_not_found**.

2. **`indeed_job_id` is the natural key.** Use whatever Indeed MCP returns. Do not invent IDs. The same `indeed_job_id` in two different searches collapses to the same `job_listings` row (upsert).

3. **One application per listing per user.** Trying to create a duplicate returns **409 duplicate**. If you want a fresh attempt at the same role, you'd need to withdraw the existing application first (`PATCH status: "withdrawn"`).

4. **Cover letters are versioned.** Every `POST /applications/:id/cover-letters` creates a new `version`, marks previous versions `is_active=false`, and marks the new one `is_active=true`. Don't try to "edit" a cover letter — write a new one.

5. **You never advance to `submitted` without a human OK.** Steps 5 and 6 in the workflow exist precisely so you stop at every pause gate and wait. The status machine is the safety net, but the discipline is yours.

6. **Don't poll `/health` repeatedly.** Once at session start is enough. The API is on a private LAN — failures are obvious from any other call returning a connection error.

---

## Endpoint reference (with curl examples)

### POST `/searches`

```bash
curl -fsS -X POST http://192.168.50.118:3014/api/v1/searches \
  -H 'content-type: application/json' \
  -d '{
    "query": "platform engineer",
    "location": "remote",
    "country_code": "US",
    "job_type": "fulltime",
    "raw_response": "<the full Indeed MCP markdown response — store it verbatim>",
    "listings": [
      {
        "indeed_job_id": "abc123",
        "title": "Senior Platform Engineer",
        "company": "Acme",
        "location": "Remote",
        "apply_url": "https://www.indeed.com/...",
        "salary_min": 150000,
        "salary_max": 200000,
        "salary_currency": "USD",
        "remote": true
      }
    ]
  }'
```

Returns `{search_id, listings: [{id, indeed_job_id}]}`. Listings are upserted (existing ones get their `last_fetched_at` bumped).

### GET `/listings/:indeed_job_id`

Cache check before calling Indeed `get_job_details`. Returns 404 if not yet seen.

### PATCH `/listings/:indeed_job_id`

After `get_job_details`, save the full markdown:

```bash
curl -fsS -X PATCH http://192.168.50.118:3014/api/v1/listings/abc123 \
  -H 'content-type: application/json' \
  -d '{"description_md": "# Full job description in markdown..."}'
```

### POST `/applications`

```bash
curl -fsS -X POST http://192.168.50.118:3014/api/v1/applications \
  -H 'content-type: application/json' \
  -d '{
    "indeed_job_id": "abc123",
    "fit_score": 87,
    "fit_reasoning": "Strong overlap on k8s + observability per resume; mismatch on years of Go experience",
    "notes": "Recruiter contact in description: jane@acme.example"
  }'
```

`fit_score` is 0-100. `fit_reasoning` is your one-paragraph why. Both nullable but please fill them in — they're the read-side signal for whether to actually apply.

### POST `/applications/:id/cover-letters`

```bash
curl -fsS -X POST http://192.168.50.118:3014/api/v1/applications/$APP_ID/cover-letters \
  -H 'content-type: application/json' \
  -d '{"body_md": "Dear hiring team,\n\n..."}'
```

Aim for ~180 words (the existing convention). The server computes word_count, version, and is_active.

### PATCH `/applications/:id/status`

```bash
curl -fsS -X PATCH http://192.168.50.118:3014/api/v1/applications/$APP_ID/status \
  -H 'content-type: application/json' \
  -d '{"status": "pending_review", "reason": "ready for human OK to click Submit"}'
```

Each status change auto-writes a `status_change` event (with `from`/`to`/`reason`). Stamps `applied_at`/`responded_at`/`closed_at` as appropriate.

### POST `/applications/:id/events`

For pause gates and freeform notes:

```bash
curl -fsS -X POST http://192.168.50.118:3014/api/v1/applications/$APP_ID/events \
  -H 'content-type: application/json' \
  -d '{
    "kind": "pause_gate",
    "payload": {"gate": "recaptcha", "url": "https://www.indeed.com/..."}
  }'
```

Allowed `kind`s: `pause_gate`, `submitted`, `response_received`, `rejection`, `offer`, `note`. (Status-change events are written automatically — don't post them yourself.)

### GET `/applications?status=...&limit=50&offset=0`

Read-side. Lists application + joined listing fields, ordered by `updated_at DESC`. Filter by status; default returns all.

### GET `/applications/:id`

Full detail: application + all status_change/pause_gate/etc. events + all cover letter versions.

### GET `/reports/funnel`

```json
{
  "by_status": {"drafting": 2, "pending_review": 1, "submitted": 14, "responded": 3},
  "last_30d": {"submitted": 14, "responded": 3, "rejected": 8}
}
```

---

## Error responses you'll see

| Code | Meaning | What to do |
|---|---|---|
| 400 `validation_error` | Zod rejected the body. The `issues` array tells you which field. | Fix the payload and retry. |
| 404 `listing_not_found` | You're trying to apply to a listing the API has never seen. | `POST /searches` first to register it. |
| 404 `application_not_found` | Wrong app_id, or it belongs to a different user. | Confirm the app_id from `GET /applications`. |
| 409 `invalid_transition` | Status machine rejected the move. Response includes `from` and `to`. | `GET /applications/:id` to see real current status; pick a legal next state. |
| 409 `duplicate` | UNIQUE constraint hit (most likely (user, listing) on applications). | `GET /applications` filtered by listing — there's already a row. |
| 503 from `/health` | DB is down. | Don't retry the workflow until `/health` returns 200. |

---

## Source of truth

- Schema: [`src/db/migrations/001_init.sql`](src/db/migrations/001_init.sql)
- Status machine code: [`src/domain/status-machine.ts`](src/domain/status-machine.ts)
- Request schemas (Zod): [`src/domain/schema.ts`](src/domain/schema.ts)
- Routes: [`src/routes/`](src/routes/)

If this guide and the code disagree, the code wins — open a PR to fix the guide.
