import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// .env is the source of truth: override stale values that editors (e.g. VS Code's useEnvFile) inject when a terminal opens.
loadDotenv({ override: true, quiet: true });

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const list = z
  .string()
  .default('')
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const EnvSchema = z.object({
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_MESSAGE_TEXT: bool(false),
  DATA_DIR: z.string().default('.data'),

  LLM_MODEL: z.string().default('gemini:gemini-3.1-flash-lite'),
  // Used when LLM_MODEL fails (overloaded, rate-limited, timeout, unusable output). Empty = no fallback.
  LLM_FALLBACK_MODEL: z.string().optional(),
  EVAL_MODELS: list,
  EVAL_DELAY_MS: z.coerce.number().int().min(0).default(0),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  GROQ_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  ZOHO_MODE: z.enum(['mock', 'live']).default('mock'),
  ZOHO_CLIENT_ID: z.string().optional(),
  ZOHO_CLIENT_SECRET: z.string().optional(),
  ZOHO_REFRESH_TOKEN: z.string().optional(),
  ZOHO_ORG_ID: z.string().optional(),
  ZOHO_API_BASE: z.string().url().default('https://www.zohoapis.in/books/v3'),
  ZOHO_ACCOUNTS_URL: z.string().url().default('https://accounts.zoho.in'),
  ZOHO_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  INVOICE_ALLOW_LIVE_CREATE: bool(false),

  MAX_MESSAGE_AGE_SEC: z.coerce.number().int().positive().default(600),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALLOWED_CHATS: list,

  DASHBOARD_PORT: z.coerce.number().int().min(0).default(3001),
  DASHBOARD_HOST: z.string().default('127.0.0.1'),

  // Adding customers from chat: 'confirm' = allowed after an explicit Yes; 'off' = disabled.
  CUSTOMER_CREATE: z.enum(['confirm', 'off']).default('confirm'),
  // Optional allowlist of sender ids who may add customers (empty = any member of an allowed chat).
  CUSTOMER_CREATORS: list,
  // 'always' = show a preview and create the invoice in Zoho only after an explicit Yes; 'off' = create immediately.
  INVOICE_CONFIRM: z.enum(['always', 'off']).default('always'),
  // Optional: only these sender ids may confirm invoices (empty = the person who asked).
  INVOICE_APPROVERS: list,

  CLARIFY_TTL_MINUTES: z.coerce.number().positive().default(15),
  RATE_POLICY: z.enum(['ask', 'item_default']).default('ask'),
  // Tax applied to invoice lines whose item has no tax of its own (needs a tax with this % in Zoho). Empty = items' own tax only.
  DEFAULT_TAX_PERCENT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().min(0).max(100).optional()),
  BASE_CURRENCY: z.string().default('INR'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}

export function requireZohoCredentials(cfg: Config) {
  const missing = (['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID'] as const).filter(
    (k) => !cfg[k],
  );
  if (missing.length) throw new Error(`Missing Zoho configuration: ${missing.join(', ')}`);
  return {
    clientId: cfg.ZOHO_CLIENT_ID!,
    clientSecret: cfg.ZOHO_CLIENT_SECRET!,
    refreshToken: cfg.ZOHO_REFRESH_TOKEN!,
    orgId: cfg.ZOHO_ORG_ID!,
    apiBase: cfg.ZOHO_API_BASE.replace(/\/$/, ''),
    accountsUrl: cfg.ZOHO_ACCOUNTS_URL.replace(/\/$/, ''),
    timeoutMs: cfg.ZOHO_TIMEOUT_MS,
  };
}
