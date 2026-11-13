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
const { RELATIVE_PHRASES, TIME_PHRASES, COMPLEMENT_PHRASES } = require("../conditions");
const { asksNegation } = require("../features");

// "outside", "not in any", "do not cross": overlay's exclude reading. Only
// consulted when overlay is already on offer.
const OUTSIDE = /\b(?:outside|not\s+(?:in|inside|within|on|cross|intersect|overlap|touch)|don'?t|doesn'?t|do\s+not|does\s+not|avoid|free\s+of|no\s+part)\b/i;

const MODULES = [
  require("./load"),
  require("./count_features"),
  require("./count_near"),
  require("./nearest_distance"),
  require("./select_features"),
  // The feature algebra (docs/GIS_OPS_PLAN.md H1): features in, features or a
  // count out. Gated on phrasing that relates two layers by distance
  // (planner/features.js), so no existing prompt sees them.
  require("./within"),
  // Overlay without a distance (H3): gated on overlay phrasing AND a polygon
  // layer among the candidates (planner/features.js overlayAlgebra).
  require("./overlay"),
  require("./summarize"),
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
  // Conditions on several measures at once, and two groups compared. Both
  // gated on phrasing (planner/conditions.js), so a question that states no
  // condition and compares no groups sees exactly the op set it saw before.
  require("./intersect"),
  require("./compare_groups"),
  // Phase F spatial methods (docs/RESEARCH_PLAN.md): the spatial lag, a
  // regression residual, and 2SFCA access. Each gated on its own phrasing.
  require("./neighbors"),
  require("./residual"),
  require("./access"),
  // Rasters over units (H4): offered only when a raster is among the
  // candidates, so no existing prompt sees it.
  require("./zonal"),
  require("./output"),
  // Internal: inserted by code (planner/levels.js), never offered, in no order.
  require("./aggregate_to"),
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
  "within", "overlay", "summarize", "filter_attr", "filter_area", "filter_place", "per_area", "normalize",
  "aggregate", "rank", "join", "combine", "hotspot", "outlier", "correlate", "explain",
  "intersect", "compare_groups", "neighbors", "residual", "access", "zonal", "output",
];

const PROMPT_ORDER = [
  "load", "count_features", "nearest_distance", "select_features", "within", "overlay", "summarize",
  "count_near", "filter_attr", "filter_area", "filter_place", "per_area", "normalize",
  "aggregate", "rank", "join", "combine", "hotspot", "outlier", "correlate", "explain",
  "intersect", "compare_groups", "neighbors", "residual", "access", "zonal", "output",
];

// correlate sits BEFORE join here: "compare A and B" is join's phrasing, but a
// question that asks whether they are related is the stronger signal, and the
// model reads this table top to bottom.
const CHOICE_ORDER = [
  "normalize", "rank", "explain", "correlate", "compare_groups", "intersect", "join", "combine", "hotspot", "outlier",
  "neighbors", "residual", "access", "zonal",
  // within before count_near: "WHICH X are within N miles of Y" is the more
  // specific reading, and the table is read top to bottom.
  "within", "overlay", "summarize",
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
  "normalize", "rank", "explain", "correlate", "compare_groups", "intersect", "join", "combine", "hotspot", "outlier",
  "neighbors", "residual", "access", "zonal",
  "count_features", "aggregate", "filter_attr", "load", "filter_area",
  "filter_place", "count_near", "select_features", "within", "overlay", "summarize", "nearest_distance",
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
  // op=filter_attr, instead of value, for "high" / "few" with no number. Gated
  // on that phrasing, so no other prompt changes.
  percentile: {
    type: "integer",
    description: "For op=filter_attr when the question says high, low, many or " +
                 "few without giving a number: compare against this percentile of " +
                 "the input's own values, e.g. operator \">=\" and percentile 75 " +
                 "for the top quarter. Leave value out when you use it."
  },
  // op=filter_attr, instead of operator + value: a published definition listed
  // under an attribute ("d1"). Code supplies the numbers. Offered only when a
  // retrieved attribute carries one (backend/definitions.js).
  definition: {
    type: "string",
    description: 'For op=filter_attr: a definition label like "d1", listed ' +
                 "under the attribute it applies to. Use it when the question " +
                 "uses that term; it sets operator and value for you."
  },
  // op=intersect: keep the counties NOT in input 2 instead ("the rest of the
  // country"). Gated on that phrasing, or on earlier workflow results being on
  // offer, which is when a complement group is most often needed.
  exclude: {
    type: "boolean",
    description: "For op=intersect: true keeps input 1's counties that are NOT " +
                 'in input 2, e.g. "the rest of the country", "all other counties".'
  },
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
  operation: (ctx) => offeredFor(ctx).includes("combine") || offeredFor(ctx).includes("neighbors"),
  // Only when the question is actually about time. Most questions want the
  // current figure and should never see a year field to get wrong.
  year: (ctx) => TIME_PHRASES.test(String(ctx.query || "")),
  // A qualifier with no number. English comparatives, not a term list.
  percentile: (ctx) => RELATIVE_PHRASES.test(String(ctx.query || "")),
  // Data-driven: only when a retrieved attribute carries a checked definition.
  definition: (ctx) => ctx.hasDefinitions === true,
  exclude: (ctx) => offeredFor(ctx).includes("within") ||
    (offeredFor(ctx).includes("overlay") && OUTSIDE.test(String(ctx.query || ""))) ||
    (offeredFor(ctx).includes("intersect") &&
    (COMPLEMENT_PHRASES.test(String(ctx.query || "")) || ctx.hasEarlierResults === true)),
};

