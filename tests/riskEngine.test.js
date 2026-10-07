'use strict';
/**
 * GuardianPay regression tests — run with `npm test`.
 * Covers the risk engine's three demo scenarios with their expected verdicts,
 * the alert composer, and the heuristic text analyzer (no network needed).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Ensure no LLM keys leak into tests — heuristic mode only.
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { analyze } = require('../lib/riskEngine');
const { heuristicAnalyze } = require('../lib/textAnalysis');
const { composeAlert, configured: smsConfigured } = require('../lib/sms');

const demoData = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'demo-data.json'), 'utf8')
);

function ctxFor(s) {
  return { ...s.context, charityRegistry: demoData.charityRegistry };
}

test('romance scam scenario → HOLD with high score', async () => {
  const s = demoData.scenarios.romance;
  const r = await analyze(s.payment, ctxFor(s));
  assert.equal(r.verdict, 'HOLD', `expected HOLD, got ${r.verdict} (${r.score})`);
  assert.ok(r.score >= 30 && r.score < 92, `score ${r.score} outside HOLD band`);
  assert.equal(r.holdHours, 24);
  assert.ok(r.signals.length >= 6, 'expected all signals present');
  const ids = r.signals.map((x) => x.id);
  for (const id of ['recipient_history', 'amount_pattern', 'text_analysis', 'relationship_velocity', 'behavioral']) {
    assert.ok(ids.includes(id), `missing signal ${id}`);
  }
});

test('fake charity scenario → HOLD', async () => {
  const s = demoData.scenarios.charity;
  const r = await analyze(s.payment, ctxFor(s));
  assert.equal(r.verdict, 'HOLD', `expected HOLD, got ${r.verdict} (${r.score})`);
  const reg = r.signals.find((x) => x.id === 'charity_registry');
  assert.ok(reg, 'charity_registry signal missing');
  assert.ok(reg.score >= 90, `expected high charity-registry score, got ${reg.score}`);
});

test('legitimate pharmacy payment → APPROVE with low score', async () => {
  const s = demoData.scenarios.legit;
  const r = await analyze(s.payment, ctxFor(s));
  assert.equal(r.verdict, 'APPROVE', `expected APPROVE, got ${r.verdict} (${r.score})`);
  assert.ok(r.score < 30, `score ${r.score} not in APPROVE band`);
  assert.equal(r.holdHours, 0);
});

test('heuristic text analysis flags coercion markers', () => {
  const r = heuristicAnalyze("Pay tonight, don't tell anyone, or you'll be arrested. Urgent!");
  assert.ok(r.score >= 50, `expected high score, got ${r.score}`);
  assert.equal(r.mode, 'heuristic');
  const benign = heuristicAnalyze('Thanks for the lovely dinner on Sunday, see you next week.');
  assert.ok(benign.score < 25, `expected low score, got ${benign.score}`);
});

test('alert composer produces a complete message', () => {
  const body = composeAlert({
    seniorName: 'Margaret', contactName: 'Tom',
    payment: { amount: 900, currency: 'CAD', recipientName: 'David M. Carter' },
    verdict: 'HOLD', score: 90, topSignals: ['Recipient history (90)', 'Relationship velocity (85)'],
  });
  assert.ok(body.includes('Margaret'), 'missing senior name');
  assert.ok(body.includes('$900'), 'missing amount');
  assert.ok(body.includes('David M. Carter'), 'missing recipient');
  assert.ok(body.includes('90/100'), 'missing score');
  assert.ok(body.includes('ON HOLD'), 'missing hold notice');
});

test('sms module reports mock mode without credentials', () => {
  delete process.env.TWILIO_ACCOUNT_SID;
  assert.equal(smsConfigured(), false);
});
