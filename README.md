# 🛡️ GuardianPay — AI scam-shield for seniors' PayPal accounts

**PayPal AI Hackathon 2026 · "Build What's Next" entry**

Every outgoing payment from a senior's PayPal account passes through an AI risk engine before any money moves. Suspicious payments are **held for 24 hours** — the senior sees a calm, plain-language explanation, and a trusted family contact gets an alert with the evidence. Legitimate payments sail through untouched.

The pitch: *protection without taking away independence.*

---

## Architecture (in words)

```
┌─────────────┐     payment request      ┌──────────────────┐
│  Senior's    │ ──────────────────────▶ │  GuardianPay     │
│  PayPal app  │                         │  risk engine     │
└─────────────┘                         │  (this repo)     │
                                        │                  │
                                        │  7 signals →     │
                                        │  score 0–100 →   │
                                        │  APPROVE/HOLD/   │
                                        │  BLOCK           │
                                        └────────┬─────────┘
                                                 │
                        ┌────────────────────────┼────────────────────────┐
                        ▼                        ▼                        ▼
                 ┌─────────────┐        ┌─────────────────┐      ┌──────────────────┐
                 │ PayPal      │        │ Senior UI: calm │      │ Trusted contact: │
                 │ Sandbox API │        │ hold notice +   │      │ SMS alert with   │
                 │ (invoices,  │        │ evidence board  │      │ evidence summary │
                 │ payouts,    │        │ (signal-by-     │      │ (real Twilio     │
                 │ webhooks)   │        │ signal)         │      │ if configured)   │
                 └─────────────┘        └─────────────────┘      └──────────────────┘
```

**What's real vs. simulated (we label it everywhere it matters):**

| Component | Status |
|---|---|
| PayPal Sandbox REST calls (OAuth, invoices, payouts, webhook receiver) | ✅ REAL — `lib/paypal.js` |
| Risk engine scoring (recipient history, amount pattern, relationship velocity, behavioral, charity registry) | ✅ REAL — `lib/riskEngine.js` |
| Message coercion-marker analysis | ✅ REAL heuristic; upgrades to a **real LLM call** automatically — OpenAI first (`OPENAI_API_KEY`), Anthropic fallback (`ANTHROPIC_API_KEY`) — `lib/textAnalysis.js` |
| Profile-photo reverse-image lookup | ⚠️ **SIMULATED** — labeled `SIMULATED` in code and UI; production swaps in TinEye/Google Lens API |
| Trusted-contact SMS | ✅ **REAL via Twilio** when `TWILIO_*` env vars are set (`POST /api/alert`, `lib/sms.js`); ⚠️ labeled UI mock otherwise — the UI shows which mode is active |
| Webhook signature verification | ✅ REAL implementation (`verifyWebhookSignature`); verified when `PAYPAL_WEBHOOK_ID` is configured |

---

## Setup

### 1. PayPal Sandbox credentials (free, ~5 minutes)

1. Go to https://developer.paypal.com and log in (or create a free developer account).
2. **Dashboard → Apps & Credentials → Sandbox → Create App.** Name it `GuardianPay`.
3. Copy the **Client ID** and **Secret**.
4. (Optional, for receiving real money in demo) Create two sandbox personal accounts: **Dashboard → Sandbox → Accounts → Create Account** — one "senior" (e.g. `margaret-facilitator@personal.example.com`), one "trusted contact".
5. (Optional, for webhooks) **Dashboard → Webhooks → Create Webhook**, point it at `https://<your-public-url>/api/webhooks/paypal`, subscribe to `INVOICING.INVOICE.PAID` / `PAYMENT.PAYOUTS-ITEM.*`, and copy the **Webhook ID**.

### 2. Install & run

```bash
cd guardianpay
npm install
cp .env.example .env   # then fill in your sandbox credentials
npm start
# → GuardianPay running at http://localhost:3000
```

Environment variables (all in `.env.example`):

| Var | Required | Purpose |
|---|---|---|
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | for live PayPal calls | Sandbox REST API auth |
| `PAYPAL_MERCHANT_EMAIL` | optional | Sandbox business email used as invoice sender |
| `PAYPAL_WEBHOOK_ID` | optional | Enables real webhook signature verification |
| `OPENAI_API_KEY` | optional | Upgrades message analysis from heuristic to a real LLM (OpenAI, tried first) |
| `ANTHROPIC_API_KEY` | optional | Fallback LLM provider (tried after OpenAI if unset/failing) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | optional | Real SMS alerts to the trusted contact. Without these, `POST /api/alert` and the demo UI use a labeled mock — nothing leaves the machine |
| `PORT` | optional | Default `3000` |

