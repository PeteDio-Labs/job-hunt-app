import { Router } from 'express';
import { db } from '../db/client.ts';
import { asyncHandler } from '../lib/http.ts';
import { importApplicationsSchema } from '../domain/schema.ts';

export const importRouter: Router = Router();

interface UpsertedListing {
  id: string;
  indeed_job_id: string;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

importRouter.post(
  '/applications/import',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const body = importApplicationsSchema.parse(req.body);

    const result = await db.transaction(async (client) => {
      const created: Array<{ indeed_job_id: string; application_id: string; status: string }> = [];
      const skipped: Array<{ indeed_job_id: string; reason: string; existing_application_id?: string }> = [];

      for (const item of body.applications) {
        const listingResult = await client.query<UpsertedListing>(
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
            item.indeed_job_id,
            item.title,
            item.company,
            item.location ?? null,
            item.apply_url,
            item.description_md ?? null,
            item.salary_min ?? null,
            item.salary_max ?? null,
            item.salary_currency ?? null,
            item.job_type ?? null,
            item.remote ?? null,
          ],
        );
        const listing = listingResult.rows[0];

        // Default applied_at when status implies the app has been submitted (and no explicit value given).
        const inferredAppliedAt =
          item.applied_at ??
          (['submitted', 'responded', 'rejected', 'offer'].includes(item.status) ? new Date() : null);

        const inferredClosedAt =
          item.closed_at ??
          (['rejected', 'withdrawn'].includes(item.status) ? new Date() : null);

        const appInsert = await client.query<{ id: string }>(
          `INSERT INTO applications (
              user_id, listing_id, status, fit_score, fit_reasoning, notes,
              applied_at, responded_at, closed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (user_id, listing_id) DO NOTHING
           RETURNING id`,
          [
            userId,
            listing.id,
            item.status,
            item.fit_score ?? null,
            item.fit_reasoning ?? null,
            item.notes ?? null,
            inferredAppliedAt,
            item.responded_at ?? null,
            inferredClosedAt,
          ],
        );

        if (appInsert.rowCount === 0) {
          const existing = await client.query<{ id: string }>(
            `SELECT id FROM applications WHERE user_id = $1 AND listing_id = $2`,
            [userId, listing.id],
          );
          skipped.push({
            indeed_job_id: item.indeed_job_id,
            reason: 'already_exists',
            existing_application_id: existing.rows[0]?.id,
          });
          continue;
        }

        const appId = appInsert.rows[0].id;

        // Audit event: where this row came from
        await client.query(
          `INSERT INTO application_events (application_id, kind, payload)
           VALUES ($1, 'imported', $2::jsonb)`,
          [appId, JSON.stringify({ source: body.source, status: item.status })],
        );

        // Status-change event so the application's history isn't silent
        await client.query(
          `INSERT INTO application_events (application_id, kind, payload)
           VALUES ($1, 'status_change', $2::jsonb)`,
          [appId, JSON.stringify({ from: null, to: item.status, reason: 'backfill' })],
        );

        // Optional cover letter
        if (item.cover_letter_md) {
          await client.query(
            `INSERT INTO cover_letters (application_id, body_md, word_count, version, is_active)
             VALUES ($1, $2, $3, 1, TRUE)`,
            [appId, item.cover_letter_md, wordCount(item.cover_letter_md)],
          );
        }

        created.push({
          indeed_job_id: item.indeed_job_id,
          application_id: appId,
          status: item.status,
        });
      }

      return { created, skipped };
    });

    res.status(201).json({
      summary: {
        requested: body.applications.length,
        created: result.created.length,
        skipped: result.skipped.length,
      },
      created: result.created,
      skipped: result.skipped,
    });
  }),
);
