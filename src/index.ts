import express from 'express';
import { env } from './lib/env.ts';
import { logger } from './lib/logger.ts';
import { db } from './db/client.ts';
import { seedDefaultUser } from './db/seed.ts';
import { bearerAuth } from './middleware/auth.ts';
import { errorHandler } from './lib/http.ts';
import { searchesRouter } from './routes/searches.ts';
import { listingsRouter } from './routes/listings.ts';
import { applicationsRouter } from './routes/applications.ts';
import { coverLettersRouter } from './routes/cover-letters.ts';
import { eventsRouter } from './routes/events.ts';
import { reportsRouter } from './routes/reports.ts';

const app = express();

app.use(express.json({ limit: '4mb' }));

app.get('/health', async (_req, res) => {
  const dbOk = await db.healthCheck();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    service: 'job-hunt',
    db: dbOk,
  });
});

const v1 = express.Router();
v1.use(bearerAuth);
v1.use('/searches', searchesRouter);
v1.use('/listings', listingsRouter);
v1.use('/applications', applicationsRouter);
v1.use('/', coverLettersRouter);
v1.use('/', eventsRouter);
v1.use('/reports', reportsRouter);
app.use('/api/v1', v1);

app.use(errorHandler);

async function main() {
  await db.connect();
  await seedDefaultUser();
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'job-hunt listening');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Startup failed');
  process.exit(1);
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down');
  await db.disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
