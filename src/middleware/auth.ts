import type { NextFunction, Request, Response } from 'express';
import { db } from '../db/client.ts';
import { env } from '../lib/env.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

interface UserRow {
  id: string;
}

export async function bearerAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // When JOB_HUNT_API_TOKEN is set, require a matching bearer token.
  // When it's unset, we're in single-user local mode — accept anything and
  // resolve the default user. Set the env var before sharing the API.
  if (env.JOB_HUNT_API_TOKEN) {
    const header = req.header('authorization') ?? '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.status(401).json({ error: 'missing_bearer_token' });
      return;
    }
    if (match[1].trim() !== env.JOB_HUNT_API_TOKEN) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
  }

  const user = await db.queryOne<UserRow>(
    'SELECT id FROM users WHERE email = $1',
    ['pedelgadillo@gmail.com'],
  );
  if (!user) {
    res.status(500).json({ error: 'no_user_seeded' });
    return;
  }
  req.userId = user.id;
  next();
}
