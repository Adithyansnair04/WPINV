# Design and evaluation

## 1. Architecture

```
Telegram group ──Bot API long polling──▶ telegram/bot.ts   (alternatives: whatsapp/cloud.ts 1:1, whatsapp/baileys.ts)
                              │ chat allowlist, ignore bots, text/captions only, stale filtering, ids namespaced per chat
                              ▼ (serialized per chat)
                         pipeline/processor.ts
   1 dedupe (message id) ──▶ state.ts (file-backed, 7-day TTL)
   2 associate pending clarification (quoted question id, or same sender within TTL)
   3 extract ──▶ extraction/extract.ts ──▶ llm/provider.ts (Mistral | Groq | Gemini | OpenRouter | compat)   [LLM]
              └▶ Zod validation (schema.ts), one corrective retry on invalid JSON
   4 load master data ──▶ zoho/cached.ts ──▶ zoho/client.ts (or zoho/mock.ts)
   5 decide ──▶ pipeline/decide.ts + matching/matcher.ts                                        [deterministic]
        ignore | respond (unsupported follow-up) | clarify (numbered options, stored as pending) | create
   6 create: idempotency key → GET /invoices?reference_number → POST /invoices?send=false (draft)
   7 reply in the group (quoted): number, customer, lines, subtotal/tax/total, status; PDF as a document
```

| Module | Responsibility |
|---|---|
| `config.ts` | Zod-validated env; safe defaults (mock Zoho, no live writes). |
| `http.ts` | `fetch` with timeout, exponential backoff + jitter, `Retry-After`, error categories (`auth`, `rate_limit`, `transient`, `timeout`, `client`, `validation`). |
| `llm/provider.ts` | Two provider families behind one `complete(system, user)` interface; JSON mode; temperature 0. |
| `extraction/` | Prompt, Zod schema (numeric strings coerced, anything else rejected), corrective retry, regex baseline. |
| `matching/` | Text normalization (rim sizes `18"`/`18 inch`/`R18` → `18in`, tyre specs `195 55 16` → `195/55r16`, pack counts, colour/shorthand synonyms) and scored matching. |
| `pipeline/decide.ts` | Turns an extraction plus master data into a decision. Every problem becomes a question; it never fills gaps by guessing. |
| `pipeline/processor.ts` | Orchestration, dedupe, clarification state, idempotent creation, replies, structured logs with per-stage latency. |
| `zoho/client.ts` | OAuth refresh (cached, single-flight), paginated lists, invoice lookup/create/PDF, 401 → refresh once, 429 backoff (not for the daily-limit code 45), no blind retries of POST. |
| `telegram/bot.ts` | Default transport: Bot API `getUpdates` long polling (no public URL), chat allowlist, Zod-validated updates, per-chat message ids, quoted replies, PDF documents, 429 `retry_after` handling. |
| `whatsapp/cloud.ts` | Optional WhatsApp Cloud API transport (1:1): webhook verification handshake, `X-Hub-Signature-256` check, payload parsing (Zod), sender allowlist, sending quoted text and uploaded PDFs via the Graph API. |
| `whatsapp/baileys.ts` | Optional unofficial WhatsApp group transport (`CHAT_TRANSPORT=baileys`). |
| `eval/` | Labeled-case runner, metrics, markdown report. |

## 2. LLM vs deterministic logic

The LLM does what it is good at: reading language. It classifies intent and pulls out the customer *mention*, product *descriptions*, quantities, rates, currency and references to previous invoices. It **never sees the customer or item database**, so it cannot "pick" or invent a record.

Everything that touches money or records is deterministic and explainable:

