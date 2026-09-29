/**
 * Does each attribute a plan uses actually measure what the question asks?
 *
 * WHY THIS EXISTS. "What is the average rainfall by county?" planned
 * load("Reading scores") -> aggregate(mean) and returned one confident number.
 * Nothing about that plan is invalid: the attribute resolves, the ops compose,
 * the SQL runs. Grounding proves an attribute EXISTS, not that it is the thing
 * asked about, and a confident wrong answer is the most damaging output this
 * system can produce.
 *
 * WHY NOT A RETRIEVAL THRESHOLD. Measured first (eval/answerability-scan.json):
 * BGE similarity between the question's concept and its best catalog row does
 * not separate the two cases. Unanswerable concepts score up to 0.65 ("football
 * attendance", "crater diameters" 0.61); answerable ones as low as 0.48
 * ("struggling renters"), 0.47 ("wealthiest people" -> income). Rainfall scored
 * 0.54, inside the answerable range. Any cutoff either misses it or refuses
 * real questions.
 *
 * SO IT IS A JUDGEMENT ON THE PLAN, NOT ON RETRIEVAL. After a plan validates,
 * one constrained call classifies each attribute the plan USES. Only
 * "unrelated" is an error, and it goes back into the repair loop, which either
 * picks a better attribute or returns no steps -- the existing honest "cannot be
 * built from the available data" path. Proxies are kept and reported, because
 * "median household income" for "where do the wealthiest people live" is a
 * reasonable answer that the reader should nonetheless be told about.
 *
 * This is NOT the verification step CLAUDE.md measured at -10pp recall. That
 * filtered the whole retrieved list before planning and deleted too much. This
 * sees only the 1-3 attributes a finished plan depends on, and can only send the
 * plan back, never remove a candidate.
 */

const VERDICTS = ["direct", "proxy", "denominator", "unrelated"];

// What the model is asked for. Deliberately NOT a verdict.
//
// The first version asked "is this attribute relevant to the question?", a
// holistic judgement, and question SHAPE pulled it off course: for "what causes
// lung cancer in the South" and "what explains asthma rates" it rejected the
// outcome measure itself ("it measures cancer, not the factors that cause it")
// and refused correct plans. Patching that per op ("an attribute feeding explain
// is direct") fixes one shape at a time.
//
// So the question is now extractive: WHICH WORDS of the question does this
// attribute measure, and how closely? Causes, trends, rankings and correlates
// are what the question wants to learn ABOUT a thing; none of them changes
// whether an attribute measures the thing. And the answer is checkable: the
// quoted phrase must actually occur in the question, which code verifies.
const FITS = ["same", "broader", "narrower", "stand_in", "denominator", "none"];
const FIT_TO_VERDICT = {
  same: "direct", broader: "proxy", narrower: "proxy", stand_in: "proxy",
  denominator: "denominator", none: "unrelated",
};

const RELEVANCE_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        // `measures` first: describing the attribute before matching it keeps
        // the match about the attribute, not about the question's intent.
        properties: {
          label: { type: "string" },
          measures: { type: "string" },
          question_phrase: { type: "string" },
          fit: { type: "string", enum: FITS },
        },
        required: ["label", "measures", "question_phrase", "fit"],
      },
    },
  },
  required: ["verdicts"],
};

const SYSTEM = `You match the data an analysis uses to the words of a question.

For EACH attribute listed, return:
  measures         in a few words, what the attribute itself measures
  question_phrase  the words of the QUESTION that name the thing this attribute
                   measures, copied exactly from the question; "" if the
                   question names nothing it measures
  fit              how the attribute relates to that phrase:
    same         it measures exactly that. A different year, or a crude vs
                 age-adjusted version, is still the same
    broader      a wider category that contains it (all cancers, for one
                 cancer type)
    narrower     a subset of it
    stand_in     a different measure a careful researcher would accept in its
                 place (median household income for "wealthiest", number of
                 hospitals for "access to care")
    denominator  used only to scale another measure: population, land area,
                 households
    none         it measures nothing the question names

Ignore what the question wants to learn ABOUT a thing: its causes, drivers,
trend, ranking, location, or what it correlates with. Ask only whether the
attribute measures a thing the question names. For "what explains high blood
pressure in Ohio", a hypertension measure is "same" -- it is the thing being
explained -- and a reading-score measure is "none".`;

