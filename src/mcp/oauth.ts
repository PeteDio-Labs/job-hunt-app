// OAuth integration: delegate everything to Authentik via the SDK's
// ProxyOAuthServerProvider, expose the MCP-spec well-known endpoints + the
// /authorize, /token, /revoke proxy routes via mcpAuthRouter.
//
// Token verification: jose.jwtVerify against Authentik's JWKS (cached in-process).

import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { RequestHandler } from 'express';
import { env } from '../lib/env.ts';
import { logger } from '../lib/logger.ts';
import { db } from '../db/client.ts';

const AUTHENTIK_APP_BASE = `${env.AUTHENTIK_BASE_URL}/application/o/${env.AUTHENTIK_APP_SLUG}`;
const ISSUER = `${AUTHENTIK_APP_BASE}/`;
const JWKS_URL = `${AUTHENTIK_APP_BASE}/jwks/`;

// Lazily-created JWKS resolver. Injectable for testing — swap in a local JWKS
// in tests via _setJwksForTesting so we don't hit the network.
let _jwks: JWTVerifyGetKey | null = null;
function jwks(): JWTVerifyGetKey {
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(JWKS_URL));
  return _jwks;
}
export function _setJwksForTesting(resolver: JWTVerifyGetKey | null): void {
  _jwks = resolver;
}

/**
 * Resolve the Authentik JWT to a job-hunt user. Auto-creates the users row on
 * first sight so adding a housemate in Authentik = instant access here.
 */
async function resolveUser(payload: JWTPayload): Promise<{ email: string }> {
  const email = String(payload.email ?? '').toLowerCase();
  if (!email) {
    throw new Error('JWT missing required `email` claim');
  }
  const displayName = String(payload.name ?? payload.preferred_username ?? email);
  await db.query(
    `INSERT INTO users (email, display_name)
     VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`,
    [email, displayName],
  );
  return { email };
}

export async function verifyAuthentikAccessToken(token: string): Promise<AuthInfo> {
  const { payload } = await jwtVerify(token, jwks(), {
    issuer: ISSUER,
    audience: env.AUTHENTIK_CLIENT_ID,
  });

  const { email } = await resolveUser(payload);

  return {
    token,
    clientId: String(payload.azp ?? payload.client_id ?? env.AUTHENTIK_CLIENT_ID),
    scopes: String(payload.scope ?? '')
      .split(' ')
      .filter(Boolean),
    expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
    extra: {
      email,
      sub: String(payload.sub),
      groups: Array.isArray(payload.groups) ? payload.groups : [],
    },
  };
}

export const oauthProvider = new ProxyOAuthServerProvider({
  endpoints: {
    authorizationUrl: `${AUTHENTIK_APP_BASE}/authorize/`,
    tokenUrl: `${AUTHENTIK_APP_BASE}/token/`,
    revocationUrl: `${AUTHENTIK_APP_BASE}/revoke/`,
    // No registrationUrl — Authentik doesn't speak RFC 7591 DCR; client is
    // pre-registered via the Ansible `provision-oauth-providers` playbook.
  },
  verifyAccessToken: verifyAuthentikAccessToken,
  getClient: async (clientId) => {
    if (clientId !== env.AUTHENTIK_CLIENT_ID) return undefined;
    return {
      client_id: env.AUTHENTIK_CLIENT_ID,
      client_secret: env.AUTHENTIK_CLIENT_SECRET,
      redirect_uris: [
        'https://claude.ai/api/mcp/auth_callback',
        `${env.PUBLIC_BASE_URL}/oauth/callback`,
      ],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'openid profile email',
    };
  },
});

export function buildOAuthRouter(): RequestHandler {
  if (!env.AUTHENTIK_CLIENT_SECRET) {
    logger.warn(
      'AUTHENTIK_CLIENT_SECRET not set — MCP OAuth router not mounted. ' +
        'MCP endpoint will be unreachable until this is configured.',
    );
    // Return a no-op middleware so the app still starts (REST API still works).
    return ((_req, _res, next) => next()) as RequestHandler;
  }

  return mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(env.PUBLIC_BASE_URL),
    baseUrl: new URL(env.PUBLIC_BASE_URL),
    scopesSupported: ['openid', 'profile', 'email'],
    resourceName: 'job-hunt',
    // No clientRegistrationOptions → /register endpoint is not exposed.
  });
}
