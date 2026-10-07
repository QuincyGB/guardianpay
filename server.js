'use strict';
/**
 * GuardianPay server — PayPal AI Hackathon 2026 entry.
 *
 * Routes:
 *   GET  /                          -> demo UI
 *   GET  /api/scenarios             -> demo scenario list
 *   GET  /api/scenario/:id          -> scenario fixture (payment + context)
 *   POST /api/analyze               -> { scenarioId } or { payment, context } -> risk engine verdict
 *   GET  /api/paypal/status         -> whether sandbox creds are configured
 *   POST /api/paypal/invoice        -> create + send a REAL sandbox invoice { recipientEmail, amount, note }
 *   POST /api/paypal/payout         -> create a REAL sandbox payout { recipientEmail, amount, note }
 *   POST /api/webhooks/paypal       -> PayPal webhook receiver (logs events, verifies signature when configured)
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { analyze } = require('./lib/riskEngine');
const paypal = require('./lib/paypal');
const sms = require('./lib/sms');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const demoData = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'demo-data.json'), 'utf8'));

// ---- Demo / risk engine ----
app.get('/api/scenarios', (req, res) => {
  res.json(Object.values(demoData.scenarios).map((s) => ({
    id: s.id, demoTitle: s.demoTitle, narrative: s.narrative,
  })));
});

app.get('/api/scenario/:id', (req, res) => {
  const s = demoData.scenarios[req.params.id];
  if (!s) return res.status(404).json({ error: 'unknown scenario' });
  res.json(s);
});

app.post('/api/analyze', async (req, res) => {
  try {
    let payment, context;
    if (req.body.scenarioId) {
      const s = demoData.scenarios[req.body.scenarioId];
      if (!s) return res.status(404).json({ error: 'unknown scenario' });
      // Merge the shared charity registry into context for the charity scene
      context = { ...s.context, charityRegistry: demoData.charityRegistry };
      payment = s.payment;
    } else if (req.body.payment) {
      payment = req.body.payment;
      context = { ...(req.body.context || {}), charityRegistry: demoData.charityRegistry };
    } else {
      return res.status(400).json({ error: 'provide scenarioId or payment' });
    }
    const result = await analyze(payment, context);
    res.json({ ...result, contact: demoData.contact, senior: demoData.senior.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---- Trusted-contact SMS alerts (REAL Twilio when configured, else mock) ----
app.get('/api/sms/status', (req, res) => {
  res.json({
    configured: sms.configured(),
    mode: sms.configured() ? 'real' : 'mock',
    hint: sms.configured()
      ? 'Twilio credentials detected — alerts send real SMS.'
      : 'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER for real SMS. Demo uses a UI mock.',
  });
});

/**
 * POST /api/alert { scenarioId } or { payment, context }
 * Re-runs analysis; if the verdict is HOLD or BLOCK, sends the trusted-contact
 * alert (real SMS via Twilio when configured, mock otherwise).
 */
app.post('/api/alert', async (req, res) => {
  try {
    let payment, context;
    if (req.body.scenarioId) {
      const s = demoData.scenarios[req.body.scenarioId];
      if (!s) return res.status(404).json({ error: 'unknown scenario' });
      context = { ...s.context, charityRegistry: demoData.charityRegistry };
      payment = s.payment;
    } else if (req.body.payment) {
      payment = req.body.payment;
      context = { ...(req.body.context || {}), charityRegistry: demoData.charityRegistry };
    } else {
      return res.status(400).json({ error: 'provide scenarioId or payment' });
    }
    const result = await analyze(payment, context);
    if (result.verdict === 'APPROVE') {
      return res.json({ sent: false, verdict: 'APPROVE', reason: 'no alert needed for approved payments' });
    }
    const alert = await sms.sendAlert({
      to: demoData.contact.phone,
      seniorName: demoData.senior.name,
      contactName: demoData.contact.name,
      payment, verdict: result.verdict, score: result.score, signals: result.signals,
    });
    res.json({ sent: !alert.error, verdict: result.verdict, score: result.score, alert });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---- PayPal (REAL sandbox calls) ----
app.get('/api/paypal/status', (req, res) => {
  res.json({
    configured: paypal.credsConfigured(),
    mode: 'sandbox',
    base: 'https://api-m.sandbox.paypal.com',
    hint: paypal.credsConfigured()
      ? 'Sandbox credentials detected.'
      : 'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (developer.paypal.com sandbox app). See README.',
  });
});

app.post('/api/paypal/invoice', async (req, res) => {
  try {
    const { recipientEmail, merchantEmail, amount, currency, note } = req.body;
    if (!recipientEmail || !amount) return res.status(400).json({ error: 'recipientEmail and amount required' });
    const draft = await paypal.createInvoice({
      recipientEmail, merchantEmail: merchantEmail || process.env.PAYPAL_MERCHANT_EMAIL,
      amount, currency: currency || 'CAD', note,
      items: [{ name: 'GuardianPay demo invoice', quantity: '1',
                 unit_amount: { currency_code: currency || 'CAD', value: String(amount) } }],
    });
    const sent = await paypal.sendInvoice(draft.id);
    res.json({ ok: true, invoiceId: draft.id, sent });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/api/paypal/payout', async (req, res) => {
  try {
    const { recipientEmail, amount, currency, note } = req.body;
    if (!recipientEmail || !amount) return res.status(400).json({ error: 'recipientEmail and amount required' });
    const result = await paypal.createPayout({ recipientEmail, amount, currency: currency || 'CAD', note });
    res.json({ ok: true, batch: result });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ---- Webhooks ----
const webhookLog = [];
app.post('/api/webhooks/paypal', async (req, res) => {
  const entry = { at: new Date().toISOString(), event: req.body };
  webhookLog.push(entry);
  console.log('[webhook] PayPal event:', req.body.event_type || '(unknown type)', 'id:', req.body.id);
  // Attempt signature verification when fully configured; never fail the webhook on it in demo.
  try {
    const h = req.headers;
    if (process.env.PAYPAL_WEBHOOK_ID && h['paypal-transmission-id']) {
      const ok = await paypal.verifyWebhookSignature({
        transmissionId: h['paypal-transmission-id'],
        transmissionTime: h['paypal-transmission-time'],
        certUrl: h['paypal-cert-url'],
        authAlgo: h['paypal-auth-algo'],
        transmissionSig: h['paypal-transmission-sig'],
        webhookId: process.env.PAYPAL_WEBHOOK_ID,
        eventBody: req.body,
      });
      entry.verified = ok;
      console.log('[webhook] signature verified:', ok);
    }
  } catch (e) {
    entry.verifyError = e.message;
  }
  res.sendStatus(200);
});
app.get('/api/webhooks/log', (req, res) => res.json(webhookLog.slice(-20)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GuardianPay running at http://localhost:${PORT}`);
  console.log(`PayPal sandbox: ${paypal.credsConfigured() ? 'CONFIGURED' : 'NOT configured — see README'}`);
});
