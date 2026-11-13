/**
 * Plan -> SQL compiler.
 *
 * The model writes a plan. This writes the SQL. That separation is the whole
 * design: a validated plan is compiled deterministically, so the same plan
 * always produces the same query, plans are cacheable and diffable, and there
 * is no path by which model output becomes executable code.
 *
 * SAFETY
 * ------
 * No model-produced string is ever interpolated into SQL. The op modules do the
 * emitting, but every one of them binds literals through `ctx.bind` and takes
 * identifiers from attribute_source (ETL-written) after a pattern check. See
 * ops/_sql.js.
 *
 * SHAPE
 * -----
 * Each step becomes one CTE over a common (fips, value) contract, which is what
 * keeps composition simple.
 *
 * A plan is a DAG, not a chain. A step may feed SEVERAL consumers -- it is a
 * named CTE, so referencing it twice costs nothing -- and a plan may carry
 * SEVERAL `output` steps. Each output is compiled into its own statement over
 * the shared prelude and comes back as a separate layer, which is what lets one
 * question return, say, a point layer and a choropleth.
 */

const { planLevel, LEVELS: LEVEL_SET } = require("./levels");
const ops = require("./ops");
const { describeGroup } = require("./conditions");
const {
  CompileError, SAFE_DB_IDENT, cte, featureFrom,
  OPERATORS, AGGREGATES, MAX_FEATURES, MAX_RESULT_ROWS,
} = require("./ops/_sql");

/**
 * @param plan      validated plan
 * @param resolved  Map<attr_id, {census_code, source_kind, table_name, value_column}>
 * @returns {{outputs: Array, sql: string, params: any[], mode: string, series: number}}
 */
