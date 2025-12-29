const GROQ_API_URL = process.env.GROQ_API_URL || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

function extractJson(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (e) { return null; }
}

function extractModelText(resp) {
  // Try several common provider response shapes to find the model's textual output
  if (!resp) return null;
  if (resp.text && resp.text.trim()) return resp.text;
  const j = resp.json;
  if (!j) return null;

  // OpenAI-like choices
  if (Array.isArray(j.choices) && j.choices.length > 0) {
    const c = j.choices[0];
    if (c.message && c.message.content) {
      if (typeof c.message.content === 'string') return c.message.content;
      if (Array.isArray(c.message.content)) return c.message.content.map(p => p.text || p).join('\n');
    }
    if (c.text) return c.text;
  }

  // Groq-style 'output' array
  if (Array.isArray(j.output) && j.output.length > 0) {
    try {
      const parts = [];
      for (const item of j.output) {
        if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.text) parts.push(c.text);
            else if (typeof c === 'string') parts.push(c);
          }
        } else if (item.content && item.content.text) parts.push(item.content.text);
      }
      if (parts.length) return parts.join('\n');
    } catch (e) { /* ignore */ }
  }

  // Fallback fields
  if (j.output_text) return j.output_text;
  if (j.response && typeof j.response === 'string') return j.response;
  return null;
}

async function callGroq(prompt) {
  if (!GROQ_API_URL) throw new Error('GROQ_API_URL not set');

  // Use chat-style messages which is commonly supported by Groq endpoints
  const payload = {
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: 'You are a helpful assistant that returns only JSON when asked.' },
      { role: 'user', content: prompt }
    ]
  };

  const headers = { 'Content-Type': 'application/json' };
  if (GROQ_API_KEY) headers['Authorization'] = `Bearer ${GROQ_API_KEY}`;

  const fetchFn = global.fetch || (typeof require === 'function' ? require('node-fetch') : null);
  if (!fetchFn) throw new Error('fetch is not available. Run on Node 18+ or install node-fetch');

  const res = await fetchFn(GROQ_API_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }

  // If status not OK, log json for debugging
  if (res.status >= 400) {
    console.error('Groq HTTP error', res.status, json || text);
  }

  return { status: res.status, text, json };
}

function buildDriverPrompt(context) {
  const { bin, drivers } = context || {};
  const driversList = (drivers || []).map(d => `- id: ${d.id}, name: ${d.name || (d.first_name + ' ' + (d.last_name||''))}, latitude: ${d.latitude}, longitude: ${d.longitude}, active_tasks: ${d.active_tasks}`).join('\n');
  const allowedIds = (drivers || []).map(d => d.id).join(', ');

  return `You are a strict decision engine for assigning one driver to empty a bin.\n\nCONTEXT:\nBin: ${JSON.stringify(bin)}\n\nCANDIDATE DRIVERS:\n${driversList}\n\nREQUIREMENTS:\n- Choose exactly one driver from the candidate list above. Use the driver's exact id value as provided in the list.\n- The returned JSON MUST be the ONLY content in the response (no explanations, no markdown, no code fences).\n- Return EXACTLY this JSON shape:\n  { "driver_id": <one of: ${allowedIds} | null>, "reason": "brief explanation (max 30 words)" }\n- If no suitable driver, set "driver_id" to null and provide a short reason.\n\nEXAMPLE:\n  { "driver_id": ${allowedIds.split(', ')[0] || 'null'}, "reason": "Closest available driver in same society" }\n\nReturn only the JSON object.`;
}

async function getOptimalDriver(context) {
  try {
    const prompt = buildDriverPrompt(context);
    const resp = await callGroq(prompt);

    if (resp.json && resp.json.error) {
      console.error('Groq provider error:', resp.json.error);
      if (resp.json.error.code === 'model_decommissioned') console.error('Model decommissioned — set GROQ_MODEL to a supported model.');
      return null;
    }

    const modelText = extractModelText(resp);
    const parsed = extractJson(modelText) || (resp.json && resp.json.output ? resp.json.output : null);
    if (!parsed) {
      console.warn('Could not parse model JSON output. Raw model text:', modelText || resp.text);
      return null;
    }

    // Validate that returned driver_id matches one of the provided candidate IDs
    const rawId = parsed.driver_id ?? parsed.id ?? null;
    const reason = parsed.reason ?? parsed.explanation ?? null;

    if (rawId === null || typeof rawId === 'undefined') {
      return { driver_id: null, reason };
    }

    // Normalize types and ensure match against context driver ids
    const candidateIds = (context && context.drivers) ? context.drivers.map(d => d.id) : [];
    const matches = candidateIds.some(cid => cid == rawId);
    if (matches) return { driver_id: rawId, reason };

    // Attempt to coerce: check if model text contains any candidate id as substring
    const modelTextLower = (modelText || '').toString();
    for (const cid of candidateIds) {
      if (modelTextLower.includes(String(cid))) {
        console.warn('Model returned non-matching id but candidate id found in model text — accepting:', cid);
        return { driver_id: cid, reason };
      }
    }

    // Attempt to extract digits from returned id (e.g., 'chatcmpl-57' -> 57)
    if (typeof rawId === 'string') {
      const digits = rawId.match(/\d+/g);
      if (digits && digits.length) {
        const numeric = digits.join('');
        for (const cid of candidateIds) {
          if (String(cid) === numeric) {
            console.warn('Extracted numeric id from model output — accepting:', numeric);
            return { driver_id: Number(numeric), reason };
          }
        }
      }
    }

    console.warn('Model returned driver_id that is NOT in candidate list — rejecting. Returned:', rawId, 'Candidates:', candidateIds);
    return null;
  } catch (e) {
    console.error('getOptimalDriver error:', e);
    return null;
  }
}

async function analyzeSentiment(text) {
  try {
    const prompt = `Analyze sentiment for the following text and return JSON: {"sentiment":"positive|neutral|negative","score":<number -1..1>}\nText: '''${text}'''`;
    const resp = await callGroq(prompt);
    const modelText = extractModelText(resp);
    const parsed = extractJson(modelText) || (resp.json && resp.json.output ? resp.json.output : null);
    if (!parsed) {
      console.warn('Could not parse sentiment JSON. Raw model text:', modelText || resp.text);
      return null;
    }
    return parsed;
  } catch (e) {
    console.error('analyzeSentiment error:', e);
    return null;
  }
}

module.exports = { getOptimalDriver, analyzeSentiment };
