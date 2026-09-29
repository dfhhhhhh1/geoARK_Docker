const { CompileError, PLACE_KINDS, PLACE_OVERLAP_MIN } = require("./_sql");
const { toFipsPrefixes } = require("../../states");

/**
 * Keep only counties inside a named boundary: a city, a ZIP code, a metro.
 * Until place_geom existed, county_geom was the only administrative geometry
 * and this could not be expressed at all.
 */
module.exports = {
  name: "filter_place",
  inputs: 1,
  needs: ["place_kind", "place_name"],
  produces: "series",
  kind: "sql",

  enumComment: "keep only counties inside a named city/ZIP/metro",
  promptLine: `  filter_place needs place_kind and place_name, 1 input
                 -> keep only counties inside a named city, ZIP code or metro.
                 place_kind is one of: place (city or town), zcta (ZIP code),
                 cbsa (metro area), urban (urbanized area). Place names repeat:
                 22 cities are called Springfield, so set "states" as well when
                 the question names one.`,
  choiceLine: `  "in Springfield", "in ZIP 63101", "in the Chicago metro" -> filter_place`,

  // Needs both a place in the question AND boundaries loaded. An install
  // without place_geom would otherwise be offered an op that can only fail.
  offered: (ctx) => ctx.mentionsArea && ctx.hasPlaceBoundaries,

  examples: [{ text:
`QUESTION: median household income for counties in the Springfield, Missouri area
  (a2 = median household income)
PLAN: {"intent":"Median household income for counties around Springfield, Missouri",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"filter_place","attr_id":"","inputs":["s1"],
           "place_kind":"place","place_name":"Springfield","states":["Missouri"]},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` }],

  /**
   * A place name must have the shape its kind implies.
   *
   * place_name is free text for the same reason `city` is: 32,642 place names
   * cannot be an enum. So it gets the same backstop, with one difference -- a
   * ZCTA's name is a ZIP code, all digits, which the place-name pattern would
   * reject.
   *
   * This runs whether or not the step's attr_id resolved: filter_place carries
   * attr_id "" by schema convention, and when these checks lived in a loop that
   * began `if (!src) continue` they were skipped entirely. Two rejection tests
   * caught it, and the registry now runs op validation unconditionally.
   */
  validate(step) {
    if (!step.place_name) return [];
    const value = String(step.place_name);
    const ok = step.place_kind === "zcta"
      ? /^\d{5}$/.test(value)
      : /^[A-Za-z0-9]([A-Za-z0-9 .'\-]*[A-Za-z0-9])?$/.test(value);
    if (ok) return [];
    return [
      `step "${step.id}": place_name ${JSON.stringify(value)} does not look like ` +
      (step.place_kind === "zcta"
        ? `a 5-digit ZIP code.`
        : `a place name. Give the name alone, e.g. "Springfield", and put ` +
          `any state in "states".`),
    ];
  },

  compile(step, ctx) {
    // EXISTS rather than a join: a city can span several counties (Springfield
    // MO covers Greene and Christian), and a join would emit a county once per
    // intersecting polygon, silently duplicating its value into every
    // downstream aggregate.
    const kind = String(step.place_kind || "");
    if (!PLACE_KINDS.includes(kind)) {
      throw new CompileError(`unsupported place_kind ${step.place_kind}`);
    }
    // Metro and urban-area names are compound: the Chicago CBSA is stored as
    // "Chicago-Naperville-Elgin, IL-IN" and the urban area as "Chicago, IL--IN",
    // so an equality test on "Chicago" matched nothing and the answer came back
    // empty rather than wrong -- which at least failed visibly, but failed.
    //
    // So: exact, or the name followed by a separator. "Chicago" matches both of
    // those; "Springfield" still does NOT match "Springfield Gardens", because
    // a space is not a separator here. The validator has already restricted
    // place_name to letters, digits, space, dot, apostrophe and hyphen, so it
    // cannot carry a LIKE wildcard.
    const nameParam = ctx.bind(String(step.place_name || ""));
    const conds = [
      `p.kind = ${ctx.bind(kind)}`,
      `(lower(p.name) = lower(${nameParam})` +
      ` OR lower(p.name) LIKE lower(${nameParam}) || '-%'` +
      ` OR lower(p.name) LIKE lower(${nameParam}) || ', %')`,
    ];
    // A state narrows an ambiguous name. 22 places are called Springfield, and
    // without this the filter keeps counties in all 22.
    if (Array.isArray(step.states) && step.states.length) {
      const { codes, unknown } = toFipsPrefixes(step.states);
      if (unknown.length) {
        throw new CompileError(`unknown state or region: ${unknown.join(", ")}`);
      }
      conds.push(`p.state_fp IN (${codes.map(c => ctx.bind(c)).join(", ")})`);
    }

    // A REAL overlap, not a shared edge or a generalization sliver.
    //
    // Plain ST_Intersects gave 27 counties for the Chicago metro, which is
    // defined as 13 whole counties: the CBSA and county layers are drawn at
    // different generalizations, so every neighbour clips a few metres in.
    // ST_Touches does not help, because those slivers have area.
    //
    // Measured: Springfield MO is 99.9914% inside Greene and 0.0086% inside
    // Christian, and that 0.0086% is an artifact rather than a municipal
    // extension. One percent of the SMALLER geometry separates the two cases
    // cleanly and is size-agnostic: for a metro the smaller side is the county
    // (so a sliver county is excluded), for a city it is the city (so a county
    // genuinely containing part of it is kept).
    //
    // The && prefilter stays first so the GIST index is used before the
    // expensive ST_Intersection runs.
    return `${ctx.name} AS (SELECT r.fips, r.value FROM ${ctx.ins[0]} r ` +
           `WHERE EXISTS (SELECT 1 FROM place_geom p JOIN county_geom c ` +
           `ON c.geom && p.geom AND ST_Intersects(c.geom, p.geom) ` +
           `AND ST_Area(ST_Intersection(c.geom, p.geom)) > ` +
           `${PLACE_OVERLAP_MIN} * LEAST(ST_Area(c.geom), ST_Area(p.geom)) ` +
           `WHERE c.fips = r.fips AND ${conds.join(" AND ")}))`;
  },
};
