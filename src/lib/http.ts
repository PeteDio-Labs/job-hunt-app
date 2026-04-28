import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger.ts';
import { InvalidTransitionError } from '../domain/status-machine.ts';

export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation_error', issues: err.issues });
    return;
  }
  if (err instanceof InvalidTransitionError) {
    res.status(409).json({ error: 'invalid_transition', from: err.from, to: err.to });
    return;
  }
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  ) {
    res.status(409).json({ error: 'duplicate', detail: (err as { detail?: string }).detail });
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, 'Unhandled request error');
  res.status(500).json({ error: 'internal_error' });
}
