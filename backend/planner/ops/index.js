/**
 * The operator registry.
 *
 * WHY THIS EXISTS: adding one op used to mean editing seven files -- the
 * decoding schema, the validator's arity table, the compiler's switch, three
 * separate places in the prompt builder, and the frontend. Nothing enforced
 * that they agreed, and they twice did not: an op named in the prompt but
 * absent from the decoding enum costs a repair round on a plan the model was
 * never able to emit, and validation that lived in a loop guarded by
 * `if (!src) continue` was silently skipped for every op carrying attr_id "".
 *
 * Now an op is ONE module declaring everything about itself, and this file
 * assembles the four views the rest of the planner needs. `planSchemaFor` and
 * `buildSystemPrompt` are both derived from the same `offered` predicate, so
 * they cannot drift apart by construction.
 *
 * AN OP MODULE DECLARES:
 *   name, inputs, needs          arity and required fields
 *   produces                     "series" | "features" | null -- the result SHAPE
 *   kind                         "sql" | "compute" (see COMPUTE OPS below)
 *   secondValue                  true if its CTE carries a value_b column
 *   grounds                      which fields cite an attribute, and its kind
 *   acceptsAttributeFilters      whether attribute_filters apply to it
 *   offered(ctx)                 narrowing predicate
 *   promptLine / choiceLine      prompt text
 *   examples                     worked examples, held back when not offered
 *   validate(step)               op-specific checks, returns error strings
 *   compile(step, ctx)           emits its CTE
 *
 *   diverging                    true if its output is signed around zero
 *   offered(ctx)                 narrowing predicate; ctx carries the query
 *
 * NARROWING ON THE QUESTION ITSELF. `offered(ctx)` receives the query text, so
 * an op can gate on phrasing as well as on what data is loaded. hotspot,
 * outlier and combine all do: they are absent from the decision space for every
 * question that is not asking for them, which is what keeps their cost near
 * zero on the queries that already worked.
 *
 * COMPUTE OPS (still unimplemented; the shape is fixed):
 * `kind: "compute"` marks an op whose work is not SQL. Note that hotspot and
 * outlier turned out NOT to need it -- Getis-Ord Gi* over contiguity weights is
 * a join and two aggregates -- so the first real case will be something like a
 * kernel-weighted or distance-band statistic. The contract stays the same as
 * everything else: `(fips, value)[]` in, `(fips, value)[]` out, over HTTP to a
 * sidecar, materialized back into the chain as a VALUES CTE. Keeping to the
 * series contract is what makes such an op compose with rank and filter_area
 * for free, and keeps the model out of the execution path -- it names the op,
 * it does not supply code.
 */

const { AREA_NAMES } = require("../../states");

const MODULES = [
  require("./load"),
  require("./count_features"),
  require("./count_near"),
  require("./nearest_distance"),
  require("./select_features"),
  require("./filter_attr"),
  require("./filter_area"),
  require("./filter_place"),
  require("./per_area"),
  require("./normalize"),
  require("./aggregate"),
  require("./rank"),
  require("./join"),
  require("./combine"),
  // Spatial and distributional statistics. Both are pure SQL against
  // county_neighbors and window aggregates -- see the modules for why that is
  // not a shortcut around PySAL but the right implementation at this scale.
  require("./hotspot"),
  require("./outlier"),
  // Association between two series; one row. Gated on phrasing like the two
  // above, so it is absent from every prompt that does not ask about a
  // relationship. docs/CORRELATE.md.
  require("./correlate"),
  // Ranked factors for one outcome; computed in Node, not SQL. Same gating
  // discipline. docs/EXPLAIN.md.
  require("./explain"),
  require("./output"),
];

const BY_NAME = new Map(MODULES.map(m => [m.name, m]));

/**
 * THREE ORDERINGS, and they genuinely differ.
 *
 * Order is behavior: the decoder reads the enum in order, and the prompt reads
 * top to bottom. Deriving one from another would change the bytes the model
 * sees, so all three are explicit and pinned by snapshot_prompt.js.
 *
 *   SCHEMA  the decoding enum: source ops, then filters, then arithmetic.
 *   PROMPT  groups the feature ops together and puts filter_attr before the
 *           place filters, because that is how the operation list reads.
 *   CHOICE  the "which op does this phrasing mean" table, ordered by how
 *           common the phrasing is rather than by op family.
 */
const SCHEMA_ORDER = [
  "load", "count_features", "count_near", "nearest_distance", "select_features",
  "filter_attr", "filter_area", "filter_place", "per_area", "normalize",
  "aggregate", "rank", "join", "combine", "hotspot", "outlier", "correlate", "explain", "output",
];

