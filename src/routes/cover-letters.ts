import { Router } from 'express';
import { db } from '../db/client.ts';
import { asyncHandler } from '../lib/http.ts';
import { createCoverLetterSchema } from '../domain/schema.ts';

export const coverLettersRouter: Router = Router();

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

coverLettersRouter.post(
  '/applications/:id/cover-letters',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const body = createCoverLetterSchema.parse(req.body);

    const result = await db.transaction(async (client) => {
      const app = (
        await client.query(
          'SELECT id FROM applications WHERE id = $1 AND user_id = $2',
          [req.params.id, userId],
        )
      ).rows[0] as { id: string } | undefined;
      if (!app) return null;

      // deactivate previous active versions
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
         VALUES ($1, $2, $3, $4, TRUE)
         RETURNING *`,
        [app.id, body.body_md, wordCount(body.body_md), next],
      );
      return inserted.rows[0];
    });

    if (!result) {
      res.status(404).json({ error: 'application_not_found' });
      return;
    }
    res.status(201).json(result);
  }),
);
