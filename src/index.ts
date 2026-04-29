import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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
import { importRouter } from './routes/import.ts';
import { reportsRouter } from './routes/reports.ts';
import { buildMcpServer } from './mcp/server.ts';
import { buildOAuthRouter, verifyAuthentikAccessToken } from './mcp/oauth.ts';

const app = express();

// Cloudflare Tunnel sets X-Forwarded-* headers. Trust them so Express sees
// the real client IP and so express-rate-limit (used by mcpAuthRouter) doesn't
// throw ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

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
v1.use('/', importRouter);
v1.use('/reports', reportsRouter);
app.use('/api/v1', v1);

// Mount the OAuth proxy router (provides /.well-known/oauth-protected-resource,
// /.well-known/oauth-authorization-server, /authorize, /token, /revoke).
// All requests are proxied to Authentik. Mounted BEFORE /mcp so well-known
// paths resolve first.
app.use(buildOAuthRouter());

// MCP endpoint (Streamable HTTP, stateful). Sessions are keyed by the
// `mcp-session-id` header issued during initialize. Subsequent POST/GET/DELETE
// on /mcp must include that header.
//
// Auth: every request must carry an Authentik-issued JWT in
//   Authorization: Bearer <jwt>
// We validate against Authentik's JWKS via jose. On failure, return 401 with
// a WWW-Authenticate header pointing clients at the protected-resource
// metadata so MCP-aware clients (like claude.ai's Cowork connector) can
// discover the OAuth dance.
const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

function mcpUnauthorized(req: express.Request, res: express.Response, detail?: string): void {
  const resourceMetadataUrl = `${env.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource`;
  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${resourceMetadataUrl}"${detail ? `, error="invalid_token", error_description="${detail}"` : ''}`,
  );
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'unauthorized', data: { resourceMetadataUrl } },
    id: null,
  });
}

async function handleMcp(req: express.Request, res: express.Response): Promise<void> {
  const m = (req.header('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  if (!m) {
    mcpUnauthorized(req, res, 'missing bearer token');
    return;
  }
  try {
    await verifyAuthentikAccessToken(m[1].trim());
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'MCP auth verification failed');
    mcpUnauthorized(req, res, (err as Error).message);
    return;
  }

  const sessionId = req.header('mcp-session-id');
  let transport: StreamableHTTPServerTransport | undefined;

  if (sessionId && mcpTransports.has(sessionId)) {
    transport = mcpTransports.get(sessionId);
  } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (transport) {
          mcpTransports.set(id, transport);
          logger.debug({ sessionId: id }, 'MCP session initialized');
        }
      },
    });
    transport.onclose = () => {
      const id = transport?.sessionId;
      if (id) {
        mcpTransports.delete(id);
        logger.debug({ sessionId: id }, 'MCP session closed');
      }
    };
    // Fresh McpServer per session — the SDK only allows one transport per server.
    const sessionServer = buildMcpServer();
    await sessionServer.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Missing or invalid mcp-session-id header (and request is not initialize)',
      },
      id: null,
    });
    return;
  }

  try {
    await transport!.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err }, 'MCP request handling failed');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'internal_error' },
        id: null,
      });
    }
  }
}

app.post('/mcp', handleMcp);
app.get('/mcp', handleMcp);
app.delete('/mcp', handleMcp);

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
