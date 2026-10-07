'use strict';
/**
 * Text coercion-marker analysis.
 *
 * Three modes, tried in order:
 *  - LLM via OpenAI (if OPENAI_API_KEY is set)
 *  - LLM via Anthropic (if ANTHROPIC_API_KEY is set)
 *  - Heuristic (default): fast keyword/regex marker detection. Always available.
 * The response labels which mode was used.
 */

const MARKERS = [
  { id: 'urgency', label: 'Urgency pressure', weight: 3,
    patterns: [/\btonight\b/i, /\bimmediately\b/i, /\bright now\b/i, /\burgent\b/i, /\basap\b/i,
               /\bwithin 24 hours\b/i, /\bbefore midnight\b/i, /\bdon't wait\b/i, /\btime is running out\b/i] },
  { id: 'secrecy', label: 'Secrecy / isolation', weight: 4,
    patterns: [/\bdon'?t tell\b/i, /\bkeep this between us\b/i, /\bconfidential\b/i, /\bdon'?t mention\b/i,
               /\bour secret\b/i, /\bnobody needs to know\b/i] },
  { id: 'authority_threat', label: 'Authority threat', weight: 4,
    patterns: [/\bavoid arrest\b/i, /\blegal action\b/i, /\bwarrant\b/i, /\bCRA\b/i, /\bIRS\b/i,
               /\baccount will be (frozen|suspended)\b/i, /\bfinal notice\b/i] },
  { id: 'affection_grooming', label: 'Affection escalation (grooming)', weight: 2,
    patterns: [/\bmy (dear|darling|sweetheart|love)\b/i, /\bi'?ve never felt this way\b/i,
               /\byou'?re the only one i trust\b/i, /\bmeant to be\b/i, /\bsoulmate\b/i] },
  { id: 'crisis_story', label: 'Sudden crisis story', weight: 3,
    patterns: [/\bhospital\b/i, /\bemergency\b/i, /\baccident\b/i, /\bstranded\b/i, /\bstuck at\b/i,
               /\bneed \$?[\d,]+ (for|to cover)\b/i, /\bdeposit\b/i, /\bmedical bill\b/i] },
  { id: 'money_first_mention', label: 'First-ever money mention', weight: 3,
    patterns: [/\bpay (me|back)\b/i, /\bsend (me )?\$?[\d,]+\b/i, /\bwire\b/i, /\binvoice\b/i,
               /\bpayment request\b/i] },
  { id: 'no_verification', label: 'Avoids verification', weight: 3,
    patterns: [/\bcan'?t (video |face ?time|call)\b/i, /\bcamera'?s broken\b/i, /\bbad connection\b/i,
               /\btrust me\b/i, /\bjust trust\b/i] },
  { id: 'charity_pressure', label: 'Charity / disaster pressure', weight: 3,
    patterns: [/\bdisaster\b/i, /\brelief fund\b/i, /\bvictims\b/i, /\bevery dollar\b/i,
               /\bdonate now\b/i, /\bmatching\b.*\bdonation\b/i] },
];

function heuristicAnalyze(text) {
  const hits = [];
  for (const m of MARKERS) {
    const matched = m.patterns.filter((p) => p.test(text)).map((p) => p.source);
    if (matched.length) hits.push({ id: m.id, label: m.label, weight: m.weight, examples: matched.slice(0, 3) });
  }
  const rawScore = hits.reduce((s, h) => s + h.weight * h.examples.length, 0);
  const score = Math.min(100, Math.round(rawScore * 6));
  return { mode: 'heuristic', score, hits };
}

async function llmAnalyze(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content:
          'You are a fraud-detection analyst. Score the message 0-100 for scam/manipulation likelihood. ' +
          'Return JSON: {"score": number, "tactics": [{"name": string, "evidence": string}], "summary": string}.' },
        { role: 'user', content: text.slice(0, 4000) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM analysis failed: ${res.status}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  return { mode: 'llm-openai', score: parsed.score, hits: parsed.tactics || [], summary: parsed.summary };
}

async function anthropicAnalyze(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
      max_tokens: 500,
      temperature: 0,
      system: 'You are a fraud-detection analyst. Score the message 0-100 for scam/manipulation likelihood. ' +
        'Return ONLY valid JSON: {"score": number, "tactics": [{"name": string, "evidence": string}], "summary": string}.',
      messages: [{ role: 'user', content: text.slice(0, 4000) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic analysis failed: ${res.status}`);
  const data = await res.json();
  const content = (data.content || []).map((b) => b.text || '').join('');
  const parsed = JSON.parse(content);
  return { mode: 'llm-anthropic', score: parsed.score, hits: parsed.tactics || [], summary: parsed.summary };
}

/** Analyze message text; prefers real LLM when a key is configured, else heuristic. */
async function analyzeText(text) {
  if (!text || !text.trim()) return { mode: 'none', score: 0, hits: [] };
  for (const fn of [llmAnalyze, anthropicAnalyze]) {
    try {
      const llm = await fn(text);
      if (llm) return llm;
    } catch (e) {
      console.warn(`[textAnalysis] ${fn.name} failed, trying next:`, e.message);
    }
  }
  return heuristicAnalyze(text);
}

module.exports = { analyzeText, heuristicAnalyze, MARKERS };
