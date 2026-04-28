import pg from 'pg';
import { env } from '../lib/env.ts';
import { logger } from '../lib/logger.ts';

const { Pool } = pg;
type PoolClient = pg.PoolClient;
type QueryResult<T extends pg.QueryResultRow = pg.QueryResultRow> = pg.QueryResult<T>;
type QueryResultRow = pg.QueryResultRow;

type SqlParam = string | number | boolean | Date | null | Record<string, unknown> | unknown[];

class DatabaseClient {
  private pool: pg.Pool | null = null;

  async connect(): Promise<void> {
    if (this.pool) return;

    this.pool = new Pool({
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      database: env.POSTGRES_DB,
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT NOW() AS now');
      logger.info(
        { host: env.POSTGRES_HOST, db: env.POSTGRES_DB, serverTime: result.rows[0].now },
        'Postgres pool initialized',
      );
    } finally {
      client.release();
    }
  }

  async disconnect(): Promise<void> {
    if (!this.pool) return;
    await this.pool.end();
    this.pool = null;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: ReadonlyArray<SqlParam>,
  ): Promise<QueryResult<T>> {
    if (!this.pool) throw new Error('Database pool not initialized');
    return this.pool.query<T>(text, params ? [...params] : undefined);
  }

  async queryOne<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: ReadonlyArray<SqlParam>,
  ): Promise<T | null> {
    const r = await this.query<T>(text, params);
    return r.rows[0] ?? null;
  }

  async queryMany<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: ReadonlyArray<SqlParam>,
  ): Promise<T[]> {
    const r = await this.query<T>(text, params);
    return r.rows;
  }

  async transaction<T>(cb: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error('Database pool not initialized');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await cb(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const r = await this.query<{ ok: number }>('SELECT 1 AS ok');
      return r.rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }
}

export const db = new DatabaseClient();
