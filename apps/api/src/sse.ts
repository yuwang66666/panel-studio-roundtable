import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Repository } from './repository';
export function registerEvents(app: FastifyInstance, repo: Repository) {
  const streams = new Map<ServerResponse, string>();
  app.get<{ Params: { id: string } }>('/api/discussions/:id/events', async (req, reply) => {
    const id = req.params.id,
      snapshot = repo.snapshot(id),
      q = req.query as { after?: string };
    let cursor = z.coerce
      .number()
      .int()
      .min(0)
      .safe()
      .parse(req.headers['last-event-id'] ?? q.after ?? 0);
    reply.hijack();
    const raw = reply.raw;
    streams.set(raw, id);
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write('retry: 1500\n\n');
    let blocked = false,
      closed = false;
    const drain = () => {
      blocked = false;
      pump();
    };
    function pump() {
      if (closed || blocked) return;
      try {
        while (!closed) {
          const batch = repo.eventsAfter(id, cursor, 100);
          if (!batch.length) return;
          for (const event of batch) {
            const accepted = raw.write(
              `id: ${event.seq}\nevent: panel\ndata: ${JSON.stringify(event)}\n\n`,
            );
            cursor = event.seq;
            if (raw.writableLength > 262144) {
              raw.destroy();
              return;
            }
            if (!accepted) {
              blocked = true;
              raw.once('drain', drain);
              return;
            }
          }
          if (batch.length < 100) return;
        }
      } catch {
        raw.end();
      }
    }
    const heartbeat = setInterval(() => {
      if (!closed && !blocked) raw.write(': heartbeat\n\n');
    }, 20000);
    heartbeat.unref();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      repo.events.off(id, pump);
      raw.off('drain', drain);
      streams.delete(raw);
    };
    raw.once('close', cleanup);
    raw.once('error', cleanup);
    repo.events.on(id, pump);
    if (cursor > snapshot.lastEventSeq) {
      raw.write('event: reset\ndata: {}\n\n');
      raw.end();
    } else pump();
  });
  app.addHook('preClose', async () => {
    for (const stream of streams.keys()) stream.end();
  });
  return (id: string) => {
    for (const [stream, discussionId] of streams)
      if (discussionId === id) stream.end(`event: deleted\ndata: ${JSON.stringify({ id })}\n\n`);
  };
}
