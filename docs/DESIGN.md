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

**Prototype vs production.** These are prototype safeguards. State is a local JSON file, not a transactional store. Idempotency relies on Zoho's `reference_number` search. Authorization is only a chat allowlist (any member of an allowed group may request), with no roles or approvals. There is no audit UI. A crash between confirming an update and finishing processing can lose that message. A production system needs a database with unique constraints on the idempotency key, an outbox for replies, per-user authorization, monitoring and alerting, and the official WhatsApp API.

## 4. Model selection

| Role | Default | Why |
|---|---|---|
| Fast/small | `mistral:mistral-small-latest` | Small model (Mistral Small is a ~24B open-weights family): low latency and cost, and likely enough for short, structured extraction. This is the candidate for production if it matches the large model on safety metrics. |
| Larger | `mistral:mistral-large-latest` | Mistral's flagship tier, many times larger. It should be stronger on the hard cases: Hinglish and Tamil-English, unusual word order, "one rate for two items", and deciding whether a reply answers a clarification. It is slower. |
| Baseline | `rules` | No LLM: regex extraction plus the same matcher. Shows what the LLM adds. |
| Upper bound | `oracle` | Labeled ideal extraction. Measures matching and decisions on their own. |
| Optional | `gemini:<flash-lite id>`, `groq:…`, `openrouter:…`, `compat:…` (e.g. local Ollama) | The same interface; add any of them to `EVAL_MODELS` for a cross-vendor check. |

**Why this pair:**

- **A real small-vs-large contrast.** Both models come from one vendor, with the same API, JSON mode and tokenizer family. Differences in the results therefore reflect model capacity, not provider quirks. The question the eval answers is whether the small, fast model is good enough, given that the deterministic layer catches its mistakes.
- **It fits a free tier.** Mistral's free "Experiment" plan needs only phone verification (no card) and covers both models with one key. Its limits are reported as roughly 1 request/second and a large monthly token budget, enough for a 50-case run per model (≈55 model calls, ≈1 KB each). Groq was not usable for us. Gemini's free tier was considered for the pair: third-party reports (Oct 2026) say Flash models have very low daily caps (as low as ~20 requests/day), which cannot complete one eval run, and that older 2.5 models are restricted for new projects. Gemini Flash-Lite remains a good optional third, cross-vendor model.
- **Stable IDs.** The `-latest` aliases survive version bumps. For reproducible numbers, pin dated IDs from the Mistral console in `EVAL_MODELS`. The eval JSON records the exact spec used.
- **Caveat.** Free-tier data may be used for model training unless you opt out in the console. That's acceptable for this synthetic dataset, but not for real customer messages: production should use a paid tier with a no-training agreement, or a self-hosted model.

Quota figures come from third-party sources and change often. Check the provider console before running. Models are configured as `provider:model` strings, so switching needs no code changes.

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

Run: `npm run eval` (all of `EVAL_MODELS`), or `npm run eval -- --models mistral:mistral-large-latest --cases S01,B01 -v`. Use `EVAL_DELAY_MS` to stay under free-tier RPM. Results go to `eval/results/<model>.json` (per-case detail) and [eval/results/summary.md](../eval/results/summary.md).

### Results (measured 2026-10-18)

| Metric | `oracle` (matching only) | `rules` (no LLM) |
|---|---|---|
| Action accuracy | 100% (50/50) | 64% (32/50) |
| Customer match accuracy | 100% (41/41) | 51.2% (21/41) |
| Item match accuracy | 100% (43/43) | 53.5% (23/43) |
| Quantity accuracy | 100% (42/42) | 78.6% (33/42) |
| Rate accuracy | 100% (42/42) | 88.1% (37/42) |
| Clarification recall | 100% (19/19) | 100% (19/19) |
| Unnecessary clarification rate | 0% (0/27) | 55.6% (15/27) |
| Confidently wrong invoices | 0 | 0 |
| Non-invoice false positives | 0% (0/8) | 25% (2/8) |

**LLM runs (`mistral:mistral-small-latest`, `mistral:mistral-large-latest`) have NOT been run yet.** No API keys were available in the build environment. Add `MISTRAL_API_KEY` to `.env` and run `npm run eval`; `summary.md` then gains one column per model, with latency and failure/429 counts. No LLM numbers are claimed here.

How to read the measured columns:

- **Oracle = 100% partly by construction.** The labels and the matcher were written together, so this mainly proves that the ground truth is internally consistent and that the matcher behaves as intended when given good descriptions. It is not evidence of generalization. New, unseen phrasings and catalogues are the real test.
- **The rules baseline never created a wrong invoice.** It fails *safe* (it asks too often: 55.6% unnecessary clarifications) because every gap it leaves is caught by the deterministic checks. This is the core design property: extraction errors become questions, not wrong invoices. The LLM's job is to cut the unnecessary questions without raising the wrong-invoice count above 0.
- The baseline's 2 non-invoice false positives (a logistics question with a number, a payment note) are where an LLM classifier should help most.

## 6. When to automate vs require human approval

| Situation | Policy in this prototype | Suggested production policy |
|---|---|---|
| All fields present, customer/items matched above thresholds, quantity and rate valid | Create **draft** automatically | Same; drafts are reviewed and *sent* by accounts staff (or auto-send only for trusted customers with amount < limit). |
| Any ambiguity, missing field, unknown record, foreign currency, invalid number | Ask in the group | Same. |
| Rate deviates from the item's list rate by > X% (not implemented) | — | Ask for confirmation, or require approval. |
| Large amount (> limit) or new customer | — | Draft + approval from a named approver. |
| Edits, cancellations, "same as last time" | Refuse politely | Supported only with an explicit confirmation step showing the referenced invoice. |
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
- "Rate same as last time" and edits are deliberately unsupported (bonus features).
- The matcher's thresholds were tuned on this synthetic catalogue. A real catalogue needs its own labeled set.
