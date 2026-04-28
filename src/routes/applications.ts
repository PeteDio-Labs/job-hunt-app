import { Router } from 'express';
import { db } from '../db/client.ts';
import { asyncHandler } from '../lib/http.ts';
import {
  applicationsQuerySchema,
  createApplicationSchema,
  updateStatusSchema,
} from '../domain/schema.ts';
import {
  type ApplicationStatus,
  assertTransition,
} from '../domain/status-machine.ts';

export const applicationsRouter: Router = Router();

interface ApplicationRow {
  id: string;
  user_id: string;
  listing_id: string;
  status: ApplicationStatus;
}

applicationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const q = applicationsQuerySchema.parse(req.query);

    const where: string[] = ['a.user_id = $1'];
    const params: unknown[] = [userId];
    if (q.status) {
      where.push(`a.status = $${params.length + 1}`);
      params.push(q.status);
    }

    params.push(q.limit, q.offset);
    const rows = await db.queryMany(
      `SELECT
         a.id, a.status, a.fit_score, a.fit_reasoning, a.notes,
         a.applied_at, a.responded_at, a.closed_at,
         a.created_at, a.updated_at,
         jl.id           AS listing_id,
         jl.indeed_job_id,
         jl.title, jl.company, jl.location, jl.apply_url
       FROM applications a
       JOIN job_listings jl ON jl.id = a.listing_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params as never,
    );
    res.json({ applications: rows });
  }),
);

applicationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const app = await db.queryOne(
      `SELECT a.*, jl.indeed_job_id, jl.title, jl.company, jl.apply_url
       FROM applications a JOIN job_listings jl ON jl.id = a.listing_id
       WHERE a.id = $1 AND a.user_id = $2`,
      [req.params.id, userId],
    );
    if (!app) {
      res.status(404).json({ error: 'application_not_found' });
      return;
    }
    const events = await db.queryMany(
      `SELECT id, kind, payload, created_at FROM application_events
       WHERE application_id = $1 ORDER BY created_at ASC`,
      [req.params.id],
    );
    const coverLetters = await db.queryMany(
      `SELECT id, body_md, word_count, version, is_active, created_at
       FROM cover_letters
       WHERE application_id = $1
       ORDER BY version DESC`,
      [req.params.id],
    );
    res.json({ application: app, events, cover_letters: coverLetters });
  }),
);

applicationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const body = createApplicationSchema.parse(req.body);

    const listing = await db.queryOne<{ id: string }>(
      'SELECT id FROM job_listings WHERE indeed_job_id = $1',
      [body.indeed_job_id],
    );
    if (!listing) {
      res.status(404).json({ error: 'listing_not_found', detail: 'POST /searches first' });
      return;
    }

    const application = await db.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO applications (user_id, listing_id, fit_score, fit_reasoning, notes, status)
         VALUES ($1, $2, $3, $4, $5, 'drafting')
         RETURNING *`,
        [userId, listing.id, body.fit_score ?? null, body.fit_reasoning ?? null, body.notes ?? null],
      );
      const app: ApplicationRow & { created_at: Date } = inserted.rows[0] as never;
      await client.query(
        `INSERT INTO application_events (application_id, kind, payload)
         VALUES ($1, 'status_change', $2::jsonb)`,
        [app.id, JSON.stringify({ from: null, to: 'drafting' })],
      );
      return app;
    });

    res.status(201).json(application);
  }),
);

applicationsRouter.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const { status: nextStatus, reason } = updateStatusSchema.parse(req.body);

    const result = await db.transaction(async (client) => {
      const current = (
        await client.query(
          `SELECT id, status FROM applications WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [req.params.id, userId],
        )
      ).rows[0] as ApplicationRow | undefined;

      if (!current) return null;

      assertTransition(current.status, nextStatus);

      const timestampCol =
        nextStatus === 'submitted'
          ? 'applied_at = NOW(),'
          : nextStatus === 'responded'
            ? 'responded_at = NOW(),'
            : nextStatus === 'rejected' || nextStatus === 'withdrawn' || nextStatus === 'offer'
              ? 'closed_at = NOW(),'
              : '';

      const updated = await client.query(
        `UPDATE applications SET ${timestampCol} status = $1
         WHERE id = $2 RETURNING *`,
        [nextStatus, current.id],
      );

      await client.query(
        `INSERT INTO application_events (application_id, kind, payload)
         VALUES ($1, 'status_change', $2::jsonb)`,
        [current.id, JSON.stringify({ from: current.status, to: nextStatus, reason: reason ?? null })],
      );

      return updated.rows[0];
    });

    if (!result) {
      res.status(404).json({ error: 'application_not_found' });
      return;
    }
    res.json(result);
  }),
);