function compilePlan(plan, resolved) {
  // Phase E: the unit the plan runs at (planner/levels.js). "county" unless
  // the question named another, so every existing plan compiles as before.
  const level = planLevel(plan);
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  // The type each step yields (ops/index.js): which form an op compiles to
  // depends on whether its input is a series, features or a scalar.
  const types = ops.stepTypes(steps);
  // The unit each step runs at. A step may carry its own `level` (a load
  // rolled up to counties, applyRollup; a catchment's tract steps,
  // planner/catchment.js), and a step with none inherits a finer level from
  // its inputs, until aggregate_to brings it back to counties. Every plan
  // without step levels runs entirely at the plan's level, as before.
  const stepLevel = new Map();
  for (const st of steps) {
    let lv = LEVEL_SET.has(st.level) ? st.level : null;
    if (!lv && st.op !== "aggregate_to") {
      lv = (st.inputs || []).map(i => stepLevel.get(i)).find(l => l && l !== level) || null;
    }
    stepLevel.set(st.id, lv || (st.op === "aggregate_to" ? "county" : level));
  }

  /**
   * Resolve a label to a feature table, with identifier checks. Identifiers
   * come from attribute_source, which only the ETL writes -- never from the
   * model -- and are pattern-checked anyway before interpolation.
   */
  // `bind` is the statement's own: an uploaded layer (backend/user_layers.js)
  // binds its features into whichever statement reads it.
  const featureSource = (attrId, field = "attr_id", bind = null) => {
    const src = resolved.get(attrId);
    if (!src) throw new CompileError(`unresolved ${field} ${attrId}`);
    const { from, geom } = featureFrom(src, bind, attrId);
    return { table: from, geom };
  };

  /**
   * The steps one output depends on, in declaration order.
   *
   * Steps are already topologically ordered by the validator, so declaration
   * order is a valid execution order for any subset of them.
   */
  const neededFor = (rootId) => {
    const needed = new Set();
    const visit = (id) => {
      const st = byId.get(id);
      if (!st || needed.has(id)) return;
      const mod = ops.byName(st.op);
      // Terminal steps contribute no CTE, nor do factors. A features step does
      // when something reads it as a CTE (GIS_OPS_PLAN.md H1): a select_features
      // read only by an output still compiles standalone, as it always has.
      if (mod && !mod.terminal && mod.produces !== "factors" &&
          !(types.get(id) === "features" && !mod.compile)) needed.add(id);
      for (const dep of st.inputs || []) visit(dep);
    };
    visit(rootId);
    return steps.filter(st => needed.has(st.id));
  };

  /**
   * Compile the CTE prelude for ONE output, with its OWN parameter list.
   *
   * Parameters cannot be shared across outputs. Each output's prelude is pruned
   * to the CTEs it actually reaches, so a shared list keeps the bindings of
   * CTEs this statement does not declare -- and Postgres rejects the mismatch
   * at execution: "bind message supplies 3 parameters, but prepared statement
   * requires 2". That was latent from the day multi-output landed, unreachable
   * only because the planner is not yet told it may emit more than one output.
   * Compiling per output costs a little repeated string building and makes the
   * count correct by construction.
   */
  const preludeFor = (rootId) => {
    const params = [];
    const bind = (v) => { params.push(v); return `$${params.length}`; };
    const declared = [];
    let hasSecond = false;
    let statColumns = [];
    // compare_groups: per-row columns (grp) and a summary repeated on every
    // row, lifted out by the executor. Same "only if the output reads that
    // step directly" rule as statColumns, or the columns do not exist.
    let rowColumns = [];
    let summaryColumns = [];

    for (const st of neededFor(rootId)) {
      const mod = ops.byName(st.op);
      if (!mod) throw new CompileError(`unknown op ${st.op}`);
      const name = cte(st.id);
      declared.push(mod.compile(st, {
        name, ins: (st.inputs || []).map(cte), bind, resolved,
        featureSource: (id, field) => featureSource(id, field, bind),
        level: stepLevel.get(st.id),
        inTypes: (st.inputs || []).map(i => types.get(i)),
      }));
      // Only the CTE this output actually reads decides whether a second
      // measure survives: every other op selects (fips, value) and drops it.
      if (mod.secondValue && st.id === rootId) hasSecond = true;
      // Same rule for a statistic's extra columns (correlate): only when the
      // output reads that step directly, or the column does not exist.
      if (mod.statColumns && st.id === rootId) statColumns = mod.statColumns;
      if (mod.rowColumns && st.id === rootId) rowColumns = mod.rowColumns;
      if (mod.summaryColumns && st.id === rootId) summaryColumns = mod.summaryColumns;
    }

    return {
      sql: declared.length ? `WITH ${declared.join(",\n     ")}\n` : "",
      params, hasSecond, statColumns, rowColumns, summaryColumns,
      // For a compute op (explain), which appends its own CTEs to the same
      // WITH list and must keep binding into the same parameter list.
      declared, bind,
    };
  };

  // The root layer of a features chain (input 1 all the way down), for its
  // label columns; and whether an op on the way put a value (a distance) there.
  const featureRoot = (id) => {
    let st = byId.get(id);
    while (st && st.op !== "select_features") st = byId.get((st.inputs || [])[0]);
    return st;
  };
  const featureLabelsOf = (id) => {
    const root = featureRoot(id);
    return root ? ops.byName("select_features").labelsOf(root, { resolved }) : [];
  };
  // What a features result's `value` is: set by the op nearest the output
  // that measured something (within: a distance; overlay: the amount inside
  // the second layer, H3), passed through by rank / filter_attr. null when
  // nothing did, or when overlay only selected (exclude).
  const featureValueOf = (id) => {
    for (let st = byId.get(id); st && st.op !== "select_features"; st = byId.get((st.inputs || [])[0])) {
      if (st.op === "within") return { column: "miles_to_nearest", label: "miles to the nearest feature of the second layer" };
      if (st.op === "overlay") {
        return st.exclude === true ? null
          : { column: "amount_inside", label: `${st.unit || "miles or square miles"} inside the second layer (none for points)` };
      }
    }
    return null;
  };

  // --- one statement per output ---------------------------------------------
  const outputSteps = steps.filter(s => ops.byName(s.op)?.terminal);
  if (!outputSteps.length) throw new CompileError("plan produced no output");

  /**
   * An arithmetic result is not interpretable on its own.
   *
   * "Poverty rate minus unemployment rate" drawn alone shows where the gap is
   * widest and says nothing about whether that is a high-poverty county or a
   * low-unemployment one -- the same difference arises from opposite
   * situations. So when a `combine` or `normalize` reaches an output, its two
   * INPUTS come back as layers too, and the reader can see the parts beside the
   * result.
   *
   * Expanded here rather than asked of the planner: it follows mechanically
   * from the plan's shape, and a prompt change would cost a measurement to
   * justify. Inputs already carried by an explicit output are not duplicated.
   */
  const SHOW_PARTS = new Set(["combine", "normalize"]);
  const explicit = new Set(outputSteps.map(o => (o.inputs || [])[0]).filter(Boolean));
  const derived = [];
  for (const out of outputSteps) {
    const src = byId.get((out.inputs || [])[0]);
    if (!src || !SHOW_PARTS.has(src.op)) continue;
    for (const partId of src.inputs || []) {
      const part = byId.get(partId);
      // Only series parts: a features step has no (fips, value) to draw here.
      if (!part || explicit.has(partId)) continue;
      if (ops.byName(part.op)?.produces !== "series") continue;
      explicit.add(partId);
      derived.push({ id: `${out.id}_part_${partId}`, inputs: [partId], part: true });
    }
  }

  const outputs = [...outputSteps, ...derived].map((out) => {
    const srcId = (out.inputs || [])[0];
    const srcStep = byId.get(srcId);
    if (!srcStep) throw new CompileError(`output "${out.id}" names no known step`);
    const srcMod = ops.byName(srcStep.op);

    if (types.get(srcId) === "features" && srcStep.op !== "select_features") {
      // A features result built by other ops (within, rank, filter_attr on
      // features): the prelude, then the features contract's columns. Labels
      // are the ones the layer at the root of the chain actually has.
      const { sql: prelude, params } = preludeFor(srcId);
      const labels = featureLabelsOf(srcId);
      const valued = featureValueOf(srcId);
      const rank = srcStep.op === "rank" ? (srcStep.direction === "asc" ? "ASC" : "DESC") : null;
      const sql =
        prelude +
        `SELECT ST_AsGeoJSON(r.geom) AS geometry` +
        (valued ? `, r.value AS ${valued.column}` : "") +
        labels.map(c => `, r.${c}`).join("") + `\n` +
        `FROM ${cte(srcId)} r\n` +
        (rank ? `ORDER BY r.value ${rank} NULLS LAST\n` : valued ? `ORDER BY r.value ASC NULLS LAST\n` : "") +
        `LIMIT ${MAX_FEATURES}`;
      return {
        id: out.id, step: srcStep.id, mode: "features",
        sql, params, labels: valued ? [valued.column, ...labels] : labels, series: 0,
        valueLabel: valued ? valued.label : null,
      };
    }

    if (srcMod?.produces === "features") {
      // Standalone: its own parameter list, no prelude.
      const fParams = [];
      const fBind = (v) => { fParams.push(v); return `$${fParams.length}`; };
      const built = srcMod.compileStandalone(srcStep, {
        resolved, bind: fBind, featureSource: (id, field) => featureSource(id, field, fBind),
      });
      return {
        id: out.id, step: srcStep.id, mode: "features",
        sql: built.sql, params: fParams, labels: built.labels, series: 0,
      };
    }

    if (srcMod?.produces === "factors") {
      // A computed result: SQL assembles the county x variable matrix, and the
      // op's compute() turns it into the ranked table after execution.
      const inputId = (srcStep.inputs || [])[0];
      const { params, declared, bind } = preludeFor(inputId);
      const built = srcMod.compileStandalone(srcStep, {
        declared, bind, resolved, input: cte(inputId),
      });
      return {
        id: out.id, step: srcStep.id, mode: "factors", op: srcStep.op,
        sql: built.sql, params, columns: built.columns,
        factors: srcStep.factors, series: 0, statColumns: [],
      };
    }

    const from = cte(srcId);
    const { sql: prelude, params, hasSecond, statColumns, rowColumns, summaryColumns } =
      preludeFor(srcId);

    // Aggregates with group_by=none yield a single NULL-fips row, so join to
    // geometry with LEFT JOIN rather than dropping it.
    //
    // The cap must clear the number of counties, or a national choropleth is
    // structurally incomplete. At the previous LIMIT 1000 a county map rendered
    // 1,000 of 3,233 counties and the other 69% drew as "no data" -- which
    // looks exactly like missing coverage rather than a truncated result.
    // `rank` applies its own LIMIT upstream, so "top 10" is unaffected.
    const sql =
      prelude +
      `SELECT r.fips, g.name, g.state_fp, r.value,\n` +
      (hasSecond ? `       r.value_b,\n` : "") +
      [...statColumns, ...rowColumns, ...summaryColumns].map(c => `       r.${c},\n`).join("") +
      `       CASE WHEN g.geom IS NULL THEN NULL ELSE ST_AsGeoJSON(g.geom) END AS geometry\n` +
      `FROM ${from} r\n` +
      // Another level draws from geo_unit, at its z12 display tier: full
      // TIGER tract geometry is ~85% of geo_unit's 4.7 GB. The level is from a
      // closed set (planner/levels.js), so it is inlined, not bound.
      (level === "county"
        ? `LEFT JOIN county_geom g USING (fips)\n`
        : `LEFT JOIN (SELECT geoid AS fips, name, state_fp, COALESCE(geom_z12, geom) AS geom ` +
          `FROM geo_unit WHERE level = '${level}') g USING (fips)\n`) +
      `ORDER BY r.value DESC NULLS LAST\n` +
      `LIMIT ${MAX_RESULT_ROWS}`;

    return {
      id: out.id, step: srcId, mode: "values",
      sql, params, series: hasSecond ? 2 : 1,
      // The unit each row is: "county", or a level the question named.
      level,
      // Named extra columns of a one-row statistic, e.g. correlate's n and
      // p_value. Empty for every per-county layer.
      statColumns,
      rowColumns, summaryColumns,
      // Which group is which, named from the plan's own filters ("South",
      // "mostly rural"), never from model text. Only for compare_groups.
      groupLabels: summaryColumns.length
        ? Object.fromEntries((srcStep.inputs || []).map((id, i) =>
            [i === 0 ? "a" : "b", describeGroup(id, byId) || (i === 0 ? "group A" : "group B")]))
        : null,
      // True for a layer the compiler added to show a combine's inputs, so the
      // UI can label it as a component rather than as the answer.
      part: out.part === true,
      // How the layer should be READ, declared by the op that produced it.
      // hotspot and outlier emit values signed around zero, and drawing those
      // on the sequential ramp would paint a cold spot and a hot spot as two
      // shades of the same colour. The frontend cannot infer this from the
      // numbers alone -- a series that happens to be all-positive is still a
      // diverging measure -- so it travels with the layer.
      op: srcStep.op,
      diverging: srcMod?.diverging === true,
      valueLabel: srcMod?.valueLabel ?? null,
    };
  });

  // Single-output plans keep the flat shape every existing caller reads. A
  // multi-output plan surfaces the first layer the same way, so nothing that
  // ignores `outputs` silently gets nothing.
  const first = outputs[0];
  return {
    outputs,
    sql: first.sql,
    params: first.params,
    mode: first.mode,
    series: first.series,
    labels: first.labels,
    finalStep: first.step,
  };
}

/**
 * Compile a lone `select_features` step. Retained as a named export because it
 * is the documented entry point for the features shape; the work now lives on
 * the op module.
 */
function compileFeatureSelect(step, resolved) {
  const params = [];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  const featureSource = (attrId, field = "attr_id") => {
    const src = resolved.get(attrId);
    if (!src) throw new CompileError(`unresolved ${field} ${attrId}`);
    return src;
  };
  const built = ops.byName("select_features")
    .compileStandalone(step, { resolved, bind, featureSource });
  return { ...built, params, finalStep: step.id };
}

module.exports = {
  compilePlan, compileFeatureSelect, CompileError,
  OPERATORS, AGGREGATES, MAX_FEATURES, MAX_RESULT_ROWS,
};
