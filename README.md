# WPINV — chat-group → Zoho Books invoice agent (prototype)

Add the bot to a **Telegram group** (official Bot API) and send messy invoice requests like

```
VK
red lenzo alloy 18 inch x 4
rate 5200
```

and creates a **draft** invoice in Zoho Books. It resolves `VK` to *VK Enterprises* and the product to *Lenzo Alloy Wheel 18" Red*, then replies in the group with the invoice number, lines, totals/tax and the PDF. If a request is ambiguous (`VK red wheel 4`), it asks a short question with **tap-to-choose buttons** instead of guessing.

- An LLM interprets the language. Deterministic code with transparent scores matches against the **real** Zoho customer and item records.
- Interchangeable LLM providers: Gemini (Flash-Lite is the evaluated default: 98% correct actions, 0 wrong invoices; the larger Flash tier is limited to 20 free requests/day), Mistral, Groq, OpenRouter, or any OpenAI-compatible endpoint such as local Ollama. A regex baseline (`rules`) needs no key.
- **"Rate same as last time"** looks up the customer's last invoice for that item and asks you to confirm the rate and its source invoice.
- **Edits:** reply to the bot's invoice message with "make it 6 pcs" or "rate 5000" to update that draft (drafts only).
- **Add customers from chat** (`add customer <name>`, or ➕ when a name is unknown) with a mandatory Yes/Cancel confirmation.
- **Dashboard** at `http://127.0.0.1:3001`: live activity, the reasoning behind each decision, open questions, and evaluation results.
- Safe defaults: Zoho is mocked; live mode only *previews* until `INVOICE_ALLOW_LIVE_CREATE=true`; invoices are drafts and are never sent to customers.

Design, model comparison and evaluation write-up: [docs/DESIGN.md](docs/DESIGN.md) · Telegram setup: [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md) · Zoho trial setup: [docs/ZOHO_SETUP.md](docs/ZOHO_SETUP.md) · Demo script: [docs/DEMO.md](docs/DEMO.md) · Latest results: [eval/results/summary.md](eval/results/summary.md)

## Requirements

