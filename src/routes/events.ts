import { Router } from 'express';
import { db } from '../db/client.ts';
import { asyncHandler } from '../lib/http.ts';
import { createEventSchema } from '../domain/schema.ts';

export const eventsRouter: Router = Router();

eventsRouter.post(
  '/applications/:id/events',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const body = createEventSchema.parse(req.body);

    const result = await db.transaction(async (client) => {
      const app = (
        await client.query(
          'SELECT id FROM applications WHERE id = $1 AND user_id = $2',
          [req.params.id, userId],
        )
      ).rows[0] as { id: string } | undefined;
      if (!app) return null;

      const inserted = await client.query(
        `INSERT INTO application_events (application_id, kind, payload)
         VALUES ($1, $2, $3::jsonb)
         RETURNING *`,
        [app.id, body.kind, JSON.stringify(body.payload)],
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
