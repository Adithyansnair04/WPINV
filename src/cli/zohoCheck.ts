import { parseArgs } from 'node:util';
import { z } from 'zod';
import { requireZohoCredentials } from '../config.js';
import { pickClient } from '../clients/registry.js';
import { createLogger } from '../logger.js';
import { ZohoBooks } from '../zoho/client.js';
import { seedCustomers, seedItems } from '../zoho/mock.js';

/**
 * Read-only connectivity check: token refresh, organizations, customer/item counts, seed coverage.
 * Usage: npm run zoho:check [-- --client acme]
 */
const { values } = parseArgs({ options: { client: { type: 'string' } } });

try {
  const client = pickClient(values.client);
  const creds = requireZohoCredentials(client.cfg);
  const zoho = new ZohoBooks(creds, { log: createLogger('warn'), aliases: client.profile.aliases });
  console.log(`Client: ${client.id} (${client.name})`);

  const { json } = await zoho.request('GET', '/organizations');
  const orgs = z.object({ organizations: z.array(z.object({ organization_id: z.coerce.string(), name: z.string(), currency_code: z.string().optional() })) }).parse(json);
  console.log('Organizations visible to this token:');
  for (const o of orgs.organizations) console.log(`  ${o.organization_id === creds.orgId ? '*' : ' '} ${o.organization_id}  ${o.name}  ${o.currency_code ?? ''}`);
  if (!orgs.organizations.some((o) => o.organization_id === creds.orgId)) console.warn(`ZOHO_ORG_ID ${creds.orgId} is not in this list.`);

  const [customers, items] = await Promise.all([zoho.listCustomers(), zoho.listItems()]);
  console.log(`\nCustomers: ${customers.length} (active ${customers.filter((c) => c.active).length})`);
  console.log(`Items: ${items.length} (active ${items.filter((i) => i.active).length}, with tax ${items.filter((i) => i.taxId).length})`);

  // The seed catalogue only exists in the demo organization.
  if (client.id === 'default') {
    const names = new Set(customers.map((c) => c.name));
    const itemNames = new Set(items.map((i) => i.name));
    const missingC = seedCustomers().filter((c) => !names.has(c.name)).map((c) => c.name);
    const missingI = seedItems().filter((i) => !itemNames.has(i.name)).map((i) => i.name);
    console.log(missingC.length ? `Seed customers missing: ${missingC.join(', ')}` : 'All seed customers present.');
    console.log(missingI.length ? `Seed items missing: ${missingI.join(', ')}` : 'All seed items present.');
  }
} catch (e) {
  const err = e as Error & { category?: string };
  console.error(`\nZoho check failed: ${err.message}`);
  if (err.category === 'auth') {
    console.error(
      [
        '',
        'The ZOHO_REFRESH_TOKEN is not valid. To get a new one:',
        '  1. https://api-console.zoho.in -> your Self Client -> Generate Code (scopes: see docs/ZOHO_SETUP.md)',
        '  2. Within 2 minutes run: npm run zoho:token -- [--client <id>] <code>   (it saves the token for you)',
        '  3. Run npm run zoho:check again',
      ].join('\n'),
    );
  }
  process.exitCode = 1;
}
