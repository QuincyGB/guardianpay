'use strict';
/**
 * GuardianPay trusted-contact alerts via Twilio SMS.
 *
 * Two modes:
 *  - REAL: when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER
 *    are all set, sendAlert() delivers a genuine SMS through Twilio.
 *  - MOCK (default): no credentials — returns the composed message so the
 *    demo UI can display it. Nothing leaves the machine.
 *
 * The UI labels which mode is active (GET /api/sms/status).
 */

function configured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER
  );
}

/** Compose the trusted-contact alert text. Shared by both modes. */
function composeAlert({ seniorName, contactName, payment, verdict, score, topSignals }) {
  const lines = [
    `🛡️ GuardianPay alert for ${contactName}:`,
    `${seniorName} just tried to pay $${payment.amount} ${payment.currency || 'CAD'} to ${payment.recipientName}.`,
    verdict === 'HOLD'
      ? `Flagged as a likely scam (risk ${score}/100). Payment is ON HOLD for 24h — nothing has left the account.`
      : `BLOCKED as conclusive fraud (risk ${score}/100). No money moved.`,
    `Top signals: ${topSignals.join(' · ')}`,
    `Reply RELEASE if legitimate, or review the evidence together.`,
  ];
  return lines.join('\n');
}

/**
 * Send the alert. Returns { mode: 'real'|'mock', sid?, to, body, error? }.
 * Never throws — a Twilio failure degrades to a reported error, not a crash.
 */
async function sendAlert({ to, seniorName, contactName, payment, verdict, score, signals }) {
  const topSignals = [...signals]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => `${s.name} (${s.score})`);
  const body = composeAlert({ seniorName, contactName, payment, verdict, score, topSignals });

  if (!configured()) {
    return { mode: 'mock', to, body, note: 'Twilio not configured — demo UI mock. Set TWILIO_* env vars for real SMS.' };
  }
  try {
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const msg = await client.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to,
      body,
    });
    return { mode: 'real', sid: msg.sid, to, body };
  } catch (e) {
    return { mode: 'real', to, body, error: `Twilio send failed: ${e.message}` };
  }
}

module.exports = { configured, composeAlert, sendAlert };
