/**
 * The data cart's curator (docs/DATA_CART_PLAN.md Phase 2).
 *
 * One schema-constrained call over the shelf: a fit for every row and a
 * proposed cart. The model sees short labels (c1, c2 ...), and both the
 * verdicts and the cart are enums of those labels, so it cannot name a row
 * that is not on the shelf. Code then applies the rules the model does not
 * decide (below), and falls back to the rule-based cart if the call fails.
 *
 * NOT the default until eval/cart_probe.py says so: an LLM filter has lost
 * recall in this project before (-10pp concept recall, CLAUDE.md).
 */
const { overrules } = require("./planner/relevance");

const FITS = ["direct", "related", "denominator", "none"];
const MAX_CART = 8;
const PER_CONCEPT = 2;
const MAX_ROWS = 40;

const SYSTEM = `You pick data for an analyst. You are given a question and a numbered list of datasets that are loaded and hold data by county.

For EVERY item, give its fit to the question:
  direct       measures the thing the question asks about
  related      a risk factor, cause, consequence or standard covariate an analyst studying the question would want beside it
  denominator  a population or count needed to turn a count into a rate
  none         not useful for this question: a different meaning of a word, an unrelated facility type, a measure of something else

Then propose a cart of at most ${MAX_CART} items an analyst would download to study the question: the direct measure first, then the most useful related ones. Do not put two items in the cart that measure the same thing (the same estimate from two sources, crude and age-adjusted). If nothing on the list measures what the question asks about, return an empty cart.

The "why" note says how an item was found. "SemMedDB" and "PubMed" mean it was linked to the question's condition in the medical literature; that is a reason to consider it, not proof it fits.`;

function schemaFor(labels) {
  return {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string", enum: labels }, fit: { type: "string", enum: FITS } },
          required: ["id", "fit"],
        },
      },
      cart: { type: "array", items: { type: "string", enum: labels }, maxItems: MAX_CART },
    },
    required: ["verdicts", "cart"],
  };
}

function line(label, it) {
  const where = it.kind === "feature" ? "locations, counted per county"
    : it.coverage ? `${it.coverage.toLocaleString("en-US")} counties` : "by county";
  const why = it.why.slice(0, 2).map(w => w.text).join("; ");
  const desc = String(it.description || it.label).replace(/\s+/g, " ").slice(0, 140);
  return `${label}: ${it.label}${desc !== it.label ? ` (${desc})` : ""} [${it.dataset || "catalog"}; ${where}${it.period ? `; ${it.period}` : ""}] why: ${why}`;
}

/** The concept a linked row came through, for "at most 2 per concept". */
function conceptOf(it) {
  const w = it.why.find(x => x.kind !== "question");
  if (!w) return null;
  const m = w.text.match(/→\s*(.+?),\s*\d+ papers|→\s*(.+?)\s*\(SemMedDB\)|keyword "([^"]+)"/);
  return (m && (m[1] || m[2] || m[3]) || w.text).toLowerCase();
}

/**
 * The rules after the model. Pure; exported for tests.
 * @param shelf     shelf items (cart.buildShelf)
 * @param verdicts  Map<id, fit>
 * @param proposed  ids the model put in the cart, in its order
 * @param query     the question
 */
