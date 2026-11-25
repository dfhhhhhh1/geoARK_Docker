/**
 * Composite index (docs/GIS_OPS_PLAN.md H6 tier 1, item 4).
 *
 * "Rank Missouri counties by poverty, uninsured rate and distance to the
 * nearest hospital" is ONE score built from several measures. Before this the
 * planner could only rank by one of them, or `join` two side by side.
 *
 * THE MODEL CHOOSES THE MEASURES AND NOTHING ELSE. It emits `composite` with
 * one input per measure the question lists. Everything an analyst would call
 * the method is read from the question here, in code, and echoed back to the
 * user so they can change it:
 *
 *   weights      four tiers, highest first:
 *                  1. stated   "transit at 50%, poverty at 30%", "flood risk
 *                               twice as important as income" (several such
 *                               ratios are solved as AHP pairwise judgments)
 *                  2. emphasis "primarily X, also considering Y": 2 to 1
 *                  3. a published index named by the question is NOT rebuilt
 *                     here: the gate needs the question to list its criteria
 *                  4. equal    1/N, the default (CDC SVI's convention), never
 *                               a guessed hidden weighting
 *   directions   "high" (more of the measure scores higher) unless the
 *                question says otherwise next to that measure: "low income",
 *                "close to transit", "few hospitals"
 *   method       sum (compensatory: a high A offsets a low B), geometric (a
 *                zero in any input zeroes the score), minimum (the
 *                bottleneck: the score is the worst input) or count (how
 *                many inputs pass their own stated threshold, 0 to N: an
 *                accumulated-inequity score of yes/no flags)
 *   standardize  percentile rank (default, as SVI), z-score or min-max
 *
 * Threshold masking ("only counties where poverty is above 20%") is a
 * filter_attr on that input before the composite: the composite is an INNER
 * join, so a unit that fails the threshold has no score at all.
 *
 * Scores are standardized over the units the composite actually sees, so a
 * place filter planned AFTER the composite is moved before it
 * (`scoreWithinArea`): "the most vulnerable Missouri counties" ranks Missouri
 * counties against each other, the way SVI's state files do, unless the
 * question asks for a national comparison.
 */

const MAX_INPUTS = 6;
// A count of yes/no flags is not weighted, so it is not held to the 6-input
// cap; 12 covers the 11-factor accumulated-inequity scores in the literature.
const MAX_COUNT_INPUTS = 12;
const METHODS = ["sum", "geometric", "minimum", "count"];
const STANDARDIZE = ["percentile", "zscore", "minmax"];
const DIRECTIONS = ["high", "low"];

// --- the gate --------------------------------------------------------------

// Words that ask for one score out of several measures.
const COMPOSITE_WORD =
  /\b(?:composite|multi[- ]?criteria|multiple\s+criteria|weighted\s+(?:index|score|sum|average|mean|overlay|ranking|combination)|combined\s+(?:index|score|ranking|rank)|(?:index|score)\s+(?:that\s+)?(?:combin(?:es|ing)|made\s+(?:up\s+)?(?:of|from)|built\s+from|based\s+on|using|from))\b/i;

// What a score is FOR: ranking, prioritising, vulnerability, suitability.
const SCORE_INTENT =
  /\b(?:rank|ranks|ranked|ranking|score|scores|scoring|index|prioriti[sz]e|prioriti[sz]ing|priority|most\s+(?:vulnerable|suitable|at[- ]risk|in\s+need|disadvantaged|deprived|underserved)|vulnerab\w*|suitab\w*|best|worst)\b/i;

// What introduces the criteria list.
const INTRODUCER =
  /\b(?:by|based\s+on|using|considering|combining|combine|combines|taking\s+into\s+account|accounting\s+for|in\s+terms\s+of|weighting|weighted\s+by|(?:index|score|composite|ranking)\s+of|(?:all|both)\s+(?:(?:two|three|four|five|six)\s+)?of|(?:score|scores|scored|scoring|rate|rated|rank|ranked)\s+(?:[\w-]+\s+){0,4}?on)\s+/gi;

// Stated relative importance, which is a composite on its own.
const WEIGHT_CUE =
  /\b(?:twice|thrice|half|double|triple|\d+(?:\.\d+)?\s*(?:times|x)|(?:two|three|four|five)\s+times)\s+(?:as\s+)?(?:important|much\s+weight|heavily|significant|the\s+weight)\b|\bweight(?:ed|ing|s)?\b[^.?!]*?\b\d+(?:\.\d+)?\s*(?:%|percent\b)|\b(?:double|triple|more|extra|less)\s+(?:the\s+)?weight\s+(?:on|to|for)\b/i;

// List items that are units or places, not criteria ("by state and county").
const NOT_CRITERION =
  /^(?:the\s+)?(?:count(?:y|ies)|states?|tracts?|census\s+tracts?|zip(?:\s*codes?)?|regions?|cit(?:y|ies)|towns?|year|years|population\s+size|size)$/i;

/** The criteria lists in a question: arrays of item strings, one per introducer. */
function criteriaLists(query) {
  const q = String(query || "");
  const out = [];
  for (const m of q.matchAll(INTRODUCER)) {
    let rest = q.slice(m.index + m[0].length);
    // The list ends at a sentence end, or where a place or follow-on clause starts.
    rest = rest.split(/[?.!;]|\s+(?:in|for|within|across|among|where|which|that|so|to\s+find|to\s+identify|to\s+decide)\s+(?=[A-Z]|the\s+[A-Z]|each|every|all\b)/)[0];
    const items = rest.split(/\s*,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+as\s+well\s+as\s+|\s+plus\s+/i)
      .map(s => s.trim()).filter(Boolean)
      .filter(s => !NOT_CRITERION.test(s));
    if (items.length >= 2) out.push(items);
  }
  return out;
}

/**
 * Whether the composite op is on offer for this question.
 *
 *   - a stated weight ("twice as important", "poverty at 30% weight"), or
 *   - a composite word AND a list of at least two criteria, or
 *   - a scoring intent (rank, index, most vulnerable, best) AND a list of at
 *     least three criteria, or of two when the question also says index,
 *     score or combine.
 *
 * "Composite" alone is not enough: "FEMA's composite risk value" names a
 * published measure, and a published index is loaded, never rebuilt.
 */
/**
 * How many measures a question lists: the longest criteria list, or the number
 * of stated thresholds ("poverty above 15%, ..., no vehicle above 15%"),
 * whichever is larger. 0 when it lists none. Used to size retrieval.
 */
