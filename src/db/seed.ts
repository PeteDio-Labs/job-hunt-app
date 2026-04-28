import { db } from './client.ts';
import { logger } from '../lib/logger.ts';

export async function seedDefaultUser(): Promise<void> {
  const email = 'pedelgadillo@gmail.com';
  const result = await db.query(
    `INSERT INTO users (email, display_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING`,
    [email, 'Pedro Delgadillo'],
  );
  if (result.rowCount && result.rowCount > 0) {
    logger.info({ email }, 'Seeded default user');
  }
}
