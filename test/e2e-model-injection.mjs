// End-to-end usefulness check: prove that an injected RSI lesson changes what a local
// model actually writes, not just what the plugin records.
//
// Requires a reachable OpenAI-compatible local model endpoint (defaults to the DSH
// NINFER local 27B engine). Set RSI_E2E_MODEL_URL / RSI_E2E_MODEL to override.
import assert from 'node:assert/strict';

const baseURL = process.env.RSI_E2E_MODEL_URL || 'http://127.0.0.1:18200/v1/chat/completions';
const model = process.env.RSI_E2E_MODEL || 'qwen3.8-27b';
const userPrompt = 'Write a Python function fetch_json(url) that performs an HTTP GET and returns JSON. Return only code.';

async function chat(system) {
  const res = await fetch(baseURL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.RSI_E2E_API_KEY || 'local'}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`model endpoint returned ${res.status} ${await res.text()}`);
  }
  const payload = await res.json();
  return payload.choices?.[0]?.message?.content || '';
}

const control = await chat('You are a coding assistant.');
const withLesson = await chat(
  'RSI-TEST-42: Always use httpx and never use requests for HTTP calls. This is a trusted lesson from prior use.',
);

console.log('CONTROL (no RSI lesson):');
console.log(control.trim());
console.log('\nWITH RSI LESSON:');
console.log(withLesson.trim());

// Some local 27B builds naturally reach for urllib.request instead of requests,
// so accept either legacy HTTP client here. The important proof is that the
// injected lesson changes the output to httpx and suppresses the legacy client.
assert.match(control, /\brequests\b|\burllib\.request\b/, 'control should use a legacy HTTP client without the lesson');
assert.match(withLesson, /\bhttpx\b/, 'injected lesson should push the model to httpx');
assert.doesNotMatch(withLesson, /import requests|import urllib\.request/, 'with the lesson the model must not fall back to a legacy HTTP client');

console.log('\nOK: the injected lesson changed the model output.');
