// AI Quick Explain helper for ashr.
// Calls Gemini or Grok to generate real-time plain-English risk explanations.
// Falls back gracefully to high-quality simulated breakdowns when keys are missing or offline.
// Design note: the hub never blocks on an AI provider. Any failure (no key,
// network error, empty reply) falls back to a local canned explanation.
//
// How it fits: routes.apiExplain calls requestAiExplanation() when the user taps "Explain" on
//   the phone (app/ai-explain-ui.js). It reads keys through keys.mjs and returns
//   { explanation, provider, simulated } so the UI can label canned answers.
// Privacy: with a key configured, the tool name, one-line summary, risk, guard reasons and up
//   to 1000 characters of detail are sent to Google (Gemini) or xAI (Grok). With no key,
//   nothing leaves the machine. Do not configure a key if commands may contain secrets.
// Test: test/ai-explain.test.mjs (injected fetch and keys; no network).
import { loadKeys } from './keys.mjs';

// Provider endpoints. The Gemini API key is passed as a query parameter by
// callGemini; Grok uses a Bearer header instead.
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GROK_URL = 'https://api.x.ai/v1/chat/completions';

// Offline explanation: pattern-match the ask summary against well-known risky
// commands and return a canned plain-English description. `provider` is
// accepted for API symmetry with the real path but is not used.
/**
 * @param {{summary?: string, tool?: string, risk?: string, reasons?: string[]}} ask
 * @param {string} [provider='gemini'] - ignored.
 * @returns {string} 1-3 sentences of plain English; never empty.
 */
export function simulateExplanation(ask, provider = 'gemini') {
  const summary = ask?.summary || '';
  const tool = ask?.tool || 'Command';
  const risk = ask?.risk || 'medium';
  // Suffix appended to every explanation when the guard supplied reasons.
  const reasons = Array.isArray(ask?.reasons) && ask.reasons.length ? ` Flagged for: ${ask.reasons.join(', ')}.` : '';

  // Rules run in order; the first match wins, so more dangerous patterns come first.
  if (/\.env\b/i.test(summary) || /printenv|export/i.test(summary) || /secret/i.test(summary)) {
    return `Reads or prints secret environment variables (.env / credentials). Exposing these secrets risks leaking API keys, database credentials, or tokens to logs or unauthorized services.${reasons}`;
  }
  if (/rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)/i.test(summary)) {
    return `Permanently deletes directories and files recursively without moving to trash. Files removed by this command cannot be undone or recovered.${reasons}`;
  }
  if (/npm\s+(i|install|add)|pip\s+install|cargo\s+install/i.test(summary)) {
    return `Downloads and installs third-party code from public package repositories. External packages may run arbitrary post-install scripts or introduce supply-chain vulnerabilities.${reasons}`;
  }
  if (/git\s+push/i.test(summary)) {
    return `Publishes local repository branches and commits to a remote server. Anyone with access to the remote repository will immediately see these code changes.${reasons}`;
  }
  if (/docker\s+run/i.test(summary)) {
    return `Launches a containerized environment. If privileged or mounting host directories, container processes could gain host system access.${reasons}`;
  }
  // Generic fallback when nothing above matched.
  return `Executes "${summary}" via ${tool} with ${risk} risk.${reasons} Verify that this command is expected and safe for your system environment before approving.`;
}

// Build the LLM prompt. Detail is truncated to 1000 chars to bound request
// size and keep long command bodies from leaking in full to a third party.
/**
 * @param {object} ask - same shape as simulateExplanation.
 * @returns {string} the full prompt text sent to the provider.
 */
function buildPrompt(ask) {
  const tool = ask?.tool || 'Bash';
  const summary = ask?.summary || 'command';
  const risk = ask?.risk || 'unknown';
  const reasons = Array.isArray(ask?.reasons) ? ask.reasons.join(', ') : (ask?.reasons || '');
  const detail = ask?.detail && ask.detail !== summary ? `\nDetail: ${ask.detail.slice(0, 1000)}` : '';
  return `You are a security assistant explaining a command or action requested by an AI coding agent to a developer on their phone.
Tool: ${tool}
Command/Action: ${summary}${detail}
Risk level: ${risk}${reasons ? `\nFlags: ${reasons}` : ''}

In 2-3 concise, plain-English sentences, explain:
1. Exactly what this command will do on the laptop or repository.
2. The primary risk or why it was flagged.
Do not use markdown formatting. Keep it readable and direct.`;
}

// POST to Gemini generateContent; returns the first candidate's text or throws.
// `fetchFn` is injectable so tests never touch the network.
/**
 * @param {{prompt: string, apiKey: string, fetchFn: typeof fetch}} args
 * @returns {Promise<string>} explanation text.
 * @throws {Error} on non-2xx status, timeout (8 s) or an empty candidate list.
 */
async function callGemini({ prompt, apiKey, fetchFn }) {
  const url = `${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
  };
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // 8 s timeout: the phone is waiting on this, so fail fast and use the fallback.
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error('Empty Gemini response');
  return text;
}

// POST to xAI's OpenAI-style chat endpoint; returns the reply text or throws.
/**
 * @param {{prompt: string, apiKey: string, fetchFn: typeof fetch}} args
 * @returns {Promise<string>} explanation text.
 * @throws {Error} on non-2xx status, timeout (8 s) or an empty reply.
 */
async function callGrok({ prompt, apiKey, fetchFn }) {
  const body = {
    model: 'grok-2-latest',
    messages: [
      {
        role: 'system',
        content: 'You are a cybersecurity expert explaining terminal commands to a developer on their mobile phone. Keep explanations concise, plain-English, and high-impact.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
  };
  const res = await fetchFn(GROK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Grok HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty Grok response');
  return text;
}

// Public entry point. Returns { explanation, provider, simulated }; `simulated`
// is true when the text came from the local fallback rather than an LLM.
/**
 * @param {object} args
 * @param {object} args.ask - the ask to explain.
 * @param {'gemini'|'grok'} [args.provider='gemini']
 * @param {typeof fetch} [args.fetchFn] - injectable for tests.
 * @param {object} [args.keys] - provider keys; defaults to loadKeys() (evaluated per call).
 * @returns {Promise<{explanation: string, provider: string, simulated: boolean}>} never rejects.
 */
export async function requestAiExplanation({ ask, provider = 'gemini', fetchFn = globalThis.fetch, keys = loadKeys() }) {
  // Anything other than 'grok' means Gemini.
  const normalizedProvider = provider === 'grok' ? 'grok' : 'gemini';
  const apiKey = normalizedProvider === 'grok' ? keys.grok : keys.gemini;

  // No key configured: stay fully offline.
  if (!apiKey) {
    return {
      explanation: simulateExplanation(ask, normalizedProvider),
      provider: normalizedProvider,
      simulated: true,
    };
  }

  const prompt = buildPrompt(ask);
  try {
    const explanation = normalizedProvider === 'grok'
      ? await callGrok({ prompt, apiKey, fetchFn })
      : await callGemini({ prompt, apiKey, fetchFn });

    return {
      explanation,
      provider: normalizedProvider,
      simulated: false,
    };
  // Deliberately swallow the error detail (it could contain the key-bearing URL) and fall back.
  } catch {
    return {
      explanation: simulateExplanation(ask, normalizedProvider),
      provider: normalizedProvider,
      simulated: true,
    };
  }
}
