# Demo plan (≈3 minutes)

**Setup before recording:** `.env` with `MISTRAL_API_KEY` (or use `--model rules`). Pick one of two setups:

- **Safest:** `ZOHO_MODE=mock`, with the simulator in one terminal.
- **Live:** Zoho trial org seeded (`npm run zoho:check` is green), `ZOHO_MODE=live`, `INVOICE_ALLOW_LIVE_CREATE=true`, `npm start` with a Telegram bot added to a demo group (privacy mode disabled, group id in `TELEGRAM_ALLOWED_CHATS`; see TELEGRAM_SETUP.md).

Font size up, logs visible in a second pane.

| Time | Show | Say |
|---|---|---|
| 0:00–0:20 | README header / architecture diagram in DESIGN.md | "Telegram group (official Bot API) → LLM reads the message → deterministic matching against real Zoho records → draft invoice → reply. The LLM never sees or picks database IDs." |
| 0:20–1:00 | **Successful invoice.** Send `VK` / `red lenzo alloy 18 inch x 4` / `rate 5200` (3 lines) | Point out: `VK` → VK Enterprises (alias), exact variant *Lenzo Alloy Wheel 18" Red* among Lenzo/Lenza/colours/sizes, 4 × ₹5,200, subtotal, tax, total, **draft** status, PDF attachment. In the log pane: `extract.ok` → `decision` trace with scores → `invoice.created`, plus latency per stage. |
| 1:00–1:15 | Resend / forward the same message (or show the dedupe test) | "Same Telegram message ID → ignored. Even after lost state, the reference number prevents a second invoice." |
| 1:15–2:00 | **Ambiguous request.** Send `VK red wheel 4` | The bot asks: which of 4 red wheels (numbered) plus the rate. Quote-reply `2, rate 5200` (or `2` then the rate). The draft is created with the chosen item. Then send `ok thanks`: no reply, no invoice. Then send `rate same as last time`: polite refusal, no invented rate. |
| 2:00–2:40 | **Evaluation.** `npm run eval` output and `eval/results/summary.md` | 50 labeled cases, each model side by side. Highlight: **confidently wrong invoices = 0**, clarification recall, unnecessary-clarification rate (where the LLM beats the regex baseline), latency p50/p95, 429/retry counts. Explain the oracle column = matching quality with perfect extraction. |
| 2:40–3:00 | DESIGN.md §6 and §9 | Drafts only, human sends. Why Telegram: official API with groups and no ban risk; WhatsApp groups are only possible unofficially (Baileys) or with an Official Business Account. |

**Fallback if Telegram or Zoho is unavailable during the demo:**

```bash
npm run simulate -m "VK\nred lenzo alloy 18 inch x 4\nrate 5200" -m "VK red wheel 4" -m ">2" -m ">rate 5200" -m "ok thanks"
```

The simulator uses the identical processor and prints the same replies.
