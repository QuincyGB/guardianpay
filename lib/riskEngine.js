'use strict';
/**
 * GuardianPay AI risk engine.
 *
 * analyze(payment, context) -> { score, verdict, signals[], summary, recommendedAction }
 * Verdicts: APPROVE (score < 30) | HOLD (30–91) | BLOCK (>= 92)
 * HOLD = pause 24h + alert trusted contact. BLOCK is reserved for conclusive-fraud
 * patterns (e.g. recipient on a known-fraud list) — the demo scenarios land on HOLD
 * by design, because the product story is "protection without taking away independence".
 *
 * Each signal: { id, name, score 0-100, weight, finding (plain language), detail, simulated? }
 */

const { analyzeText } = require('./textAnalysis');

const WEIGHTS = {
  recipient_history: 0.20,
  amount_pattern: 0.15,
  text_analysis: 0.20,
  relationship_velocity: 0.15,
  image_check: 0.10,
  charity_registry: 0.10,
  behavioral: 0.10,
};

/** 1. Recipient history — new payee? young account? name variants? */
function signalRecipientHistory(payment, ctx) {
  const known = (ctx.knownPayees || []).find(
    (p) => p.email.toLowerCase() === payment.recipientEmail.toLowerCase()
  );
  if (known) {
    return {
      id: 'recipient_history', name: 'Recipient history', score: 5, weight: WEIGHTS.recipient_history,
      finding: `${payment.recipientName} is a known payee — ${known.paymentsCount} payments over ${known.relationshipMonths} months, no disputes.`,
      detail: known,
    };
  }
  let score = 70;
  const notes = ['First-ever payment to this recipient.'];
  const age = payment.recipientAccountAgeDays;
  if (typeof age === 'number') {
    if (age < 30) { score = Math.min(100, score + 20); notes.push(`Recipient PayPal account is only ${age} days old.`); }
    else if (age < 180) { score = Math.min(100, score + 10); notes.push(`Recipient account is ${age} days old (under 6 months).`); }
  }
  if (payment.nameVariantMismatch) {
    score = Math.min(100, score + 10);
    notes.push('Name on the account differs from the name the senior knows them by.');
  }
  return {
    id: 'recipient_history', name: 'Recipient history', score, weight: WEIGHTS.recipient_history,
    finding: notes.join(' '), detail: { recipientAccountAgeDays: age ?? 'unknown' },
  };
}

/** 2. Amount vs. the senior's historical pattern. */
function signalAmountPattern(payment, ctx) {
  const avg = ctx.avgPaymentAmount || 50;
  const ratio = payment.amount / Math.max(avg, 1);
  let score = 0;
  const notes = [];
  if (ratio >= 10) { score = 85; notes.push(`$${payment.amount} is ${ratio.toFixed(0)}× her usual payment of ~$${avg}.`); }
  else if (ratio >= 4) { score = 60; notes.push(`$${payment.amount} is ${ratio.toFixed(1)}× her usual payment of ~$${avg}.`); }
  else if (ratio >= 2) { score = 30; notes.push(`$${payment.amount} is above her usual ~$${avg}.`); }
  else { score = 5; notes.push(`$${payment.amount} is within her normal range (~$${avg}).`); }
  return {
    id: 'amount_pattern', name: 'Amount vs. her pattern', score, weight: WEIGHTS.amount_pattern,
    finding: notes.join(' '), detail: { amount: payment.amount, avgPaymentAmount: avg, ratio: +ratio.toFixed(2) },
  };
}

/** 3. Message / memo text analysis (real LLM when key present, else heuristic). */
async function signalTextAnalysis(payment) {
  const text = [payment.memo, payment.invoiceNote, ...(payment.messageHistory || [])].filter(Boolean).join('\n');
  const result = await analyzeText(text);
  const tactics = (result.hits || []).map((h) => h.label || h.name).filter(Boolean);
  return {
    id: 'text_analysis', name: 'Message analysis', score: result.score, weight: WEIGHTS.text_analysis,
    finding: result.score >= 60
      ? `Detected manipulation tactics: ${tactics.join('; ') || 'coercive language'}.`
      : result.score >= 25
        ? `Some pressuring language detected: ${tactics.join('; ') || 'mild markers'}.`
        : 'No coercion markers in the messages.',
    detail: { mode: result.mode, tactics: result.hits, summary: result.summary },
  };
}

