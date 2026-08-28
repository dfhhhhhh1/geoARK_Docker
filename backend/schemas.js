/**
 * JSON Schemas for schema-constrained LLM decoding.
 *
 * Ollama accepts a JSON Schema as the `format` field and constrains token
 * sampling to it, which makes invalid output *unrepresentable* rather than
 * merely discouraged. That replaces the previous approach — asking politely for
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
 * uses nine known ops far more reliably than an open-ended DSL, and a closed
 * set is what makes a deterministic SQL compiler possible.
 *
 * Note what is NOT here: no table names, no column names, no SQL. Steps refer
 * to attributes by `attr_id`, and every one is checked against
 * attribute_source before the plan is allowed to run. The model may only cite
 * identifiers a tool actually returned to it.
 */
const PLAN_SCHEMA = {
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
        properties: {
          id: { type: "string", description: "Step identifier, e.g. s1" },
          op: {
            type: "string",
            enum: [
              "load",          // pull one attribute's values by attr_id
              "count_features",// count a facility dataset's features per county
              "filter_attr",   // keep rows matching a numeric comparison
              "normalize",     // numerator / denominator * scale
              "aggregate",     // mean | sum | count | min | max, optional group_by
              "rank",          // order and take the top/bottom n
              "join",          // combine two steps on the shared entity key
              "output"         // terminal step
            ]
          },
          attr_id: {
            type: "string",
            description: 'Reference label of the attribute, e.g. "a3". Required for ' +
                         'op=load and op=count_features. Use "" for every other op.'
          },
          inputs: {
            type: "array",
            items: { type: "string" },
            description: "Ids of the steps this one consumes. [] for op=load, " +
                         "one id for filter_attr/aggregate/rank/output, " +
                         "two for normalize/join"
          },
          operator: { type: "string", enum: ["<", "<=", ">", ">=", "=", "!="] },
          value: { type: "number" },
          function: { type: "string", enum: ["mean", "sum", "count", "min", "max"] },
          group_by: { type: "string", enum: ["state", "none"] },
          direction: { type: "string", enum: ["asc", "desc"] },
          limit: { type: "integer" },
          scale: { type: "number", description: "Multiplier for normalize, e.g. 100 for a percentage" }
        },
        // "inputs" is required on purpose: constrained decoding lets a model
        // omit optional fields, and a 4B model omits this one every time --
        // producing steps with no wiring that then fail arity validation.
        // attr_id is required for the same reason as inputs: the decoder drops
        // optional fields. JSON Schema cannot express "required only when
        // op=load" in a form Ollama's constrained decoder handles reliably, so
        // it is required everywhere and non-load steps pass "". The validator
        // treats "" as absent, and only checks it for op=load.
        required: ["id", "op", "inputs", "attr_id"],
        additionalProperties: false
      }
    }
  },
  required: ["intent", "output_type", "entity_type", "steps"],
  additionalProperties: false
};

module.exports = { DECOMPOSITION_SCHEMA, VERIFICATION_SCHEMA, PLAN_SCHEMA };
