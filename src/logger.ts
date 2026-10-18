const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;
export type Fields = Record<string, unknown>;

const SECRET_KEY = /token|secret|authorization|api[_-]?key|password|cookie/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') {
    if (typeof value === 'string') return value.replace(/(Zoho-oauthtoken|Bearer)\s+\S+/gi, '$1 [redacted]');
    return value;
  }
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

export function createLogger(level: Level = 'info', base: Fields = {}, sink = (line: string) => console.log(line)): Logger {
  const min = LEVELS[level];
  const write = (lvl: Level, event: string, fields?: Fields) => {
    if (LEVELS[lvl] < min) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, event, ...(redact({ ...base, ...fields }) as Fields) }));
  };
  return {
    debug: (e, f) => write('debug', e, f),
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, sink),
  };
}

export const silentLogger: Logger = createLogger('error', {}, () => {});