const PROMPT_ORDER = [
  "load", "count_features", "nearest_distance", "select_features", "count_near",
  "filter_attr", "filter_area", "filter_place", "per_area", "normalize",
  "aggregate", "rank", "join", "combine", "hotspot", "outlier", "correlate", "explain", "output",
];

// correlate sits BEFORE join here: "compare A and B" is join's phrasing, but a
// question that asks whether they are related is the stronger signal, and the
// model reads this table top to bottom.
const CHOICE_ORDER = [
  "normalize", "rank", "explain", "correlate", "join", "combine", "hotspot", "outlier",
  "count_features", "count_near", "nearest_distance", "select_features",
  "aggregate", "filter_attr", "filter_area", "filter_place", "per_area", "load",
];

/**
 * A fourth order, for the worked examples.
 *
 * It leads with the ops every query gets, so the first thing the model reads is
 * always a plan it can actually emit. An op contributes ALL of its examples at
 * its position here, in the order its module lists them.
 */
const EXAMPLE_ORDER = [
  "normalize", "rank", "explain", "correlate", "join", "combine", "hotspot", "outlier",
  "count_features", "aggregate", "filter_attr", "load", "filter_area",
  "filter_place", "count_near", "select_features", "nearest_distance",
  "per_area",
];

/**
 * Step field definitions, in the order the decoder sees them.
 *
 * Ordered explicitly, and centrally, for the same reason as the op orders: this
 * order is part of the prompt's bytes. It cannot be derived from op order
 * either, because fields are shared -- `limit` belongs to rank AND
 * select_features, `states` to three ops -- so no single owner exists.
 *
 * Field-level narrowing is a live lever and only `attribute_filters` currently
 * uses it. Withholding a field the model cannot use correctly measurably helps:
 * offered unconditionally, attribute_filters was attached to layers with no
 * such column, and at temperature 0.1 the repair loop re-emitted the identical
 * plan all three attempts.
 */
const STEP_FIELDS = {
  id: { type: "string", description: "Step identifier, e.g. s1" },
  op: null,   // filled from the offered op list
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
  // The second dataset in a proximity question: for "hospitals within 10 miles
  // of transmission lines", attr_id is hospitals and near_attr_id is
  // transmission lines. Both are reference labels.
  near_attr_id: {
    type: "string",
    description: 'Reference label of the dataset to measure proximity TO, ' +
                 'e.g. "a5". Required for op=count_near.'
  },
  miles: { type: "number", description: "Radius in miles for op=count_near" },
  // Enumerated so the decoder cannot invent a place that has no FIPS code.
  // Regions expand to their member states in the compiler.
  states: {
    type: "array",
    items: { type: "string", enum: AREA_NAMES },
    description: "States and/or regions to keep, for op=filter_area " +
                 "and (optionally) op=select_features"
  },
  // What KIND of named boundary, for op=filter_place. Enumerated because
  // place_geom holds exactly these four and asking for a fifth would silently
  // match nothing.
  place_kind: {
    type: "string",
    enum: ["place", "zcta", "cbsa", "urban"],
    description: 'place = city/town, zcta = ZIP code, cbsa = metro area, ' +
                 'urban = urbanized area. Required for op=filter_place.'
  },
  // Free text: 32,642 place names cannot go in an enum, and a ZIP is a number.
  // Validated by shape against place_kind instead.
  place_name: {
    type: "string",
    description: 'The boundary name, e.g. "Springfield" or "63101". ' +
                 'Required for op=filter_place. Set "states" too when the ' +
                 'question names one: 22 places are called Springfield.'
  },
  // Free text, not an enum: there is no city boundary layer to enumerate from,
  // so this is matched against the layer's own `city` column when it has one.
  city: {
    type: "string",
    description: "Restrict op=select_features to one city by name, e.g. " +
                 '"Springfield". Leave out unless the question names a city.'
  },
  // Which ones, as opposed to where. Values are not enumerated in the schema
  // because they differ per dataset -- the candidate list names the ones each
  // layer actually holds, and the validator checks against those.
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
  },
  // op=combine only. Declared here rather than in combine.js because field
  // ORDER is part of the prompt and cannot be owned by a module that may or
  // may not be registered.
  operation: {
    type: "string",
    enum: ["ratio", "sum", "difference", "percent_change"],
    description: "How to combine the two inputs, for op=combine."
  },
  // op=load only. Omitting it means the most recent year that measure has,
  // which differs per measure, so there is no default to hardcode here.
  year: {
    type: "integer",
    description: "Which year of the attribute to load, for op=load. Leave it " +
                 "out for the most recent. Set it on BOTH loads to compare two " +
                 "points in time."
  },
};

