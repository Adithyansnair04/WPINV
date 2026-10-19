# Zoho Books trial setup

These steps use the **India** data centre (`zoho.in`). For another DC, change the domains in `.env`: `ZOHO_ACCOUNTS_URL` (`accounts.zoho.com`, `.eu`, `.com.au`, …) and `ZOHO_API_BASE` (`https://www.zohoapis.<dc>/books/v3`).

## 1. Create the trial organization

1. Sign up at <https://www.zoho.com/in/books/> (free trial). Use a test organization, not a real business.
2. Currency INR, time zone Asia/Kolkata. GST registration is optional. If you enable GST, set up GST18/IGST18 tax rates (Settings → Taxes).

## 2. Create OAuth credentials (Self Client)

1. Open <https://api-console.zoho.in> → **Add Client** → **Self Client** → Create.
2. Copy the **Client ID** and **Client Secret** into `.env` (`ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`).
3. Open the *Generate Code* tab and enter these scopes:

   ```
   ZohoBooks.contacts.READ,ZohoBooks.contacts.CREATE,ZohoBooks.settings.READ,ZohoBooks.settings.CREATE,ZohoBooks.invoices.READ,ZohoBooks.invoices.CREATE,ZohoBooks.invoices.UPDATE
   ```

   `settings` covers Items and Organizations. The `CREATE` scopes for contacts/settings are needed only for `zoho:seed`. Drop them if you import the CSVs instead.
4. Pick a duration (e.g. 10 minutes), generate, then immediately run:

   ```bash
   npm run zoho:token -- <grant_code>
   ```

   Grant codes are single-use and expire within minutes. Put the printed `ZOHO_REFRESH_TOKEN` in `.env`. The refresh token does not expire until revoked. The app exchanges it for 1-hour access tokens and caches them in memory (Zoho limits how many access tokens one refresh token can mint per 10 minutes).

## 3. Find the organization ID

Run `npm run zoho:check` with `ZOHO_ORG_ID` set to anything. It lists the organizations visible to the token. Copy the right ID into `ZOHO_ORG_ID`. You can also find it in Zoho Books under Settings → Organization Profile.

## 4. Load the synthetic master data

The dataset has 12 customers and 20 items with deliberately confusing variants (Lenzo vs Lenza, 17"/18", red/black/silver, Apex vs Durotrac in the same tyre size, chrome vs black nut sets).

**Option A: CSV import (recommended if GST is enabled)**

- Customers: Sales → Customers → ⋮ → Import → `data/seed/customers.csv`.
- Items: Items → ⋮ → Import → `data/seed/items.csv`.
- Map the columns in the import wizard. Header names may differ slightly from Zoho's template; the CSVs include `HSN/SAC` and intra/inter-state tax columns for GST orgs.

**Option B: API seeding**

```bash
npm run zoho:seed              # prints what it would do
npm run zoho:seed -- --confirm # creates missing customers/items (skips existing names)
```

For a GST-registered org, add `--gst-treatment business_none` (or another valid treatment), then set each item's tax preference in the UI.

Then verify:

```bash
npm run zoho:check   # all seed customers/items present?
```

## 5. Turn on live mode safely

```env
ZOHO_MODE=live
INVOICE_ALLOW_LIVE_CREATE=false   # bot replies with "DRY RUN" previews only
```

Try a few messages in the simulator (`npm run simulate`) or the group. When the previews are right:

```env
INVOICE_ALLOW_LIVE_CREATE=true    # creates DRAFT invoices (send=false); nothing is emailed
```

## API details used (and where they are uncertain)

Verified against the Zoho Books v3 docs:

| Purpose | Call |
|---|---|
| Token refresh | `POST {accounts}/oauth/v2/token` with `grant_type=refresh_token, client_id, client_secret, refresh_token` |
| Auth header | `Authorization: Zoho-oauthtoken <access_token>`, plus `organization_id` query param on every call |
| Customers | `GET /contacts?contact_type=customer&page&per_page=200` (paginated by `page_context.has_more_page`) |
| Items | `GET /items?page&per_page=200` |
| Idempotency lookup | `GET /invoices?reference_number=<key>` (documented filter) |
| Create | `POST /invoices?send=false` with `customer_id`, `reference_number`, `line_items[{item_id, quantity, rate}]`; new invoices are `draft` |
| Rate limits | 100 req/min/org; HTTP 429 with codes 44 (per-minute), 45 (daily, not retried), 1070 (concurrency) |

Implemented but **not verified against a live org** (no credentials were available while building), isolated in [src/zoho/client.ts](../src/zoho/client.ts):

- **PDF**: `GET /invoices/{id}?accept=pdf`. The code checks the `content-type` and falls back to a text-only reply when Zoho does not return a PDF.
- **Tax**: no `tax_id` is sent per line, so Zoho applies the item's default tax / GST preference and the customer's place of supply. The bot reports Zoho's `sub_total`, `tax_total` and `total` from the response. It never computes tax itself in live mode.
- **`invoice_url`** is shown when present. Zoho documents it as the online-view link, but it is generally only useful after the invoice is shared/sent. Drafts stay internal.
- **GST contact fields** (`gst_treatment`, `place_of_supply`) may be required by GST-registered orgs when seeding via the API.

Run `npm run zoho:check` and one dry-run, then one draft creation in a trial org, to confirm these before relying on them.
