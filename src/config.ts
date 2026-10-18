import 'dotenv/config';
import { z } from 'zod';

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

  LLM_MODEL: z.string().default('mistral:mistral-small-latest'),
  EVAL_MODELS: list,
  EVAL_DELAY_MS: z.coerce.number().int().min(0).default(0),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MISTRAL_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  COMPAT_BASE_URL: z.string().url().optional(),
  COMPAT_API_KEY: z.string().optional(),

  ZOHO_MODE: z.enum(['mock', 'live']).default('mock'),
  ZOHO_CLIENT_ID: z.string().optional(),
  ZOHO_CLIENT_SECRET: z.string().optional(),
  ZOHO_REFRESH_TOKEN: z.string().optional(),
  ZOHO_ORG_ID: z.string().optional(),
  ZOHO_API_BASE: z.string().url().default('https://www.zohoapis.in/books/v3'),
  ZOHO_ACCOUNTS_URL: z.string().url().default('https://accounts.zoho.in'),
  ZOHO_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  INVOICE_ALLOW_LIVE_CREATE: bool(false),

  CHAT_TRANSPORT: z.enum(['telegram', 'whatsapp_cloud', 'baileys']).default('telegram'),
  MAX_MESSAGE_AGE_SEC: z.coerce.number().int().positive().default(600),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALLOWED_CHATS: list,

  WA_PHONE_NUMBER_ID: z.string().optional(),
  WA_ACCESS_TOKEN: z.string().optional(),
  WA_APP_SECRET: z.string().optional(),
  WA_VERIFY_TOKEN: z.string().optional(),
  WA_GRAPH_VERSION: z.string().default('v25.0'),
  WA_ALLOWED_SENDERS: list,
  PORT: z.coerce.number().int().positive().default(3000),

  WA_AUTH_DIR: z.string().default('.data/wa-auth'),
  WA_ALLOWED_GROUPS: list,

  CLARIFY_TTL_MINUTES: z.coerce.number().positive().default(15),
  RATE_POLICY: z.enum(['ask', 'item_default']).default('ask'),
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