function applyRules(shelf, verdicts, proposed, query) {
  const byId = new Map(shelf.map(it => [it.id, it]));
  const notes = [];
  // A "none" stands only when the row's name shares no content word with the
  // question, the relevance check's rule (qwen3 has rejected rows the
  // question names outright).
  for (const [id, fit] of verdicts) {
    const it = byId.get(id);
    if (fit === "none" && it && overrules(it.description || it.label, query, it.dataset || "")) {
      verdicts.set(id, "related");
      notes.push(`kept ${it.label}: it shares a word with the question`);
    }
  }
  const usable = (id) => byId.has(id) && !byId.get(id).checkout && verdicts.get(id) !== "none";
  let cart = [...new Set(proposed)].filter(usable);

  // An empty cart means "nothing here measures the question". When the model
  // proposed one while judging rows direct or related, it contradicted itself
  // (eval/cart dev-r1: extreme heat, all four heat rows "related" and an empty
  // cart; lung cancer, cancer prevalence "related" and an empty cart). Its own
  // verdicts win: the rows it judged useful, direct first, in shelf order.
  if (!cart.length) {
    const useful = shelf.filter(it => usable(it.id) && ["direct", "related"].includes(verdicts.get(it.id)));
    if (useful.length) {
      cart = [...useful.filter(it => verdicts.get(it.id) === "direct"),
              ...useful.filter(it => verdicts.get(it.id) === "related")].map(it => it.id);
      notes.push(`the model proposed no cart but judged ${useful.length} item(s) useful; those were used`);
    }
  }
  // A direct measure the model judged but left out goes first.
  if (!cart.some(id => verdicts.get(id) === "direct")) {
    const direct = shelf.find(it => usable(it.id) && verdicts.get(it.id) === "direct");
    if (direct) { cart.unshift(direct.id); notes.push(`added ${direct.label}: the measure the question asks about`); }
  }
  // At most PER_CONCEPT rows through any one linked concept.
  const perConcept = new Map();
  cart = cart.filter(id => {
    const c = conceptOf(byId.get(id));
    if (!c) return true;
    perConcept.set(c, (perConcept.get(c) || 0) + 1);
    return perConcept.get(c) <= PER_CONCEPT;
  });
  return { cart: cart.slice(0, MAX_CART), notes };
}

/**
 * @returns {{cart, verdicts: Object<id, fit>, notes, ms, fallback?: string}}
 */
async function curate({ query, shelf, callLLM, fallbackCart, log = () => {} }) {
  const started = Date.now();
  const rows = shelf.slice(0, MAX_ROWS);
  if (!rows.length) return { cart: [], verdicts: {}, notes: [], ms: 0 };
  const labels = rows.map((_, i) => `c${i + 1}`);
  const idOf = new Map(labels.map((l, i) => [l, rows[i].id]));
  let parsed;
  try {
    const raw = await callLLM(SYSTEM,
      `QUESTION: ${query}\nITEMS:\n${rows.map((it, i) => line(labels[i], it)).join("\n")}`,
      0, schemaFor(labels));
    if (!raw) throw new Error("the model returned nothing");
    parsed = JSON.parse(raw);
  } catch (err) {
    log(`   cart curator did not run: ${err.message}`);
    return { cart: fallbackCart, verdicts: {}, notes: [], ms: Date.now() - started, fallback: err.message };
  }
  const verdicts = new Map();
  for (const v of Array.isArray(parsed.verdicts) ? parsed.verdicts : []) {
    if (idOf.has(v.id) && FITS.includes(v.fit) && !verdicts.has(idOf.get(v.id))) verdicts.set(idOf.get(v.id), v.fit);
  }
  const proposed = (Array.isArray(parsed.cart) ? parsed.cart : []).filter(l => idOf.has(l)).map(l => idOf.get(l));
  const { cart, notes } = applyRules(rows, verdicts, proposed, query);
  log(`   cart curator: ${verdicts.size}/${rows.length} judged, cart ${cart.length} (${Date.now() - started} ms)`);
  return { cart, verdicts: Object.fromEntries(verdicts), notes, ms: Date.now() - started,
           unjudged: rows.length - verdicts.size };
}

/** Top-k by retrieval score, the plan's second baseline. */
function topByScore(shelf, k = MAX_CART) {
  return shelf.filter(it => !it.checkout).slice().sort((a, b) => b.score - a.score).slice(0, k).map(it => it.id);
}

module.exports = { curate, applyRules, topByScore, conceptOf, SYSTEM, MAX_CART };