function listedMeasureCount(query) {
  const q = String(query || "");
  if (!q) return 0;
  const longest = criteriaLists(q).reduce((n, l) => Math.max(n, l.length), 0);
  return Math.max(longest, statedThresholds(q).length);
}

function asksComposite(query) {
  const q = String(query || "");
  if (!q) return false;
  if (WEIGHT_CUE.test(q)) return true;
  // "how many of these thresholds each county meets: poverty above 15%, ..."
  if (COUNT_METHOD.test(q) && statedThresholds(q).length >= 2) return true;
  const lists = criteriaLists(q);
  const longest = lists.reduce((n, l) => Math.max(n, l.length), 0);
  if (COMPOSITE_WORD.test(q) && longest >= 2) return true;
  if (!SCORE_INTENT.test(q)) return false;
  if (longest >= 3) return true;
  return longest >= 2 && /\b(?:index|score|combin\w*|composite|overall)\b/i.test(q);
}

// --- words -----------------------------------------------------------------

const STOP = new Set(("a an the of to for in on at by with and or as is are be been being that this these " +
  "those it its their there from into than then more most less least very much many each every per all any " +
  "which what who whom where when how rank ranks ranking ranked score scores index composite weight weights " +
  "weighted weighting important importance twice double half times primarily mainly mostly especially " +
  "particularly also considering consider consideration account accounting focus focusing emphasis emphasize " +
  "emphasise priority prioritize prioritise counties county tract tracts state states make give should would " +
  "could count counts percent pct estimate estimates total rate rates share number level levels value values " +
  "high higher highest low lower lowest using based combine combining combined while plus well secondary " +
  "lesser extent degree").split(/\s+/));