/** 4. Relationship velocity — grooming curve: long warm-up, sudden first money ask. */
function signalRelationshipVelocity(payment, ctx) {
  const rel = ctx.relationship || {};
  const firstPayment = !((ctx.knownPayees || []).some(
    (p) => p.email.toLowerCase() === payment.recipientEmail.toLowerCase()
  ));
  if (!firstPayment) {
    return { id: 'relationship_velocity', name: 'Relationship velocity', score: 5, weight: WEIGHTS.relationship_velocity,
      finding: 'Established payment relationship — no velocity anomaly.', detail: {} };
  }
  const monthsKnown = rel.monthsKnown || 0;
  const priorMoneyMentions = rel.priorMoneyMentions || 0;
  let score = 40; // first payment to anyone carries baseline caution
  const notes = ['First payment to this person.'];
  if (monthsKnown >= 2 && priorMoneyMentions === 0 && payment.amount >= 200) {
    score = 85;
    notes.push(`Known ${monthsKnown} months with zero prior money mentions — then a first ask of $${payment.amount}. Classic grooming curve.`);
  } else if (monthsKnown >= 1 && priorMoneyMentions === 0) {
    score = 65;
    notes.push(`Known ${monthsKnown} month(s), money never mentioned before tonight.`);
  }
  if (rel.neverVideoCalled) { score = Math.min(100, score + 8); notes.push('They have never video-called — always an excuse.'); }
  return {
    id: 'relationship_velocity', name: 'Relationship velocity', score,
    weight: WEIGHTS.relationship_velocity, finding: notes.join(' '),
    detail: { monthsKnown, priorMoneyMentions, firstPayment },
  };
}

/** 5. Profile-photo reverse-image lookup — SIMULATED in the MVP. */
function signalImageCheck(payment) {
  // SIMULATED: production would call TinEye / Google Lens API here.
  const flagged = Boolean(payment.photoFlaggedAsStock);
  return {
    id: 'image_check', name: 'Profile photo check', score: flagged ? 90 : 5,
    weight: WEIGHTS.image_check, simulated: true,
    finding: flagged
      ? 'SIMULATED reverse-image lookup: this profile photo appears on a stock-photo website — not a real photo of this person.'
      : 'SIMULATED reverse-image lookup: no matches on stock-photo sites.',
    detail: { simulated: true, note: 'Production: TinEye/Google Lens API. Demo uses fixture data.' },
  };
}

/** 6. Charity registry cross-check (charity scenario only). */
function signalCharityRegistry(payment, ctx) {
  if (!payment.claimedCharity) return null;
  const registry = ctx.charityRegistry || [];
  const found = registry.find((c) => c.name.toLowerCase() === payment.claimedCharity.toLowerCase());
  if (found) {
    return { id: 'charity_registry', name: 'Charity registry check', score: 5, weight: WEIGHTS.charity_registry,
      finding: `${payment.claimedCharity} is a registered charity (#${found.regNo}).`, detail: found };
  }
  return { id: 'charity_registry', name: 'Charity registry check', score: 95, weight: WEIGHTS.charity_registry,
    finding: `${payment.claimedCharity} does NOT appear in the charity registry — likely a fictitious organization.`,
    detail: { searched: payment.claimedCharity, registrySize: registry.length } };
}

/** 7. Behavioral — time of day vs. her habits. */
function signalBehavioral(payment, ctx) {
  const hour = payment.hourOfDay ?? new Date().getHours();
  const usual = ctx.usualHours || { start: 8, end: 20 };
  const inWindow = hour >= usual.start && hour <= usual.end;
  return {
    id: 'behavioral', name: 'Behavioral pattern', score: inWindow ? 5 : 55,
    weight: WEIGHTS.behavioral,
    finding: inWindow
      ? `Sent at ${hour}:00 — inside her usual ${usual.start}:00–${usual.end}:00 window.`
      : `Sent at ${hour}:00 — she has never sent a payment outside ${usual.start}:00–${usual.end}:00.`,
    detail: { hourOfDay: hour, usualHours: usual },
  };
}

async function analyze(payment, ctx = {}) {
  const signals = [
    signalRecipientHistory(payment, ctx),
    signalAmountPattern(payment, ctx),
    await signalTextAnalysis(payment),
    signalRelationshipVelocity(payment, ctx),
    signalImageCheck(payment),
    signalCharityRegistry(payment, ctx),
    signalBehavioral(payment, ctx),
  ].filter(Boolean);

  const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
  const score = Math.round(signals.reduce((s, x) => s + x.score * x.weight, 0) / totalWeight);
  const verdict = score >= 92 ? 'BLOCK' : score >= 30 ? 'HOLD' : 'APPROVE';

  const top = [...signals].sort((a, b) => b.score - a.score).slice(0, 3);
  const summary = verdict === 'APPROVE'
    ? 'This payment looks normal — it matches her history, habits, and contacts.'
    : `This payment shows ${top.length} strong risk signals (${top.map((t) => t.name.toLowerCase()).join(', ')}). ` +
      (verdict === 'HOLD'
        ? 'GuardianPay will hold it for 24 hours and notify her trusted contact before any money moves.'
        : 'GuardianPay will block this payment — the fraud pattern is conclusive.');

  return {
    score, verdict, signals, summary,
    recommendedAction: verdict === 'APPROVE' ? 'Release payment normally.'
      : verdict === 'HOLD' ? 'Hold 24h, alert trusted contact with the evidence, let the senior + contact decide.'
      : 'Block payment and report the recipient account.',
    holdHours: verdict === 'HOLD' ? 24 : 0,
  };
}

module.exports = { analyze, WEIGHTS };
