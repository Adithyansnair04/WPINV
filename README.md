# WPINV: chat-to-invoice bot for Zoho Books

Your team types an order in a Telegram group. WPINV turns it into a **draft invoice in Zoho Books**.

```
VK
red lenzo alloy 18 inch x 4
rate 5200
```

The bot works out that `VK` is *VK Enterprises* and that the item is *Lenzo Alloy Wheel 18" Red*. It shows a preview, and when someone taps ✅ it creates the draft and posts the PDF. If anything is unclear, it **asks instead of guessing**.

**One bot, many businesses.** Each Telegram group can belong to a different client with its own Zoho Books organization. A new client can be onboarded even when you know nothing about their customers or products.

| | |
|---|---|
| **Chat** | Telegram groups (official Bot API) |
| **AI** | Gemini 3.1 Flash-Lite, with Groq gpt-oss-20b as automatic backup |
| **Accounting** | Zoho Books (India), draft invoices only |
| **Built with** | Node.js + TypeScript, 75 offline tests |
| **Result** | 98% correct decisions, **0 wrong invoices** across every model tested |

## Contents

1. [What it does](#what-it-does)
2. [Multiple clients](#multiple-clients)
3. [How it works](#how-it-works)
4. [Evaluation and results](#evaluation-and-results)
5. [Getting started](#getting-started)
6. [Commands and settings](#commands-and-settings)
7. [Safety and limits](#safety-and-limits)
8. [More documentation](#more-documentation)

---

## What it does

| You send | The bot |
|---|---|
| `VK` / `red lenzo alloy 18 inch x 4` / `rate 5200` | Shows a preview with **✅ Create / ❌ Cancel**. After ✅, creates the draft in Zoho and posts the totals and PDF. |
| `VK red wheel 4` | Asks which red wheel (with buttons) and the missing rate |
| `VK lenzo 18 red x 4, rate same as last time` | Finds the last invoice and asks *"Use ₹5,100 from INV-000101?"* |
| Reply to an invoice: `make it 6 pcs` | Updates that draft and shows old → new |
| `add customer Zenith Motors` | Asks for confirmation, warns about similar names, then adds the customer |
| `ok thanks`, `good morning` | Stays quiet |

A local **dashboard** (`http://127.0.0.1:3001`) shows every request: which client, which AI model handled it, what was matched, and any open questions.

---

## Multiple clients

One bot can serve several businesses. Each Telegram group is linked to one **client**, and each client has its own Zoho organization.

```
 Telegram group "wheels"  ──┐                 ┌──▶ client "default": Zoho org 1 (wheels & tyres)
                            ├── one bot ──────┤
 Telegram group "onboard" ──┘  (routes by     └──▶ client "onboard": Zoho org 2 (stationery)
                                chat id)
```

**What each client gets:**
- **Its own Zoho organization.** One client can never see or write another client's invoices.
- **Its own settings:** tax, rate rules, whether drafts are allowed, who may approve.
- **Its own profile:** a short description of the business and its approved customer shorthand ("VK" → VK Enterprises). The AI prompt and matching rules adapt to it.
- **Its own state.** If one client is misconfigured, it is skipped and the others keep running.

**What all clients share:** the Telegram bot, the AI keys and the dashboard (set in `.env`).

Client details live in `clients.json` (see [clients.example.json](clients.example.json)). Because it holds credentials, it is never committed. Without a `clients.json`, the bot runs as a single client from `.env`.

### Onboarding a client you know nothing about

You don't need to know the client's customers or products. The bot reads them from the client's Zoho Books.

```bash
# 1. Link the client's Telegram group (send /whoami in the group to get its chat id)
npm run client:add -- --id onboard --name "Onboard Stationery" --chat -5428596935

# 2. Connect the client's Zoho Books
npm run zoho:token -- --client onboard <grant_code>
npm run zoho:check -- --client onboard

# 3. Let the bot study the client's catalogue
npm run client:profile -- --client onboard --write --business "an Indian stationery wholesaler"
```

Step 3 writes an **onboarding report** that warns you where the bot will need to ask questions:

- items that differ by only one word (`Gel Pen Blue` / `Gel Pen Black`);
- customers that share a name (`Mehta Traders` / `Mehta Book Depot`);
- sizes that could be mistaken for quantities (`60 ml`, `50 g`).

It also drafts a profile for you to review.

A new client always **starts in preview mode**: the bot replies with previews but writes nothing to Zoho. When the previews look right, set `INVOICE_ALLOW_LIVE_CREATE` to `true` for that client and restart.

Full guide: [docs/ONBOARDING.md](docs/ONBOARDING.md).

---

## How it works

**The AI reads the message. Plain code makes every decision.**

```
Telegram message
   │
   ▼
1. Which client?          chat id → client (its Zoho org, profile, settings)
2. Read the message       AI extracts: customer words, items, quantities, rates     ← Gemini, Groq as backup
3. Check the output       must match a strict schema, otherwise retry / use backup
4. Match records          customer and item matched against that client's Zoho data  ← plain code
5. Verify numbers         every quantity and rate must appear in the original message
6. Decide                 create · ask a question · reply · ignore
7. Confirm and create     preview → ✅ → draft invoice in Zoho → reply with PDF
```

| Job | Done by | Why |
|---|---|---|
| Understand messy text, Hinglish, typos | **AI** | Language is what the AI is good at |
| Pick the customer and the item | Code | Only accepted when the match is clearly better than any alternative. Two "Sharma"s → it asks. |
| Check quantities and rates | Code | The numbers must really be in the message; one rate can't silently cover two products |
| Calculate tax and totals | Zoho | Zoho's own tax setup |
| Create invoices or customers | Code **+ a person** | Nothing is written until someone taps ✅ |

The AI never sees database IDs and never chooses a record. A wrong AI answer becomes a question, not a wrong invoice.

---

## Evaluation and results

**How it was tested:**
- **50 labelled test messages** covering 12 kinds of request: simple orders, shorthand, typos, look-alike products, missing details, ambiguous requests, chit-chat, "same as last time" and multi-step conversations.
- **24 extra unseen messages**, written and committed before any model was run on them, to check the bot wasn't tuned to the test.
- Each case runs against a fresh copy of demo Zoho data, and only the AI call is real.
- Two reference runs:
  - an **oracle**, which uses perfect AI output to test the code alone;
  - a **regex baseline**, which uses no AI.

**Results** (main set of 50; held-out set of 24 in brackets):

| | Gemini Flash-Lite | Groq gpt-oss-20b | Groq gpt-oss-120b | No AI (regex) |
|---|---|---|---|---|
| **Correct decision** | **98%** (95.8%) | 94% (95.8%) | 92% (70.8%) | 72% (45.8%) |
| **Wrong invoices** | **0** (0) | **0** (0) | **0** (0) | **0** (0) |
| Customer matched | 100% | 95.1% | 92.7% | 95.1% |
| Item matched | 97.7% | 97.7% | 97.7% | 67.4% |
| Quantity / rate read correctly | 97.6% / 92.9% | 100% / 100% | 100% / 100% | 78.6% / 88.1% |
| Asked when it had to | 100% | 100% | 100% | 100% |
| Asked when it didn't need to | **3.7%** | 11.1% | 14.8% | 40.7% |
| Response time (typical / slow) | **1.3 s / 6.8 s** | 4.9 s / 11.0 s* | 1.9 s / 8.4 s* | instant |

\* Slowed by Groq's free-tier rate limits during testing. In normal chat use, gpt-oss-20b replies in about 1–2 s.

**What this shows:**
1. **Safety comes from the code, not the AI.** Every model, even with no AI at all, made zero wrong invoices. Mistakes turned into questions.
2. **The AI's value is asking fewer unnecessary questions.** Flash-Lite needs to ask on 3.7% of clear requests, against 40.7% without AI.
3. **A bigger model isn't better here.** The 120b model scored lower than the 20b one on unseen messages.

**Recommendation:**
- Use **Gemini Flash-Lite** as the main model: the most accurate, the fastest, with a generous free quota.
- Use **Groq gpt-oss-20b** as the backup: a different company, so its outages are independent, with equal held-out accuracy.
- Keep **preview → ✅ → draft**, and let people send the invoices.
- Before production, test on 100–200 of the client's real messages.

Full numbers: [eval/results/summary.md](eval/results/summary.md). Method and reasoning: [docs/DESIGN.md](docs/DESIGN.md).

---

## Getting started

**You need:**
- Node.js 20 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A [Gemini API key](https://aistudio.google.com/apikey). A [Groq key](https://console.groq.com/keys) for the backup model is optional.
- A Zoho Books organization (for real invoices)

```bash
npm install
cp .env.example .env      # put real keys in .env only
```

**Try it offline, with no keys:**

```bash
npm test
npm run simulate -- --model rules --dashboard -m "VK\nred lenzo alloy 18 inch x 4\nrate 5200"
```

**Run it for real:**
1. **Telegram:** create the bot, turn off privacy mode and add it to your group. See [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md).
2. **Zoho:** run `npm run zoho:token -- <code>`, then `npm run zoho:check`. See [docs/ZOHO_SETUP.md](docs/ZOHO_SETUP.md).
3. **Start in preview mode** (`INVOICE_ALLOW_LIVE_CREATE=false`). Switch it to `true` when you're happy.
4. **Start:** `npm start`. The dashboard is at http://127.0.0.1:3001.

Run **only one copy** of the bot per Telegram token. Two copies interrupt each other.

**Add more clients:** see [Multiple clients](#multiple-clients).

---

## Commands and settings

| Command | What it does |
|---|---|
| `npm start` | Run the bot |
| `npm test` | Run the offline tests |
| `npm run simulate` | Chat with the bot in your terminal |
| `npm run eval` | Run the evaluation |
| `npm run client:add` | Link a new client to a Telegram group |
| `npm run client:profile` | Study a client's Zoho catalogue and draft its profile |
| `npm run zoho:token` / `zoho:check` | Connect / test Zoho (add `-- --client <id>` for a specific client) |
| `npm run zoho:seed` | Load demo customers and items into an empty test organization |

**Main settings** (in `.env`, or per client in `clients.json`):

| Setting | Default | Meaning |
|---|---|---|
| `LLM_MODEL`, `LLM_FALLBACK_MODEL` | Gemini Flash-Lite, none | Main and backup AI model |
| `ZOHO_MODE` | `mock` | `live` uses real Zoho; `mock` uses demo data |
| `INVOICE_ALLOW_LIVE_CREATE` | `false` | `false` = previews only; `true` = create drafts |
| `INVOICE_CONFIRM`, `INVOICE_APPROVERS` | `always`, anyone | Tap ✅ before every invoice; optionally only listed people |
| `RATE_POLICY` | `ask` | Ask for missing rates, or use the Zoho price (`item_default`) |
| `DEFAULT_TAX_PERCENT` | none | Tax for items without one (needs a GST-registered org) |
| `CUSTOMER_CREATE` | `confirm` | Allow adding customers from chat, with confirmation |

---

## Safety and limits

**Safety:**
- Invoices are always **drafts**. The bot can't send, void or delete anything in Zoho.
- Nothing is written to Zoho until someone taps ✅.
- Each client is locked to its own Zoho organization.
- Secrets stay in `.env` and `clients.json`. Both are git-ignored, and logs hide tokens.
- The dashboard is read-only and only reachable from your own computer. Don't expose it to the internet.
- On free AI tiers, messages may be used for training. Use paid tiers for real customer data.

**Current limits:**
- Text messages only, no voice notes or photos. Quantities must be whole numbers.
- One line changed per edit.
- All clients share one running bot, so if it stops, it stops for everyone.
- State is kept in local files, not a database.
- Tested on demo catalogues. Each real client should be tested on their own messages.

**Status:**
- The Telegram bot, Gemini with Groq backup, and Zoho (drafts, PDFs, adding customers, "same as last time") run live.
- Multiple clients run live, with two Zoho organizations connected.
- GST tax needs the Zoho organization to be GST-registered.

**Future plans:** WhatsApp (official Cloud API), Docker packaging, GST invoices, learning shorthand from confirmed answers, and a real database.

---

## More documentation

| Document | Contents |
|---|---|
| [docs/ONBOARDING.md](docs/ONBOARDING.md) | Adding a new client, step by step |
| [docs/DESIGN.md](docs/DESIGN.md) | Architecture, safety rules, model choice, full evaluation |
| [docs/TELEGRAM_SETUP.md](docs/TELEGRAM_SETUP.md) | Creating and configuring the Telegram bot |
| [docs/ZOHO_SETUP.md](docs/ZOHO_SETUP.md) | Connecting Zoho Books |
| [docs/DEMO.md](docs/DEMO.md) | A demo script to try |
