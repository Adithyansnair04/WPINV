# Demo plan (≈4 minutes)

**Setup before recording:**

- `.env` with `GEMINI_API_KEY` and `LLM_MODEL=gemini:gemini-3.1-flash-lite`, or use `--model rules` for an offline demo.
- `npm start` with the Telegram bot in a demo group: privacy mode disabled, group id in `TELEGRAM_ALLOWED_CHATS` (see TELEGRAM_SETUP.md).
- Open the **dashboard** at <http://127.0.0.1:3001> in a browser window next to Telegram.
- Zoho:
  - **Safest:** `ZOHO_MODE=mock`.
  - **Live:** trial org seeded (`npm run zoho:check` is green), `ZOHO_MODE=live`, `INVOICE_ALLOW_LIVE_CREATE=true`.

Turn the font size up.

| Time | Show | Say |
|---|---|---|
| 0:00–0:20 | Architecture diagram in DESIGN.md | "Telegram group → the LLM reads the message → deterministic matching against real Zoho records → draft invoice → reply. The LLM never sees or picks database IDs, and every number it extracts must appear in the message." |
| 0:20–1:00 | **Successful invoice:** send `VK` / `red lenzo alloy 18 inch x 4` / `rate 5200` (3 lines) | `VK` → VK Enterprises (alias); the exact variant *Lenzo Alloy Wheel 18" Red* out of Lenzo/Lenza, three colours and three sizes; 4 × ₹5,200, tax, total, **draft** status, PDF. On the dashboard, the new row shows the match scores and the latency (~1 s). |
| 1:00–1:40 | **Ambiguous request:** send `VK red wheel 4` | The bot asks which of 4 red wheels, **with buttons**, plus the rate. A *different* group member taps option 2 (or replies `2, rate 5200`) → draft created. The dashboard shows the open question, then the invoice. Send `ok thanks`: no reply. |
| 1:40–2:10 | **"Rate same as last time":** `VK lenzo 18 red x 4 rate same as last time` | "Use the last rate: ₹5,100 (invoice INV-000101, 28 Sep)?" with a **Yes** button. Nothing is guessed; the source invoice is shown. Tap Yes → draft. |
| 2:10–2:30 | **Edit:** reply to the bot's invoice message with `make it 6 pcs` | "Changed …: 4 × ₹5,200 → 6 × ₹5,200", plus the updated totals. Drafts only; sent invoices are refused. |
| 2:30–3:30 | **Evaluation:** the dashboard's evaluation tables, or `eval/results/summary.md` | 50 labeled cases plus a 24-case **held-out set** committed before any model ran on it. Point out **0 confidently wrong invoices** in every column, Flash-Lite 98% (main) / 95.8% (held-out) correct action, p50 ≈1.3 s, versus the regex baseline. The oracle column is matching quality with perfect extraction. Mention the held-out story: one heuristic created a wrong invoice on the held-out set, so it was restricted before shipping. Also mention the larger model's free-tier limit (20 requests/day). |
| 3:30–4:00 | DESIGN.md §6 and §9 | Drafts only, a human sends them. Why Telegram: official API with groups and no ban risk. |

**Fallback if Telegram or Zoho is unavailable:**

```bash
npm run simulate -- --dashboard -m "VK\nred lenzo alloy 18 inch x 4\nrate 5200" -m "VK red wheel 4" -m ">2" -m ">rate 5200" -m "VK lenzo 18 red x 4 rate same as last time" -m ">yes" -m "ok thanks"
```

The simulator uses the identical processor and fills the dashboard at the same URL.