/**
 * Field VARIANTS: the same field with a different definition for some
 * questions. A variant is returned only when its predicate holds, so every
 * other question decodes against the field exactly as before.
 *
 *   exclude            gains the within reading when within is on offer
 *   attribute_filters  gains `negate` on negation phrasing ("not critical
 *                      access", "other than"), the NOT filter of H1
 */
const FIELD_VARIANTS = {
  exclude: (ctx) => !(offeredFor(ctx).includes("within") || offeredFor(ctx).includes("overlay")) ? null : {
    type: "boolean",
    description: (offeredFor(ctx).includes("within")
                   ? "For op=within: true keeps input 1's features FARTHER than miles " +
                     "from every feature of input 2."
                   : "For op=overlay: true keeps input 1's features that touch NO " +
                     'feature of input 2, e.g. "outside", "not in any".') +
                 (offeredFor(ctx).includes("intersect")
                   ? " For op=intersect: true keeps input 1's counties that are NOT " +
                     'in input 2, e.g. "the rest of the country", "all other counties".'
                   : ""),
  },
  // Only where features are the answer: "not" is common in county questions
  // ("counties that do not have a hospital"), which keep their schema.
  attribute_filters: (ctx) => !(asksNegation(ctx.query) &&
      (ctx.wantsLocations === true || offeredFor(ctx).includes("within"))) ? null : {
    ...STEP_FIELDS.attribute_filters,
    items: {
      type: "object",
      properties: {
        column: { type: "string", enum: ["type", "status", "owner"] },
        value: { type: "string" },
        negate: { type: "boolean", description: "true keeps features whose column is NOT this value" },
      },
      required: ["column", "value"],
      additionalProperties: false,
    },
  },
};

/** A field's definition for this query: its variant if one applies, else the default. */
const fieldDef = (name, ctx = {}) =>
  (FIELD_VARIANTS[name] && FIELD_VARIANTS[name](ctx)) || STEP_FIELDS[name];

// TIME_PHRASES (the question has a time dimension) lives in conditions.js with
// the other phrasing gates, so op modules (combine) can read it without a
// require cycle through this file.

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
      // An example for one phrasing only (nearest_distance's catchment).
      if (typeof ex.when === "function" && !ex.when(ctx)) continue;
      // An op with a definition-using and a plain example shows exactly one.
      if (ex.usesDefinitions !== undefined &&
          ex.usesDefinitions !== fieldOffered("definition", ctx)) continue;
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

/**
 * THE TYPES (docs/GIS_OPS_PLAN.md H1). Every step yields one of
 *
 *   series     (fips, value), one row per unit
 *   features   the features contract of _sql.js: geometry, value, labels
 *   scalar     one row with no unit: an ungrouped aggregate or summarize
 *   statistic  one summary row with named columns (correlate)
 *   factors    a computed table (explain)
 *
 * An op declares what it accepts per input (`accepts`, default series) and
 * what it yields (`resultType(step, inTypes)`, else `produces`). The validator
 * checks every edge against that one rule, which replaced three special cases
 * that each said a version of "this may only feed an output". output accepts
 * everything.
 */
function typeOf(mod, step, inTypes = []) {
  if (!mod) return null;
  if (typeof mod.resultType === "function") return mod.resultType(step, inTypes);
  if (mod.statColumns) return "statistic";
  return mod.produces ?? null;
}

/** The types input `i` of this op accepts; null means any (output). */
function acceptsOf(mod, i) {
  if (!mod || mod.terminal) return null;
  return (mod.accepts && mod.accepts[i]) || ["series"];
}

/** Map step id -> type, for steps already in execution order. */
function stepTypes(steps) {
  const out = new Map();
  for (const st of steps || []) {
    const mod = BY_NAME.get(st.op);
    out.set(st.id, typeOf(mod, st, (st.inputs || []).map(i => out.get(i))));
  }
  return out;
}

/** Arity of the internal ops: validated like any other, never shown to the model. */
function internalArity() {
  const out = {};
  for (const m of MODULES.filter(m => m.internal)) out[m.name] = { needs: m.needs, inputs: m.inputs };
  return out;
}

module.exports = {
  MODULES, BY_NAME, STEP_FIELDS, internalArity,
  SCHEMA_ORDER, PROMPT_ORDER, CHOICE_ORDER, EXAMPLE_ORDER,
  byName: (n) => BY_NAME.get(n),
  names, offeredFor, inPromptOrder, inChoiceOrder, examplesFor,
  arityTable, featureOps, filterOps,
  fieldOffered, fieldDef, TIME_PHRASES,
  typeOf, acceptsOf, stepTypes,
};
