import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import type { StateStore } from '../pipeline/state.js';
import type { ActivityLog } from './activity.js';
import { DASHBOARD_HTML } from './page.js';

export interface DashboardOptions {
  port: number;
  host: string;
  activity: ActivityLog;
  /** One state store per client; open clarifications from all of them are listed. */
  stores: StateStore[];
  info: Record<string, unknown>;
  log: Logger;
  evalDir?: string;
}

function evalSummary(dir: string) {
  const read = (d: string) =>
    existsSync(d)
      ? readdirSync(d)
          .filter((f) => f.endsWith('.json'))
          .map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')))
          .filter((r) => r.status === 'ok' && r.metrics)
          .map((r) => ({ model: r.model, timestamp: r.timestamp, casesScored: r.casesScored ?? r.caseCount, caseCount: r.caseCount, headline: r.metrics.headline, latency: r.metrics.latency_ms }))
      : [];
  return { main: read(dir), holdout: read(join(dir, 'holdout')) };
}

/** Read-only dashboard. Binds to localhost by default; there is no authentication, so do not expose it publicly. */
export function startDashboard(o: DashboardOptions): Promise<Server> {
  const json = (data: unknown) => [200, { 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify(data)] as const;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    let out: readonly [number, Record<string, string>, string];
    try {
      if (req.method !== 'GET') out = [405, {}, ''];
      else if (path === '/') out = [200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self' 'unsafe-inline'" }, DASHBOARD_HTML];
      else if (path === '/api/activity') out = json(o.activity.list());
      else if (path === '/api/pending')
        out = json(o.stores.flatMap((st) => st.listPending()).map((p) => ({ question: p.question, options: p.options.map((x) => x.name), attempts: p.attempts, createdAt: p.createdAt, expiresAt: p.expiresAt })));
      else if (path === '/api/info') out = json(o.info);
      else if (path === '/api/eval') out = json(evalSummary(o.evalDir ?? 'eval/results'));
      else out = [404, {}, 'not found'];
    } catch (e) {
      o.log.error('dashboard.error', { error: e, path });
      out = [500, {}, 'error'];
    }
    res.writeHead(out[0], out[1]).end(out[2]);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => resolve(server));
  });
}
