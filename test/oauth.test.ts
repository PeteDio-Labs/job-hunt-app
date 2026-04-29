// Verify the JWT validation path of the MCP OAuth integration.
//
// We don't talk to Authentik. We generate a local RSA keypair, build a local
// JWKS, and inject it into the SUT via _setJwksForTesting.

import { describe, it, expect, beforeAll, mock, setDefaultTimeout } from 'bun:test';

// Module init (importing the SUT, mock setup, ES256 keypair gen) can run >5s
// in cold containers — bump the per-test/hook default before anything else.
setDefaultTimeout(30_000);
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWK,
} from 'jose';

const ISSUER = 'https://auth.toastedbytes.com/application/o/job-hunt/';
const AUDIENCE = 'job-hunt-mcp';

let signKey: unknown;

beforeAll(async () => {
  // Required env BEFORE the SUT is loaded — env.ts parses on module load.
  process.env.POSTGRES_PASSWORD ||= 'dummy-postgres-password-for-tests';
  process.env.AUTHENTIK_CLIENT_SECRET ||= 'dummy-client-secret-at-least-16-chars';

  // Stub the db client so the user-upsert side effect is a no-op.
  await mock.module('../src/db/client.ts', () => ({
    db: { query: async () => ({ rows: [], rowCount: 0 }) },
  }));

  // ES256 is much faster to generate than RS256 — keeps the beforeAll under
  // the default test-hook timeout.
  const kp = await generateKeyPair('ES256');
  signKey = kp.privateKey;
  const pubJwk = await exportJWK(kp.publicKey);
  const fullJwk: JWK = { ...pubJwk, alg: 'ES256', use: 'sig', kid: 'test-key' };
  const localJwks = createLocalJWKSet({ keys: [fullJwk] });

  const oauth = await import('../src/mcp/oauth.ts');
  oauth._setJwksForTesting(localJwks);
});

async function makeJwt(overrides: Record<string, unknown> = {}, opts: { iss?: string; aud?: string; expSeconds?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    email: 'pedelgadillo@gmail.com',
    name: 'Pedro Delgadillo',
    sub: 'authentik-user-5',
    scope: 'openid profile email',
    azp: AUDIENCE,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expSeconds ?? 300))
    .sign(signKey as never);
}

describe('verifyAuthentikAccessToken', () => {
  it('accepts a valid JWT and returns AuthInfo', async () => {
    const { verifyAuthentikAccessToken } = await import('../src/mcp/oauth.ts');
    const jwt = await makeJwt();
    const info = await verifyAuthentikAccessToken(jwt);
    expect(info.token).toBe(jwt);
    expect(info.clientId).toBe(AUDIENCE);
    expect(info.scopes).toEqual(['openid', 'profile', 'email']);
    expect(info.extra?.email).toBe('pedelgadillo@gmail.com');
    expect(info.extra?.sub).toBe('authentik-user-5');
  });

  it('rejects wrong audience', async () => {
    const { verifyAuthentikAccessToken } = await import('../src/mcp/oauth.ts');
    const jwt = await makeJwt({}, { aud: 'some-other-client' });
    await expect(verifyAuthentikAccessToken(jwt)).rejects.toThrow();
  });

  it('rejects wrong issuer', async () => {
    const { verifyAuthentikAccessToken } = await import('../src/mcp/oauth.ts');
    const jwt = await makeJwt({}, { iss: 'https://evil.example/issuer/' });
    await expect(verifyAuthentikAccessToken(jwt)).rejects.toThrow();
  });

  it('rejects expired token', async () => {
    const { verifyAuthentikAccessToken } = await import('../src/mcp/oauth.ts');
    const jwt = await makeJwt({}, { expSeconds: -3600 });
    await expect(verifyAuthentikAccessToken(jwt)).rejects.toThrow();
  });

  it('rejects token missing email claim', async () => {
    const { verifyAuthentikAccessToken } = await import('../src/mcp/oauth.ts');
    const jwt = await makeJwt({ email: undefined });
    await expect(verifyAuthentikAccessToken(jwt)).rejects.toThrow(/email/);
  });
});
