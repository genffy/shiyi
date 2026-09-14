import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ShiYiDb } from '../core/db.js';
import { syncLocalSources } from '../core/sync.js';
import { SOURCE_LABELS, type LocalSourceAdapter, type SourceId } from '../core/types.js';

const VALID_SOURCES = new Set(Object.keys(SOURCE_LABELS));

export interface BuildAppOptions {
  db: ShiYiDb;
  adapters: LocalSourceAdapter[];
  /** extra status surfaced to the frontend (e.g. whether the watcher runs) */
  watchInfo?: () => Record<string, unknown>;
}

export async function buildApp({ db, adapters, watchInfo }: BuildAppOptions) {
  const app = Fastify({ logger: false });

  app.get('/api/stats', async () => {
    const counts = db.sourceCounts();
    const total = counts.reduce((s, c) => s + c.count, 0);
    return {
      total,
      sources: counts.map((c) => ({ ...c, label: SOURCE_LABELS[c.source] ?? c.source })),
      ...(watchInfo ? watchInfo() : {}),
    };
  });

  app.get('/api/sessions', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const source = q['source'] && VALID_SOURCES.has(q['source']) ? (q['source'] as SourceId) : undefined;
    const limit = Math.max(1, Math.min(Number(q['limit'] ?? 50), 200));
    const offset = Math.max(0, Number(q['offset'] ?? 0) || 0);
    const { total, items } = db.listSessions({ source, q: q['q'], limit, offset });
    return {
      total,
      items: items.map((s) => ({
        id: s.id,
        source: s.source,
        title: s.title,
        project: s.project,
        started_at: s.started_at,
        ended_at: s.ended_at,
        message_count: s.message_count,
        snippet: s.snippet ?? null,
      })),
    };
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = db.getSession(decodeURIComponent(id));
    if (!session) return reply.code(404).send({ error: 'not found' });
    const messages = db.getMessages(session.id).map((m) => ({
      seq: m.seq,
      role: m.role,
      content: m.content,
      thinking: m.thinking ?? null,
      tool_calls: m.tool_calls_json ? (JSON.parse(m.tool_calls_json) as unknown[]) : [],
      created_at: m.created_at,
    }));
    return { session, messages };
  });

  app.post('/api/sync', async () => {
    return { results: await syncLocalSources(db, adapters) };
  });

  // built frontend assets (skipped when absent; vite dev server serves the page instead)
  const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist-web');
  try {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  } catch {
    // @fastify/static throws when dist-web is missing; safe to ignore
  }

  return app;
}
