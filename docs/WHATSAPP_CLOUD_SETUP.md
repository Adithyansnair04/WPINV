# WhatsApp Cloud API setup (optional transport: free test number, 1:1 chat)

> The default transport is Telegram (see [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md)). Use this guide only with `CHAT_TRANSPORT=whatsapp_cloud`.

The bot uses Meta's official **WhatsApp Business Cloud API**. Each user chats 1:1 with the bot's business number. Meta gives every developer app a free **test number** that can message up to **5 verified recipients**, which is enough for development and the demo. There's no second SIM to buy and none of the ban risk of unofficial clients.

## 1. Create the Meta app

1. Go to <https://developers.facebook.com> → **My Apps → Create app**. Choose the **Business** use case "Connect with customers through WhatsApp" (or app type *Business*), then create or select a Business portfolio.
2. Add the **WhatsApp** product. Open **WhatsApp → API Setup**.
3. On that page, copy:
   - the **Phone number ID** of the test number → `WA_PHONE_NUMBER_ID`
   - the **Temporary access token** → `WA_ACCESS_TOKEN` (it expires after **24 hours**; see step 6 for a permanent one)
4. Under **To**, click *Manage phone number list* and add your own WhatsApp number. Enter the code WhatsApp sends you. Only verified numbers can chat with the test number.
5. Open **App settings → Basic**, click *Show* next to **App secret**, and copy it → `WA_APP_SECRET`.

Choose any random string for `WA_VERIFY_TOKEN` (e.g. from `node -e "console.log(crypto.randomUUID())"`). In `.env`, put your number (digits only, with country code, e.g. `919876543210`) in `WA_ALLOWED_SENDERS`.

## 2. Run the bot and expose the webhook

```bash
npm start                       # listens on http://localhost:3000/webhook
```

Meta needs a public HTTPS URL. In a second terminal:

```bash
# Cloudflare (no account needed):
cloudflared tunnel --url http://localhost:3000
# or ngrok:
ngrok http 3000
```

Copy the `https://…` URL it prints.

## 3. Connect the webhook in Meta

1. **WhatsApp → Configuration → Webhook → Edit**:
   - Callback URL: `https://<your-tunnel>/webhook`
   - Verify token: the same value as `WA_VERIFY_TOKEN`
   - Click **Verify and save**. The bot logs `cloud.verify ok:true`.
2. Under **Webhook fields**, **Subscribe** to `messages`.

## 4. Test

From your phone, send a WhatsApp message to the test number. On the API Setup page you can first send the "hello_world" template to open the chat.

```
VK
red lenzo alloy 18 inch x 4
rate 5200
```

You should get the draft-invoice summary back. Then try `VK red wheel 4`: the bot asks with numbered options. **Swipe to reply** on the question and answer `2`.

If nothing happens, check the bot log:

| Log event | Meaning / fix |
|---|---|
| no log at all | The tunnel or webhook isn't reaching you. Check the callback URL and that `messages` is subscribed. |
| `cloud.bad_signature` | `WA_APP_SECRET` is wrong. |
| `cloud.sender_not_allowed` | Add the logged number to `WA_ALLOWED_SENDERS` and restart. |
| `reply.failed … 401` | The access token expired (24h) or is wrong. Generate a new one. |
| `reply.failed … not in allowed list` | Your number isn't verified as a recipient on the API Setup page. |

## 5. How it behaves

- **Verification:** `GET /webhook` answers Meta's `hub.challenge` only when `hub.verify_token` matches.
- **Signatures:** every `POST /webhook` must carry a valid `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret), otherwise it gets 401. Valid events are acknowledged with 200 immediately and processed asynchronously.
- **Retries:** Meta retries failed deliveries for up to 36 hours. Duplicates are dropped by WhatsApp message ID, and stale messages are skipped (`MAX_MESSAGE_AGE_SEC`).
- **Messages:** only text messages are processed. Images, voice notes and status (delivery/read) events are ignored.
- **Replies** quote the user's message (`context.message_id`). Invoice PDFs are uploaded via `/{phone-number-id}/media` and sent as a document.
- **Clarifications** are per chat. A swipe-reply to the bot's question, or the next message within `CLARIFY_TTL_MINUTES`, is treated as the answer.
- **24-hour window:** the bot only replies to users who just messaged it, so free-form replies are always allowed. It never starts conversations, which would need approved templates.

## 6. Beyond the test number

- **Permanent token:** Business Settings → Users → **System users** → add one → assign the app with `whatsapp_business_messaging` → *Generate token*.
- **Real number:** add your own business phone number in WhatsApp Manager. It must not be active in the WhatsApp or WhatsApp Business app. Complete business verification and display-name approval. Pricing is per conversation/message category; replies inside the 24-hour service window are cheapest or free, depending on Meta's current pricing.
- **Hosting:** any always-on server with HTTPS (a VPS behind Caddy/nginx, Railway, Fly.io, Render). Unlike Baileys, no session files need to persist, only `.data/state.json` for dedupe and clarification state.
- **Groups** in the Cloud API require an Official Business Account and are invite-only, so this bot is deliberately 1:1.
