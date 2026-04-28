// MCP server exposing job-hunt tools over Streamable HTTP at POST /mcp.
// Single-user local mode: every tool resolves to the seeded default user.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { logger } from '../lib/logger.ts';
import {
  type ApplicationStatus,
  APPLICATION_STATUSES,
  assertTransition,
} from '../domain/status-machine.ts';

const DEFAULT_USER_EMAIL = 'pedelgadillo@gmail.com';

let cachedUserId: string | null = null;
async function defaultUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;
  const row = await db.queryOne<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [DEFAULT_USER_EMAIL],
  );
  if (!row) throw new Error(`No user seeded for ${DEFAULT_USER_EMAIL}`);
  cachedUserId = row.id;
  return cachedUserId;
}

function ok(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

const listingShape = {
  indeed_job_id: z.string().min(1).max(128),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().nullish(),
  apply_url: z.string().url(),
  description_md: z.string().nullish(),
  salary_min: z.number().int().nonnegative().nullish(),
  salary_max: z.number().int().nonnegative().nullish(),
  salary_currency: z.string().length(3).nullish(),
  job_type: z.string().nullish(),
  remote: z.boolean().nullish(),
};

interface UpsertedListing {
  id: string;
  indeed_job_id: string;
}

async function upsertListing(
  client: { query: (text: string, params: unknown[]) => Promise<{ rows: UpsertedListing[] }> },
  l: z.infer<z.ZodObject<typeof listingShape>>,
): Promise<UpsertedListing> {
  const { rows } = await client.query(
    `INSERT INTO job_listings (
        indeed_job_id, title, company, location, apply_url, description_md,
        salary_min, salary_max, salary_currency, job_type, remote, last_fetched_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (indeed_job_id) DO UPDATE SET
       title           = EXCLUDED.title,
       company         = EXCLUDED.company,
       location        = COALESCE(EXCLUDED.location, job_listings.location),
       apply_url       = EXCLUDED.apply_url,
       description_md  = COALESCE(EXCLUDED.description_md, job_listings.description_md),
       salary_min      = COALESCE(EXCLUDED.salary_min, job_listings.salary_min),
       salary_max      = COALESCE(EXCLUDED.salary_max, job_listings.salary_max),
       salary_currency = COALESCE(EXCLUDED.salary_currency, job_listings.salary_currency),
       job_type        = COALESCE(EXCLUDED.job_type, job_listings.job_type),
       remote          = COALESCE(EXCLUDED.remote, job_listings.remote),
       last_fetched_at = NOW()
     RETURNING id, indeed_job_id`,
    [
      l.indeed_job_id, l.title, l.company, l.location ?? null, l.apply_url,
      l.description_md ?? null, l.salary_min ?? null, l.salary_max ?? null,
      l.salary_currency ?? null, l.job_type ?? null, l.remote ?? null,
    ],
  );
  return rows[0];
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'job-hunt', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'search_create',
    {
      title: 'Log an Indeed search and upsert its listings',
      description:
        'Persist an Indeed search query plus the listings it returned. Listings are upserted by indeed_job_id (re-running with the same id updates rather than duplicates). Returns the new search_id and the listing rows it created/updated.',
      inputSchema: {
        query: z.string().min(1),
        location: z.string().min(1),
        country_code: z.string().length(2),
        job_type: z.string().nullish(),
        raw_response: z.string().nullish(),
        listings: z.array(z.object(listingShape)),
      },
    },
    async (args) => {
      const userId = await defaultUserId();
      const result = await db.transaction(async (client) => {
        const search = await client.query(
          `INSERT INTO searches (user_id, query, location, country_code, job_type, raw_response, result_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
          [
            userId, args.query, args.location, args.country_code,
            args.job_type ?? null, args.raw_response ?? null, args.listings.length,
          ],
        );
        const searchId = search.rows[0].id;
        const listings: UpsertedListing[] = [];
        for (let i = 0; i < args.listings.length; i++) {
          const upserted = await upsertListing(client, args.listings[i]);
          listings.push(upserted);
          await client.query(
            `INSERT INTO search_listings (search_id, listing_id, rank)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [searchId, upserted.id, i + 1],
          );
        }
        return { search_id: searchId, listings };
      });
      return ok(result);
    },
  );

  server.registerTool(
    'listing_get',
    {
      title: 'Get a cached listing by indeed_job_id',
      description:
        'Returns a job_listings row by indeed_job_id, or null if not yet seen. Use this BEFORE calling Indeed MCP get_job_details to avoid redundant fetches.',
      inputSchema: { indeed_job_id: z.string().min(1) },
    },
    async ({ indeed_job_id }) => {
      const row = await db.queryOne(
        'SELECT * FROM job_listings WHERE indeed_job_id = $1',
        [indeed_job_id],
      );
      return ok(row);
    },
  );

  server.registerTool(
    'listing_update',
    {
      title: 'Save full description for a known listing',
      description:
        'Patch a listing after fetching its full description via Indeed get_job_details. Any field can be updated; existing values are preserved if a field is omitted (COALESCE).',
      inputSchema: {
        indeed_job_id: z.string().min(1),
        title: z.string().min(1).optional(),
        company: z.string().min(1).optional(),
        location: z.string().optional(),
        apply_url: z.string().url().optional(),
        description_md: z.string().optional(),
        salary_min: z.number().int().nonnegative().optional(),
        salary_max: z.number().int().nonnegative().optional(),
        salary_currency: z.string().length(3).optional(),
        job_type: z.string().optional(),
        remote: z.boolean().optional(),
      },
    },
    async (args) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      const fields: ReadonlyArray<[string, unknown]> = [
        ['title', args.title], ['company', args.company], ['location', args.location],
        ['apply_url', args.apply_url], ['description_md', args.description_md],
        ['salary_min', args.salary_min], ['salary_max', args.salary_max],
        ['salary_currency', args.salary_currency], ['job_type', args.job_type],
        ['remote', args.remote],
      ];
      for (const [col, val] of fields) {
        if (val !== undefined) { sets.push(`${col} = $${i++}`); params.push(val); }
      }
      sets.push('last_fetched_at = NOW()');
      params.push(args.indeed_job_id);
      const row = await db.queryOne(
        `UPDATE job_listings SET ${sets.join(', ')}
         WHERE indeed_job_id = $${i} RETURNING *`,
        params as never,
      );
      if (!row) throw new Error(`listing_not_found: ${args.indeed_job_id}`);
      return ok(row);
    },
  );

  server.registerTool(
    'application_create',
    {
      title: 'Create a draft application for a known listing',
      description:
        'Creates an application in status `drafting` referencing a listing by indeed_job_id. The listing must already exist (call search_create or listing_update first). One application per (user, listing) — duplicates are rejected.',
      inputSchema: {
        indeed_job_id: z.string().min(1),
        fit_score: z.number().int().min(0).max(100).optional(),
        fit_reasoning: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async (args) => {
      const userId = await defaultUserId();
      const listing = await db.queryOne<{ id: string }>(
        'SELECT id FROM job_listings WHERE indeed_job_id = $1',
        [args.indeed_job_id],
      );
      if (!listing) throw new Error(`listing_not_found: ${args.indeed_job_id} — call search_create first`);
      const app = await db.transaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO applications (user_id, listing_id, fit_score, fit_reasoning, notes, status)
           VALUES ($1,$2,$3,$4,$5,'drafting') RETURNING *`,
          [userId, listing.id, args.fit_score ?? null, args.fit_reasoning ?? null, args.notes ?? null],
        );
        const row = inserted.rows[0] as { id: string };
        await client.query(
          `INSERT INTO application_events (application_id, kind, payload)
           VALUES ($1, 'status_change', $2::jsonb)`,
          [row.id, JSON.stringify({ from: null, to: 'drafting' })],
        );
        return row;
      });
      return ok(app);
    },
  );

  server.registerTool(
    'application_status_update',
    {
      title: 'Move an application along its status machine',
      description:
        'Transition an application to a new status. Server enforces legal transitions (drafting → pending_review → submitted → responded → offer | rejected | withdrawn). Stamps applied_at/responded_at/closed_at automatically. Writes a status_change event.',
      inputSchema: {
        application_id: z.string().uuid(),
        status: z.enum(APPLICATION_STATUSES),
        reason: z.string().optional(),
      },
    },
    async (args) => {
      const userId = await defaultUserId();
      const result = await db.transaction(async (client) => {
        const current = (
          await client.query(
            `SELECT id, status FROM applications WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [args.application_id, userId],
          )
        ).rows[0] as { id: string; status: ApplicationStatus } | undefined;
        if (!current) return null;

        assertTransition(current.status, args.status);

        const stamp =
          args.status === 'submitted' ? 'applied_at = NOW(),' :
          args.status === 'responded' ? 'responded_at = NOW(),' :
          args.status === 'rejected' || args.status === 'withdrawn' || args.status === 'offer' ? 'closed_at = NOW(),' :
          '';

        const updated = await client.query(
          `UPDATE applications SET ${stamp} status = $1
           WHERE id = $2 RETURNING *`,
          [args.status, current.id],
        );

        await client.query(
          `INSERT INTO application_events (application_id, kind, payload)
           VALUES ($1, 'status_change', $2::jsonb)`,
          [
            current.id,
            JSON.stringify({ from: current.status, to: args.status, reason: args.reason ?? null }),
          ],
        );
        return updated.rows[0];
      });
      if (!result) throw new Error(`application_not_found: ${args.application_id}`);
      return ok(result);
    },
  );

  server.registerTool(
    'cover_letter_create',
    {
      title: 'Save a new cover letter version for an application',
      description:
        'Writes a new cover letter version (auto-incremented), marks previous versions inactive, and the new one active. Aim for ~180 words.',
      inputSchema: {
        application_id: z.string().uuid(),
        body_md: z.string().min(1),
      },
    },
    async ({ application_id, body_md }) => {
      const userId = await defaultUserId();
      const result = await db.transaction(async (client) => {
        const app = (
          await client.query(
            'SELECT id FROM applications WHERE id = $1 AND user_id = $2',
            [application_id, userId],
          )
        ).rows[0] as { id: string } | undefined;
        if (!app) return null;

        await client.query(
          `UPDATE cover_letters SET is_active = FALSE
           WHERE application_id = $1 AND is_active = TRUE`,
          [app.id],
        );
        const next = (
          await client.query(
            `SELECT COALESCE(MAX(version), 0) + 1 AS v
             FROM cover_letters WHERE application_id = $1`,
            [app.id],
          )
        ).rows[0].v as number;
        const inserted = await client.query(
          `INSERT INTO cover_letters (application_id, body_md, word_count, version, is_active)
           VALUES ($1, $2, $3, $4, TRUE) RETURNING *`,
          [app.id, body_md, wordCount(body_md), next],
        );
        return inserted.rows[0];
      });
      if (!result) throw new Error(`application_not_found: ${application_id}`);
      return ok(result);
    },
  );

  server.registerTool(
    'event_create',
    {
      title: 'Log a pause-gate or freeform event on an application',
      description:
        'Append an audit event to an application. Use for pause gates (recaptcha, demographic, final submit), response_received messages, freeform notes, etc.',
      inputSchema: {
        application_id: z.string().uuid(),
        kind: z.enum(['pause_gate', 'submitted', 'response_received', 'rejection', 'offer', 'note']),
        payload: z.record(z.string(), z.unknown()).default({}),
      },
    },
    async ({ application_id, kind, payload }) => {
      const userId = await defaultUserId();
      const result = await db.transaction(async (client) => {
        const app = (
          await client.query(
            'SELECT id FROM applications WHERE id = $1 AND user_id = $2',
            [application_id, userId],
          )
        ).rows[0] as { id: string } | undefined;
        if (!app) return null;
        const inserted = await client.query(
          `INSERT INTO application_events (application_id, kind, payload)
           VALUES ($1, $2, $3::jsonb) RETURNING *`,
          [app.id, kind, JSON.stringify(payload)],
        );
        return inserted.rows[0];
      });
      if (!result) throw new Error(`application_not_found: ${application_id}`);
      return ok(result);
    },
  );

  server.registerTool(
    'applications_list',
    {
      title: 'List applications, optionally filtered by status',
      description:
        'Returns applications joined with their listing fields, ordered by updated_at desc. Use status=pending_review at session start to surface what awaits human OK.',
      inputSchema: {
        status: z.enum(APPLICATION_STATUSES).optional(),
        limit: z.number().int().positive().max(200).default(50),
        offset: z.number().int().nonnegative().default(0),
      },
    },
    async ({ status, limit, offset }) => {
      const userId = await defaultUserId();
      const where: string[] = ['a.user_id = $1'];
      const params: unknown[] = [userId];
      if (status) {
        where.push(`a.status = $${params.length + 1}`);
        params.push(status);
      }
      params.push(limit, offset);
      const rows = await db.queryMany(
        `SELECT
           a.id, a.status, a.fit_score, a.fit_reasoning, a.notes,
           a.applied_at, a.responded_at, a.closed_at,
           a.created_at, a.updated_at,
           jl.id AS listing_id, jl.indeed_job_id,
           jl.title, jl.company, jl.location, jl.apply_url
         FROM applications a JOIN job_listings jl ON jl.id = a.listing_id
         WHERE ${where.join(' AND ')}
         ORDER BY a.updated_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params as never,
      );
      return ok(rows);
    },
  );

  server.registerTool(
    'application_get',
    {
      title: 'Get a single application with its events and cover letters',
      description:
        'Full read for one application — joined listing fields plus all status_change/pause_gate/etc events plus all cover letter versions.',
      inputSchema: { application_id: z.string().uuid() },
    },
    async ({ application_id }) => {
      const userId = await defaultUserId();
      const app = await db.queryOne(
        `SELECT a.*, jl.indeed_job_id, jl.title, jl.company, jl.apply_url
         FROM applications a JOIN job_listings jl ON jl.id = a.listing_id
         WHERE a.id = $1 AND a.user_id = $2`,
        [application_id, userId],
      );
      if (!app) throw new Error(`application_not_found: ${application_id}`);
      const events = await db.queryMany(
        `SELECT id, kind, payload, created_at FROM application_events
         WHERE application_id = $1 ORDER BY created_at ASC`,
        [application_id],
      );
      const coverLetters = await db.queryMany(
        `SELECT id, body_md, word_count, version, is_active, created_at
         FROM cover_letters WHERE application_id = $1 ORDER BY version DESC`,
        [application_id],
      );
      return ok({ application: app, events, cover_letters: coverLetters });
    },
  );

  server.registerTool(
    'funnel_report',
    {
      title: 'Funnel snapshot: counts by status + last-30d throughput',
      description: 'Top-level pulse of the job hunt — call at session start.',
      inputSchema: {},
    },
    async () => {
      const userId = await defaultUserId();
      const counts = await db.queryMany<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count FROM applications
         WHERE user_id = $1 GROUP BY status`,
        [userId],
      );
      const last30 = await db.queryOne<{ submitted: string; responded: string; rejected: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE applied_at >= NOW() - INTERVAL '30 days')::text AS submitted,
           COUNT(*) FILTER (WHERE responded_at >= NOW() - INTERVAL '30 days')::text AS responded,
           COUNT(*) FILTER (WHERE closed_at >= NOW() - INTERVAL '30 days' AND status='rejected')::text AS rejected
         FROM applications WHERE user_id = $1`,
        [userId],
      );
      const byStatus: Record<string, number> = {};
      for (const r of counts) byStatus[r.status] = Number(r.count);
      return ok({
        by_status: byStatus,
        last_30d: {
          submitted: Number(last30?.submitted ?? 0),
          responded: Number(last30?.responded ?? 0),
          rejected: Number(last30?.rejected ?? 0),
        },
      });
    },
  );

  server.registerTool(
    'applications_import',
    {
      title: 'Bulk-backfill historical applications',
      description:
        'Backfill applications submitted before this API existed (e.g. from a Drive CSV or Indeed history scrape). Bypasses the status machine — set the final status directly. Idempotent on (user, indeed_job_id): duplicates land in `skipped`, not errored. Up to 500 per call.',
      inputSchema: {
        source: z.string().min(1).max(64),
        applications: z.array(z.object({
          ...listingShape,
          status: z.enum(APPLICATION_STATUSES),
          fit_score: z.number().int().min(0).max(100).nullish(),
          fit_reasoning: z.string().nullish(),
          notes: z.string().nullish(),
          cover_letter_md: z.string().nullish(),
          // ISO-8601 strings (e.g. "2026-03-15T10:00:00Z"). Date objects can't
          // be serialized to JSON Schema for MCP tool discovery.
          applied_at: z.string().datetime({ offset: true }).nullish(),
          responded_at: z.string().datetime({ offset: true }).nullish(),
          closed_at: z.string().datetime({ offset: true }).nullish(),
        })).min(1).max(500),
      },
    },
    async ({ source, applications }) => {
      const userId = await defaultUserId();
      const toDate = (s: string | null | undefined): Date | null =>
        s ? new Date(s) : null;
      const result = await db.transaction(async (client) => {
        const created: Array<{ indeed_job_id: string; application_id: string; status: string }> = [];
        const skipped: Array<{ indeed_job_id: string; reason: string; existing_application_id?: string }> = [];

        for (const item of applications) {
          const listing = await upsertListing(client, item);

          const appliedAt = toDate(item.applied_at);
          const respondedAt = toDate(item.responded_at);
          const closedAt = toDate(item.closed_at);

          const inferredAppliedAt =
            appliedAt ??
            (['submitted', 'responded', 'rejected', 'offer'].includes(item.status) ? new Date() : null);
          const inferredClosedAt =
            closedAt ??
            (['rejected', 'withdrawn'].includes(item.status) ? new Date() : null);

          const ins = await client.query<{ id: string }>(
            `INSERT INTO applications (user_id, listing_id, status, fit_score, fit_reasoning, notes, applied_at, responded_at, closed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (user_id, listing_id) DO NOTHING RETURNING id`,
            [
              userId, listing.id, item.status,
              item.fit_score ?? null, item.fit_reasoning ?? null, item.notes ?? null,
              inferredAppliedAt, respondedAt, inferredClosedAt,
            ],
          );
          if (ins.rowCount === 0) {
            const existing = await client.query<{ id: string }>(
              `SELECT id FROM applications WHERE user_id = $1 AND listing_id = $2`,
              [userId, listing.id],
            );
            skipped.push({
              indeed_job_id: item.indeed_job_id, reason: 'already_exists',
              existing_application_id: existing.rows[0]?.id,
            });
            continue;
          }
          const appId = ins.rows[0].id;
          await client.query(
            `INSERT INTO application_events (application_id, kind, payload) VALUES ($1, 'imported', $2::jsonb)`,
            [appId, JSON.stringify({ source, status: item.status })],
          );
          await client.query(
            `INSERT INTO application_events (application_id, kind, payload) VALUES ($1, 'status_change', $2::jsonb)`,
            [appId, JSON.stringify({ from: null, to: item.status, reason: 'backfill' })],
          );
          if (item.cover_letter_md) {
            await client.query(
              `INSERT INTO cover_letters (application_id, body_md, word_count, version, is_active)
               VALUES ($1, $2, $3, 1, TRUE)`,
              [appId, item.cover_letter_md, wordCount(item.cover_letter_md)],
            );
          }
          created.push({ indeed_job_id: item.indeed_job_id, application_id: appId, status: item.status });
        }
        return { created, skipped };
      });

      return ok({
        summary: {
          requested: applications.length,
          created: result.created.length,
          skipped: result.skipped.length,
        },
        ...result,
      });
    },
  );

  logger.info('MCP server initialized with 11 tools');
  return server;
}