- **Validation.** LLM output is parsed with Zod. Only finite numbers, or strings like `"5,200"`, are accepted. Zero and negative values are kept so they can be rejected with a question instead of silently dropped.
- **Customer matching.** The order is: exact name or business-approved alias (`data/aliases.json`, keyed by name, never IDs), then initials, then token overlap with typo tolerance. A score of ≥ 0.9 with a margin of ≥ 0.15 over the runner-up is required. Otherwise the bot asks.
- **Item matching.** Each query token is scored against each item's tokens: exact = 1, typo = 0.85. Unmatched tokens count against the item, so `blue lenzo 18` or `momo …` never silently becomes a red Lenzo. A query word that exists exactly in the catalogue is *never* typo-matched to a different word, so `lenzo` cannot drift to `lenza`. Typo tolerance is off for numbers and words under 4 characters. The same ≥ 0.9 / 0.15 thresholds apply. Ties (`red wheel` → 4 items) become a numbered question listing only the close candidates.
- **Field checks.** Quantity must be a positive integer ≤ 10,000. Rate must be > 0. A foreign currency triggers a question. A missing rate triggers a question (or uses the Zoho selling rate if `RATE_POLICY=item_default`). A rate taken from a previous invoice is refused.
- **Tax and totals.** These come from Zoho's response; the mock uses each item's tax percentage. Live mode never computes tax client-side.
- **Exact IDs only.** `createInvoice` receives only Zoho `customer_id`/`item_id` values that came from the API listing.

Every decision carries a `trace`: query, status, scores, candidates and problems. The trace is logged and used by the eval.

## 3. Reliability and safety mechanisms

| Risk | Mechanism |
|---|---|
| Duplicate WhatsApp delivery / reconnect replay | Message-ID dedupe (persisted), stale-message cutoff. |
| Retry after crash or lost state | Idempotency key `WA-<sha256(chat\|msg)[:16]>` stored as `reference_number`. Before creating, the bot looks it up with `GET /invoices?reference_number=`. |
| Timeout during create (unknown outcome) | Look up the reference first, then retry at most once. If it's still unknown, the reply asks the user to check Zoho for that reference. |
| Wrong association of a clarification answer | Pending state is per (chat, sender), with a 15-minute TTL and at most 3 rounds. A quoted reply must quote *our* question. Another member can only answer by quoting it. A reply to an expired question gets "please resend". The LLM must classify the reply as `clarification_response`, otherwise it is treated as a new message. |
| Concurrent messages | Processing is serialized per chat. |
| Messages from unknown chats or bots | Telegram: chat-id allowlist, bot senders dropped. WhatsApp Cloud: HMAC-SHA256 webhook signature check plus sender allowlist. |
| Accidental live writes | `ZOHO_MODE=mock` by default. Live mode is dry-run unless `INVOICE_ALLOW_LIVE_CREATE=true`. Invoices are created as drafts with `send=false`. |
| Secrets / PII in logs | Key-based redaction, `Zoho-oauthtoken`/`Bearer` scrubbing, hashed chat/sender/message IDs, message text off by default. |
| Model outage | Error reply ("nothing was created") for invoice-like messages; never a fallback guess. |
| Model invents or spreads numbers | **Grounding check:** every quantity and rate must appear in the message (`5.2k`, `₹5,200` and number words are understood). One value written once cannot silently apply to several items unless the message says "both"/"all". Added after Flash-Lite copied one rate onto two items in case B05. |
| Model supplies a "previous" rate | Ignored unless the number is in the message. Previous rates come only from a Zoho lookup the user confirms. |

**Prototype vs production.** These are prototype safeguards. State is a local JSON file, not a transactional store. Idempotency relies on Zoho's `reference_number` search. Authorization is only a chat allowlist (any member of an allowed group may request), with no roles or approvals. There is no audit UI. A crash between confirming an update and finishing processing can lose that message. A production system needs a database with unique constraints on the idempotency key, an outbox for replies, per-user authorization, monitoring and alerting, and the official WhatsApp API.

## 4. Model selection

