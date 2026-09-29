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
    out.push(`${alias}.${f.column} = ${bind(f.value)}`);
  }
  return out;
}

module.exports = {
  CompileError, SAFE_ID, SAFE_DB_IDENT,
  OPERATORS, AGGREGATES, FILTERABLE_COLUMNS, PLACE_KINDS,
  PLACE_OVERLAP_MIN, MAX_FEATURES, MAX_RESULT_ROWS,
  cte, attributeFilterSql,
};
