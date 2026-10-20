# WPINV: chat-to-invoice agent for Zoho Books

WPINV turns informal invoice requests posted in a team chat into **draft invoices in Zoho Books**. It reads messages like

```
VK
red lenzo alloy 18 inch x 4
rate 5200
```

resolves `VK` to the customer *VK Enterprises* and the product to the exact catalogue variant *Lenzo Alloy Wheel 18" Red* (among Lenzo/Lenza brands, three colours and three sizes), creates a draft invoice, and replies in the chat with the lines, totals and PDF. When a request is ambiguous, incomplete or refers to something it cannot verify, it **asks a short question instead of guessing**.

The design principle: **the LLM reads language; deterministic code decides.** The model never sees database IDs and never chooses a record. Every customer, item, quantity and rate is checked against Zoho data and the original message before anything is written.

| | |
|---|---|
| **Chat** | Telegram groups (official Bot API). WhatsApp is future scope. |
| **LLMs** | Gemini 3.1 Flash-Lite (primary), Groq gpt-oss-20b (automatic fallback) |
| **Books** | Zoho Books REST API (India data centre), OAuth refresh tokens, draft invoices only |
| **Stack** | Node.js 24 + TypeScript, Zod validation, no web framework; 62 offline tests |
| **Result** | 98% correct actions (95.8% on a held-out set) and **0 wrong invoices across every model tested** |

---

## Contents