| Role | Model | Status |
|---|---|---|
| Fast/small (**production default**) | `gemini:gemini-3.1-flash-lite` | Fully evaluated (main + held-out). |
| Larger | `gemini:gemini-2.5-flash` / `gemini:gemini-3-flash-preview` | **Not fully evaluated:** the free tier allows only **20 requests/day per model** (Google's 429 response: `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, `quotaValue: 20`). One main-set run needs about 55. |
| Baseline | `rules` | No LLM: regex extraction plus the same matcher and checks. Shows what the LLM adds. |
| Upper bound | `oracle` | Labeled ideal extraction. Measures matching and decisions on their own. |
| Also wired | `mistral:…`, `groq:…`, `openrouter:…`, `compat:…` (e.g. local Ollama) | Same interface. Mistral's free plan returned 429 on every chat call for this account; Groq keys were unavailable. |

**Why this pair:**
- **Flash-Lite** is the smallest, fastest current Gemini tier: about 1.3 s median per message and a free daily quota large enough for real use and repeated evaluation.
- **Flash** is the larger tier of the same family, with the same API and JSON mode, so any difference would come from model capacity rather than provider quirks.
- The question the comparison answers: **is the small model good enough when deterministic checks catch its mistakes?** For this task, yes. Flash-Lite reaches 98% / 95.8% with zero wrong invoices, and every one of its misses is a safe question. A larger model can at most remove a few unnecessary questions; it cannot improve safety, which the checks already enforce.

**Finishing the larger-model comparison:** the runner stops a model after 3 consecutive quota failures and records the blocked cases. Each day, run

```bash
npm run eval -- --models gemini:gemini-2.5-flash --retry-errors
```

It keeps earlier cases and adds about 18 more per day, so the main set completes in about 3 days (the held-out set needs `--set holdout` on 2 more). Quota-blocked cases are excluded from metrics and shown as "Cases scored", so partial runs never count as wrong answers. With a billed key or another provider, the whole run takes minutes.

Models are configured as `provider:model` strings; switching needs no code change.

## 5. Evaluation

### Method

- **Dataset:** [eval/cases.json](../eval/cases.json) has 50 labeled cases. The categories: straightforward (5), aliases (5), word order (3), informal/Hinglish/Tamil-English (2), typos (4), confusable variants (4), missing fields (5), ambiguous (5), invalid quantity/currency/unknown records (4), non-invoice (4), previous-invoice follow-ups (4), and multi-turn clarification flows (5). The flows include a numeric option reply, a free-text answer, an unquoted answer and a different sender trying to complete someone else's request.
- **Ground truth per case:** expected action (`create`/`clarify`/`respond`/`ignore`, with explicitly acceptable alternatives for borderline cases, e.g. "rate same as last time" may be refused *or* clarified, never invoiced). Where defined, it also records the expected customer (or `null` = must not resolve), the expected items by SKU (or `null` = must not resolve), and quantity and rate.
- **Isolation:** every case runs against a fresh in-memory `MockBooks` built from the same seed data as the Zoho trial org. There is no WhatsApp and no real Zoho.
- **Stage separation:**
  - *Extraction quality:* intent, line count, quantity and rate, compared against the labels from the model's validated output.
  - *Record matching:* customer/item resolution against the mock master data.
  - *Decision quality:* action accuracy, clarification recall, unnecessary clarifications, confidently wrong invoices, non-invoice false positives.
  - The `oracle` run feeds [eval/gold.json](../eval/gold.json), the ideal extraction per turn, into the same pipeline, so its scores are matching and decision quality alone.
- **Definitions:**
  - *Clarification recall* = turns that must clarify (including first turns of flows) where the bot asked.
  - *Unnecessary clarification rate* = expected-create cases that ended in a question.
  - *Confidently wrong* = any created invoice that differs from ground truth in customer, item, quantity or rate, or that should not exist.
  - *Non-invoice false positive* = a non-invoice or follow-up message that led to an invoice or an invoice-style question.
  - *Latency* = wall-clock time per turn that called the model, including retries.

Run: `npm run eval` (all of `EVAL_MODELS`), `npm run eval -- --set holdout`, or `npm run eval -- --models gemini:gemini-3.1-flash-lite --cases S01,B01 -v`. Use `EVAL_DELAY_MS` to stay under free-tier RPM. Results go to `eval/results/<model>.json` (per-case detail) and [eval/results/summary.md](../eval/results/summary.md).

### Results (measured 2026-10-18, current code)

**Main set (50 cases)**

| Metric | `gemini-3.1-flash-lite` | `oracle` (matching only) | `rules` (no LLM) |
|---|---|---|---|
| Action accuracy | **98%** (49/50) | 100% (50/50) | 72% (36/50) |
| Customer match accuracy | 100% (41/41) | 100% | 95.1% (39/41) |
| Item match accuracy | 97.7% (42/43) | 100% | 67.4% (29/43) |
| Quantity / rate accuracy (extraction) | 97.6% / 92.9% | 100% / 100% | 78.6% / 88.1% |
| Clarification recall | 100% (19/19) | 100% | 100% |
| Unnecessary clarification rate | 3.7% (1/27) | 0% | 40.7% (11/27) |
| Exactly-correct invoices | 96.3% (26/27) | 100% | 59.3% (16/27) |
| **Confidently wrong invoices** | **0** | 0 | 0 |
| Non-invoice false positives | 0% (0/8) | 0% | 25% (2/8) |
| Latency p50 / p95 per message | 1.3 s / 6.8 s | – | – |
| Model failures / invalid JSON / 429s | 0 / 0 / 0 | – | – |

**Held-out set (24 cases, committed in `e58cbc0` before any model ran on it)**

| Run | Flash-Lite action accuracy | Wrong invoices | Notes |
|---|---|---|---|
| 1. Before any tuning | 95.8% (23/24) | 0 | **Clean generalization number.** |
| 2. After the boundary-repair heuristic | 91.7% (22/24) | **1 (H10)** | The repair turned the ambiguous "VK Auto" into VK Enterprises. |
| 3. After restricting the repair (current) | 95.8% (23/24) | 0 | Never repairs ambiguous customers; only drops filler words. |

The regex baseline scores 45.8% on the held-out set (0 wrong invoices). The raw files for runs 1 and 2 are in `eval/results/holdout-history/`. From run 2 on, the held-out set is no longer untouched, so run 1 is the number to quote for generalization.

**How we got here:** the first Flash-Lite run (86% action accuracy) produced **one wrong invoice (B05)**: it copied a single "rate 5200" onto two different products. That led to the deterministic **grounding check**. Every quantity and rate must appear in the message, and one value cannot silently cover several items. Then came a fix for numbers glued to units (`4pc`), swapped-letter typos (`tyers`), and the customer/product boundary repair, which the held-out set caught overreaching (run 2) before it was restricted.

**How to read it:**

- **Zero wrong invoices in every column, including the no-LLM baseline.** Extraction errors become questions, not invoices. The LLM's value shows in fewer unnecessary questions (3.7% vs 40.7%) and far more exactly-correct invoices (96% vs 59%).
- **Remaining misses are all safe questions.**
  - W03: the model split "royal alloys" into a customer and an item.
  - H05: "vijay kumar tyers": the misspelt customer word leaked into the product description.
- **Oracle = 100% is partly by construction.** The labels and the matcher were written together, so it proves the ground truth is consistent and that matching works on good descriptions. The held-out set is the generalization check.
- **Limits of this evaluation:**
  - The catalogue is synthetic and small (12 customers, 20 items).
  - One author wrote both sets.
  - Latency was measured from India on the free tier, with occasional slow outliers (max 28 s).
  - A real deployment needs a labeled sample of the client's actual messages.

## 6. When to automate vs require human approval

| Situation | Policy in this prototype | Suggested production policy |
|---|---|---|
| All fields present, customer/items matched above thresholds, quantity and rate valid | Create **draft** automatically | Same; drafts are reviewed and *sent* by accounts staff (or auto-send only for trusted customers with amount < limit). |
| Any ambiguity, missing field, unknown record, foreign currency, invalid number | Ask in the group | Same. |
| Rate deviates from the item's list rate by > X% (not implemented) | — | Ask for confirmation, or require approval. |
| Large amount (> limit) or new customer | — | Draft + approval from a named approver. |
| "Rate same as last time" | Look up the customer's latest issued invoice (not draft, not void) for that exact item and **ask to confirm** the rate and its source invoice (Yes button, or reply with another rate); if none is found, ask for the rate | Same. |
| "Make it 6 pcs" / "rate 5000" | Only as a **reply to the bot's invoice message**; drafts only; one line per edit; numbers must be in the message; reply shows old → new | Add an audit trail and restrict edits to the requester or an approver. |
| New customer ("add customer X", or ➕ when a name is unknown) | Explicit **Yes/Cancel confirmation**: similar existing names shown as a warning, exact duplicates refused, single-use, expires with the clarification TTL; only the requester (or a `CUSTOMER_CREATORS` member) can confirm; `CUSTOMER_CREATE=off` disables it | Restrict to named admins; collect GSTIN and place of supply before creating. |
| Cancellations, resends, "same order as last week" | Refuse politely | Human only. |
| Sending to the customer, recording payments, voiding | Never | Human only. |

## 7. Learning aliases and shorthand safely

- **Today:** aliases come from `data/aliases.json`, keyed by the exact Zoho customer *name* (resolved to an ID at runtime). Initials and typos are handled generically.
- **Proposed loop:** when a clarification is resolved (e.g. user says `kwh` → picks *Kerala Wheel Hub*), record a *candidate* alias with its count and the user who confirmed it. Promote it to an active alias only after N consistent confirmations from authorized users, or after an admin approves it. Never promote an alias that collides with another customer's name, alias or initials. Store aliases with provenance and allow revocation. Apply the same idea to product shorthand (`lnz red 18`) via a synonym table that feeds the deterministic matcher, never by letting the LLM "remember" IDs.
- Optionally store the aliases in a Zoho custom field (`cf_aliases`) so accounts staff can edit them in the Zoho UI.

## 8. Questions for a real client before production

1. Who in the group may request invoices? Should requests from other members be ignored, or need approval? (Today any member of an allowed group can.)
2. Should invoices stay drafts, or be sent automatically? Under what amount, and for which customers?
3. Are rates negotiated per message, or should the Zoho price list / customer-specific price lists apply? What deviation needs approval?
4. GST: are all customers registered? How is place of supply determined? Are there inclusive-tax rates, discounts or freight lines?
5. Units and pack sizes: is "4" wheels or sets of 4? How should tyres vs rims vs kits be handled?
6. What shorthand do you use for customers and products? Can you provide the list, and who maintains it?
7. Should the bot handle edits ("make it 6"), repeat orders and "same as last time"? What confirmation do you expect?
8. Data retention: how long may message text and logs be kept? Who may see them?
9. Expected volume and peak times (Zoho limits: 100 requests/min and a plan-dependent daily cap).
10. Is Telegram acceptable for the team, or must it be WhatsApp? (WhatsApp groups are only possible unofficially or with an Official Business Account.)
11. What should happen when Zoho is down: queue and retry later, or ask the sender to resend?

## 9. Transport choice

| | Telegram Bot API (**default**) | WhatsApp Cloud API | Baileys (WhatsApp Web) |
|---|---|---|---|
| Official | Yes | Yes | No (reverse-engineered) |
| Group chats | Yes | Only with an Official Business Account (invite-only, max 8) | Yes |
| Ban risk | None | None | Real: number can be banned |
| Public URL needed | No (long polling) | Yes (HTTPS webhook) | No |
| Cost | Free | Free test number; paid per conversation in production | Free |
| Setup | BotFather token, 2 minutes | Meta app, tokens, tunnel, verified recipients | QR scan with a spare number |

**Decision:** the workflow needs a shared group chat, and that rules out the WhatsApp Cloud API for most businesses. Baileys meets the group requirement only by accepting ban risk and fragility. Telegram meets every functional requirement on an official, free API. The cost is a product one: the client's team must use Telegram.

All three transports implement the same small contract (`IncomingMessage` in, `SendFn` out), so the matching, clarification, idempotency and Zoho logic is identical across them, and switching is one setting (`CHAT_TRANSPORT`).

**Telegram specifics:**
- **Privacy mode.** Bots only see all group messages after `/setprivacy` → Disable (then re-add the bot), or when made an admin.
- **Message ids.** Ids are per chat, so they are namespaced `<chatId>:<messageId>` for dedupe and reply association.
- **Rate limits.** Roughly 20 messages/minute per group.
- **One instance per token.** A second poller with the same token gets 409.

**Baileys risks (if `CHAT_TRANSPORT=baileys`):** unofficial, can get the number banned, breaks on protocol changes, and the session folder is equivalent to account access.

## 10. Known limitations

- The LLM evaluation is not yet run (needs keys). Live Zoho behaviour (PDF via `accept=pdf`, GST fields, `invoice_url`) is implemented from the docs but not exercised against a real org. See [ZOHO_SETUP.md](ZOHO_SETUP.md).
- Only text messages are handled (captions included). Voice notes and images of handwritten orders are not.
- Quantities must be integers. There are no discounts, shipping lines or price lists.
- Edits change one line per message and only drafts this bot created (tracked for 7 days). Cancellation and repeat orders are refused.
- The matcher's thresholds were tuned on this synthetic catalogue. A real catalogue needs its own labeled set.
