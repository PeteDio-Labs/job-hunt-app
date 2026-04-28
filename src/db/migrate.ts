import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './client.ts';
import { logger } from '../lib/logger.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

interface Migration {
  version: number;
  name: string;
  sql: string;
}

async function ensureMigrationsTable(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getApplied(): Promise<Set<number>> {
  const rows = await db.queryMany<{ version: number }>(
    'SELECT version FROM schema_migrations',
  );
  return new Set(rows.map((r) => r.version));
}

function loadMigrations(): Migration[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const m = file.match(/^(\d+)_(.+)\.sql$/);
      if (!m) throw new Error(`Bad migration filename: ${file}`);
      return {
        version: Number(m[1]),
        name: m[2],
        sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'),
      };
    });
}

async function migrate(): Promise<void> {
  await db.connect();
  await ensureMigrationsTable();
  const applied = await getApplied();
  const all = loadMigrations();
  const pending = all.filter((m) => !applied.has(m.version));

  if (pending.length === 0) {
    logger.info('No pending migrations');
    return;
  }

  for (const m of pending) {
    logger.info({ version: m.version, name: m.name }, 'Applying migration');
    await db.transaction(async (client) => {
      await client.query(m.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
        [m.version, m.name],
      );
    });
  }
  logger.info({ count: pending.length }, 'Migrations applied');
}

async function status(): Promise<void> {
  await db.connect();
  await ensureMigrationsTable();
  const applied = await getApplied();
  const all = loadMigrations();
  for (const m of all) {
    const mark = applied.has(m.version) ? '✓' : '✗';
    console.log(`${mark} ${String(m.version).padStart(3, '0')}  ${m.name}`);
  }
}

async function main() {
  const cmd = process.argv[2] ?? 'migrate';
  try {
    if (cmd === 'migrate') await migrate();
    else if (cmd === 'status') await status();
    else {
      console.error(`Unknown command: ${cmd}. Use 'migrate' or 'status'.`);
      process.exit(1);
    }
  } finally {
    await db.disconnect();
  }
}

main().catch((err) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});