1. [How it behaves](#how-it-behaves)
2. [Architecture](#architecture)
3. [LLM vs deterministic code](#llm-vs-deterministic-code)
4. [Evaluation methodology](#evaluation-methodology)
5. [Results](#results)
6. [Recommendation](#recommendation)
7. [Current status](#current-status)
8. [Getting started](#getting-started)
9. [Project layout](#project-layout)
10. [Security, privacy and limitations](#security-privacy-and-limitations)
11. [Future scope](#future-scope)

---

## How it behaves

| A user sends | WPINV does |
|---|---|
| `VK` / `red lenzo alloy 18 inch x 4` / `rate 5200` | Posts a **preview** (customer, lines, estimated total) with **✅ Create invoice / ❌ Cancel**. Only after ✅ does it create the **draft** in Zoho and reply with lines, tax, total, status and the PDF. |
| `VK red wheel 4` | Asks which of the four red wheels (tap-to-choose buttons) and the missing rate. Any member may answer by replying to the question. |
| `Metro - 4 lenzo 18 red, 2 neo 16 red, rate 5200` | Asks: one rate was written for two different products |
| `VK lenzo 18 red x 4 rate same as last time` | Looks up the customer's last invoice for that item and asks: *"Use ₹5,100 (invoice INV-000101, 28 Sep, paid)?"* with a Yes button |
| Reply to an invoice message: `make it 6 pcs` | Updates that **draft** and shows old → new. Sent or paid invoices are refused. |
| `add customer Zenith Motors` (or ➕ on an unknown name) | Asks for **explicit confirmation**, warning about similar existing names, then creates the customer and continues the waiting invoice |
| `ok thanks`, `good morning` | Nothing |
| `where is my invoice from yesterday?` | Explains what it can and cannot do; creates nothing |

A read-only **dashboard** (`http://127.0.0.1:3001`) shows every decision with **which LLM handled it** (main model, backup with the reason the main model failed, or no LLM for button taps), match scores, open questions, latency and the evaluation tables.

---

## Architecture

```
 Telegram group ──Bot API long polling──▶ telegram/bot.ts
                                            │ chat allowlist · ignore bots · text/captions · stale & duplicate filter
                                            ▼  one message at a time per chat
                                     pipeline/processor.ts
   1. dedupe by message id ─────────────▶ pipeline/state.ts  (dedupe, pending questions, confirmations, invoice↔message map)
   2. associate with a pending question (reply-to or same sender within TTL) / confirmation / edit target
   3. extract ──▶ extraction/extract.ts ──▶ llm/provider.ts   Gemini Flash-Lite ──fails?──▶ Groq gpt-oss-20b     [LLM]
                  └ Zod schema · one corrective retry · model output treated as untrusted
   4. load master data ──▶ zoho/cached.ts ──▶ zoho/client.ts (live) | zoho/mock.ts (offline)
   5. decide ──▶ pipeline/decide.ts + matching/* + pipeline/grounding.ts                                     [deterministic]
                  ignore · respond · clarify (with buttons) · create
   6. create ──▶ idempotency key → GET /invoices?reference_number → POST /invoices?send=false (draft)
   7. reply in the chat (quoted): number, lines, subtotal/tax/total, status, PDF ──▶ dashboard/activity log
```

| Module | Responsibility |
|---|---|
| `telegram/` | Chat transport: turns Telegram updates into `IncomingMessage` and implements `send()`. The pipeline is platform-agnostic, so another chat platform is a new transport, not a rewrite. |
| `extraction/` | Prompt, Zod schema, LLM extractor with corrective retry, primary→fallback wrapper, regex baseline |
| `llm/provider.ts` | Gemini and Groq (OpenAI-compatible API) providers, JSON mode, timeouts, backoff |
| `matching/` | Text normalisation (rim sizes, tyre specs, pack counts, synonyms, typos incl. swapped letters) and scored customer/item matching |
| `pipeline/decide.ts` | Turns an extraction plus master data into a decision; every problem becomes a question |
| `pipeline/grounding.ts` | Every quantity and rate must appear in the message; one value cannot silently cover several items |
| `pipeline/processor.ts` | Orchestration: dedupe, clarifications, confirmations, edits, idempotent creation, replies, structured logs |
| `zoho/` | OAuth refresh (cached, single-flight), paginated reads, invoices, PDF, taxes, contacts; in-memory mock from seed data |
| `dashboard/` | Read-only web view of activity, pending questions and evaluation results |
| `eval/` | Labelled-case runner, metrics, markdown reports |

---

## LLM vs deterministic code

| Concern | Owned by | How |
|---|---|---|
| Is this an invoice request, a reply to a question, an edit, chit-chat, or a follow-up we don't support? | **LLM** | Intent classification inside the extraction |
| What customer mention, product words, quantities, rates and currency does the message contain? | **LLM** | Copies text as written; never sees the database |
| Is the LLM output well-formed? | Deterministic | Zod schema; numeric strings coerced, anything else rejected; one corrective retry, then the fallback model |
| Which Zoho customer is "VK" / "royl alloys" / "kwh"? | Deterministic | Exact name/alias → initials → token match with typo tolerance. Accepted only at score ≥ 0.9 **and** a 0.15 margin over the runner-up; ambiguous names (e.g. two "Sharma"s) always ask. |
| Which exact item is "red lenzo 18"? | Deterministic | Token scoring where unmatched words count against an item (so `blue lenzo 18` never becomes the red one) and exact catalogue words are never typo-matched to another word (`lenzo` ≠ `lenza`) |
| Are the numbers real? | Deterministic | Quantities and rates must appear in the message (`4pc`, `₹5,200`, `5.6k`, `four` understood); one rate written once cannot cover two products |
| Is the quantity/rate/currency valid? | Deterministic | Positive integer quantity, positive rate, INR only; otherwise ask |
| "Rate same as last time" | Deterministic + **user** | Zoho lookup of the last non-void invoice for that customer and item; the user confirms the rate and its source invoice |
| Tax and totals | **Zoho** | Zoho calculates tax from its own tax setup; the bot never computes tax in live mode |
| Creating invoices, creating customers, editing invoices | Deterministic + **user** | Every invoice is previewed and created only after an explicit ✅ (`INVOICE_CONFIRM=always`; optional `INVOICE_APPROVERS`). Customers need a Yes; edits are a reply to the invoice. Drafts only; single-use, expiring confirmations. |
| Duplicates and retries | Deterministic | Message-id dedupe plus an idempotency key stored as Zoho `reference_number` |

Every decision carries a trace (query, candidates, scores, problems), which is logged and shown on the dashboard.

---

## Evaluation methodology

- **Main set: 50 labelled cases** ([eval/cases.json](eval/cases.json)) across 12 categories:

  | Category | Cases |
  |---|---|
  | Straightforward | 5 |
  | Customer aliases | 5 |
  | Word order and informal Hinglish/Tamil-English | 5 |
  | Typos | 4 |
  | Confusable variants | 4 |
  | Missing fields | 5 |
  | Ambiguous requests | 5 |
  | Invalid values | 4 |
  | Non-invoice chatter | 4 |
  | Previous-invoice follow-ups | 4 |
  | Multi-turn clarification flows | 5 |

  The flows include a second group member trying to complete someone else's request.
- **Held-out set: 24 cases** ([eval/holdout.json](eval/holdout.json)) with new phrasings, **committed before any model was run on them** (commit `e58cbc0`), to measure generalisation.
- **Ground truth per case:** the expected action (`create`, `clarify`, `respond` or `ignore`, with explicitly acceptable alternatives for borderline cases), plus customer, items (by SKU), quantity and rate. Labels can say "must *not* resolve" for ambiguous customers or items.
- **Isolation:** every case runs on a fresh in-memory copy of the Zoho data (12 customers, 20 items, a small invoice history). There is no network to Zoho and no chat; only the LLM call is real.
- **Stage separation:**

  | Stage | What it measures |
  |---|---|
  | Extraction | Intent, line count, quantity, rate |
  | Record matching | Customer and item resolution |
  | Decision | Action accuracy, clarification behaviour, wrong invoices |

  An **oracle** run feeds hand-labelled ideal extractions ([eval/gold.json](eval/gold.json)) through the same pipeline, to measure matching and decision quality without the LLM. A **regex baseline** shows what the LLM adds.
- **Key definitions:**
  - *Confidently wrong invoice:* any invoice that should not exist, or differs in customer, item, quantity or rate.
  - *Clarification recall:* cases that must ask, where the bot asked.
  - *Unnecessary clarification:* cases that should invoice, where the bot asked instead.
  - *Latency:* wall-clock time per model turn, including retries.
- **Reproduce:**

  ```bash
  npm run eval                   # main set, every model in EVAL_MODELS
  npm run eval -- --set holdout  # held-out set
  ```

  Results go to [eval/results/summary.md](eval/results/summary.md) and per-case JSON. Cases blocked by provider quota are excluded and reported as coverage, never as wrong answers.

---

## Results

Measured 2026-10-18/19 against mocked Zoho data. All numbers are produced by `npm run eval`; nothing is estimated.

### Main set (50 cases)

| Metric | Gemini 3.1 Flash-Lite | Groq gpt-oss-20b | Groq gpt-oss-120b | Regex baseline | Oracle (no LLM) |
|---|---|---|---|---|---|
| **Correct action** | **98%** (49/50) | 94% (47/50) | 92% (46/50) | 72% (36/50) | 100% |
| **Confidently wrong invoices** | **0** | **0** | **0** | **0** | 0 |
| Exactly-correct invoices | **96.3%** (26/27) | 88.9% (24/27) | 85.2% (23/27) | 59.3% (16/27) | 100% |
| *Extraction:* intent | 98% | 98% | 98% | 93.9% | 100% |
| *Extraction:* quantity | 97.6% | 100% | 100% | 78.6% | 100% |
| *Extraction:* rate | 92.9% | 100% | 100% | 88.1% | 100% |
| *Extraction:* line count | 95.1% | 97.6% | 97.6% | 92.7% | 100% |
| *Matching:* customer | **100%** (41/41) | 95.1% | 92.7% | 95.1% | 100% |
| *Matching:* item | 97.7% (42/43) | 97.7% | 97.7% | 67.4% | 100% |
| *Clarification:* recall (asked when it must) | 100% (19/19) | 100% | 100% | 100% | 100% |
| *Clarification:* unnecessary questions | **3.7%** (1/27) | 11.1% | 14.8% | 40.7% | 0% |
| Non-invoice messages treated as invoices | 0% | 0% | 0% | 25% | 0% |
| Latency p50 / p95 / mean | **1.3 / 6.8 / 2.3 s** | 4.9 / 11.0 / 5.0 s* | 1.9 / 8.4 / 3.5 s* | <1 ms | <1 ms |
| Model failures / invalid JSON / 429 retries | 0 / 0 / 0 | 0 / 0 / 32* | 0 / 0 / 26* | – | – |

### Held-out set (24 unseen cases)

| Metric | Gemini 3.1 Flash-Lite | Groq gpt-oss-20b | Groq gpt-oss-120b | Regex baseline |
|---|---|---|---|---|
| **Correct action** | **95.8%** (23/24) | **95.8%** (23/24) | 70.8% (17/24) | 45.8% (11/24) |
| **Confidently wrong invoices** | **0** | **0** | **0** | **0** |
| Exactly-correct invoices | 92.3% (12/13) | 92.3% (12/13) | 46.2% (6/13) | 15.4% (2/13) |
| *Extraction:* intent / quantity / rate | 100 / 100 / 100% | 100 / 100 / 100% | 100 / 95 / 85% | 83 / 40 / 40% |
| *Matching:* customer / item | 100 / 95% | 100 / 95% | 78.9 / 85% | 78.9 / 35% |
| *Clarification:* recall / unnecessary | 100% / 7.7% | 100% / 7.7% | 100% / **53.8%** | 100% / 69.2% |
| Latency p50 / p95 | 1.7 / 5.1 s | 1.6 / 8.7 s | 1.4 / 3.2 s | <1 ms |

\* Groq runs hit the free tier's per-minute limit at evaluation pace (one call every 2.5 s). Every 429 was retried successfully, but the waits inflate latency. At normal chat pace, gpt-oss-20b answers in about 1–2 s.

### What the numbers say

1. **Safety comes from the deterministic layer, not the model.** Every LLM, and even the regex baseline, produced **zero wrong invoices** on both sets.
   - Model mistakes became questions.
   - Flash-Lite's 92.9% rate accuracy on the main set still gave 0 wrong invoices, because the grounding check caught a rate the model had spread across two products.
2. **The LLM's value is fewer unnecessary questions.** Flash-Lite cuts them from 40.7% (regex) to 3.7% and raises exactly-correct invoices from 59% to 96%.
3. **Bigger is not better for this task.** gpt-oss-20b matches Flash-Lite on held-out data, while gpt-oss-120b drops to 70.8%. The larger model tends to lose the customer when merging a clarification answer, and sometimes splits the customer name into a product line. The task is short structured extraction, where following the JSON contract matters more than size.
4. **The held-out set did its job.** A heuristic tuned on the main set made one wrong invoice on unseen data. It was restricted before shipping, and the clean pre-tuning held-out score (95.8%) is the generalisation number. Run history is in [eval/results/holdout-history/](eval/results/holdout-history/).
5. **Limits of this evaluation:**
   - The catalogue is synthetic and small.
   - One author wrote both case sets.
   - The oracle's 100% is partly by construction: labels and matcher were written together.
   - Free-tier latency includes occasional slow outliers.
   - A real deployment needs a labelled sample of the client's own messages.

The full write-up, including model-selection rationale, safety mechanisms and the automation policy, is in [docs/DESIGN.md](docs/DESIGN.md).

---

## Recommendation

| Decision | Recommendation | Why |
|---|---|---|
| Primary model | **Gemini 3.1 Flash-Lite** | Highest accuracy on both sets (98% / 95.8%), fastest, generous free quota |
| Fallback | **Groq gpt-oss-20b** | Different vendor (independent outages), equal held-out accuracy; covers Gemini's 503 overloads seen in practice |
| Larger models | **Not needed** | They cannot improve safety, which is already enforced deterministically. The measured large model was worse. Re-evaluate only if the client's real messages show a gap. |
| Automation level | **Preview → confirm → draft; humans send** | Nothing is written to Zoho until someone taps ✅, so mistakes cost no Zoho calls; drafts stay reviewable in Zoho. Use `INVOICE_APPROVERS` for manager approval. |
| Rates | Keep `RATE_POLICY=ask` | A missing rate is asked for, never filled from a price list, unless the client explicitly wants list prices |
| Chat platform | **Telegram** for group workflows | Official API with groups and no ban risk. If WhatsApp is mandatory, use the **WhatsApp Cloud API** (official, 1:1) rather than Baileys (unofficial, ban risk). |
| Before production | Label 100–200 real client messages and run `npm run eval` on them | The synthetic sets prove the mechanism; only real messages prove fit |
| Also before production | Move to paid API tiers with no-training data terms; register the Zoho org for GST and set `DEFAULT_TAX_PERCENT=18` or item tax preferences; run one instance on an always-on host (e.g. pm2); restrict `CUSTOMER_CREATORS` | Free tiers may use data for training and have tight quotas; tax and access control need real settings |

---

## Current status

| Area | Status |
|---|---|
| Telegram bot (groups, buttons, replies, PDFs) | ✅ Running live |
| Gemini primary + Groq fallback | ✅ Live; fallback verified by forcing a primary failure |
| Zoho Books (India DC) | ✅ Verified live: OAuth refresh, customer/item reads, seeding, draft creation, PDF download, add-customer from chat, previous-rate lookup |
| Edits ("make it 6 pcs") | ✅ Tested offline; ⏳ not yet run against live Zoho |
| 18% tax | ⏳ Implemented (`DEFAULT_TAX_PERCENT`); Zoho requires the org to be **registered for GST** before it accepts tax invoices |
| Larger Gemini models | ⏳ Free tier allows 20 requests/day; resumable with `--retry-errors` |

---

## Getting started

**Requirements:**
- Node.js ≥ 20
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A [Gemini API key](https://aistudio.google.com/apikey); a [Groq key](https://console.groq.com/keys) for the fallback is optional
- For live invoices, a Zoho Books organization

```bash
npm install
cp .env.example .env     # real values go in .env only; .env.example holds placeholders and is committed
```

**Try it offline, with no keys:**

```bash
npm test                                            # 62 tests, no network
npm run simulate -- --model rules --dashboard -m "VK\nred lenzo alloy 18 inch x 4\nrate 5200"
npm run eval -- --models oracle,rules
```

**Run it for real:**
1. **Telegram.** Create the bot, disable privacy mode, add it to a group and allow the chat id. See [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md).
2. **Zoho.**
   - `npm run zoho:token -- <grant code>` saves the refresh token and org id into `.env`.
   - Then `npm run zoho:check` and `npm run zoho:seed -- --confirm`. See [docs/ZOHO_SETUP.md](docs/ZOHO_SETUP.md).
3. **Go live in steps.**
   - Start with `ZOHO_MODE=live` and `INVOICE_ALLOW_LIVE_CREATE=false` (preview replies only).
   - Then set `INVOICE_ALLOW_LIVE_CREATE=true` to create drafts.
4. **Start:** `npm start`. The dashboard is at `http://127.0.0.1:3001`.

**Key settings** (all in `.env`, validated at startup; `.env` overrides stale shell variables):

| Setting | Default | Meaning |
|---|---|---|
| `LLM_MODEL` / `LLM_FALLBACK_MODEL` | `gemini:gemini-3.1-flash-lite` / – | `provider:model` for `gemini` or `groq`, or `rules` (no LLM) |
| `ZOHO_MODE`, `INVOICE_ALLOW_LIVE_CREATE` | `mock`, `false` | Live Zoho, and whether drafts may be created |
| `INVOICE_CONFIRM`, `INVOICE_APPROVERS` | `always`, – | Preview with ✅/❌ before every invoice; optionally only listed ids may confirm |
| `RATE_POLICY` | `ask` | `item_default` uses the Zoho selling rate when none is given |
| `DEFAULT_TAX_PERCENT` | – | Tax on lines whose item has none (needs a GST-registered org) |
| `CUSTOMER_CREATE`, `CUSTOMER_CREATORS` | `confirm`, – | Add-customer from chat, and an optional allowlist (`/whoami` shows ids) |
| `TELEGRAM_ALLOWED_CHATS` | – | Chats the bot acts in; others are ignored and logged once |

**Commands:**

| Command | Purpose |
|---|---|
| `npm start` | Run the bot |
| `npm test` / `npm run typecheck` | Offline tests / type check |
| `npm run simulate [-- --dashboard]` | Chat with the same pipeline in the terminal |
| `npm run eval [-- --set holdout --models … --retry-errors]` | Evaluation |
| `npm run zoho:token`, `zoho:check`, `zoho:seed` | Zoho setup |

**Deploying:** run a single instance per bot token on any always-on host. It only makes outbound connections.
- pm2: `pm2 start "npm start" --name wpinv`

---

## Project layout

```
src/
  index.ts, app.ts, config.ts       entry point, wiring, Zod-validated settings
  telegram/                         chat transport (Telegram Bot API)
  llm/, extraction/                 providers, prompt, schema, fallback, regex baseline
  matching/, pipeline/              normalisation and scoring; decide, grounding, processor, state, format
  zoho/                             Zoho Books client, cache, offline mock
  dashboard/                        read-only web dashboard
  cli/                              simulator, Zoho token/check/seed, CSV export
  eval/                             evaluation runner, metrics, reports
data/seed/                          synthetic customers, items, invoice history (JSON + Zoho-importable CSV)
data/aliases.json                   business-approved customer shorthand
eval/                               cases.json (50), holdout.json (24), gold.json, results/
test/                               62 node:test tests
docs/                               DESIGN, TELEGRAM_SETUP, ZOHO_SETUP, DEMO
```

---

## Security, privacy and limitations

**Security and privacy:**
- Secrets live only in `.env` (git-ignored). Logs redact tokens and keys, and hash chat and sender ids.
- Message text is not logged unless `LOG_MESSAGE_TEXT=true`.
- The dashboard is read-only, has no authentication and binds to `127.0.0.1` by default. Never expose it publicly.
- Invoices are always drafts created with `send=false`. The bot cannot send, void or delete anything in Zoho.
- On free LLM tiers, prompts may be used for training. Use paid tiers with no-training terms for real customer data.

**Prototype limits:**
- State is a local JSON file, not a transactional database.
- Authorization is a chat allowlist plus the optional creator allowlist.
- Only text messages are processed, and quantities must be whole numbers.
- One line is changed per edit.
- Thresholds were tuned on a synthetic catalogue.

The production hardening list is in [docs/DESIGN.md](docs/DESIGN.md#10-known-limitations).

---

## Future scope

- **WhatsApp transport:** the official WhatsApp Cloud API (1:1 chats; groups need an Official Business Account) as a second transport behind the same `IncomingMessage`/`send()` contract. An unofficial Baileys prototype was built and removed because of its ban risk.
- **Docker packaging:** a container image with the `.data/` state on a volume and the dashboard bound to localhost, for one-command deployment.
- **Real-data evaluation:** a labelled set of the client's own messages, run through `npm run eval` before go-live.
- **GST invoices:** once the Zoho org is GST-registered, per-customer place of supply and intra/inter-state tax.
- **Learned shorthand:** aliases confirmed through clarifications, promoted only after repeated confirmation (see [docs/DESIGN.md](docs/DESIGN.md#7-learning-aliases-and-shorthand-safely)).
- **Persistent state:** a database with unique constraints in place of the local JSON state file.
