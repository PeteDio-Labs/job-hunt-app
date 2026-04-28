import { Router } from 'express';
import { db } from '../db/client.ts';
import { asyncHandler } from '../lib/http.ts';
import { updateListingSchema } from '../domain/schema.ts';

export const listingsRouter: Router = Router();

listingsRouter.get(
  '/:indeedJobId',
  asyncHandler(async (req, res) => {
    const row = await db.queryOne(
      'SELECT * FROM job_listings WHERE indeed_job_id = $1',
      [req.params.indeedJobId],
    );
    if (!row) {
      res.status(404).json({ error: 'listing_not_found' });
      return;
    }
    res.json(row);
  }),
);

listingsRouter.patch(
  '/:indeedJobId',
  asyncHandler(async (req, res) => {
    const patch = updateListingSchema.parse(req.body);

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    const fields: ReadonlyArray<[string, unknown]> = [
      ['title', patch.title],
      ['company', patch.company],
      ['location', patch.location],
      ['apply_url', patch.apply_url],
      ['description_md', patch.description_md],
      ['salary_min', patch.salary_min],
      ['salary_max', patch.salary_max],
      ['salary_currency', patch.salary_currency],
      ['job_type', patch.job_type],
      ['remote', patch.remote],
      ['posted_at', patch.posted_at],
    ];
    for (const [col, val] of fields) {
      if (val !== undefined) {
        sets.push(`${col} = $${i++}`);
        params.push(val);
      }
    }
    if (patch.metadata !== undefined) {
      sets.push(`metadata = metadata || $${i++}::jsonb`);
      params.push(JSON.stringify(patch.metadata));
    }
    sets.push('last_fetched_at = NOW()');

    if (sets.length === 1) {
      res.status(400).json({ error: 'no_fields_to_update' });
      return;
    }

    params.push(req.params.indeedJobId);
    const row = await db.queryOne(
      `UPDATE job_listings SET ${sets.join(', ')}
       WHERE indeed_job_id = $${i}
       RETURNING *`,
      params as never,
    );
    if (!row) {
      res.status(404).json({ error: 'listing_not_found' });
      return;
    }
    res.json(row);
  }),
);