> **The demo UI and risk engine run with zero credentials.** PayPal calls are only needed for the "create a real sandbox invoice/payout" buttons/endpoint — the three demo scenes are fully self-contained.

### 3. Run the tests

```bash
npm test
# 6 tests: romance → HOLD, charity → HOLD, legit → APPROVE, heuristic text markers,
# alert composer, SMS mock mode. No network needed.

---

## API reference

| Method & path | What it does |
|---|---|
| `GET /` | Demo UI (senior view → evidence board → contact alert) |
| `GET /api/scenarios` | List of the 3 demo scenes |
| `GET /api/scenario/:id` | Fixture for one scene (`romance` / `charity` / `legit`) |
| `POST /api/analyze` | Body: `{"scenarioId":"romance"}` or `{"payment":{…},"context":{…}}` → `{score, verdict, signals[], summary, recommendedAction}` |
| `GET /api/paypal/status` | Whether sandbox creds are configured |
| `GET /api/sms/status` | Whether Twilio creds are configured (`real` vs `mock` mode) |
| `POST /api/alert` | Body: `{"scenarioId":"romance"}` → re-analyzes; if HOLD/BLOCK, sends the trusted-contact alert (**real SMS via Twilio when configured**, labeled mock otherwise) |
| `POST /api/paypal/invoice` | **Real sandbox call:** create + send an invoice. Body: `{recipientEmail, amount, note}` |
| `POST /api/paypal/payout` | **Real sandbox call:** create a payout. Body: `{recipientEmail, amount, note}` |
| `POST /api/webhooks/paypal` | PayPal webhook receiver (logs + verifies signature when configured) |
| `GET /api/webhooks/log` | Recent webhook events received |

---

## 🎬 Demo script (for judges — under 3 minutes)

**Setup:** `npm install && npm start` → open http://localhost:3000

**Scene 1 — The romance scam (0:00–1:20)**
1. Tab 1 is "Scene 1 — The romance scam". Read the narrative: Margaret, 78, four months of sweet messages from "David".
2. Click **Pay $900**. Watch the evidence board fire signal by signal:
   - *Recipient history* — first-ever payment, 21-day-old account, name variant mismatch
   - *Amount vs. her pattern* — $900 is 20× her usual $45
   - *Message analysis* — "my dear", "don't tell anyone", "tonight"
   - *Relationship velocity* — 4 months of grooming, zero prior money mentions, never video-called
   - *Profile photo check* — **SIMULATED** reverse-image hit on a stock-photo site
   - *Behavioral* — 11 PM; she has never paid after 8 PM
3. Verdict: **⏸️ HOLD — 90/100**. "Protection without taking away independence."
4. Click **"See what Tom receives"** → the SMS alert. If Twilio is configured, a **"Send real SMS alert"** button fires a genuine text; otherwise a labeled mock is shown (the UI tells you which mode is active).

**Scene 2 — The fake charity (1:20–2:10)**
1. Switch tabs. Margaret gets a polished "Ontario Wildfire Relief Fund" invoice for $250.
2. Click **Pay $250** → the charity-registry signal fires: *not in the registry*. Verdict: **HOLD — 58/100**.

**Scene 3 — The legitimate payment (2:10–2:50)**
1. Switch tabs. Her $45 pharmacy bill — 3-year payee, normal amount, 10 AM.
2. Click **Pay $45** → every signal green. Verdict: **✅ APPROVE — 4/100**. "Protection without friction."

**The line:** *"It caught the scam that fools real people for months — and didn't slow down her real life by a second."*

**(Optional, with sandbox creds)** `POST /api/paypal/invoice` with Margaret's sandbox email to create a *real* PayPal sandbox invoice, and watch the webhook land at `/api/webhooks/log`.

---

## Tech

Node.js + Express, vanilla JS frontend (no framework), PayPal REST via direct HTTPS calls. Dependencies: `express`, `twilio` (SMS only loads when credentials are set).

## License

MIT — see LICENSE (required: public repo with an open-source license for the hackathon).