const normText = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Words too generic to connect an attribute to a question: every catalog row
// and most questions contain some of them.
const GENERIC = new Set(("county counties each every state states rate rates percent percentage " +
  "estimate total number count among adults adult people population data level levels " +
  "prevalence crude adjusted mapped locations location average mean median which where " +
  "what that this with from have many much across area areas year years").split(" "));
const contentWords = (x) => new Set(normText(x).split(" ")
  .filter(w => w.length >= 4 && !GENERIC.has(w))
  .map(w => w.replace(/(ies)$/, "y").replace(/s$/, "")));

/**
 * Content words the attribute's own name shares with the question.
 *
 * A model's "none" is overruled when this is non-empty. Measured: qwen3
 * rejected "Coronary heart disease among adults" for "risk factors for heart
 * disease" and "Transmission Lines" for "hospitals within 10 miles of electric
 * power transmission lines", each time writing that it "measures X, which the
 * question does not name" while the question named X. Every correct rejection
 * measured shares nothing: reading scores / rainfall, household income / milk
 * prices, household counts / pet dogs, climate events / snowfall.
 */
function sharedWords(description, query) {
  const q = contentWords(query);
  return [...contentWords(description)].filter(w => q.has(w));
}

/** The quoted phrase really occurs in the question (word by word, any order). */
function grounded(phrase, query) {
  const p = normText(phrase);
  if (!p) return false;
  const q = normText(query);
  if (q.includes(p)) return true;
  const qWords = new Set(q.split(" "));
  return p.split(" ").every(w => qWords.has(w));
}

/**
 * Attribute ids a plan depends on, with the op that reads each and the ops its
 * step feeds. The consumers matter: without them, "what explains asthma rates"
 * had its asthma outcome judged UNRELATED ("it measures asthma, not the factors
 * that explain it") and a correct plan was refused twice.
 */
function usedAttributes(plan) {
  const out = [];
  const steps = plan.steps || [];
  for (const s of steps) {
    const feeds = steps.filter(c => (c.inputs || []).includes(s.id)).map(c => c.op)
      .filter(op => op !== "output");
    for (const field of ["attr_id", "near_attr_id"]) {
      if (s[field]) out.push({ attr_id: s[field], op: s.op, feeds });
    }
  }
  const seen = new Set();
  return out.filter(u => !seen.has(u.attr_id) && seen.add(u.attr_id));
}

/**
 * @returns {{ errors: string[], verdicts: Array, skipped?: string }}
 * Never throws: if the check itself fails, the plan stands, and the caller is
 * told the check did not run rather than that it passed.
 */
