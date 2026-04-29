// OAuth integration: delegate everything to Authentik via the SDK's
// ProxyOAuthServerProvider, expose the MCP-spec well-known endpoints + the
// /authorize, /token, /revoke proxy routes via mcpAuthRouter.
//
// Token verification: jose.jwtVerify against Authentik's JWKS (cached in-process).

import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Response, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
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

// --- Dynamic Client Registration (RFC 7591) bridge -----------------------
// Authentik doesn't natively support DCR, but Cowork (claude.ai) requires it:
// it POSTs to /register, expects a fresh client_id back, then uses that ID
// for /authorize and /token.
//
// Strategy: accept DCR, mint a per-Cowork-install dynamic client_id, store
// it in memory, but when WE forward /authorize and /token to Authentik,
// substitute our single pre-registered Authentik client (`job-hunt-mcp`).
// Cowork sees DCR, Authentik sees a normal confidential client.
//
// In-memory only — survives only until process restart, which is fine since
// Cowork re-registers transparently on first use.

interface StoredClient extends OAuthClientInformationFull {}
const dynamicClients = new Map<string, StoredClient>();

function staticAuthentikClient(): OAuthClientInformationFull {
  if (!env.AUTHENTIK_CLIENT_SECRET) {
    throw new Error('AUTHENTIK_CLIENT_SECRET not set');
  }
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
}

const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId: string) {
    if (clientId === env.AUTHENTIK_CLIENT_ID) return staticAuthentikClient();
    return dynamicClients.get(clientId);
  },
  registerClient(metadata: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) {
    // Honor the redirect_uris Cowork sent — Authentik already has the canonical
    // one allow-listed (https://claude.ai/api/mcp/auth_callback).
    const id = `mcp-dyn-${randomUUID()}`;
    const stored: StoredClient = {
      ...metadata,
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      // Public client (PKCE-only) — no secret returned to Cowork.
      client_secret: undefined,
      token_endpoint_auth_method: 'none',
    };
    dynamicClients.set(id, stored);
    logger.info(
      { dynamicClientId: id, redirectUris: metadata.redirect_uris },
      'Registered dynamic OAuth client (proxied to Authentik)',
    );
    return stored;
  },
};

class JobHuntOAuthProvider extends ProxyOAuthServerProvider {
  override get clientsStore(): OAuthRegisteredClientsStore {
    return clientsStore;
  }

  // For every operation that talks to Authentik, swap in the static client.
  // The dynamic client_id Cowork uses is just a coupon redeemed locally.
  override async authorize(
    _client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    return super.authorize(staticAuthentikClient(), params, res);
  }

  override async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    return super.exchangeAuthorizationCode(
      staticAuthentikClient(),
      authorizationCode,
      codeVerifier,
      redirectUri,
      resource,
    );
  }

  override async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    return super.exchangeRefreshToken(staticAuthentikClient(), refreshToken, scopes, resource);
  }
}

export const oauthProvider = new JobHuntOAuthProvider({
  endpoints: {
    authorizationUrl: `${AUTHENTIK_APP_BASE}/authorize/`,
    tokenUrl: `${AUTHENTIK_APP_BASE}/token/`,
    revocationUrl: `${AUTHENTIK_APP_BASE}/revoke/`,
  },
  verifyAccessToken: verifyAuthentikAccessToken,
  // SDK requires a getClient on construction; ours is overridden by clientsStore above.
  getClient: async (clientId) => clientsStore.getClient(clientId),
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
    clientRegistrationOptions: {
      // Dynamic registrations don't expire — the underlying Authentik client
      // is what enforces real auth. Public-client (PKCE) flow.
      clientSecretExpirySeconds: 0,
      clientIdGeneration: false, // we generate our own in clientsStore.registerClient
    },
  });
}
