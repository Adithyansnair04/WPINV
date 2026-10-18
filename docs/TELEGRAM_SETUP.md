# Telegram setup (group chat)

The bot uses the official **Telegram Bot API** with long polling. It fetches messages from Telegram itself, so **no tunnel, public URL or open port is needed**: `npm start` on any machine with internet access is enough. Groups are fully supported, it's free, and there's no ban risk.

## 1. Create the bot (2 minutes)

1. In Telegram, open **@BotFather** (the official bot with the blue tick) and send `/newbot`.
2. Choose a display name (e.g. `WPINV Invoices`) and a username ending in `bot` (e.g. `wpinv_invoice_bot`).
3. BotFather replies with a **token** like `123456789:AA…`. Put it in **`.env`** (not `.env.example`):

   ```env
   TELEGRAM_BOT_TOKEN=123456789:AA...
   ```

   The token controls the bot. If it leaks, send `/revoke` to BotFather.

## 2. Let the bot read group messages (important)

By default, bots in groups only see commands and replies to their own messages ("privacy mode"). An invoice request like `VK red wheel 4` would never reach the bot. Use **one** of these:

- **Option A (recommended):** in @BotFather send `/setprivacy` → choose your bot → **Disable**. Then **remove the bot from the group and add it again**; the setting only applies to groups it joins afterwards.
- **Option B:** make the bot an **admin** of the group. Admins receive all messages.

## 3. Add the bot to your group

1. Create a group (e.g. *Sales – Invoices*) or open an existing one. Tap the group name → **Add members** → search for your bot's username → add.
2. In `.env`, keep `CHAT_TRANSPORT=telegram` (the default).

## 4. Allow the group

1. Start the bot: `npm start`. You should see `telegram.connected` with your bot's username.
2. Send any message in the group, e.g. `hello`.
3. The log shows:

   ```
   {"event":"telegram.chat_not_allowed","chatId":"-1001234567890","title":"Sales – Invoices",...}
   ```

4. Copy that chat id (including the minus sign) into `.env`, then restart with Ctrl+C and `npm start`:

   ```env
   TELEGRAM_ALLOWED_CHATS=-1001234567890
   ```

   Separate several groups with commas. You can also list a private chat id to use the bot 1:1.

## 5. Test

In the group:

```
VK
red lenzo alloy 18 inch x 4
rate 5200
```

The bot replies to your message with the draft-invoice summary. Then:

- `VK red wheel 4`: the bot asks which wheel. **Reply** to its question (swipe left on mobile, or right-click → Reply on desktop) with `2, rate 5200`.
- `ok thanks`: no reply.
- `where is my invoice from yesterday?`: a polite refusal.

In a group, an answer is linked to the pending question when it **replies to the bot's question** (any member may answer that way), or when it's the **next message from the same person** within `CLARIFY_TTL_MINUTES`. A different member's unrelated message never completes someone else's request.

## Troubleshooting

| Log | Meaning / fix |
|---|---|
| `Startup failed: TELEGRAM_BOT_TOKEN is not set` | Put the token in `.env`. |
| `telegram.poll_failed … 401` | Wrong token. Copy it again from BotFather. |
| `telegram.poll_failed … 409` | Another copy of the bot is running with the same token. Stop it. |
| no log when you write in the group | Privacy mode is still on (step 2); remove and re-add the bot, or make it admin. |
| `telegram.chat_not_allowed` | Add the logged chat id to `TELEGRAM_ALLOWED_CHATS` and restart. |
| `telegram.chat_migrated` | The group became a supergroup and got a new id. Update `TELEGRAM_ALLOWED_CHATS`. |

## How it behaves

- **Polling:** `getUpdates` long polling with a 25 s timeout. Any webhook previously set for the bot is removed on start. An update is confirmed only after it has been handed to the processor; duplicates after a restart are dropped by message id (stored as `<chatId>:<messageId>`, since Telegram ids are per chat).
- **What's processed:** text messages and captions only. Bot messages, messages older than `MAX_MESSAGE_AGE_SEC` and chats not in the allowlist are ignored.
- **Replies** quote the original message. Invoice PDFs are sent as documents.
- **Rate limits:** Telegram limits bots to roughly 20 messages/minute per group. On HTTP 429 the bot waits `retry_after` once and retries.
- **Hosting:** any always-on machine with outbound internet (your PC, a VPS, Railway/Fly/Render as a worker). Run only **one** instance per token. No inbound port or HTTPS certificate is needed.