const stem = (w) => {
  let s = String(w || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (s.length > 5 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 4 && s.endsWith("es") && !s.endsWith("ses")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
};
const words = (text) => String(text || "").toLowerCase().split(/[^a-z0-9%]+/).filter(Boolean);
const content = (text) => words(text).map(stem).filter(w => w.length > 2 && !STOP.has(w) && !/^\d/.test(w));

// Words that make a distance input mean "how close" or "how far".
const NEAR_WORDS = new Set(["near", "nearer", "nearby", "close", "closer", "closeness", "proximity", "proximate",
  "access", "accessible", "accessibility", "walkable", "walking", "reach", "reachable", "within"]);
const FAR_WORDS = new Set(["far", "farther", "farthest", "further", "furthest", "distance", "distant", "remote",
  "remoteness", "isolated", "isolation", "lack", "lacking", "poor", "limited", "without", "away"]);
const LOW_WORDS = new Set(["low", "lower", "lowest", "least", "less", "fewer", "fewest", "few", "little",
  "minimal", "small", "smaller", "smallest", "short", "shorter", "shortest", "cheap", "cheaper"]);
// Negations flip a COUNT ("counties without a hospital", "a lack of
// pharmacies") but name a rate's own subject: "adults without health
// insurance" IS the uninsured rate, "limited English" is the measure. On a
// value input they are never a direction (the Missouri dev question read the
// uninsured rate inverted until this was split out, 2026-11-21 dry run).
const NEG_WORDS = new Set(["lack", "lacking", "limited", "without", "no", "scarce", "scarcity"]);
const HIGH_WORDS = new Set(["high", "higher", "highest", "most", "more", "many", "great", "greater", "greatest",
  "large", "larger", "largest", "long", "longer", "longest", "heavy", "elevated", "abundant"]);

// Extra vocabulary an input carries because of its op, not its label.
const OP_TERMS = {
  nearest_distance: ["distance", "nearest", "closest", "near", "close", "proximity", "access", "far", "mile", "travel"],
  count_features: ["number", "count", "many"],
  count_near: ["number", "count", "many", "near", "within"],
  per_area: ["density", "dense", "square", "mile"],
};

// --- the inputs ------------------------------------------------------------

// Ops that pass their input's measure through unchanged in kind.
const PASS = new Set(["filter_area", "filter_place", "filter_attr", "rank", "intersect", "per_area",
  "normalize", "aggregate_to", "neighbors"]);

/** The step that names an input's measure, walking back through filters. */
function rootOf(id, byId) {
  let st = byId.get(id);
  const ops = [];
  for (let guard = 0; st && guard < 20; guard++) {
    ops.push(st.op);
    if (st.attr_id || !PASS.has(st.op) || !(st.inputs || []).length) break;
    st = byId.get(st.inputs[0]);
  }
  return { root: st || null, ops };
}

/**
 * What each composite input is, for grounding: its label and the words that
 * can refer to it.
 *
 * `info(attrId)` -> { name, text } (catalog name, and description + dataset +
 * tags); `phrasesOf(attrId)` -> question phrases the relevance and named-data
 * checks tied to that attribute. Those phrases are the strongest evidence of
 * what words in THIS question mean this input ("transit" for a public
 * transportation measure), so they count double.
 */
function describeInputs(step, byId, { info = () => null, phrasesOf = () => [] } = {}) {
  return (step.inputs || []).map((id) => {
    const { root, ops } = rootOf(id, byId);
    const attr = root?.attr_id || "";
    const meta = (attr && info(attr)) || {};
    const phrases = (attr && phrasesOf(attr)) || [];
    const opTerms = ops.flatMap(o => OP_TERMS[o] || []).concat(root ? OP_TERMS[root.op] || [] : []);
    const base = content(`${meta.name || ""} ${meta.text || ""}`);
    const strong = content(phrases.join(" "));
    const name = root?.op === "nearest_distance" ? `distance to the nearest ${meta.name || attr}`
      : root?.op === "count_features" ? `number of ${meta.name || attr}`
      : (meta.name || attr || id);
    return {
      id, attr, op: root?.op || null, name,
      terms: new Set([...base, ...opTerms.map(stem)]),
      strong: new Set(strong),
      // The catalog's own words, unstemmed, for telling a name from a cue.
      nameWords: new Set(words(`${meta.name || ""} ${meta.text || ""}`)),
      isDistance: root?.op === "nearest_distance" || ops.includes("nearest_distance"),
      isCount: ["count_features", "count_near"].includes(root?.op),
    };
  });
}

/** Which input a piece of question text refers to: index, or null if none or tied. */
function groundText(text, inputs) {
  const ws = content(text);
  if (!ws.length) return null;
  const scores = inputs.map(inp => ws.reduce((n, w) => n + (inp.strong.has(w) ? 2 : inp.terms.has(w) ? 1 : 0), 0));
  const best = Math.max(...scores);
  if (best <= 0) return null;
  const at = scores.map((s, i) => (s === best ? i : -1)).filter(i => i >= 0);
  return at.length === 1 ? at[0] : null;
}

// --- weights ---------------------------------------------------------------

const NUM_WORDS = { two: 2, three: 3, four: 4, five: 5, twice: 2, double: 2, thrice: 3, triple: 3, half: 0.5 };

// A percentage that is a threshold, not a weight: "poverty above 20%".
const THRESHOLD_BEFORE = /(?:above|below|over|under|exceed\w*|more\s+than|less\s+than|fewer\s+than|at\s+least|at\s+most|greater\s+than|higher\s+than|lower\s+than|[<>]=?|than)\s*$/i;

/** Clauses: the pieces a list or a sentence splits into. */
const clauses = (q) => String(q).split(/[,;:]|\s+and\s+|\s+while\s+|\s+plus\s+|\s+but\s+/i).map(s => s.trim()).filter(Boolean);

/** Stated percentages or fractions per input: { byInput: Map<i, number>, unmatched: string[] }. */
function statedShares(query, inputs) {
  const q = String(query || "");
  if (!/\bweight|\bimportan|\bcounts?\s+for\b|\bworth\b/i.test(q)) return null;
  const byInput = new Map();
  const unmatched = [];
  for (const c of clauses(q)) {
    const m = c.match(/(\d+(?:\.\d+)?)\s*(%|percent\b)/i);
    if (!m) continue;
    if (THRESHOLD_BEFORE.test(c.slice(0, m.index))) continue;
    const i = groundText(c.replace(m[0], " "), inputs);
    if (i === null || byInput.has(i)) { unmatched.push(c); continue; }
    byInput.set(i, Number(m[1]));
  }
  return byInput.size || unmatched.length ? { byInput, unmatched } : null;
}

// "A is twice as important as B", "give A three times the weight of B",
// "weight A twice as heavily as B", "A should count half as much as B".
const RATIO = /\b(twice|thrice|half|double|triple|(\d+(?:\.\d+)?)\s*(?:times|x)|(two|three|four|five)\s+times)\s+(?:as\s+(?:important|much|heavily|significant)|the\s+(?:weight|importance))\s+(?:as|of|than)\s+/gi;

/** Pairwise ratio judgments: [{ a, b, r }] meaning w_a / w_b = r. */
function ratioJudgments(query, inputs) {
  const q = String(query || "");
  const out = [], unmatched = [];
  for (const m of q.matchAll(RATIO)) {
    const r = m[2] ? Number(m[2]) : NUM_WORDS[(m[3] || m[1]).toLowerCase()];
    const before = q.slice(0, m.index).split(/[,;:.?!]|\s+and\s+/i).pop();
    const after = q.slice(m.index + m[0].length).split(/[,;:.?!]|\s+and\s+/i)[0];
    const a = groundText(before, inputs), b = groundText(after, inputs);
    if (a === null || b === null || a === b || !(r > 0)) { unmatched.push(m[0].trim()); continue; }
    out.push({ a, b, r });
  }
  // "double weight on A", "give A double weight", "A should count double".
  for (const m of q.matchAll(/\b(double|triple|twice\s+the|extra)\s+(?:the\s+)?weight(?:ing)?\s+(?:on|to|for)\s+([^,;.?!]+)/gi)) {
    const a = groundText(m[2].split(/\s+and\s+/i)[0], inputs);
    if (a === null) { unmatched.push(m[0].trim()); continue; }
    out.push({ a, b: null, r: m[1].toLowerCase() === "triple" ? 3 : 2 });
  }
  for (const m of q.matchAll(/([^,;.?!]+?)\s+(?:should\s+)?(?:counts?|weighs?|weighted)\s+(double|twice|triple)\b(?!\s+as)/gi)) {
    const a = groundText(m[1].split(/\s+and\s+/i).pop(), inputs);
    if (a === null) { unmatched.push(m[0].trim()); continue; }
    out.push({ a, b: null, r: m[2].toLowerCase() === "triple" ? 3 : 2 });
  }
  return { judgments: out, unmatched };
}

/**
 * Weights from pairwise judgments, AHP-style.
 *
 * Judgments against "the rest" (b === null) are judgments against every input
 * that has no other judgment of its own. The priority vector is the
 * logarithmic least-squares solution, which works for an incomplete set and,
 * for a complete reciprocal matrix, is the row geometric mean, one of the two
 * standard AHP prioritisations. When every pair is judged (n >= 3) the
 * consistency ratio is reported against Saaty's random index: CR >= 0.10 means
 * the judgments contradict each other and the user is told so.
 */
function ahpWeights(n, judgments) {
  const mentioned = new Set(judgments.flatMap(j => (j.b === null ? [j.a] : [j.a, j.b])));
  const pairs = [];
  for (const j of judgments) {
    if (j.b !== null) { pairs.push([j.a, j.b, j.r]); continue; }
    for (let k = 0; k < n; k++) if (k !== j.a && !mentioned.has(k)) pairs.push([j.a, k, j.r]);
    // Against the rest, when every other input was also mentioned: against each.
    if (![...Array(n).keys()].some(k => k !== j.a && !mentioned.has(k))) {
      for (let k = 0; k < n; k++) if (k !== j.a && !judgments.some(o => o.a === k && o.b === null)) pairs.push([j.a, k, j.r]);
    }
  }
  if (!pairs.length) return null;
  // Connected? Every input must be reachable through judgments, else a free
  // weight would default to whatever the solver started from.
  const adj = Array.from({ length: n }, () => new Set());
  for (const [a, b] of pairs) { adj[a].add(b); adj[b].add(a); }
  const seen = new Set([0]), stack = [0];
  while (stack.length) for (const k of adj[stack.pop()]) if (!seen.has(k)) { seen.add(k); stack.push(k); }
  if (seen.size < n) return { incomplete: true };
  // Log least squares: minimise sum (x_a - x_b - ln r)^2, x_0 fixed by sum 0.
  // Normal equations, solved by Gauss-Seidel (n <= 6).
  const x = new Array(n).fill(0);
  for (let it = 0; it < 500; it++) {
    for (let k = 0; k < n; k++) {
      let num = 0, den = 0;
      for (const [a, b, r] of pairs) {
        if (a === k) { num += x[b] + Math.log(r); den++; }
        else if (b === k) { num += x[a] - Math.log(r); den++; }
      }
      if (den) x[k] = num / den;
    }
    const mean = x.reduce((s, v) => s + v, 0) / n;
    for (let k = 0; k < n; k++) x[k] -= mean;
  }
  const e = x.map(Math.exp);
  const sum = e.reduce((s, v) => s + v, 0);
  const weights = e.map(v => v / sum);
  // Consistency, only when every pair was judged directly.
  let cr = null;
  const direct = new Map();
  for (const [a, b, r] of pairs) { direct.set(`${a},${b}`, r); direct.set(`${b},${a}`, 1 / r); }
  if (n >= 3 && direct.size === n * (n - 1)) {
    const RI = { 3: 0.58, 4: 0.90, 5: 1.12, 6: 1.24 };
    let lambda = 0;
    for (let i = 0; i < n; i++) {
      let row = 0;
      for (let j = 0; j < n; j++) row += (i === j ? 1 : direct.get(`${i},${j}`)) * weights[j];
      lambda += row / weights[i];
    }
    lambda /= n;
    cr = ((lambda - n) / (n - 1)) / RI[n];
  }
  return { weights, cr };
}

// "focusing primarily on X", "especially X", "above all X".
const PRIMARY = /\b(?:primarily|mainly|mostly|chiefly|especially|particularly|above\s+all|most\s+importantly|first\s+and\s+foremost|with\s+(?:an?\s+|the\s+)?(?:main\s+|primary\s+)?(?:emphasis|focus)\s+on|emphasi[sz]ing|focus(?:ing|ed)?\s+(?:mainly\s+|mostly\s+|primarily\s+)?on|prioriti[sz]ing|most\s+weight\s+(?:on|to))\s+([^,;.?!]+)/gi;
// "while also considering Y and Z", "to a lesser extent W".
const SECONDARY = /\b(?:also\s+(?:considering|consider|accounting\s+for|including|looking\s+at|factoring\s+in)|to\s+a\s+lesser\s+(?:extent|degree)(?:\s*,)?|secondarily|less\s+weight\s+(?:on|to))\s+([^;.?!]+)/gi;

/** Emphasis tiers: { primary: Set<i>, secondary: Set<i>, unmatched } or null. */
function emphasis(query, inputs) {
  const q = String(query || "");
  const primary = new Set(), secondary = new Set(), unmatched = [];
  for (const m of q.matchAll(PRIMARY)) {
    // "primarily on poverty and unemployment": every item of the list.
    for (const part of m[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)) {
      const i = groundText(part, inputs);
      if (i !== null) primary.add(i); else if (content(part).length) unmatched.push(part.trim());
    }
  }
  for (const m of q.matchAll(SECONDARY)) {
    for (const part of m[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)) {
      const i = groundText(part, inputs);
      if (i !== null && !primary.has(i)) secondary.add(i);
    }
  }
  if (!primary.size && !secondary.size) return unmatched.length ? { primary, secondary, unmatched } : null;
  return { primary, secondary, unmatched };
}

/** A weight as a readable share: 0.5 -> "50%", 1/3 -> "33%". */
const pct = (w) => `${Math.round(w * 1000) / 10}%`.replace(/\.0%$/, "%");

/**
 * The weights for a composite step, by tier: { weights, how, notes }.
 * `weights` sum to 1.
 */
function readWeights(query, inputs) {
  const n = inputs.length;
  const notes = [];
  const equal = () => new Array(n).fill(1 / n);

  // Tier 1a: stated shares.
  const shares = statedShares(query, inputs);
  if (shares && shares.byInput.size) {
    if (shares.unmatched.length) {
      notes.push(`could not tell which measure ${shares.unmatched.map(s => `"${s}"`).join(", ")} ` +
                 `refers to, so the stated weights were not applied; equal weights used`);
      return { weights: equal(), how: "equal", notes };
    }
    const stated = [...shares.byInput.values()].reduce((s, v) => s + v, 0);
    const w = new Array(n).fill(null);
    for (const [i, v] of shares.byInput) w[i] = v;
    const rest = w.filter(v => v === null).length;
    if (rest) {
      // "poverty at 50%" with three measures: the other half is split equally.
      const left = Math.max(0, 100 - stated);
      if (left === 0) notes.push(`the stated weights already total ${stated}%, so ${rest} unweighted measure(s) get 0`);
      for (let i = 0; i < n; i++) if (w[i] === null) w[i] = left / rest;
    } else if (Math.abs(stated - 100) > 0.5) {
      notes.push(`the stated weights total ${stated}%, rescaled to 100%`);
    }
    const sum = w.reduce((s, v) => s + v, 0);
    if (!(sum > 0)) return { weights: equal(), how: "equal", notes: [...notes, "stated weights are all zero; equal weights used"] };
    return { weights: w.map(v => v / sum), how: "stated", notes };
  }

  // Tier 1b: stated ratios ("twice as important"), solved as AHP judgments.
  const { judgments, unmatched } = ratioJudgments(query, inputs);
  if (unmatched.length && !judgments.length) {
    notes.push(`could not tell which measures ${unmatched.map(s => `"${s}"`).join(", ")} compares, ` +
               `so equal weights were used`);
    return { weights: equal(), how: "equal", notes };
  }
  if (judgments.length) {
    const ahp = ahpWeights(n, judgments);
    if (!ahp || ahp.incomplete) {
      // Inputs no judgment reaches are each worth "1" against the rest.
      const w = new Array(n).fill(1);
      for (const j of judgments) if (j.b === null) w[j.a] = j.r;
      const linked = judgments.filter(j => j.b !== null);
      if (linked.length) {
        notes.push("the stated comparisons do not relate every measure, so the unrelated ones are weighted 1");
        for (const j of linked) w[j.a] = j.r * w[j.b];
      }
      const sum = w.reduce((s, v) => s + v, 0);
      return { weights: w.map(v => v / sum), how: "stated", notes };
    }
    if (ahp.cr !== null && ahp.cr >= 0.1) {
      notes.push(`the stated comparisons are inconsistent (AHP consistency ratio ${ahp.cr.toFixed(2)}, ` +
                 `above 0.10); weights are their best fit`);
    }
    return { weights: ahp.weights, how: ahp.cr !== null ? "pairwise" : "stated", notes, cr: ahp.cr };
  }

  // Tier 2: emphasis words.
  const em = emphasis(query, inputs);
  if (em && (em.primary.size || em.secondary.size)) {
    const w = inputs.map((_, i) => em.primary.size
      ? (em.primary.has(i) ? 2 : 1)
      : (em.secondary.has(i) ? 1 : 2));
    const sum = w.reduce((s, v) => s + v, 0);
    if (w.every(v => v === w[0])) return { weights: equal(), how: "equal", notes };
    notes.push("emphasis words read as 2 to 1");
    return { weights: w.map(v => v / sum), how: "emphasis", notes };
  }

  // Asked for a data-driven scheme that is not implemented: say so.
  if (/\b(?:entropy|pca|principal\s+components?|factor\s+analysis|data[- ]driven\s+weights?|weights?\s+(?:derived\s+)?(?:from|based\s+on)\s+the\s+data)\b/i.test(String(query))) {
    notes.push("weights derived from the data (entropy, PCA) are not supported; equal weights used");
  }
  // Tier 4: equal.
  return { weights: equal(), how: "equal", notes };
}

// --- thresholds (method "count") ---------------------------------------------

// A comparison word and a number: "above 15%", "less than 3.75", "> 5000".
const CMP_WORDS = [
  [/^(?:at\s+least|>=|no\s+(?:less|fewer)\s+than)$/i, ">="],
  [/^(?:at\s+most|<=|no\s+more\s+than)$/i, "<="],
  [/^(?:above|over|exceed\w*|more\s+than|greater\s+than|higher\s+than|>)$/i, ">"],
  [/^(?:below|under|less\s+than|fewer\s+than|lower\s+than|<)$/i, "<"],
];
const CMP_NUM = /(at\s+least|at\s+most|no\s+(?:less|fewer|more)\s+than|above|over|exceed\w*|more\s+than|greater\s+than|higher\s+than|below|under|less\s+than|fewer\s+than|lower\s+than|>=|<=|>|<)\s*\$?(-?\d[\d,]*(?:\.\d+)?)\s*(%|percent\b|k\b|thousand\b)?/gi;

/** Every "comparison number" in the text: [{operator, value, at, end}]. */
function statedThresholds(text) {
  const out = [];
  for (const m of String(text || "").matchAll(CMP_NUM)) {
    const w = m[1].replace(/\s+/g, " ").toLowerCase();
    const operator = (CMP_WORDS.find(([re]) => re.test(w)) || [])[1];
    if (!operator) continue;
    let value = Number(m[2].replace(/,/g, ""));
    if (/^(k|thousand)$/i.test(m[3] || "")) value *= 1000;
    if (!Number.isFinite(value)) continue;
    out.push({ operator, value, at: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * The threshold the question states for each input, or null: a comparison
 * belongs to the input its own clause names ("poverty above 15%").
 */
function readThresholds(query, inputs) {
  const found = new Array(inputs.length).fill(null);
  for (const c of clauses(query)) {
    const ts = statedThresholds(c);
    if (ts.length !== 1) continue;
    const i = groundText(c.slice(0, ts[0].at) + " " + c.slice(ts[0].end), inputs);
    if (i === null || found[i]) continue;
    found[i] = { operator: ts[0].operator, value: ts[0].value };
  }
  return found;
}

/**
 * For a count, a filter_attr the model put on an input ("poverty above 15%"
 * as a mask) IS that input's threshold: folding it in rewires the input past
 * the filter, so a unit that fails it scores 0 instead of vanishing. Only
 * stated-number filters fold; a percentile ("high poverty") stays a mask.
 * PURE: returns { found, inputs, drop } and changes nothing.
 */
function foldFilterThresholds(plan, c) {
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  const used = (id) => steps.some(s => s !== c && (s.inputs || []).includes(id));
  const found = [], inputs = [], drop = [];
  for (const id of c.inputs || []) {
    const f = byId.get(id);
    const value = Number(f?.value);
    if (!f || f.op !== "filter_attr" || (f.percentile !== undefined && f.percentile !== null) ||
        ![">", ">=", "<", "<="].includes(f.operator) || f.value === null || f.value === "" || !Number.isFinite(value)) {
      found.push(null); inputs.push(id); continue;
    }
    found.push({ operator: f.operator, value, ...(f.definition ? { definition: f.definition } : {}) });
    inputs.push((f.inputs || [])[0]);
    if (!used(id)) drop.push(id);
  }
  return { found, inputs, drop };
}

// --- directions, method, standardization ------------------------------------

/**
 * Which end of each input scores high.
 *
 * Default "high". "low"/"few"/"lack of" next to a measure's words flips it.
 * A distance input reads its own vocabulary: "close to", "access to",
 * "proximity to" mean nearer scores higher (low); "far from", "distance to",
 * "remote", "lack of access" keep farther scoring higher.
 */
function readDirections(query, inputs) {
  // Commas stay as tokens: a cue never reaches across one.
  const toks = String(query || "").toLowerCase().split(/(,)|[^a-z0-9,]+/).filter(Boolean);
  const stems = toks.map(stem);
  return inputs.map((inp) => {
    const own = (w) => inp.strong.has(w) || (inp.terms.has(w) && !OP_GENERIC.has(w));
    let best = null;   // { dir, gap }
    for (let t = 0; t < stems.length; t++) {
      if (!own(stems[t])) continue;
      for (let back = 1; back <= 4 && t - back >= 0; back++) {
        const w = toks[t - back];
        // A clause boundary: a cue beyond it belongs to another measure
        // ("low poverty and income" says nothing about income).
        if (/^(?:,|and|or|but|while|plus|versus|vs)$/.test(w)) break;
        // A word of the measure's own name is not a cue: "low birth weight",
        // "low-income households", "lack of health insurance".
        if (inp.nameWords.has(w)) continue;
        let dir = null;
        if (inp.isDistance) {
          if (FAR_WORDS.has(w)) dir = "high";
          else if (NEAR_WORDS.has(w)) dir = "low";
        } else if (LOW_WORDS.has(w) || (inp.isCount && NEG_WORDS.has(w))) dir = "low";
        else if (HIGH_WORDS.has(w)) dir = "high";
        // Nearest cue wins; for a distance, "far" words win a tie with "near"
        // words ("distance to the nearest" is a distance).
        if (dir && (!best || back < best.gap || (inp.isDistance && dir === "high"))) {
          best = { dir, gap: back };
        }
      }
    }
    // A distance input with no cue at all: "distance to the nearest X" reads
    // as farther = more (its value), which is the default.
    return best ? best.dir : "high";
  });
}

// Op vocabulary is for grounding, never a direction anchor on its own
// ("nearest" in "distance to the nearest hospital" is not the measure).
const OP_GENERIC = new Set(["nearest", "closest", "near", "close", "proximity", "access", "far", "distance",
  "mile", "travel", "number", "count", "many", "within", "density", "dense", "square"].map(stem));

const MIN_METHOD =
  /\b(?:bottleneck|weakest\s+(?:link|factor|input|measure)|limiting\s+factor|worst\s+of\s+(?:the|its|their)|non[- ]?compensatory|(?:can(?:not|'t)|should\s+not|shouldn'?t|must\s+not|does\s+not|doesn'?t|do\s+not|don'?t|never)\s+(?:compensate|offset|make\s+up\s+for|cancel\s+out)|(?:high|low|bad|poor|good|strong|weak)\s+(?:on|in)\s+(?:all|every|each)\s+(?:of\s+(?:them|these|the)|criteri\w+|factors?|measures?|inputs?|three|four|five)|(?:all|every|each)\s+(?:of\s+(?:them|these|the\s+\w+)|criteri\w+|factors?|measures?|inputs?)\s+(?:must|need\s+to|has\s+to|have\s+to)\b|minimum\s+(?:of\s+the\s+)?(?:scores?|percentiles?|ranks?))/i;
const GEO_METHOD =
  /\b(?:geometric(?:\s+mean)?|multiplicative|multipl(?:y|ied|ying)|product\s+of|if\s+any\s+(?:one\s+)?(?:of\s+them|factor|criterion|measure|input)\s+is\s+(?:zero|0|missing|absent|none)|any\s+(?:one\s+)?(?:factor|criterion|measure|input)\s+(?:at|of)\s+zero)\b/i;

// A score that counts flags: "how many of these thresholds each county meets",
// "number of factors above their thresholds", "accumulated inequity score".
const COUNT_METHOD =
  /\b(?:(?:how\s+many|number|count)\s+of\s+(?:the\s+|these\s+|those\s+)?(?:\w+\s+){0,2}?(?:thresholds?|criteri(?:a|on)|conditions?|factors?|indicators?|flags?|determinants?|measures?)\s+(?:\w+\s+){0,3}?(?:meets?|met|exceed\w*|pass\w*|present|crossed|above|beyond|over)|count(?:s|ing)?\s+(?:how\s+many|the\s+(?:thresholds?|criteria|conditions|factors|flags))|thresholds?\s+(?:met|exceeded|crossed)|(?:accumulat\w+|cumulative)\s+(?:\w+\s+){0,2}?(?:scores?|index|count|inequit\w*|disadvantage|burden)|(?:sum|count|tally)\s+of\s+(?:binary|yes\s*\/\s*no|0\s*\/\s*1|indicator)\s+(?:flags?|indicators?|variables?))/i;

function readMethod(query) {
  const q = String(query || "");
  if (COUNT_METHOD.test(q)) return "count";
  if (MIN_METHOD.test(q)) return "minimum";
  if (GEO_METHOD.test(q)) return "geometric";
  return "sum";
}

function readStandardize(query) {
  const q = String(query || "");
  if (/\b(?:z[- ]?scores?|standard\s+deviations?|standard\s+scores?)\b/i.test(q)) return "zscore";
  if (/\b(?:min[- ]?max|rescal\w*|scaled?\s+(?:from\s+)?0\s*(?:to|-)\s*1|0\s*(?:to|-)\s*1\s+scale|normali[sz]ed?\s+to\s+(?:0|a\s+0|the\s+range))\b/i.test(q)) return "minmax";
  return "percentile";
}

// --- the place restriction --------------------------------------------------

// The question asks for national scores even though it shows one area.
const NATIONAL = /\b(?:nationally|national\s+(?:percentile|rank|scores?|comparison)|compared\s+(?:to|with)\s+(?:the\s+(?:whole\s+)?)?(?:nation|country|us|u\.s\.|united\s+states)|relative\s+to\s+(?:the\s+)?(?:nation|country))\b/i;

/**
 * A place filter planned AFTER the composite is moved before it, onto its
 * first input, so scores rank the area's units against each other.
 *
 * Every input is inner-joined, so restricting one restricts all of them; the
 * standardization then runs over exactly the units the user asked about.
 * Returns a description, or null.
 */
function scoreWithinArea(plan, query) {
  if (NATIONAL.test(String(query || ""))) return null;
  const steps = plan.steps || [];
  const fixes = [];
  for (const c of steps.filter(s => s.op === "composite")) {
    for (;;) {
      const f = steps.find(s => ["filter_area", "filter_place"].includes(s.op) && (s.inputs || [])[0] === c.id);
      if (!f || !(c.inputs || []).length) break;
      const ci = steps.indexOf(c);
      const moved = { ...f, inputs: [c.inputs[0]] };
      // Consumers of the filter now read the composite.
      for (const s of steps) s.inputs = (s.inputs || []).map(i => (i === f.id ? c.id : i));
      steps.splice(steps.indexOf(f), 1);
      steps.splice(ci, 0, moved);
      c.inputs = [moved.id, ...c.inputs.slice(1)];
      const where = f.op === "filter_area" ? (f.states || []).join(", ") : f.place_name;
      fixes.push(`scored only the units in ${where}, so the ranks compare them with each other ` +
                 `(say "nationally" for national ranks)`);
    }
  }
  return fixes.length ? fixes.join("; ") : null;
}

// --- ranks around the composite ---------------------------------------------

// The question asks for the bottom of the score, not the top.
// Which units to LIST, never how to combine: "the lowest of its three
// percentile ranks" (the minimum method) and "at least" must not flip it.
const ASKS_LEAST =
  /\b(?<!at\s)least\s+(?:vulnerable|in\s+need|at\s+risk|deprived|disadvantaged|suitable|underserved)\b|\bbottom\s+(?:\d+|ten|five|twenty)\b|\blowest[- ](?:scor\w+|ranked|rated)\b|\bscor\w*\s+(?:the\s+)?lowest\b|\blowest\s+(?:\d+|ten|five|twenty)\b|\bbest[- ]off\b/i;

/**
 * Ranks belong after the composite, and run toward what was asked.
 *
 * A rank with a limit on an INPUT truncates it before scoring: "Georgia
 * counties high on all three of obesity, diabetes and inactivity" planned
 * rank(20) on each measure, then a composite over the few counties in all
 * three top-20s (composite_dev r3a, 2026-11-21). Such a rank is moved after
 * the composite (largest limit kept) unless one is already there.
 *
 * The score is oriented by `directions` so that high means MORE of what the
 * question asks for, so a rank right after it is descending unless the
 * question asks for the least / lowest. dev r3a: "which Kentucky counties are
 * most in need" ranked ascending once, overlap 0 with the gold top 10.
 */
function ranksAroundComposite(plan, query) {
  const steps = plan.steps || [];
  const fixes = [];
  const consumers = (id) => steps.filter(s => (s.inputs || []).includes(id));
  for (const c of steps.filter(s => s.op === "composite")) {
    const dropped = [];
    c.inputs = (c.inputs || []).map((id) => {
      const st = steps.find(s => s.id === id);
      if (st?.op !== "rank" || consumers(id).length !== 1) return id;
      dropped.push(st);
      steps.splice(steps.indexOf(st), 1);
      return st.inputs[0];
    });
    if (dropped.length) {
      let after = consumers(c.id).find(s => s.op === "rank");
      if (!after) {
        const limit = Math.max(...dropped.map(r => (Number.isInteger(r.limit) ? r.limit : 0)));
        after = { id: `${c.id}_rank`, op: "rank", attr_id: "", inputs: [c.id], direction: "desc",
                  ...(limit > 0 ? { limit } : {}) };
        for (const s of consumers(c.id)) s.inputs = s.inputs.map(i => (i === c.id ? after.id : i));
        steps.splice(steps.indexOf(c) + 1, 0, after);
      }
      fixes.push(`ranked after scoring instead of before (${dropped.length} input rank(s) would have scored only their top units)`);
    }
    const want = ASKS_LEAST.test(String(query || "")) ? "asc" : "desc";
    for (const r of consumers(c.id).filter(s => s.op === "rank")) {
      if (r.direction !== want) {
        r.direction = want;
        fixes.push(`ranked the score ${want === "desc" ? "highest first" : "lowest first"}: a higher score means more of what the question asks for`);
      }
    }
  }
  return fixes.length ? fixes.join("; ") : null;
}

/**
 * "High on all three of A, B and C ... the lowest of its three percentile
 * ranks": the bottleneck composite, which qwen3 (reasoning off) planned as
 * rank(A), rank(B), rank(C) -> intersect -> intersect in 2 of 3 dev runs with
 * composite on offer (composite_dev r3b, r3c, 2026-11-21). Top-N lists
 * intersected answer "in every top list", not a score.
 *
 * Narrow on purpose: only when the question asks for a composite AND states
 * the minimum method, the plan has no composite, and an output reads an
 * intersect tree whose leaves are distinct measures. Each leaf's rank and
 * filter_attr steps are dropped (they were the model's stand-in for "high");
 * place filters are kept. Returns a description, or null.
 */
function intersectAsComposite(plan, query) {
  const q = String(query || "");
  if (!asksComposite(q) || readMethod(q) !== "minimum") return null;
  const steps = plan.steps || [];
  if (steps.some(s => s.op === "composite")) return null;
  const byId = new Map(steps.map(s => [s.id, s]));
  const out = steps.find(s => s.op === "output" && byId.get((s.inputs || [])[0])?.op === "intersect");
  if (!out) return null;
  const root = byId.get(out.inputs[0]);
  if (root.exclude === true) return null;
  // Leaves of the intersect tree, in order.
  const leaves = [];
  const walk = (id) => {
    const st = byId.get(id);
    if (st?.op === "intersect" && st.exclude !== true) (st.inputs || []).forEach(walk);
    else leaves.push(id);
  };
  walk(root.id);
  const drop = new Set();
  const chains = leaves.map((id) => {
    let st = byId.get(id);
    while (st && ["rank", "filter_attr"].includes(st.op)) { drop.add(st.id); st = byId.get(st.inputs[0]); }
    return st?.id;
  });
  const roots = chains.map(id => rootOf(id, byId).root?.attr_id);
  if (chains.length < 2 || chains.length > MAX_INPUTS || chains.some(c => !c) ||
      new Set(roots).size !== roots.length || roots.some(r => !r)) return null;
  // Remove the intersects and the stand-ins; the composite takes the root's place.
  const isIntersect = (s) => s.op === "intersect" && byId.has(s.id) && s !== undefined;
  const comp = { id: root.id, op: "composite", attr_id: "", inputs: chains };
  const keep = steps.filter(s => !drop.has(s.id) && !(isIntersect(s) && s.id !== root.id));
  // Nothing else may read a removed step.
  const gone = new Set(steps.filter(s => !keep.includes(s)).map(s => s.id));
  if (keep.some(s => (s.inputs || []).some(i => gone.has(i)) && s.id !== root.id)) return null;
  plan.steps = keep.map(s => (s.id === root.id ? comp : s));
  // The composite must come after every chain it reads.
  const ci = plan.steps.findIndex(s => s.id === root.id);
  plan.steps.splice(ci, 1);
  const last = Math.max(...chains.map(id => plan.steps.findIndex(s => s.id === id)));
  plan.steps.splice(last + 1, 0, comp);
  return `scored each unit by the weakest of its ${chains.length} measures (a composite), ` +
         `instead of keeping units in every measure's top list`;
}

/**
 * The question names one state (or region) and the plan restricts nothing:
 * the area goes on the composite's first input, which restricts every input
 * (inner join) before scoring. "Score every Texas county on ..." planned no
 * place filter at all once, and scored all 3,132 counties nationally
 * (composite_dev r4a, 2026-11-21). Only with exactly one named area and no
 * place step anywhere, so a plan that restricts some other way is left alone.
 */
function restrictToNamedArea(plan, query) {
  return require("./area").restrictToNamedArea(plan, query, {
    op: "composite", national: NATIONAL, because: "restricted the scores to",
  });
}

// --- apply -----------------------------------------------------------------

/**
 * Set weights, directions, method and standardization on every composite step
 * from the question. Returns { fixes, notes } (strings for the response), or
 * null when the plan has no composite.
 */
function applyComposite(plan, query, deps = {}) {
  const fixes = [], notes = [];
  const asComp = intersectAsComposite(plan, query);
  if (asComp) fixes.push(asComp);
  const steps = plan.steps || [];
  const comps = steps.filter(s => s.op === "composite");
  if (!comps.length) return null;
  const ranked = ranksAroundComposite(plan, query);
  if (ranked) fixes.push(ranked);
  const moved = scoreWithinArea(plan, query);
  if (moved) fixes.push(moved);
  const area = restrictToNamedArea(plan, query);
  if (area) fixes.push(area);
  const byId = new Map(steps.map(s => [s.id, s]));
  for (const c of comps) {
    if (readMethod(query) === "count") {
      const r = applyCount(plan, c, query, deps);
      for (const n of r.notes) notes.push(n);
      if (r.fix) { fixes.push(r.fix); continue; }
    }
    const inputs = describeInputs(c, byId, deps);
    const { weights, how, notes: wn, cr } = readWeights(query, inputs);
    const directions = readDirections(query, inputs);
    let method = readMethod(query);
    if (method === "count") method = "sum";
    let standardize = readStandardize(query);
    if (method === "geometric" && standardize === "zscore") {
      standardize = "percentile";
      notes.push("a geometric mean needs non-negative scores, so percentile ranks were used instead of z-scores");
    }
    c.weights = weights.map(w => Math.round(w * 1e6) / 1e6);
    c.directions = directions;
    c.method = method;
    c.standardize = standardize;
    if (cr !== null && cr !== undefined) c.consistency_ratio = Math.round(cr * 1000) / 1000;
    if (method === "minimum" && how !== "equal") {
      notes.push("the score is each unit's weakest input, so the stated weights do not change it");
    }
    for (const n of wn) notes.push(n);
    fixes.push(describeComposite(c, inputs, how));
  }
  return { fixes, notes };
}

/**
 * method "count" on one composite step: thresholds from the model's own
 * filter_attr masks first, then from the question's words. Every input needs
 * one; otherwise NOTHING is changed and the step goes on to the weighted
 * score exactly as before, with the gap said. Returns { fix, notes }.
 */
function applyCount(plan, c, query, deps) {
  const notes = [];
  const fold = foldFilterThresholds(plan, c);
  const byId = new Map((plan.steps || []).map(s => [s.id, s]));
  const inputs = describeInputs({ ...c, inputs: fold.inputs }, byId, deps);
  const said = readThresholds(query, inputs);
  const thresholds = inputs.map((_, i) => fold.found[i] || said[i]);
  const missing = inputs.filter((_, i) => !thresholds[i]).map(x => x.name);
  if (missing.length) {
    notes.push(`a count of thresholds met needs a stated threshold for every measure, and none was found for ` +
               `${missing.join(", ")}, so a weighted score was built instead`);
    return { fix: null, notes };
  }
  if (inputs.length > MAX_COUNT_INPUTS) {
    notes.push(`a count takes at most ${MAX_COUNT_INPUTS} measures, so a weighted score was built instead`);
    return { fix: null, notes };
  }
  c.inputs = fold.inputs;
  if (fold.drop.length) plan.steps = plan.steps.filter(s => !fold.drop.includes(s.id));
  c.method = "count";
  c.thresholds = thresholds.map(t => ({ operator: t.operator, value: t.value, ...(t.definition ? { definition: t.definition } : {}) }));
  c.directions = thresholds.map(t => (t.operator.startsWith("<") ? "low" : "high"));
  c.weights = inputs.map(() => Math.round(1e6 / inputs.length) / 1e6);
  delete c.standardize;
  if (fold.found.some(Boolean)) {
    notes.push("threshold filters on the inputs became flags, so units that fail them score 0 instead of being dropped");
  }
  if (/\bweight|\btwice|\bimportan/i.test(String(query || ""))) {
    notes.push("a count of thresholds met is unweighted: each flag counts 1");
  }
  return { fix: describeComposite(c, inputs), notes };
}

const STD_LABEL = { percentile: "percentile ranks", zscore: "z-scores", minmax: "min-max rescaled values" };
const METHOD_LABEL = {
  sum: "weighted sum",
  geometric: "weighted geometric mean (a zero in any input zeroes the score)",
  minimum: "minimum (each unit scores its weakest input)",
};
const HOW_LABEL = {
  equal: "equal weights", stated: "the weights stated", pairwise: "weights from the stated pairwise comparisons (AHP)",
  emphasis: "weights from the emphasis",
};

/** The echo: what the score is made of, readable enough to edit. */
function describeComposite(step, inputs, how = "equal") {
  if (step.method === "count") {
    const parts = inputs.map((inp, i) => {
      const t = step.thresholds?.[i] || {};
      return `${inp.name} ${t.operator} ${t.value}`;
    });
    return `count of thresholds met (0 to ${inputs.length}), one point each: ${parts.join("; ")}`;
  }
  const parts = inputs.map((inp, i) =>
    `${inp.name} ${pct(step.weights?.[i] ?? 1 / inputs.length)} (${(step.directions?.[i] || "high") === "low" ? "lower scores higher" : "higher scores higher"})`);
  return `composite of ${STD_LABEL[step.standardize || "percentile"]}, ${METHOD_LABEL[step.method || "sum"]}, ` +
         `${HOW_LABEL[how] || "weights"}: ${parts.join("; ")}`;
}

/** The value label the map legend and exports carry. */
function compositeValueLabel(step) {
  if (step.method === "count") {
    const n = (step.thresholds || step.inputs || []).length;
    return `number of thresholds met (0 to ${n})`;
  }
  const std = step.standardize || "percentile";
  const method = step.method || "sum";
  const scale = std === "zscore" && method !== "geometric" ? "weighted z-score" : "0 to 1";
  return `composite score (${scale}, ${method === "sum" ? "weighted sum" : method === "geometric" ? "geometric mean" : "minimum"} of ${STD_LABEL[std]})`;
}

module.exports = {
  MAX_INPUTS, MAX_COUNT_INPUTS, METHODS, STANDARDIZE, DIRECTIONS,
  readThresholds, statedThresholds, foldFilterThresholds, listedMeasureCount,
  asksComposite, criteriaLists,
  describeInputs, groundText, readWeights, ahpWeights, readDirections, readMethod, readStandardize,
  scoreWithinArea, restrictToNamedArea, ranksAroundComposite, intersectAsComposite, applyComposite, describeComposite, compositeValueLabel,
};
