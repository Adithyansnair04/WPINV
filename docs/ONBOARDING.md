# Onboarding a new client

One bot serves several businesses. Each business is a **client**: its own Telegram group(s), its own Zoho Books organization, its own profile, and its own settings. This guide covers adding a client whose customers and items we have never seen.

## How clients are separated

| Shared by all clients (`.env`) | Per client (`clients.json`) |
|---|---|
| `TELEGRAM_BOT_TOKEN`, LLM keys and models, dashboard, `DATA_DIR`, logging | Telegram chat ids, `ZOHO_*`, `INVOICE_*`, `CUSTOMER_*`, `RATE_POLICY`, `DEFAULT_TAX_PERCENT`, `BASE_CURRENCY` |

- A message is routed by its chat id. A chat can belong to only one client; the bot refuses to start if two clients claim the same chat.
- Per-client settings are **never inherited** from `.env`. A client with no Zoho token is skipped at startup; it can never fall back to another client's organization.
- Each client has its own state (pending questions, recent invoices) in `.data/clients/<id>/state.json`, and its own Zoho cache.
- A client that fails to start (bad setting, missing credentials) is logged and skipped. The other clients keep running.
- `clients.json` and `clients/` are git-ignored because they hold credentials and client data. [clients.example.json](../clients.example.json) shows the format.

Without `clients.json`, the bot runs exactly as before: `.env` describes one client, with the demo profile [data/profile.json](../data/profile.json).

## What changes for an unknown catalogue

The extraction prompt, matching rules and aliases used to be written for the demo wheels-and-tyres business. They now come from a **client profile**:

| Profile field | Used for | Demo value |
|---|---|---|
| `business` | One line in the LLM prompt | "an Indian auto-parts (alloy wheels, tyres, accessories) business" |
| `descriptionExample`, `quantityExample`, `previousRateExample` | Examples in the prompt | "red lenzo alloy 18 inch" |
| `notQuantity` | Tells the LLM which numbers are sizes, not quantities | tyre sizes like "195/65 R15" |
| `keepWords` | Words the LLM must keep in item descriptions | set, nut, cap, alloy… |
| `normalizer.packs` | Domain matching rules (`auto_parts`: tyre sizes, `r17`, bare 12–24 → inches) | `["auto_parts"]` |
| `normalizer.synonyms`, `stopwords` | Extra word mappings for matching | – |
| `aliases` | Business-approved customer shorthand ("VK" → Vijay Kumar Auto) | 12 aliases |

A client without a profile gets the generic one: neutral prompt, no domain rules, no aliases. The matching safety rules (score thresholds, margins, grounding, never guessing a customer) are the same for every client and are not part of the profile.

## Steps

### 1. Register the client

Get the group's chat id: add the bot to the group and send `/whoami`.

```bash
npm run client:add -- --id acme --name "Acme Stationery" --chat -1002222222222
```

- The first time, this moves your current `.env` client into `clients.json` as `default`, with the demo profile.
- The new client starts **in preview mode**: `INVOICE_ALLOW_LIVE_CREATE=false`, confirmation on every invoice, confirmation before adding customers, and rates must be given.
- It creates an empty profile template at `clients/acme/profile.json`.

### 2. Connect the client's Zoho Books

The client creates a Self Client in **their** Zoho account ([docs/ZOHO_SETUP.md](ZOHO_SETUP.md)), or gives you access to do it.

1. Put the client id and secret into `clients.json` under that client's `settings`.
2. Generate a grant code with the scopes in ZOHO_SETUP.md, then within its lifetime run:

```bash
npm run zoho:token -- --client acme <grant_code>    # saves the refresh token, API base and org id into clients.json
npm run zoho:check -- --client acme                 # read-only: organizations, customer and item counts
```

### 3. Profile the catalogue

```bash
npm run client:profile -- --client acme --write --business "an Indian stationery wholesaler"
```

This reads the client's customers and items (read-only) and writes:

- `clients/acme/onboarding-report.md`, which lists:
  - **items the bot can never tell apart** (identical names): fix them in Zoho;
  - **look-alike items** that differ by one word (colour, size, brand): requests that leave it out will get a question;
  - **customer names that share a word** ("Mehta Traders" / "Mehta Book Depot"): a message saying only "Mehta" will get a question;
  - **colliding initials**: "VK"-style shorthand won't resolve on its own;
  - frequent item words, units found in item names, and whether the auto-parts rules fit.
- A draft `clients/acme/profile.json`, only if the profile is still the empty template. A reviewed profile is never overwritten.

The draft never invents aliases.

### 4. Review the profile with the client

- Write the `business` line and an example description in the client's own words.
- Check `keepWords` and the units sentence (`notQuantity`).
- Ask the client which shorthand their team uses for customers, and add **only confirmed** shorthand to `aliases`.

### 5. Run in preview mode

Restart the bot. The startup log lists every client and any client that was skipped. The dashboard tags each request with its client.

For 1–2 weeks the bot replies in the client's group with previews but creates nothing in Zoho. Collect the real messages (with the client's permission).

### 6. Evaluate on the client's own messages

Label 50+ real messages in the format of [eval/cases.json](../eval/cases.json) and run `npm run eval`. Before going live, the bar is **zero wrong invoices** and a clarification rate the team accepts. Fix misses through the profile (keepWords, units, aliases) or by cleaning item names in Zoho, not by loosening the matching thresholds.

### 7. Allow drafts

Set `"INVOICE_ALLOW_LIVE_CREATE": true` for that client in `clients.json` and restart. Invoices are still drafts, still confirmed in the chat, and still never sent by the bot.

## Removing a client

Delete its entry from `clients.json` and restart. Its state stays in `.data/clients/<id>/` until you delete it. Revoke the Zoho refresh token in the client's Zoho API console.
