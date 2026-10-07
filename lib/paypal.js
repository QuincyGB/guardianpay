'use strict';
/**
 * PayPal sandbox REST client — REAL API calls, no mocks.
 * Requires env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (from developer.paypal.com sandbox app).
 * Base: https://api-m.sandbox.paypal.com
 */

const BASE = process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';

function credsConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

async function getAccessToken() {
  if (!credsConfigured()) {
    throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set — see README for sandbox setup.');
  }
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal token failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function api(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`PayPal ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

/** Create a draft invoice (e.g. the scammer's invoice to Margaret). */
async function createInvoice({ recipientEmail, merchantEmail, amount, currency = 'CAD', items, note, invoiceNumber }) {
  const body = {
    detail: {
      invoice_number: invoiceNumber || `GP-${Date.now()}`,
      currency_code: currency,
      note: note || '',
    },
    primary_recipients: [{ billing_info: { email: recipientEmail } }],
    items: items || [{ name: 'Payment request', quantity: '1', unit_amount: { currency_code: currency, value: String(amount) } }],
  };
  if (merchantEmail) body.invoicer = { email_address: merchantEmail };
  return api('POST', '/v2/invoicing/invoices', body);
}

/** Send a draft invoice to the recipient. */
async function sendInvoice(invoiceId) {
  return api('POST', `/v2/invoicing/invoices/${invoiceId}/send`, { send_to_recipient: true });
}

/** Create a payout (used for the legitimate pharmacy payment path). */
async function createPayout({ recipientEmail, amount, currency = 'CAD', note }) {
  return api('POST', '/v1/payments/payouts', {
    sender_batch_header: {
      sender_batch_id: `GP-${Date.now()}`,
      email_subject: 'GuardianPay payment',
    },
    items: [{
      recipient_type: 'EMAIL',
      amount: { value: String(amount), currency },
      receiver: recipientEmail,
      note: note || '',
      sender_item_id: `item-${Date.now()}`,
    }],
  });
}

/**
 * Webhook signature verification.
 * Production: verify using PayPal's /v1/notifications/verify-webhook-signature endpoint
 * with the transmission headers + webhook id. This helper performs that call.
 */
async function verifyWebhookSignature({ transmissionId, transmissionTime, certUrl, authAlgo, transmissionSig, webhookId, eventBody }) {
  const data = await api('POST', '/v1/notifications/verify-webhook-signature', {
    transmission_id: transmissionId,
    transmission_time: transmissionTime,
    cert_url: certUrl,
    auth_algo: authAlgo,
    transmission_sig: transmissionSig,
    webhook_id: webhookId,
    webhook_event: eventBody,
  });
  return data.verification_status === 'SUCCESS';
}

module.exports = {
  credsConfigured,
  getAccessToken,
  createInvoice,
  sendInvoice,
  createPayout,
  verifyWebhookSignature,
};
