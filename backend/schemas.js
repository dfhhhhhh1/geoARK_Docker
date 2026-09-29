/**
 * JSON Schemas for schema-constrained LLM decoding.
 *
 * Ollama accepts a JSON Schema as the `format` field and constrains token
 * sampling to it, which makes invalid output *unrepresentable* rather than
 * merely discouraged. That replaces the previous approach, asking politely for
 * JSON in the prompt, then digging it back out with
 * `response.match(/\{[\s\S]*\}/)` and hoping.
 *
 * That approach failed whenever a small local model emitted a preamble, a
 * trailing comma, two JSON objects, a markdown fence, or `<think>` tags (which
 * deepseek-r1 does by default). Every one of those failures took down a whole
 * request.
 *
 * Keep these schemas strict. `additionalProperties: false` plus a full
 * `required` list is what stops a model inventing fields, and the constrained
 * decoder enforces it for free.
 */

// Query decomposition: split a question into searchable concepts.
// The plan schema is assembled from the op registry: every op declares its own
// narrowing predicate, and both this file and the prompt builder read that same
// declaration, so the enum and the prompt cannot drift apart.
const ops_ = require("./planner/ops");

const DECOMPOSITION_SCHEMA = {
  type: "object",
  properties: {
    primary_concepts: {
      type: "array",
      items: { type: "string" },
      description: "The main data variables the user is asking for"
    },
    normalization_concepts: {
      type: "array",
      items: { type: "string" },
      description: "Denominators for rates and per-capita figures, e.g. population"
    },
    filter_concepts: {
      type: "array",
      items: { type: "string" },
      description: "Qualifiers such as rural, urban, high, low"
    },
    geographic_level: {
      type: "string",
      enum: ["COUNTY", "STATE", "TRACT", "BLOCKGROUP", "BLOCK", "UNKNOWN"]
    },
    search_queries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          query: { type: "string" },
          purpose: {
            type: "string",
            enum: ["primary", "normalization", "filter", "related"]
          }
        },
        required: ["query", "purpose"],
        additionalProperties: false
      }
    }
  },
  required: [
    "primary_concepts", "normalization_concepts", "filter_concepts",
    "geographic_level", "search_queries"
  ],
  additionalProperties: false
};

// Result verification. Retained for the opt-in `use_llm_filter` path.
const VERIFICATION_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    keep_ids: { type: "array", items: { type: "string" } }
  },
  required: ["reasoning", "keep_ids"],
  additionalProperties: false
};

/**
 * Analysis plan. The closed operation vocabulary is the point: a small model
 * uses a handful of known ops far more reliably than an open-ended DSL, and a
 * closed set is what makes a deterministic SQL compiler possible.
 *
 * Note what is NOT here: no table names, no column names, no SQL. Steps refer
 * to attributes by `attr_id`, and every one is checked against
 * attribute_source before the plan is allowed to run. The model may only cite
 * identifiers a tool actually returned to it.
 *
 * The op list and the step fields both come from the registry
 * (planner/ops/index.js), so an op cannot appear here without also bringing its
 * validation, its compilation and its prompt text.
 */
function buildPlanSchema(ops, ctx = {}) {
  const properties = {};
  for (const [name, def] of Object.entries(ops_.STEP_FIELDS)) {
    if (name === "op") {
      properties.op = { type: "string", enum: ops };
      continue;
    }
    // Field-level narrowing, from the registry's gates. A field the model
    // cannot use correctly is a field it should not be shown.
    if (!ops_.fieldOffered(name, ctx)) continue;
    properties[name] = def;
  }

  return {
    type: "object",
    properties: {
      intent: {
        type: "string",
        description: "One sentence restating what the user asked for"
      },
      output_type: {
        type: "string",
        enum: ["map", "table", "chart", "statistics"]
      },
      entity_type: {
        type: "string",
        enum: ["COUNTY", "STATE"]
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties,
          // "inputs" is required on purpose: constrained decoding lets a model
          // omit optional fields, and a 4B model omits this one every time --
          // producing steps with no wiring that then fail arity validation.
          // attr_id is required for the same reason as inputs: the decoder
          // drops optional fields. JSON Schema cannot express "required only
          // when op=load" in a form Ollama's constrained decoder handles
          // reliably, so it is required everywhere and non-load steps pass "".
          // The validator treats "" as absent, and only checks it for op=load.
          required: ["id", "op", "inputs", "attr_id"],
          additionalProperties: false
        }
      }
    },
    required: ["intent", "output_type", "entity_type", "steps"],
    additionalProperties: false
  };
}

/** Every registered op, for callers that want the unnarrowed shape. */
const PLAN_SCHEMA = buildPlanSchema(ops_.names(), {
  hasFilterableValues: true, query: "",
});

/**
 * Narrow PLAN_SCHEMA to the operations a given query can actually use.
 *
 * Every op in the enum is a choice the model has to reason about, and a small
 * model's accuracy degrades with the size of that space. Adding count_features
 * for facility data dropped plan validity from 62.5% to 12.5% -- including on
 * ACS-only queries where the op is irrelevant and simply cannot apply.
 * Narrowing per query recovered half of that. See docs/RUNBOOK.md.
 *
 * The predicates themselves live on the op modules (`offered(ctx)`), which is
 * what guarantees this and buildSystemPrompt cannot disagree: they call the
 * same function.
 */
function planSchemaFor(ctx = {}) {
  return buildPlanSchema(ops_.offeredFor(ctx), ctx);
}

module.exports = { DECOMPOSITION_SCHEMA, VERIFICATION_SCHEMA, PLAN_SCHEMA, planSchemaFor, buildPlanSchema };
