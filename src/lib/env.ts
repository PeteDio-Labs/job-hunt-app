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

  // --- Authentik OAuth integration (MCP only) ---
  // The MCP /mcp endpoint validates JWTs from this Authentik OIDC provider.
  // The /authorize, /token, /revoke endpoints exposed by the SDK's mcpAuthRouter
  // proxy directly to Authentik — so we need both client_id and client_secret.
  AUTHENTIK_BASE_URL: z
    .string()
    .url()
    .default('https://auth.toastedbytes.com'),
  AUTHENTIK_APP_SLUG: z.string().min(1).default('job-hunt'),
  AUTHENTIK_CLIENT_ID: z.string().min(1).default('job-hunt-mcp'),
  AUTHENTIK_CLIENT_SECRET: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(16, 'AUTHENTIK_CLIENT_SECRET must be set when MCP OAuth is enabled').optional(),
  ),

  // Public URL the MCP server is reachable at (used in OAuth metadata so
  // claude.ai sees endpoints on this hostname rather than on Authentik's).
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .default('https://job-hunt.toastedbytes.com'),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
