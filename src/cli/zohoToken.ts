import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CLIENTS_FILE, pickClient, readClientsFile, saveClientSetting } from '../clients/registry.js';

/**
 * One-time setup: exchanges a Zoho "Self Client" grant code for a refresh token and SAVES it (and the
 * organization id, when there is exactly one) into .env, or into clients.json for --client, so nothing has to be copied by hand.
 * Usage: npm run zoho:token -- [--client acme] <grant_code>
 * Generate the code at https://api-console.zoho.in (Self Client > Generate Code) with scopes:
 * ZohoBooks.contacts.READ,ZohoBooks.contacts.CREATE,ZohoBooks.settings.READ,ZohoBooks.settings.CREATE,ZohoBooks.invoices.READ,ZohoBooks.invoices.CREATE,ZohoBooks.invoices.UPDATE
 * Tokens are never printed.
 */
const { values, positionals } = parseArgs({ options: { client: { type: 'string' } }, allowPositionals: true });
const multiClient = readClientsFile() !== null;
const target = multiClient ? CLIENTS_FILE : '.env';

/** Replaces KEY=... in .env (or appends it) without touching other lines. */
function saveEnv(key: string, value: string) {
  const lines = readFileSync('.env', 'utf8').split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync('.env', lines.join('\n'));
}

const HINTS: Record<string, string> = {
  invalid_code:
    'The code has expired or was already used. Codes are single-use and only live for the "Time Duration" you picked (3-10 min). Generate a NEW code and run this command right away.',
  invalid_client:
    'This client id/secret is not known at this Zoho data centre. Create the Self Client at the API console of your region (api-console.zoho.in for India) and check ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET.',
};

async function main(): Promise<number> {
  const code = positionals[0]?.trim();
  const client = pickClient(values.client);
  const cfg = client.cfg;
  const save = multiClient ? (key: string, value: string) => saveClientSetting(client.id, key, value) : saveEnv;
  if (!code || !cfg.ZOHO_CLIENT_ID || !cfg.ZOHO_CLIENT_SECRET) {
    console.error(`Usage: npm run zoho:token -- [--client <id>] <grant_code>   (requires ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in ${target})`);
    return 1;
  }
  if (multiClient) console.log(`Client: ${client.id} (${client.name})`);

  const accounts = cfg.ZOHO_ACCOUNTS_URL.replace(/\/$/, '');
  const res = await fetch(`${accounts}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.ZOHO_CLIENT_ID, client_secret: cfg.ZOHO_CLIENT_SECRET, code }),
    signal: AbortSignal.timeout(20000),
  });
  const tok = (await res.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; error?: string; api_domain?: string; scope?: string };
  if (!tok.refresh_token || !tok.access_token) {
    console.error(`\nToken exchange failed: ${tok.error ?? `HTTP ${res.status}`}\n${HINTS[tok.error ?? ''] ?? ''}`);
    return 1;
  }

  save('ZOHO_REFRESH_TOKEN', tok.refresh_token);
  console.log(`✅ Refresh token saved to ${target} (ZOHO_REFRESH_TOKEN).`);
  if (tok.scope && !tok.scope.includes('invoices.CREATE')) console.warn(`⚠️ Granted scopes look incomplete: ${tok.scope}`);

  const apiBase = `${tok.api_domain ?? 'https://www.zohoapis.in'}/books/v3`;
  if (apiBase !== cfg.ZOHO_API_BASE.replace(/\/$/, '')) {
    save('ZOHO_API_BASE', apiBase);
    console.log(`✅ ZOHO_API_BASE set to ${apiBase} (your data centre).`);
  }

  const orgRes = await fetch(`${apiBase}/organizations`, { headers: { authorization: `Zoho-oauthtoken ${tok.access_token}` }, signal: AbortSignal.timeout(20000) });
  const orgJson = (await orgRes.json().catch(() => ({}))) as { organizations?: { organization_id: string | number; name: string }[]; message?: string };
  const orgs = orgJson.organizations ?? [];
  if (orgs.length === 1) {
    save('ZOHO_ORG_ID', String(orgs[0]!.organization_id));
    console.log(`✅ ZOHO_ORG_ID set to ${orgs[0]!.organization_id} (${orgs[0]!.name}).`);
  } else if (orgs.length > 1) {
    console.log(`Several organizations found. Put the right one into ZOHO_ORG_ID in ${target}:`);
    for (const o of orgs) console.log(`  ${o.organization_id}  ${o.name}`);
  } else {
    console.warn(`⚠️ Could not list organizations (${orgJson.message ?? `HTTP ${orgRes.status}`}). Is a Zoho Books organization set up for this account?`);
  }
  console.log(`\nNext: npm run zoho:check${multiClient ? ` -- --client ${client.id}` : ''}`);
  return 0;
}

// exitCode instead of process.exit(): avoids a libuv assertion on Windows right after fetch.
process.exitCode = await main().catch((e) => {
  console.error(`zoho:token failed: ${(e as Error).message}`);
  return 1;
});