- Node.js ≥ 20 (developed on Node 24)
- For live LLM runs: a free [Gemini](https://aistudio.google.com/apikey) API key. Alternatives: [Mistral](https://console.mistral.ai), [OpenRouter](https://openrouter.ai/keys), or local [Ollama](https://ollama.com)
- For live Zoho: a Zoho Books trial organization (India DC by default)
- For chat: a Telegram bot token from @BotFather (free). No tunnel or public URL is needed.

## Install

```bash
npm install
cp .env.example .env      # then fill in keys as needed
```

## Commands

| Command | What it does |
|---|---|
| `npm test` | 62 offline tests: matcher, schema, decision engine, number grounding, processor (dedupe, idempotency, clarifications, previous rates, edits), Zoho client, Telegram/WhatsApp transports, dashboard. No network. |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run simulate` | Interactive chat simulator using the same processor as the bot (mock Zoho by default). |
| `npm run simulate -- --model rules -m "VK red wheel 4"` | One-shot simulation; `-m ">2"` replies to the last question. Add `--dashboard` to watch it on the dashboard. |
| `npm run eval` | Runs the 50 labeled cases through every model in `EVAL_MODELS` against mocked Zoho and writes `eval/results/summary.md`. |
| `npm run eval -- --set holdout` | Runs the 24-case held-out set (frozen before any tuning) into `eval/results/holdout/`. |
| `npm run eval -- --retry-errors` | Re-runs only cases that were blocked by provider quota, keeping the rest. |
| `npm start` | Starts the bot on the configured transport (Telegram long polling by default). |
| `npm run zoho:token -- <grant_code>` | Exchanges a Zoho Self Client grant code for a refresh token. |
| `npm run zoho:check` | Read-only Zoho check: token refresh, org list, customer/item counts, seed coverage. |
| `npm run zoho:seed -- --confirm` | Creates the synthetic customers/items in a trial org (skips existing names). |
| `npm run seed:csv` | Regenerates the importable CSVs in `data/seed/`. |

## Configuration

All configuration is in `.env`, validated with Zod at startup ([src/config.ts](src/config.ts)). Values in `.env` take precedence over variables already in the shell, so stale copies (e.g. from VS Code's `useEnvFile`) never win. See [.env.example](.env.example) for every option. Key ones:

- `LLM_MODEL`: `provider:model`, e.g. `gemini:gemini-3.1-flash-lite`, `gemini:gemini-2.5-flash`, `mistral:<model>`, `groq:<model>`, `openrouter:<model>`, `compat:<model>` (any OpenAI-compatible endpoint via `COMPAT_BASE_URL`, e.g. Ollama), or `rules`.
- `ZOHO_MODE`: `mock` (default) or `live`.
- `INVOICE_ALLOW_LIVE_CREATE`: must be `true` before anything is written to a real Zoho org.
- `ZOHO_API_BASE` / `ZOHO_ACCOUNTS_URL`: India DC by default (`https://www.zohoapis.in/books/v3`, `https://accounts.zoho.in`).
- `CHAT_TRANSPORT`: `telegram` (default; groups, official API), `whatsapp_cloud` (official, 1:1 only), or `baileys` (unofficial WhatsApp groups, ban risk).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHATS`: bot token and the group/chat ids the bot acts in. Every other chat is ignored.
- `RATE_POLICY`: `ask` (default: missing rate → clarify) or `item_default` (use the item's Zoho selling rate).
- `DEFAULT_TAX_PERCENT`: e.g. `18` to tax lines whose item has no tax. Needs a GST-registered Zoho org; see [docs/ZOHO_SETUP.md](docs/ZOHO_SETUP.md#tax-18-gst).
- `LLM_FALLBACK_MODEL`: backup model used when `LLM_MODEL` fails, e.g. `groq:openai/gpt-oss-120b`.

## Quick demo without any credentials

```bash
npm run simulate -- --model rules -m "VK\nred lenzo alloy 18 inch x 4\nrate 5200" -m "Royal Alloys - neo 16 x 4 rate 4000" -m ">2" -m "ok thanks"
npm run eval -- --models oracle,rules
```

With a Gemini key in `.env`, drop `--model rules` to use the LLM.

## Running in a Telegram group

Full walkthrough: [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md).

1. Create a bot with **@BotFather** (`/newbot`) and put the token in `TELEGRAM_BOT_TOKEN`.
2. In BotFather, `/setprivacy` → **Disable** (or make the bot a group admin) so it can read normal group messages, then add it to your group.
3. `npm start`, write anything in the group, copy the logged `chatId` into `TELEGRAM_ALLOWED_CHATS`, and restart.
4. Send requests in the group. Reply to the bot's question to answer a clarification (any member may answer that way); the next message from the **same person** within `CLARIFY_TTL_MINUTES` also counts.

The bot ignores other bots, unlisted chats, messages older than `MAX_MESSAGE_AGE_SEC` and already-processed message ids.

**Other transports.** The processor doesn't depend on the chat platform:
- `CHAT_TRANSPORT=whatsapp_cloud` uses Meta's official WhatsApp Cloud API. It is 1:1 only and needs a public webhook URL; see [docs/WHATSAPP_CLOUD_SETUP.md](docs/WHATSAPP_CLOUD_SETUP.md).
- `CHAT_TRANSPORT=baileys` uses unofficial WhatsApp groups, with a ban risk.

## Using it in the group

| You send | Bot does |
|---|---|
| `VK` / `red lenzo alloy 18 inch x 4` / `rate 5200` | Creates a draft invoice and replies with lines, tax, total and the PDF. |
| `VK red wheel 4` | Asks which wheel (buttons) and the rate. Tap a button or reply to the question. |
| `VK lenzo 18 red x 4 rate same as last time` | "Use the last rate: ₹5,100 (invoice INV-000101)?" Tap **Yes** or reply with another rate. |
| Reply to an invoice message: `make it 6 pcs` | Updates that draft and shows old → new. Refused for sent or paid invoices. |
| `add customer Zenith Motors` | Asks **"Add new customer ‘Zenith Motors’? (similar: Sri Ganesh Motors)"** with ✅ Yes / ❌ Cancel. Created only after Yes. |
| An invoice for an unknown customer | Offers **➕ Add new customer**; after you confirm, the same invoice continues. |
| `/whoami` | Shows your user id and the chat id (for `CUSTOMER_CREATORS` / `TELEGRAM_ALLOWED_CHATS`). |
| `ok thanks`, `good morning` | Nothing. |
| `where is my invoice from yesterday?`, `cancel the last bill` | A short "can't do that here" reply. |

## Dashboard

While the bot runs, open <http://127.0.0.1:3001>. It shows:
- every message's outcome, with the matched customer and items (with scores), quantities, rates and latency;
- the reason behind every question;
- open clarifications and when they expire;
- the latest evaluation tables.

It is read-only, has no login, and listens only on your machine by default (`DASHBOARD_HOST`). Message text is shown only if `LOG_MESSAGE_TEXT=true`. To try it without Telegram: `npm run simulate -- --dashboard`.

## Deploying

The bot only makes outbound connections (Telegram long polling, the LLM, Zoho), so any always-on machine works. Run **one** instance per bot token.

- **pm2 on a VPS:**

  ```bash
  npm ci && npm i -g pm2 && pm2 start "npm start" --name wpinv && pm2 save
  ```

- **Docker** (written, but not build-tested here because Docker wasn't installed):

  ```bash
  docker build -t wpinv .
  docker run -d --name wpinv --env-file .env -v wpinv-data:/app/.data -p 127.0.0.1:3001:3001 wpinv
  ```

  The volume keeps dedupe and clarification state across restarts. The dashboard port is bound to localhost on the host; reach it from elsewhere with an SSH tunnel, never by exposing it.

## Going live with Zoho Books

Follow [docs/ZOHO_SETUP.md](docs/ZOHO_SETUP.md). In short: create a trial org, create a Self Client in the Zoho API console, run `npm run zoho:token`, import `data/seed/*.csv` (or `npm run zoho:seed -- --confirm`), then run `npm run zoho:check`. Next set `ZOHO_MODE=live`; the bot then replies with **dry-run previews**. Set `INVOICE_ALLOW_LIVE_CREATE=true` to create real **draft** invoices.

## Project layout

```
src/
  config.ts, logger.ts, http.ts     env validation, redacting JSON logs, fetch with timeout/backoff/Retry-After
  types.ts                          domain types + BooksApi interface
  llm/provider.ts                   Mistral/Groq/OpenRouter/compat (OpenAI-style) and Gemini providers
  extraction/                       prompt, Zod schema, LLM extractor with one corrective retry, regex baseline
  matching/                         normalization (sizes, tyre specs, synonyms) + scored customer/item matcher
  pipeline/                         decide (create/clarify/respond/ignore), processor, state (dedupe, pending), format
  zoho/                             OAuth + REST client, catalogue cache, in-memory mock from seed data
  telegram/bot.ts                   Telegram Bot API: long polling, chat allowlist, quoted replies, option buttons, PDFs (default)
  dashboard/                        read-only web dashboard (activity log, pending questions, eval results)
  whatsapp/cloud.ts                 WhatsApp Cloud API (1:1): signed webhook server, send text/PDF
  whatsapp/baileys.ts               unofficial WhatsApp groups (CHAT_TRANSPORT=baileys)
  cli/                              simulator, Zoho token/check/seed, CSV export
  eval/                             runner, metrics, markdown report
data/seed/                          synthetic customers/items (JSON + Zoho-importable CSV)
data/aliases.json                   business-approved customer shorthand (by name, no IDs)
eval/cases.json, eval/gold.json     50 labeled cases + ideal extractions for the oracle run
eval/holdout.json                   24 held-out cases, committed before any model was run on them
data/seed/history.json              synthetic past invoices (for "rate same as last time" in mock mode)
test/                               node:test suites
```

## Security and privacy notes

- Secrets live only in `.env` (git-ignored). Logs redact token/secret/authorization fields. Message text is **not** logged unless `LOG_MESSAGE_TEXT=true`, and chat, sender and message IDs are hashed in logs.
- `.data/` holds dedupe and pending-clarification state and simulator PDFs (plus the session if you use the legacy Baileys transport). It is git-ignored.
- `TELEGRAM_BOT_TOKEN` (and the WhatsApp tokens, if used) are secrets: `.env` only. If a bot token leaks, revoke it with @BotFather `/revoke`.
- Seed data is synthetic.

## Why Telegram

The workflow needs a **shared group**. On WhatsApp the options are poor:
- **Baileys** (unofficial): groups work, but it carries a ban risk and breaks easily.
- **WhatsApp Cloud API** (official): groups need an Official Business Account, so in practice it's 1:1 only.

Telegram's official Bot API supports groups, is free, has no ban risk, and needs no public URL. The trade-off: the team must use Telegram. The WhatsApp transports remain available. See [docs/DESIGN.md](docs/DESIGN.md#9-transport-choice).
