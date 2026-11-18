// AI Quick Explain helper for ashr.
// Calls Gemini or Grok to generate real-time plain-English risk explanations.
// Falls back gracefully to high-quality simulated breakdowns when keys are missing or offline.
import { loadKeys } from './keys.mjs';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GROK_URL = 'https://api.x.ai/v1/chat/completions';

export function simulateExplanation(ask, provider = 'gemini') {
  const summary = ask?.summary || '';
  const tool = ask?.tool || 'Command';
  const risk = ask?.risk || 'medium';
  const reasons = Array.isArray(ask?.reasons) && ask.reasons.length ? ` Flagged for: ${ask.reasons.join(', ')}.` : '';

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
  return `Executes "${summary}" via ${tool} with ${risk} risk.${reasons} Verify that this command is expected and safe for your system environment before approving.`;
}

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
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error('Empty Gemini response');
  return text;
}

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

export async function requestAiExplanation({ ask, provider = 'gemini', fetchFn = globalThis.fetch, keys = loadKeys() }) {
  const normalizedProvider = provider === 'grok' ? 'grok' : 'gemini';
  const apiKey = normalizedProvider === 'grok' ? keys.grok : keys.gemini;

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
  } catch {
    return {
      explanation: simulateExplanation(ask, normalizedProvider),
      provider: normalizedProvider,
      simulated: true,
    };
  }
}
