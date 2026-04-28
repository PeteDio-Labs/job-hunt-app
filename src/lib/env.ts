import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3014),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),

  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().default('job_hunt'),
  POSTGRES_USER: z.string().default('job_hunt'),
  POSTGRES_PASSWORD: z.string().min(1, 'POSTGRES_PASSWORD is required'),

  // Optional. When unset OR empty, the API is open (single-user local dev).
  // When set, every /api/v1 request must send `Authorization: Bearer <token>`.
  JOB_HUNT_API_TOKEN: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z
      .string()
      .min(16, 'JOB_HUNT_API_TOKEN must be at least 16 chars')
      .optional(),
  ),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
