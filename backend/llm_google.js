/**
 * Google Gemini as an alternative planner, for BENCHMARKING ONLY.
 *
 * WHAT THIS COSTS, STATED PLAINLY. Every other model call in this project runs
 * on the machine, and the "no cloud APIs" rule exists so that a user's question
 * and the attributes retrieved for it never leave it. This path breaks that:
 * the question, the candidate attribute list, and the whole system prompt are
 * sent to Google. That is a change in what the product IS, not a configuration
 * detail, which is why it is:
 *
 *   - off unless GOOGLE_API_KEY is set AND LLM_PROVIDER=google,
 *   - never the default, and
 *   - reported by /api/health so a running instance cannot be quietly remote.
 *
 * WHY IT IS WORTH MEASURING ANYWAY. The local planner is the bottleneck:
 * retrieval is ~0.7s and planning is 15-200s, and the held-out suite measured a
 * 43s mean with a 216s worst case. Whether a hosted model is meaningfully
 * faster, and whether it plans BETTER, is a real question -- and this project's
 * standing rule is to measure rather than assume. The answer might be that the
 * latency is worth the privacy cost, or that it is not; either way the existing
 * instruments (eval/plan_probe.py, eval/wild_probe.py) can now be pointed at
 * both arms of the comparison.
 *
 * SCHEMA-CONSTRAINED DECODING IS NOT OPTIONAL. The whole design rests on the
 * model being unable to emit an invalid plan. Gemini supports this through
 * responseSchema, but its dialect is a SUBSET of the JSON Schema Ollama takes,
 * so the schema has to be translated rather than passed through -- see
 * toGeminiSchema. A silent translation failure would drop the constraint and
 * put us back to regex-extracting JSON out of prose, which is the failure mode
 * schemas.js was written to end.
 */

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Translate a JSON Schema into the subset Gemini accepts.
 *
 * Differences that matter here:
 *   - `additionalProperties` is not supported and is rejected outright.
 *   - Gemini honours `propertyOrdering`; without it the field order is
 *     unspecified, and this project treats decoder-visible order as behavior.
 *   - `type` must be a single string, never a union.
 *   - Unknown keywords are rejected rather than ignored, so the translation is
 *     an allow-list: anything not named here is dropped.
 */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;

  const out = {};
  if (schema.type) out.type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum.map(String);

  if (schema.type === "object" && schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = toGeminiSchema(v);
    }
    // Field order is part of what the model sees; keep the authored order.
    out.propertyOrdering = Object.keys(schema.properties);
    if (Array.isArray(schema.required) && schema.required.length) {
      out.required = [...schema.required];
    }
  }

  if (schema.type === "array" && schema.items) {
    out.items = toGeminiSchema(schema.items);
  }

  // `additionalProperties`, `$schema`, `title`, `default` and friends are
  // deliberately not copied: Gemini rejects the request rather than ignoring
  // them, and a 400 here reads as "the model failed" unless you know.
  return out;
}

/**
 * One completion, shaped like the Ollama path's return value: the raw text, or
 * null on any failure. Callers already treat null as "the model did not answer"
 * and fall through to the repair loop, so failures stay on one path.
 */
async function callGoogle({
  systemPrompt, userPrompt, temperature = 0.2, schema = null,
  model = process.env.GOOGLE_MODEL || "gemini-3.8-flash",
  apiKey = process.env.GOOGLE_API_KEY,
  timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 90000),
  log = console.log,
}) {
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set");

  const body = {
    // The system prompt goes in systemInstruction, not as a turn. Sent as a
    // user turn it competes with the question for attention, and this project
    // has already been bitten once by a prompt the planner never really read.
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt || systemPrompt }] }],
    generationConfig: {
      temperature,
      ...(schema
        ? { responseMimeType: "application/json", responseSchema: toGeminiSchema(schema) }
        : {}),
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${API_ROOT}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      // The body carries the real reason -- usually a schema the translation
      // above did not clean -- and swallowing it makes this undiagnosable.
      const detail = (await res.text()).slice(0, 400);
      throw new Error(`Google returned ${res.status}: ${detail}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    log(`   Google ${model}: ${text.length} chars in ${Date.now() - started}ms`);
    return text;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Google did not respond within ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether the remote arm is configured at all. */
const googleConfigured = () => Boolean(process.env.GOOGLE_API_KEY);

module.exports = { callGoogle, toGeminiSchema, googleConfigured };
