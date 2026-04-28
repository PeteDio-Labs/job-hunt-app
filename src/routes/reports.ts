import { Router } from 'express';
import { db } from '../db/client.ts';
import { asyncHandler } from '../lib/http.ts';

export const reportsRouter: Router = Router();

reportsRouter.get(
  '/funnel',
  asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const counts = await db.queryMany<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count
       FROM applications
       WHERE user_id = $1
       GROUP BY status`,
      [userId],
    );

    const last30 = await db.queryOne<{ submitted: string; responded: string; rejected: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE applied_at   >= NOW() - INTERVAL '30 days')::text AS submitted,
         COUNT(*) FILTER (WHERE responded_at >= NOW() - INTERVAL '30 days')::text AS responded,
         COUNT(*) FILTER (WHERE closed_at    >= NOW() - INTERVAL '30 days' AND status = 'rejected')::text AS rejected
       FROM applications
       WHERE user_id = $1`,
      [userId],
    );

    const byStatus: Record<string, number> = {};
    for (const r of counts) byStatus[r.status] = Number(r.count);

    res.json({
      by_status: byStatus,
      last_30d: {
        submitted: Number(last30?.submitted ?? 0),
        responded: Number(last30?.responded ?? 0),
        rejected: Number(last30?.rejected ?? 0),
      },
    });
  }),
);
