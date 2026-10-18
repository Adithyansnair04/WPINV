import { loadConfig } from '../config.js';

/**
 * One-time exchange of a Zoho "Self Client" grant code for a refresh token.
 * Usage: npm run zoho:token -- <grant_code>
 * Generate the code at https://api-console.zoho.in (Self Client) with scopes:
 * ZohoBooks.contacts.READ,ZohoBooks.contacts.CREATE,ZohoBooks.settings.READ,ZohoBooks.settings.CREATE,ZohoBooks.invoices.READ,ZohoBooks.invoices.CREATE
 */
const code = process.argv[2];
const cfg = loadConfig();
if (!code || !cfg.ZOHO_CLIENT_ID || !cfg.ZOHO_CLIENT_SECRET) {
  console.error('Usage: npm run zoho:token -- <grant_code>   (requires ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in .env)');
  process.exit(1);
}

const res = await fetch(`${cfg.ZOHO_ACCOUNTS_URL.replace(/\/$/, '')}/oauth/v2/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.ZOHO_CLIENT_ID, client_secret: cfg.ZOHO_CLIENT_SECRET, code }),
  signal: AbortSignal.timeout(20000),
});
const json = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string; api_domain?: string; scope?: string };
if (!json.refresh_token) {
  console.error(`Token exchange failed: ${json.error ?? `HTTP ${res.status}`}. Grant codes expire within minutes and are single-use; check the accounts data centre (${cfg.ZOHO_ACCOUNTS_URL}).`);
  process.exit(1);
}
console.log('Success. Add this to your .env (keep it secret, never commit it):\n');
console.log(`ZOHO_REFRESH_TOKEN=${json.refresh_token}`);
if (json.api_domain) console.log(`\napi_domain=${json.api_domain} -> ZOHO_API_BASE should be ${json.api_domain}/books/v3`);
