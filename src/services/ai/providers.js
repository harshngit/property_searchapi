const Anthropic = require('@anthropic-ai/sdk');

// The two AI providers behind one call shape (contract: a vendor-agnostic
// interface, so a failing provider can be swapped without touching callers).
//
//   generate({ provider, model, effort, maxTokens, system, parts, schema })
//     parts  [{ type: 'text', text }, { type: 'image', mediaType, data }, { type: 'pdf', data }]
//            (data = base64)
//     schema optional JSON schema: the reply is returned parsed as `json`
//   -> { text, json, inputTokens, outputTokens, model }
//
// Claude: the official Anthropic SDK. Opus / Sonnet 5.5 requests carry the
// server-side refusal fallback (`fallbacks: "default"`), and a refusal is
// thrown so the orchestrator can try the other provider.
// OpenAI: the Responses REST API (no SDK dependency).

class ProviderError extends Error {
  constructor(message, { provider, retryable = true, refusal = false } = {}) {
    super(message);
    this.provider = provider;
    this.retryable = retryable;
    this.refusal = refusal;
  }
}

// Test mode (never in production): AI_PROVIDER_MOCK=true answers locally with a
// schema-shaped reply, so tests and demos spend nothing. A prompt containing
// "[fail-openai]" / "[fail-claude]" makes that provider fail (fallback tests).
const mock = () => process.env.NODE_ENV !== 'production' && process.env.AI_PROVIDER_MOCK === 'true';
const configured = (provider) => mock() || (provider === 'claude' ? !!process.env.ANTHROPIC_API_KEY : !!process.env.OPENAI_API_KEY);

function sample(schema) {
  if (!schema) return null;
  if (schema.anyOf) return sample(schema.anyOf.find((x) => x.type !== 'null') || schema.anyOf[0]);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (schema.enum) return schema.enum[0];
  if (type === 'object') return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, sample(v)]));
  if (type === 'array') return [sample(schema.items)];
  // Numbers are neutral (0 or the minimum), so test-mode answers never flag or score anything.
  if (type === 'integer' || type === 'number') return schema.minimum ?? 0;
  if (type === 'boolean') return false;
  return 'mock';
}

function mockGenerate({ provider, model, parts, schema }) {
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  if (text.includes(`[fail-${provider}]`)) throw new ProviderError(`${provider}: simulated failure`, { provider });
  const json = sample(schema);
  return { text: json ? JSON.stringify(json) : `mock reply from ${model}`, json, inputTokens: Math.ceil(text.length / 4) + 10, outputTokens: 50, model };
}

// ---------------------------------------------------------------- Claude

let anthropic = null;
const claudeClient = () => {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
};
// Models that take the server-side refusal fallback (not Haiku 5.5, which has none).
const CLAUDE_FALLBACK_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-1'];

async function claude({ model, effort, maxTokens, system, parts, schema }) {
  const content = parts.map((p) => {
    if (p.type === 'image') return { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } };
    if (p.type === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } };
    return { type: 'text', text: p.text };
  });
  const withFallback = CLAUDE_FALLBACK_MODELS.includes(model);
  const body = {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
    ...(withFallback ? { fallbacks: 'default' } : {}),
    messages: [{ role: 'user', content }],
  };
  let response;
  try {
    response = await claudeClient().messages.create(body, withFallback ? { headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' } } : undefined);
  } catch (err) {
    const status = err instanceof Anthropic.APIError ? err.status : null;
    // 400 / 401 / 403 / 404: the request itself is wrong - the other provider is still worth a try.
    throw new ProviderError(`Claude: ${err.message}`, { provider: 'claude', retryable: true, status });
  }
  // Check the stop reason before reading the content (a refusal may come back empty).
  if (response.stop_reason === 'refusal') throw new ProviderError(`Claude declined${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}`, { provider: 'claude', refusal: true });
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (response.stop_reason === 'max_tokens' && schema) throw new ProviderError('Claude: reply cut off at the output limit', { provider: 'claude' });
  return {
    text,
    json: schema ? parseJson(text, 'claude') : null,
    inputTokens: (response.usage?.input_tokens || 0) + (response.usage?.cache_read_input_tokens || 0) + (response.usage?.cache_creation_input_tokens || 0),
    outputTokens: response.usage?.output_tokens || 0,
    model: response.model || model,
  };
}

// ---------------------------------------------------------------- OpenAI

// Strict structured outputs need every property required and no extra keys;
// schemas that are not written that way are sent non-strict.
function strictCompatible(s) {
  if (!s || typeof s !== 'object') return true;
  if (s.type === 'object' || s.properties) {
    const keys = Object.keys(s.properties || {});
    if (s.additionalProperties !== false) return false;
    if (keys.some((k) => !(s.required || []).includes(k))) return false;
    return keys.every((k) => strictCompatible(s.properties[k]));
  }
  if (s.items) return strictCompatible(s.items);
  if (s.anyOf) return s.anyOf.every(strictCompatible);
  return true;
}

async function openai({ model, maxTokens, system, parts, schema }) {
  const content = parts.map((p) => {
    if (p.type === 'image') return { type: 'input_image', image_url: `data:${p.mediaType};base64,${p.data}` };
    if (p.type === 'pdf') return { type: 'input_file', filename: 'document.pdf', file_data: `data:application/pdf;base64,${p.data}` };
    return { type: 'input_text', text: p.text };
  });
  const body = {
    model,
    max_output_tokens: maxTokens,
    ...(system ? { instructions: system } : {}),
    input: [{ role: 'user', content }],
    ...(schema ? { text: { format: { type: 'json_schema', name: 'result', schema, strict: strictCompatible(schema) } } } : {}),
  };
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    throw new ProviderError(`OpenAI: ${err.message}`, { provider: 'openai' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new ProviderError(`OpenAI: ${data?.error?.message || `HTTP ${res.status}`}`, { provider: 'openai' });
  const items = (data.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []);
  const refusal = items.find((c) => c.type === 'refusal');
  if (refusal) throw new ProviderError(`OpenAI declined: ${String(refusal.refusal || '').slice(0, 120)}`, { provider: 'openai', refusal: true });
  if (data.status === 'incomplete' && schema) throw new ProviderError(`OpenAI: reply incomplete (${data.incomplete_details?.reason || 'unknown'})`, { provider: 'openai' });
  const text = typeof data.output_text === 'string' ? data.output_text : items.filter((c) => c.type === 'output_text').map((c) => c.text).join('');
  return {
    text,
    json: schema ? parseJson(text, 'openai') : null,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
    model: data.model || model,
  };
}

function parseJson(text, provider) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`${provider}: reply was not valid JSON`, { provider });
  }
}

async function generate(req) {
  if (mock()) return mockGenerate(req);
  if (!configured(req.provider)) throw new ProviderError(`${req.provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} is not set`, { provider: req.provider });
  return req.provider === 'claude' ? claude(req) : openai(req);
}

module.exports = { generate, configured, ProviderError, strictCompatible };
