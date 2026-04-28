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
v1.use('/', importRouter);
v1.use('/reports', reportsRouter);
app.use('/api/v1', v1);

// MCP endpoint (Streamable HTTP, stateful). Sessions are keyed by the
// `mcp-session-id` header issued during initialize. Subsequent POST/GET/DELETE
// on /mcp must include that header.
//
// Auth: when JOB_HUNT_API_TOKEN is set, MCP requests must send
//   Authorization: Bearer <token>
// When the token is unset (single-user local dev), the endpoint is open —
// same model as the REST API.
const mcpServer = buildMcpServer();
const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

function mcpAuthOk(req: express.Request): boolean {
  if (!env.JOB_HUNT_API_TOKEN) return true;
  const m = (req.header('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  return m !== null && m[1].trim() === env.JOB_HUNT_API_TOKEN;
}

async function handleMcp(req: express.Request, res: express.Response): Promise<void> {
  if (!mcpAuthOk(req)) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'unauthorized' },
      id: null,
    });
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
    await mcpServer.connect(transport);
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