async function checkRelevance({ query, plan, candidates, refs, callLLM, log = () => {} }) {
  const used = usedAttributes(plan);
  if (!used.length) return { errors: [], verdicts: [] };

  // The plan's attr_ids are already real ids here; the model saw a1, a2 ...
  const labelOf = new Map([...refs.entries()].map(([label, id]) => [id, label]));
  const byId = new Map(candidates.map(c => [c.attr_id, c]));
  const lines = used.map(u => {
    const c = byId.get(u.attr_id) || {};
    const label = labelOf.get(u.attr_id) || u.attr_id;
    const desc = (c.attr_desc || u.attr_id).replace(/\s+/g, " ").slice(0, 140);
    const ds = c.dataset_clean ? ` [dataset: ${c.dataset_clean}]` : "";
    const role = u.feeds?.length ? `, feeding ${u.feeds.join(" and ")}` : "";
    return `${label}: ${desc}${ds} (used by ${u.op}${role})`;
  });

  let parsed, raw;
  try {
    raw = await callLLM(SYSTEM,
      `QUESTION: ${query}\nPLAN INTENT: ${plan.intent || ""}\nATTRIBUTES:\n${lines.join("\n")}`,
      0, RELEVANCE_SCHEMA);
    if (!raw) throw new Error("the model returned nothing");
    parsed = JSON.parse(raw);
  } catch (err) {
    log(`   relevance check did not run: ${err.message}`);
    return { errors: [], verdicts: [], skipped: err.message };
  }

  // Match the model's verdicts back to attributes. It does not always echo the
  // label verbatim ("a1: Median household income", the attr_id, or the
  // description), and an exact-match lookup silently turned every verdict into
  // "unchecked" on the first probe run: the check looked live and did nothing.
  const got = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  const norm = (x) => String(x || "").trim().toLowerCase();
  const find = (u, label, i) => {
    const byLabel = got.find(x => norm(x.label) === norm(label))
      || got.find(x => norm(x.label).match(/^a\d+/)?.[0] === norm(label))
      || got.find(x => norm(x.label) === norm(u.attr_id));
    if (byLabel) return byLabel;
    // Same count and order as asked: positional is unambiguous.
    return got.length === used.length ? got[i] : undefined;
  };
  const verdicts = used.map((u, i) => {
    const label = labelOf.get(u.attr_id) || u.attr_id;
    const v = find(u, label, i);
    const fit = FITS.includes(v?.fit) ? v.fit : null;
    const phrase = String(v?.question_phrase || "").trim();
    const isGrounded = grounded(phrase, query);
    // "none" rejects whatever phrase accompanies it. An earlier rule treated
    // "none" + a real question phrase as a contradiction and let it pass; the
    // benchmark showed that is how qwen3 ANSWERS a rejection -- it quotes the
    // unmeasured thing ("average rainfall by county") -- so the rule would have
    // disabled every rainfall-style catch in production.
    let verdict = fit ? FIT_TO_VERDICT[fit] : "unchecked";
    const desc = byId.get(u.attr_id)?.attr_desc || "";
    const shared = fit === "none" ? sharedWords(`${desc} ${byId.get(u.attr_id)?.dataset_clean || ""}`, query) : [];
    // A rejection must survive the lexical cross-check (sharedWords above).
    if (fit === "none" && shared.length) verdict = "unchecked";
    const measures = String(v?.measures || "").trim();
    const reason = !fit ? null
      : fit === "none" && shared.length
        ? `model said it measures nothing asked about, overruled: it shares "${shared.join(", ")}" with the question`
      : fit === "none" ? `measures ${measures || "something else"}, which the question does not name`
      : fit === "denominator" ? `scales the result (${measures})`
      : fit === "same" ? `measures ${phrase ? `"${phrase}"` : measures}`
      : `${fit.replace("_", "-")} for "${phrase}": measures ${measures}`;
    return {
      attr_id: u.attr_id, label,
      description: byId.get(u.attr_id)?.attr_desc || null,
      verdict, fit, question_phrase: phrase || null, grounded: isGrounded,
      measures: measures || null, reason,
    };
  });
  if (verdicts.every(v => v.verdict === "unchecked")) {
    // Never report a check that matched nothing as though it had passed.
    log(`   relevance check unmatched, raw response: ${String(raw).slice(0, 300)}`);
    return { errors: [], verdicts, skipped: "no verdict matched an attribute" };
  }
  for (const v of verdicts) {
    log(`   relevance ${v.label} ${v.verdict}: ${(v.description || "").slice(0, 60)} -- ${v.reason || ""}`);
  }

  const errors = verdicts.filter(v => v.verdict === "unrelated").map(v =>
    `NOT_RELEVANT: ${v.label} ("${(v.description || "").slice(0, 80)}") ${v.reason || "does not measure anything the question names"}. Use an attribute ` +
    `that does. If none of the AVAILABLE ATTRIBUTES measures it, return an empty ` +
    `"steps" array: the data is not loaded, and saying so is the correct answer.`);
  return { errors, verdicts };
}

module.exports = { checkRelevance, usedAttributes, grounded, sharedWords, RELEVANCE_SCHEMA, VERDICTS, FITS, SYSTEM };
