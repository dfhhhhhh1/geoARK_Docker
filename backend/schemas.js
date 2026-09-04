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
const { AREA_NAMES } = require("./states");

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
              "count_near",    // count features within N miles of another dataset
              "nearest_distance", // miles from each county to the nearest feature
              "select_features",  // the individual locations themselves, mapped
              "filter_attr",   // keep rows matching a numeric comparison
              "filter_area",   // keep only counties in named states or regions
              "filter_place",  // keep only counties inside a named city/ZIP/metro
              "per_area",      // value per square mile of county land area
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
          scale: { type: "number", description: "Multiplier for normalize, e.g. 100 for a percentage" },
          // The second dataset in a proximity question: for "hospitals within
          // 10 miles of transmission lines", attr_id is hospitals and
          // near_attr_id is transmission lines. Both are reference labels.
          near_attr_id: {
            type: "string",
            description: 'Reference label of the dataset to measure proximity TO, ' +
                         'e.g. "a5". Required for op=count_near.'
          },
          miles: { type: "number", description: "Radius in miles for op=count_near" },
          // Enumerated so the decoder cannot invent a place that has no FIPS
          // code. Regions expand to their member states in the compiler.
          states: {
            type: "array",
            items: { type: "string", enum: AREA_NAMES },
            description: "States and/or regions to keep, for op=filter_area " +
                         "and (optionally) op=select_features"
          },
          // What KIND of named boundary, for op=filter_place. Enumerated
          // because place_geom holds exactly these four and asking for a fifth
          // would silently match nothing.
          place_kind: {
            type: "string",
            enum: ["place", "zcta", "cbsa", "urban"],
            description: 'place = city/town, zcta = ZIP code, cbsa = metro area, ' +
                         'urban = urbanized area. Required for op=filter_place.'
          },
          // Free text: 32,642 place names cannot go in an enum, and a ZIP is a
          // number. Validated by shape against place_kind instead.
          place_name: {
            type: "string",
            description: 'The boundary name, e.g. "Springfield" or "63101". ' +
                         'Required for op=filter_place. Set "states" too when the ' +
                         'question names one: 22 places are called Springfield.'
          },
          // Free text, not an enum: there is no city boundary layer to
          // enumerate from, so this is matched against the layer's own `city`
          // column when it has one.
          city: {
            type: "string",
            description: "Restrict op=select_features to one city by name, e.g. " +
                         '"Springfield". Leave out unless the question names a city.'
          },
          // Which ones, as opposed to where. Values are not enumerated in the
          // schema because they differ per dataset -- the candidate list names
          // the ones each layer actually holds, and the validator checks
          // against those.
          attribute_filters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                column: { type: "string", enum: ["type", "status", "owner"] },
                value: { type: "string" }
              },
              required: ["column", "value"],
              additionalProperties: false
            },
            description: "Keep only features whose column has this value, e.g. " +
                         '[{"column":"type","value":"CRITICAL ACCESS"}]. Use only ' +
                         "the values listed for that dataset in AVAILABLE ATTRIBUTES."
          }
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

/**
 * Narrow PLAN_SCHEMA to the operations a given query can actually use.
 *
 * Every op in the enum is a choice the model has to reason about, and a small
 * model's accuracy degrades with the size of that space. Adding count_features
 * for facility data dropped plan validity from 62.5% to 12.5% -- including on
 * ACS-only queries where the op is irrelevant and simply cannot apply.
 *
 * So show only what applies. This matters more now than it did with eight ops:
 * the geospatial additions take the full surface to twelve, and offering all of
 * them unconditionally would repeat the 12.5% mistake at a larger scale.
 *
 *   count_features    needs one facility dataset among the candidates
 *   nearest_distance  same
 *   count_near        needs TWO -- it measures one against the other, so with a
 *                     single facility dataset the op is unusable by construction
 *   filter_area       needs the question to actually name a place
 */
function planSchemaFor({ hasFeatureTables = false, featureTableCount = 0,
                         mentionsArea = false, wantsLocations = false,
                         hasFilterableValues = false,
                         hasPlaceBoundaries = false } = {}) {
  const schema = JSON.parse(JSON.stringify(PLAN_SCHEMA));
  const ops = schema.properties.steps.items.properties.op;
  const drop = new Set();

  // Same narrowing rule applied to a FIELD rather than an op. Offered
  // unconditionally, attribute_filters was added to datasets that have none:
  // "fire stations in Springfield, Missouri" came back with a `status` filter
  // on a layer with no status column, failed validation, and -- at temperature
  // 0.1 -- the repair loop re-emitted the identical plan all three attempts.
  // A field the model cannot use correctly is a field it should not be shown.
  if (!hasFilterableValues) {
    delete schema.properties.steps.items.properties.attribute_filters;
  }

  if (!hasFeatureTables) {
    drop.add("count_features");
    drop.add("nearest_distance");
    drop.add("select_features");
  }
  if (featureTableCount < 2) drop.add("count_near");
  if (!mentionsArea) drop.add("filter_area");
  // Needs both a place in the question AND boundaries loaded. An install
  // without place_geom would otherwise be offered an op that can only fail.
  if (!mentionsArea || !hasPlaceBoundaries) drop.add("filter_place");
  // select_features returns a different SHAPE of answer -- individual locations
  // rather than a per-county number. Offering it to "how many hospitals per
  // county" invites the wrong one, so it appears only when the question is
  // actually asking where things are.
  if (!wantsLocations) drop.add("select_features");

  ops.enum = ops.enum.filter(op => !drop.has(op));
  return schema;
}

module.exports = { DECOMPOSITION_SCHEMA, VERIFICATION_SCHEMA, PLAN_SCHEMA, planSchemaFor };
