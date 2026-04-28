import { Router } from 'express';
import { db } from '../db/client.ts';
import { asyncHandler } from '../lib/http.ts';
import { createSearchSchema, listingInputSchema } from '../domain/schema.ts';
import type { z } from 'zod';

export const searchesRouter: Router = Router();

type ListingInput = z.infer<typeof listingInputSchema>;

interface ListingRow {
  id: string;
  indeed_job_id: string;
}

async function upsertListing(
  client: { query: (text: string, params: unknown[]) => Promise<{ rows: ListingRow[] }> },
  listing: ListingInput,
): Promise<ListingRow> {
  const { rows } = await client.query(
    `INSERT INTO job_listings (
        indeed_job_id, title, company, location, apply_url, description_md,
        salary_min, salary_max, salary_currency, job_type, remote, posted_at, metadata,
        last_fetched_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
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
       posted_at       = COALESCE(EXCLUDED.posted_at, job_listings.posted_at),
       metadata        = job_listings.metadata || EXCLUDED.metadata,
       last_fetched_at = NOW()
     RETURNING id, indeed_job_id`,
    [
      listing.indeed_job_id,
      listing.title,
      listing.company,
      listing.location ?? null,
      listing.apply_url,
      listing.description_md ?? null,
      listing.salary_min ?? null,
      listing.salary_max ?? null,
      listing.salary_currency ?? null,
      listing.job_type ?? null,
      listing.remote ?? null,
      listing.posted_at ?? null,
      JSON.stringify(listing.metadata ?? {}),
    ],
  );
  return rows[0];
}

searchesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSearchSchema.parse(req.body);
    const userId = req.userId!;

    const result = await db.transaction(async (client) => {
      const search = await client.query(
        `INSERT INTO searches (user_id, query, location, country_code, job_type, raw_response, result_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, created_at`,
        [
          userId,
          body.query,
          body.location,
          body.country_code,
          body.job_type ?? null,
          body.raw_response ?? null,
          body.listings.length,
        ],
      );
      const searchId: string = search.rows[0].id;

      const listingIds: ListingRow[] = [];
      for (let i = 0; i < body.listings.length; i++) {
        const upserted = await upsertListing(client, body.listings[i]);
        listingIds.push(upserted);
        await client.query(
          `INSERT INTO search_listings (search_id, listing_id, rank)
           VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`,
          [searchId, upserted.id, i + 1],
        );
      }

      return { search_id: searchId, listings: listingIds };
    });

    res.status(201).json(result);
  }),
);

searchesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const rows = await db.queryMany(
      `SELECT id, query, location, country_code, job_type, result_count, created_at
       FROM searches
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [userId],
    );
    res.json({ searches: rows });
  }),
);

searchesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const search = await db.queryOne(
      `SELECT * FROM searches WHERE id = $1 AND user_id = $2`,
      [req.params.id, userId],
    );
    if (!search) {
      res.status(404).json({ error: 'search_not_found' });
      return;
    }
    const listings = await db.queryMany(
      `SELECT jl.*, sl.rank
       FROM search_listings sl
       JOIN job_listings jl ON jl.id = sl.listing_id
       WHERE sl.search_id = $1
       ORDER BY sl.rank`,
      [req.params.id],
    );
    res.json({ search, listings });
  }),
);