/**
 * Field-level narrowing.
 *
 * The same lever as op narrowing, one level down, and it is measured: offered
 * unconditionally, `attribute_filters` was attached to layers that have no such
 * column, failed validation, and at temperature 0.1 the repair loop re-emitted
 * the identical plan all three attempts. A field the model cannot use correctly
 * is a field it should not be shown.
 */
const FIELD_GATES = {
  attribute_filters: (ctx) => ctx.hasFilterableValues === true,
  operation: (ctx) => offeredFor(ctx).includes("combine"),
  // Only when the question is actually about time. Most questions want the
  // current figure and should never see a year field to get wrong.
  year: (ctx) => TIME_PHRASES.test(String(ctx.query || "")),
};

/** Phrasings that mean the question has a time dimension. */
const TIME_PHRASES =
  /\b(19\d{2}|20\d{2}|trends?|over time|since|growth|grew|shrank|declin\w*|increas\w*|decreas\w*|change\s+(from|in|since|between)|year[- ]over[- ]year|historical)\b/i;

/** Whether a step field is shown for this query. Unlisted fields always are. */
const fieldOffered = (name, ctx = {}) =>
  FIELD_GATES[name] ? FIELD_GATES[name](ctx) : true;

/** Registered op modules, in decoding-enum order. */
const registered = (order) =>
  order.map(n => BY_NAME.get(n)).filter(Boolean);

/** Names of every registered op, in decoding-enum order. */
const names = () => registered(SCHEMA_ORDER).map(m => m.name);

/**
 * The ops on offer for one query, in decoding-enum order.
 *
 * Single source of truth for narrowing: planSchemaFor and buildSystemPrompt
 * both call this, so the prompt can no longer mention an op the enum dropped.
 */
function offeredFor(ctx = {}) {
  return registered(SCHEMA_ORDER).filter(m => m.offered(ctx)).map(m => m.name);
}

const inPromptOrder = (offered) =>
  PROMPT_ORDER.filter(n => offered.includes(n));

const inChoiceOrder = (offered) =>
  CHOICE_ORDER.filter(n => offered.includes(n) && BY_NAME.get(n).choiceLine);

/**
 * Worked examples for the offered ops.
 *
 * One example per available op, so no op is demonstrated that the model cannot
 * actually use, and none it CAN use is left undemonstrated. `usesFilters`
 * examples are held back for the same reason at field level: demonstrating a
 * field that is absent from the decoding schema teaches a plan it cannot emit.
 */
function examplesFor(offered, ctx = {}) {
  const { hasFilterableValues = false } = ctx;
  const out = [];
  for (const name of EXAMPLE_ORDER) {
    if (!offered.includes(name)) continue;
    const mod = BY_NAME.get(name);
    if (!mod) continue;
    for (const ex of mod.examples || []) {
      if (ex.usesFilters && !hasFilterableValues) continue;
      // Same rule for the year field: an example that sets a field the decoding
      // schema has dropped teaches a plan the model cannot emit.
      if (ex.usesYear && !fieldOffered("year", ctx)) continue;
      out.push(ex.text);
    }
  }
  return out;
}

/** The arity/required-field table the validator checks against. */
function arityTable() {
  const out = {};
  for (const m of registered(SCHEMA_ORDER)) {
    out[m.name] = { needs: m.needs, inputs: m.inputs };
  }
  return out;
}

/** Ops whose attr_id must name a facility dataset. */
const featureOps = () => registered(SCHEMA_ORDER)
  .filter(m => (m.grounds || []).some(g => g.sourceKind === "feature"))
  .map(m => m.name);

/**
 * Ops that can be narrowed by their layer's own columns.
 *
 * `select_features` leads because this list is interpolated verbatim into a
 * repair message the model reads ("attribute_filters only apply to X or Y"),
 * and that message has always read in this order. Anything not named here
 * follows in decoding-enum order, so a new filterable op still appears.
 */
const FILTER_OP_PREFERENCE = ["select_features", "count_features"];

const filterOps = () => {
  const all = registered(SCHEMA_ORDER)
    .filter(m => m.acceptsAttributeFilters)
    .map(m => m.name);
  const lead = FILTER_OP_PREFERENCE.filter(n => all.includes(n));
  return [...lead, ...all.filter(n => !lead.includes(n))];
};

module.exports = {
  MODULES, BY_NAME, STEP_FIELDS,
  SCHEMA_ORDER, PROMPT_ORDER, CHOICE_ORDER, EXAMPLE_ORDER,
  byName: (n) => BY_NAME.get(n),
  names, offeredFor, inPromptOrder, inChoiceOrder, examplesFor,
  arityTable, featureOps, filterOps,
  fieldOffered, TIME_PHRASES,
};
