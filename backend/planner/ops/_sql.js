/**
 * Compilation primitives shared by the op modules.
 *
 * Everything here exists to keep one promise: no model-produced string is ever
 * interpolated into SQL. Identifiers are pattern-checked, operators and
 * aggregate functions come from closed maps, and every literal is bound.
 * An op module that reaches around these is a bug, not a shortcut.
 */

class CompileError extends Error {}

// Step ids are ours to constrain, and short by convention.
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;

// Database identifiers are NOT ours to constrain: the geospatial ETL derives
// table names from source filenames, e.g.
//   c862525677cf485a84b2ba86a78e277d_histtornadotracks   (50 chars)
// A 31-char cap rejected legitimate tables as "unsafe". Postgres' own limit is
// NAMEDATALEN-1 = 63, which is the right bound -- still a strict allow-list,
// just not an arbitrarily tighter one than the database itself uses.
const SAFE_DB_IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const OPERATORS = { "<": "<", "<=": "<=", ">": ">", ">=": ">=", "=": "=", "!=": "<>" };
const AGGREGATES = { mean: "AVG", sum: "SUM", count: "COUNT", min: "MIN", max: "MAX" };

/** Columns an attribute filter may name. Mirrors FILTERABLE_COLUMNS server-side. */
const FILTERABLE_COLUMNS = ["type", "status", "owner"];

/** Boundary kinds held in place_geom. Mirrors the schema enum. */
const PLACE_KINDS = ["place", "zcta", "cbsa", "urban"];

/**
 * Minimum share of the smaller geometry that must overlap for a county to count
 * as "in" a named boundary. See filter_place for the measurements.
 */
const PLACE_OVERLAP_MIN = Number(process.env.PLACE_OVERLAP_MIN ?? 0.01);

/** Cap on individual features returned by select_features. */
const MAX_FEATURES = Number(process.env.MAX_FEATURES ?? 3000);

// Upper bound on returned rows. Must exceed the 3,233 US counties so a
// county-level map is complete; 5,000 leaves room without being unbounded.
// Values-only payload for a full county result is ~230 KB.
const MAX_RESULT_ROWS = Number(process.env.MAX_RESULT_ROWS ?? 5000);

function cte(id) {
  if (!SAFE_ID.test(id)) throw new CompileError(`unsafe step id: ${JSON.stringify(id)}`);
  return `step_${id}`;
}

/**
 * SQL predicates for a step's attribute_filters, as `alias.col = $n` fragments.
 *
 * Column names come from a fixed allow-list, never from the model's string --
 * `alias.${col}` is only ever interpolated after membership is confirmed.
 * Values are bound, and the validator has already normalized them to the
 * layer's own spelling, so an exact `=` is correct here and cheaper than ILIKE.
 */
function attributeFilterSql(step, alias, bind) {
  const out = [];
  for (const f of step.attribute_filters || []) {
    if (!FILTERABLE_COLUMNS.includes(f.column)) {
      throw new CompileError(`unsupported filter column ${f.column}`);
    }
    // `negate` ("hospitals that are not critical access"): IS DISTINCT FROM,
    // so a feature with no value in that column is kept -- it is not known to
    // be the excluded kind. Offered only on negation phrasing (ops/index.js).
    out.push(f.negate === true
      ? `${alias}.${f.column} IS DISTINCT FROM ${bind(f.value)}`
      : `${alias}.${f.column} = ${bind(f.value)}`);
  }
  return out;
}

/**
 * The FEATURES contract (GIS_OPS_PLAN.md H1), the counterpart of (fips, value).
 *
 * A features step that something other than an output reads is a CTE with
 * exactly these columns, in this order, whatever layer it came from: `geom`,
 * a `value` (NULL until an op such as `within` puts a distance in it), and the
 * label columns, NULL where the layer has none. One fixed shape is what lets
 * within, rank and filter_attr read any features step without knowing which
 * layer, or which op, produced it.
 */
const FEATURE_LABELS = ["name", "city", "state", "county", "address", "type", "status"];
const FEATURE_COLUMNS = ["geom", "value", ...FEATURE_LABELS];

/** `alias.col` for every feature column, for a SELECT that passes them through. */
const featureColumns = (alias) => FEATURE_COLUMNS.map(c => `${alias}.${c}`).join(", ");

/**
 * Degree box around `g` holding every point within `meters` of it. Per axis,
 * as count_near learned the hard way: a degree of longitude is ~111.32 km *
 * cos(lat), so dx widens with the box's poleward edge. `meters` is SQL (a bound
 * parameter or an expression).
 */
function expandBox(g, meters) {
  const dy = `(${meters}) / 110574.0`;
  const poleward = `least(greatest(abs(ST_YMin(${g})), abs(ST_YMax(${g}))) + ${dy}, 89.9)`;
  return `ST_Expand(${g}, ${dy} / cos(radians(${poleward})), ${dy})`;
}

/**
 * What a feature step reads FROM, and its geometry column: a catalog table
 * (identifiers from attribute_source, which only the ETL writes, checked
 * anyway) or, for a layer the user uploaded this session (backend/
 * user_layers.js), a table expression over bound arrays. Every op that reads
 * a feature layer goes through this, so an uploaded layer is never special-
 * cased op by op.
 */
function featureFrom(src, bind, label = "attribute") {
  if (!src) throw new CompileError(`unresolved ${label}`);
  if (src.source_kind !== "feature_table") throw new CompileError(`${label} is not a feature table`);
  const geom = src.geom_column || "geom";
  if (!SAFE_DB_IDENT.test(geom)) throw new CompileError(`unsafe identifier in attribute_source for ${label}`);
  if (src.user_layer) {
    if (!Array.isArray(src.geoms) || !Array.isArray(src.props)) {
      throw new CompileError(`uploaded layer ${label} carries no features`);
    }
    // Asked only for its columns (select_features labelsOf): nothing to bind.
    if (typeof bind !== "function") return { from: null, geom: "geom", userLayer: true };
    return { from: require("../../user_layers").fromSql(src, bind), geom: "geom", userLayer: true };
  }
  if (!SAFE_DB_IDENT.test(src.table_name || "")) {
    throw new CompileError(`unsafe identifier in attribute_source for ${label}`);
  }
  return { from: src.table_name, geom, userLayer: false };
}

module.exports = {
  featureFrom,
  CompileError, SAFE_ID, SAFE_DB_IDENT,
  OPERATORS, AGGREGATES, FILTERABLE_COLUMNS, PLACE_KINDS,
  PLACE_OVERLAP_MIN, MAX_FEATURES, MAX_RESULT_ROWS,
  FEATURE_LABELS, FEATURE_COLUMNS,
  cte, attributeFilterSql, featureColumns, expandBox,
};
