import { z } from 'zod';
import { loadConfig, requireZohoCredentials } from '../config.js';
import { createLogger } from '../logger.js';
import { ZohoBooks } from '../zoho/client.js';
import { loadAliases, seedCustomers, seedItems } from '../zoho/mock.js';

/** Read-only connectivity check: token refresh, organizations, customer/item counts, seed coverage. */
const cfg = loadConfig();
const creds = requireZohoCredentials(cfg);
const zoho = new ZohoBooks(creds, { log: createLogger('warn'), aliases: loadAliases() });

const { json } = await zoho.request('GET', '/organizations');
const orgs = z.object({ organizations: z.array(z.object({ organization_id: z.coerce.string(), name: z.string(), currency_code: z.string().optional() })) }).parse(json);
console.log('Organizations visible to this token:');
for (const o of orgs.organizations) console.log(`  ${o.organization_id === creds.orgId ? '*' : ' '} ${o.organization_id}  ${o.name}  ${o.currency_code ?? ''}`);
if (!orgs.organizations.some((o) => o.organization_id === creds.orgId)) console.warn(`ZOHO_ORG_ID ${creds.orgId} is not in this list.`);

const [customers, items] = await Promise.all([zoho.listCustomers(), zoho.listItems()]);
console.log(`\nCustomers: ${customers.length} (active ${customers.filter((c) => c.active).length})`);
console.log(`Items: ${items.length} (active ${items.filter((i) => i.active).length}, with tax ${items.filter((i) => i.taxId).length})`);

const names = new Set(customers.map((c) => c.name));
const itemNames = new Set(items.map((i) => i.name));
const missingC = seedCustomers().filter((c) => !names.has(c.name)).map((c) => c.name);
const missingI = seedItems().filter((i) => !itemNames.has(i.name)).map((i) => i.name);
console.log(missingC.length ? `Seed customers missing: ${missingC.join(', ')}` : 'All seed customers present.');
console.log(missingI.length ? `Seed items missing: ${missingI.join(', ')}` : 'All seed items present.');
