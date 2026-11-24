/**
 * Paper upload (docs/PAPER_AND_CART_INTEGRATION.md P3, docs/DATA_CART_PLAN.md
 * U1-U3): a research paper -> a study card (area, unit, period, variables,
 * methods), every field backed by a sentence quoted from the paper.
 *
 * Three rules, each from a defect in the prototype extractor
 * (search_and_analysis/.../recommendML/llm2.py) or from this project's traps:
 *
 *   1. NEVER TRUNCATE. The prototype cut every paper at 10,000 characters,
 *      which usually ends before the methods section. The text is split by
 *      section heading, references and boilerplate are set aside, and the rest
 *      is sent in chunks that fit the planner's 8,192-token window (an
 *      overflow silently drops the system prompt, CLAUDE.md traps). If the
 *      paper is longer than MAX_CHUNKS chunks, the sections NOT read are
 *      reported by name, never dropped quietly.
 *   2. QUOTES, CHECKED BY CODE. The prototype's "evidence" was a paraphrase
 *      ("The paper explicitly states that ..."), which nothing can check.
 *      Every extracted item carries a quote; an item whose quote does not
 *      occur in the text (compared on letters and digits only, so line breaks,
 *      hyphenation and ligatures do not matter) is dropped and counted.
 *   3. NO METHOD GEOARK DOES NOT HAVE. A method's family is an enum; anything
 *      else is `other`, with the paper's own term kept as the label. Which
 *      family can be run, approximated or not at all is decided in
 *      paper_templates.js, not by the model.
 *
 * Nothing in this file knows any paper, disease or dataset. The vocabulary it
 * does carry is the generic structure of a research article (section names)
 * and of the United States (states.js).
 *
 * The file is never stored: bytes in, text out, discarded with the request.
 */

const { STATE_FIPS, REGIONS, POSTAL_TO_NAME } = require("./states");

const MAX_BYTES = 25 * 1024 * 1024;
// ~2,500 tokens of paper per call: with the ~1,000-token instructions and a
// 3,000-token answer cap that stays inside num_ctx 8,192.
const CHUNK_CHARS = Number(process.env.PAPER_CHUNK_CHARS ?? 10000);
const MAX_CHUNKS = Number(process.env.PAPER_MAX_CHUNKS ?? 8);
const MAX_VARIABLES = 45;
const MAX_METHODS = 12;
const MIN_QUOTE = 16;     // letters+digits; shorter quotes match by accident
const MIN_SHORT_QUOTE = 6; // a variable's table cell, matched as a whole phrase

class PaperError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// --------------------------------------------------------------------------
// U1. Text
// --------------------------------------------------------------------------

let pdfjsPromise = null;
function pdfjs() {
  // pdf.js ships as ES modules only; a CommonJS file reaches it by import().
  // A bare specifier: ESM resolution reads the package's "exports" (Node 20's
  // require.resolve cannot reach this import-only path; Node 24's can).
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

function formatOf(name, bytes) {
  const n = String(name || "").toLowerCase();
  if (bytes.length >= 4 && bytes.slice(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b && /\.docx$/.test(n)) return "docx";
  if (/\.(txt|md|markdown)$/.test(n)) return "text";
  if (/\.docx$/.test(n)) return "docx";
  if (/\.pdf$/.test(n)) return "pdf";
  return null;
}

/**
 * Bytes -> { text, pages: [{page, start, end}], format, title }.
 * `pages` holds character offsets into `text`, so a quote can be traced to
 * the page it is on.
 */
async function extractText(bytes, name) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new PaperError("the file is empty");
  if (bytes.length > MAX_BYTES) throw new PaperError(`the file is larger than ${MAX_BYTES / 1e6} MB`, 413);
  const format = formatOf(name, bytes);
  if (!format) throw new PaperError("a paper must be a PDF, a Word .docx or a plain-text file");

  if (format === "text") {
    const text = bytes.toString("utf8");
    return { text, pages: [{ page: 1, start: 0, end: text.length }], format, title: null };
  }
  if (format === "docx") {
    const mammoth = require("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return { text: value, pages: [{ page: 1, start: 0, end: value.length }], format, title: null };
  }

  const lib = await pdfjs();
  let doc;
  try {
    doc = await lib.getDocument({
      data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false,
      disableFontFace: true, verbosity: 0,
    }).promise;
  } catch (err) {
    throw new PaperError(`the PDF could not be read (${err.message})`);
  }
  let text = "";
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const start = text.length;
    let lastY = null;
    for (const it of content.items) {
      if (typeof it.str !== "string") continue;
      const y = Array.isArray(it.transform) ? it.transform[5] : null;
      // A jump in baseline without an EOL marker is still a new line.
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !text.endsWith("\n")) text += "\n";
      text += it.str;
      if (it.hasEOL) text += "\n";
      lastY = y;
    }
    if (!text.endsWith("\n")) text += "\n";
    pages.push({ page: p, start, end: text.length });
    text += "\n";
  }
  let title = null;
  try {
    const meta = await doc.getMetadata();
    const t = String(meta?.info?.Title || "").trim();
    // Many PDFs carry the file name or a template name as the title.
    if (t.length >= 12 && !/\.(pdf|docx?|tex)$/i.test(t) && /\s/.test(t)) title = t;
  } catch { /* no metadata */ }
  await doc.destroy();
  if (text.replace(/\s/g, "").length < 200) {
    throw new PaperError("the PDF holds almost no text; a scanned paper needs OCR first", 422);
  }
  return { text, pages, format, title };
}

// --------------------------------------------------------------------------
// Sections and chunks
// --------------------------------------------------------------------------

// The generic sections of a research article, by heading.
const SECTION_KINDS = [
  ["abstract", /^(abstract|summary|structured abstract)$/],
  ["references", /^(references?|bibliography|literature cited|works cited|reference list)$/],
  ["boilerplate", /^(acknowledge?ments?|funding( information| sources?)?|author(s'|s)? contributions?|competing interests?|conflicts? of interests?|declarations?|ethics( approval| statement| declarations?)?( and consent to participate)?|consent for publication|abbreviations|publisher'?s note|additional information|supplementary (information|material)s?|electronic supplementary material|orcid)$/],
  ["methods", /\b(methods?|methodology|materials?|data( sources?| and \w+| collection| description)?|study (area|design|population|setting|site|region)|variables?|measures?|measurement|statistical( analysis| analyses| methods)?|analytic(al)? (approach|strategy)|model(s|ling|ing)?( specification)?|spatial analysis|sampl(e|ing)|covariates?|outcomes?|exposures?)\b/],
  ["results", /\b(results?|findings)\b/],
  ["discussion", /\b(discussion|conclusions?|limitations?|implications?|strengths?)\b/],
  ["introduction", /\b(introduction|background|literature review|related work)\b/],
];

/** A line that is a section heading, and the heading's text without numbering. */
function headingOf(line) {
  const raw = line.trim();
  if (raw.length < 4 || raw.length > 70) return null;
  if (/[.,;:]$/.test(raw) && !/^\d+(\.\d+)*\.?\s/.test(raw)) return null;
  const numbered = raw.match(/^(?:\d+(?:\.\d+)*\.?|[IVX]{1,4}\.)\s+([A-Z][^]*)$/);
  const body = (numbered ? numbered[1] : raw).trim();
  const lower = body.toLowerCase().replace(/\s+/g, " ");
  const words = lower.split(" ");
  if (words.length > 8) return null;
  for (const [kind, re] of SECTION_KINDS) {
    if (!re.test(lower)) continue;
    // An unnumbered line is a heading only if it is short and title-like:
    // "Data were obtained from" is a sentence, not a heading.
    if (!numbered && (words.length > 5 || /^[a-z]/.test(body))) return null;
    return { heading: body, kind };
  }
  // A numbered short line in title case is a heading of unknown kind.
  if (numbered && words.length <= 6 && /^[A-Z]/.test(body) && !/\d{3,}/.test(body)) {
    return { heading: body, kind: "other" };
  }
  return null;
}

/**
 * text -> sections [{heading, kind, start, end}]. The part before the first
 * heading is "front" (title, authors, often the abstract).
 */
function splitSections(text) {
  const sections = [];
  let cur = { heading: "(front matter)", kind: "front", start: 0 };
  let offset = 0;
  for (const line of text.split("\n")) {
    const h = headingOf(line);
    if (h) {
      cur.end = offset;
      sections.push(cur);
      cur = { ...h, start: offset };
    }
    offset += line.length + 1;
  }
  cur.end = text.length;
  sections.push(cur);
  // References are the end of the article: a heading of another kind after
  // them is usually a reference title that happened to look like one.
  const out = [];
  let inRefs = false;
  for (const s of sections.filter(s => s.end > s.start)) {
    if (s.kind === "references" && s.start > text.length * 0.3) inRefs = true;
    out.push(inRefs && s.kind !== "references" && s.kind !== "boilerplate"
      ? { ...s, kind: "references", heading: `${s.heading} (after references)` } : s);
  }
  return out;
}

// Methods first: that is where the variables and techniques are. Then the
// abstract and front matter (study area, design), results (the techniques
// reported), and the rest.
const READ_ORDER = ["methods", "front", "abstract", "results", "other", "introduction", "discussion"];

/**
 * Sections -> chunks of at most CHUNK_CHARS, each from one or more whole
 * sections of the same priority, long sections split at paragraph breaks.
 * Returns { chunks: [{text, start, headings}], read: [heading], skipped:
 * [{heading, kind, chars, why}] }.
 */
function planChunks(text, sections, { chunkChars = CHUNK_CHARS, maxChunks = MAX_CHUNKS } = {}) {
  const skipped = [];
  const pieces = [];
  // The introduction and discussion describe OTHER studies' variables and
  // methods ("prior work used GWR"), and read as this paper's. Measured on
  // the first dev paper: every concept-level "variable" ("healthcare access",
  // "socioeconomic disadvantage") came from those two parts. When the paper
  // has a methods section of its own they are set aside, and said to be.
  const hasMethods = sections.some(s => s.kind === "methods" && s.end - s.start > 400);
  for (const s of sections) {
    if (s.kind === "references" || s.kind === "boilerplate") {
      skipped.push({ heading: s.heading, kind: s.kind, chars: s.end - s.start, why: s.kind });
      continue;
    }
    if (hasMethods && (s.kind === "introduction" || s.kind === "discussion")) {
      skipped.push({ heading: s.heading, kind: s.kind, chars: s.end - s.start, why: "background or discussion" });
      continue;
    }
    // Split a long section at blank lines or line ends near the limit.
    let a = s.start;
    while (a < s.end) {
      let b = Math.min(s.end, a + chunkChars);
      if (b < s.end) {
        const window = text.slice(a + Math.floor(chunkChars * 0.6), b);
        const para = window.lastIndexOf("\n\n");
        const nl = window.lastIndexOf("\n");
        const cut = para >= 0 ? para : nl;
        if (cut >= 0) b = a + Math.floor(chunkChars * 0.6) + cut + 1;
      }
      pieces.push({ start: a, end: b, heading: s.heading, kind: s.kind,
                    rank: READ_ORDER.indexOf(s.kind) < 0 ? READ_ORDER.length : READ_ORDER.indexOf(s.kind) });
      a = b;
    }
  }
  // Pack pieces in reading priority, keeping document order inside a rank.
  const ordered = pieces.slice().sort((p, q) => p.rank - q.rank || p.start - q.start);
  const chunks = [];
  let cur = null;
  const unread = [];
  for (const p of ordered) {
    const len = p.end - p.start;
    // Fill a chunk across ranks too: a 9-character "Results" heading is not
    // worth a model call of its own.
    if (cur && cur.len + len <= chunkChars) {
      cur.parts.push(p); cur.len += len; continue;
    }
    if (chunks.length >= maxChunks) { unread.push(p); continue; }
    cur = { parts: [p], len, rank: p.rank };
    chunks.push(cur);
  }
  for (const p of unread) {
    const last = skipped.find(x => x.heading === p.heading && x.why === "length");
    if (last) last.chars += p.end - p.start;
    else skipped.push({ heading: p.heading, kind: p.kind, chars: p.end - p.start, why: "length" });
  }
  return {
    chunks: chunks.map(c => ({
      text: c.parts.map(p => text.slice(p.start, p.end)).join("\n"),
      start: c.parts[0].start,
      headings: [...new Set(c.parts.map(p => p.heading))],
    })),
    read: [...new Set(chunks.flatMap(c => c.parts.map(p => p.heading)))],
    skipped,
  };
}

// --------------------------------------------------------------------------
// Quotes
// --------------------------------------------------------------------------

/** Letters and digits only, lower case: what a quote is compared on. */
function squash(s) {
  return String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * An index over the paper for quote checks: the squashed text plus, for each
 * squashed position, the page it came from.
 */
function quoteIndex(text, pages = []) {
  let flat = "";
  const pageAt = [];   // [{at, page}] squashed offset where each page begins
  let pi = 0;
  const sortedPages = pages.slice().sort((a, b) => a.start - b.start);
  for (let i = 0; i < text.length; i++) {
    while (pi < sortedPages.length && sortedPages[pi].start <= i) {
      pageAt.push({ at: flat.length, page: sortedPages[pi].page });
      pi++;
    }
    const c = squash(text[i]);
    if (c) flat += c;
  }
  return { flat, pageAt, words: ` ${wordsOf(text)} ` };
}

/** Lower-case words separated by single spaces: phrase matching on word bounds. */
function wordsOf(s) {
  return String(s || "").normalize("NFKC").toLowerCase()
    .replace(/(\p{L})-[ \t]*\n\s*(\p{L})/gu, "$1$2")     // hyphenation at a line end
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Does the quote occur in the paper? A quote with an ellipsis is several
 * fragments that must each occur, in order. Returns {ok, page} or {ok:false,
 * why}.
 */
function checkQuote(index, quote, { short = false } = {}) {
  const parts = String(quote || "").split(/\.{3}|…|\[\s*\.\.\.\s*\]/).map(squash).filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length, 0);
  // A variable named in a table is a short cell ("Poverty (%)"). It counts
  // only as a whole phrase of the text, so "rate" cannot match "separate".
  if (short && parts.length === 1 && total >= MIN_SHORT_QUOTE && total < MIN_QUOTE && index.words) {
    const phrase = wordsOf(quote);
    if (phrase && index.words.includes(` ${phrase} `)) return { ok: true, page: null, short: true };
    return { ok: false, why: "not found in the paper" };
  }
  if (!parts.length || total < MIN_QUOTE) return { ok: false, why: "no quote, or too short to check" };
  let from = 0;
  let first = -1;
  for (const p of parts) {
    if (p.length < 6 && parts.length > 1) continue;
    const at = index.flat.indexOf(p, from);
    if (at < 0) return { ok: false, why: "not found in the paper" };
    if (first < 0) first = at;
    from = at + p.length;
  }
  let page = null;
  for (const pa of index.pageAt) { if (pa.at <= first) page = pa.page; else break; }
  return { ok: true, page };
}

// --------------------------------------------------------------------------
// U2. Extraction
// --------------------------------------------------------------------------

// Method families, with what each covers. The descriptions go into the prompt
// verbatim: without them qwen3 filed Moran's I and Getis-Ord Gi* under
// "spatial_lag" and Pearson correlation under "other" (first dev paper,
// 2026-11-23). Which family GeoARK runs, approximates or cannot do is
// paper_templates.js's decision; the model only names the family.
const FAMILY_TEXT = {
  map: "mapping or describing the geographic distribution of a measure (choropleth, descriptive maps)",
  hotspot: "Getis-Ord Gi* or Gi, hot spot / cold spot analysis",
  moran_global: "global Moran's I, global spatial autocorrelation (one statistic for the whole area)",
  moran_local: "LISA, local Moran's I, Anselin local Moran, cluster and outlier analysis",
  scan_statistic: "SaTScan, Kulldorff spatial or space-time scan statistic",
  correlation: "Pearson or Spearman correlation between two measures",
  regression: "a non-spatial regression model: OLS, linear, logistic, Poisson, negative binomial, GLM, multilevel / mixed",
  spatial_regression: "a spatial regression model: spatial lag (SAR), spatial error, spatial Durbin, GWR, MGWR, Bayesian spatial (BYM / CAR)",
  spatial_lag: "a spatially lagged VARIABLE or neighbourhood average used as data (not a regression model)",
  group_comparison: "comparing groups: t-test, Mann-Whitney, Kruskal-Wallis, ANOVA, chi-square",
  access: "access or proximity: distance to the nearest facility, travel time, 2SFCA, catchment areas",
  machine_learning: "machine learning or deep learning models: random forest, gradient boosting / XGBoost, SVM, neural network, decision tree, SHAP",
  time_series: "time-series models or forecasting: ARIMA, SARIMA, ETS, exponential smoothing, joinpoint, trend models",
  outlier: "finding outlying values, non-spatially (boxplot, IQR, z-score)",
  preprocessing: "data preparation, not an analysis: imputation, scaling / normalisation, VIF or multicollinearity screening, outlier screening before modelling, train/test split",
  other: "an analysis that fits none of the above",
};
const METHOD_FAMILIES = Object.keys(FAMILY_TEXT);

// Standard technique names that settle the family whatever the model chose.
// These are the field's own names for its methods (not any paper's wording),
// checked against the paper's term, most specific first. A technique that
// matches none keeps the model's family.
const KNOWN_TECHNIQUES = [
  [/\b(lisa|local (indicators? of spatial association|moran)|anselin|cluster and outlier)\b/i, "moran_local"],
  [/\bgetis|\bgi\s*\*|\bgi\*|hot\s*-?\s*spot/i, "hotspot"],
  [/\bmoran/i, "moran_global"],
  [/\bsatscan\b|\bkulldorff|\bscan statistic/i, "scan_statistic"],
  [/\b(m?gwr|geographically weighted|spatial (lag|error|durbin|autoregressive) (model|regression)|\bsar model|\bbym\b|besag|conditional autoregressive|\bcar model|\bsem\b)\b/i, "spatial_regression"],
  [/\b(s?arima|exponential smoothing|\bets\b|holt[- ]winters|joinpoint|time[- ]series|forecast)/i, "time_series"],
  [/\b(random forest|xgboost|gradient boost|lightgbm|catboost|neural network|\bann\b|deep learning|support vector|\bsvm\b|decision tree|shap\b|shapley|k-?nearest neighbou?r (classifier|regression)|machine learning)/i, "machine_learning"],
  [/\b(two[- ]step floating catchment|2sfca|e2sfca|travel time|network distance|nearest (facility|hospital|provider))/i, "access"],
  [/\b(variance inflation|\bvif\b|imputation|min[- ]?max|normali[sz]ation|standardi[sz]ation|train(ing)?[ /-]+test split|multicollinearity)/i, "preprocessing"],
  [/\b(pearson|spearman)\b.*\bcorrelation|\bcorrelation (coefficient|analysis)\b/i, "correlation"],
  [/\b(t-test|mann[- ]whitney|kruskal|wilcoxon|anova|chi[- ]square)/i, "group_comparison"],
  [/\b(negative binomial|poisson|logistic|linear|ols|ordinary least squares|multilevel|mixed[- ]effects?|hierarchical) (regression|model)/i, "regression"],
];

/** The family a technique's own name settles, or null. */
function familyFromName(technique) {
  // Papers set dashes as en or em dashes ("Min–Max", "Getis–Ord").
  const name = String(technique || "").replace(/[‐-―−]/g, "-");
  for (const [re, fam] of KNOWN_TECHNIQUES) if (re.test(name)) return fam;
  return null;
}

const UNITS = ["county", "tract", "block_group", "zip", "state", "city", "point", "grid", "individual", "other", "not_stated"];
const ROLES = ["outcome", "exposure", "covariate"];

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    country: { type: "object", properties: { name: { type: "string" }, quote: { type: "string" } },
               required: ["name", "quote"] },
    study_area: {
      type: "object",
      properties: { description: { type: "string" }, places: { type: "array", items: { type: "string" } },
                    quote: { type: "string" } },
      required: ["description", "places", "quote"],
    },
    unit: { type: "object", properties: { value: { type: "string", enum: UNITS }, quote: { type: "string" } },
            required: ["value", "quote"] },
    period: {
      type: "object",
      properties: { start_year: { type: ["integer", "null"] }, end_year: { type: ["integer", "null"] },
                    quote: { type: "string" } },
      required: ["start_year", "end_year", "quote"],
    },
    variables: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string", enum: ROLES },
          measure: { type: "string" },
          source: { type: "string" },
          quote: { type: "string" },
        },
        required: ["name", "role", "measure", "source", "quote"],
      },
    },
    methods: {
      type: "array",
      items: {
        type: "object",
        properties: {
          technique: { type: "string" },
          family: { type: "string", enum: METHOD_FAMILIES },
          applied_to: { type: "string" },
          alpha: { type: ["number", "null"] },
          permutations: { type: ["integer", "null"] },
          weights: { type: "string" },
          quote: { type: "string" },
        },
        required: ["technique", "family", "applied_to", "alpha", "permutations", "weights", "quote"],
      },
    },
  },
  required: ["title", "country", "study_area", "unit", "period", "variables", "methods"],
};

const EXTRACTION_SYSTEM = `You read one part of a research paper and record its study design, variables and analysis methods, for someone who wants to rebuild the analysis with their own data.

Rules:
- Every "quote" is copied EXACTLY from the text you are given: one sentence or clause, character for character. Never paraphrase, never summarise, never combine sentences. If nothing in this part states a field, leave its quote "" and its other fields empty, "not_stated" or null.
- Record only what THIS part of the paper states. Do not guess from general knowledge.
- country: the country the data cover (not the authors' affiliations).
- study_area: the geographic area analysed. "places" lists the named areas (states, provinces, cities, regions, or "nationwide").
- unit: the geographic unit each observation is (county, census tract, ZIP code ...). "individual" when the rows are people.
- period: the years of the data analysed.
- variables: each measured quantity THIS study analysed, one entry per variable, each named once. A variable is something with a value for every unit (a rate, a percentage, a count, an index); a category or theme ("socioeconomic factors", "healthcare access") is not a variable, but the measures listed under it are. Variables in a table each get an entry; their quote may be the table cell.
  - role "outcome" for the dependent / response variable, "exposure" for the main independent variables of interest, "covariate" for controls and adjustment variables. When a paper lists predictors without singling any out, they are "exposure".
  - name: a short generic name ("adult obesity prevalence", "median household income").
  - measure: how it is expressed if stated ("age-adjusted rate per 100,000", "percent of adults"), else "".
  - source: the dataset or agency it came from if stated ("CDC WONDER", "American Community Survey"), else "".
- methods: each analysis technique the paper APPLIED (not ones it only mentions as background or future work).
  - technique: the paper's own name for it.
  - family: the closest category:
${Object.entries(FAMILY_TEXT).map(([k, v]) => `      ${k}: ${v}`).join("\n")}
  - applied_to: the variable(s) it was applied to, by name.
  - alpha, permutations: the significance level and number of permutations if stated, else null.
  - weights: the spatial weights if stated ("queen contiguity", "k = 8 nearest neighbours", "inverse distance"), else "".
- Return at most ${MAX_VARIABLES} variables and ${MAX_METHODS} methods.
- Return JSON only.`;

function extractionPrompt(chunk, i, n, headings) {
  return `PART ${i + 1} OF ${n} (sections: ${headings.join("; ")})\n\n<<<\n${chunk}\n>>>`;
}

function parseJson(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* none */ } }
  return null;
}

const clean = (s, n = 200) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const key = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// --------------------------------------------------------------------------
// Study area: names -> states, in code
// --------------------------------------------------------------------------

const STATE_NAMES = Object.keys(STATE_FIPS);
const LOWER48 = STATE_NAMES.filter(s => !["Alaska", "Hawaii", "American Samoa", "Guam",
  "Northern Mariana Islands", "Puerto Rico", "U.S. Virgin Islands"].includes(s));
const FIFTY_DC = STATE_NAMES.filter(s => !["American Samoa", "Guam", "Northern Mariana Islands",
  "Puerto Rico", "U.S. Virgin Islands"].includes(s));
// "us" and "national" are ordinary words; only the upper-case abbreviation
// and the full names say United States.
const US_NAME = /\b(united states|usa|america|conus)\b/i;
const US_ABBR = /(^|[^A-Za-z])U\.?\s?S\.?(\s?A\.?)?(?![A-Za-z])/;
const US_WORDS = { test: (s) => US_NAME.test(s) || US_ABBR.test(s) };

function isUnitedStates(name) {
  const s = String(name || "").trim();
  if (!s) return null;
  if (US_WORDS.test(s)) return true;
  if (statesIn(s).length) return true;
  return false;
}

/** State names (and census regions) mentioned in a string. */
function statesIn(s) {
  const out = new Set();
  const text = ` ${String(s || "")} `;
  for (const name of STATE_NAMES) {
    // "Washington" alone is also a city; "West Virginia" contains "Virginia".
    const re = new RegExp(`(^|[^A-Za-z])${name.replace(/\./g, "\\.")}(?![A-Za-z])`, "i");
    if (!re.test(text)) continue;
    if (name === "Virginia" && /west\s+virginia/i.test(text) &&
        !/(^|[^a-z])virginia/i.test(text.replace(/west\s+virginia/ig, ""))) continue;
    if (name === "Washington" && /washington,?\s*d\.?\s?c\.?/i.test(text) &&
        !/washington(?!,?\s*d\.?\s?c)/i.test(text.replace(/washington,?\s*d\.?\s?c\.?/ig, ""))) {
      out.add("District of Columbia"); continue;
    }
    out.add(name);
  }
  // A census region only as "the South" etc., and never inside a state's
  // name ("West Virginia", "South Dakota"), which are removed first.
  let rest = text;
  for (const name of STATE_NAMES) rest = rest.replace(new RegExp(name.replace(/\./g, "\\."), "ig"), " ");
  for (const region of Object.keys(REGIONS)) {
    if (new RegExp(`\\bthe\\s+${region}\\b`, "i").test(rest)) for (const st of REGIONS[region]) out.add(st);
  }
  // Two-letter postal codes only as whole upper-case tokens in a list.
  for (const m of text.matchAll(/(?:^|[\s,(])([A-Z]{2})(?=[\s,)]|$)/g)) {
    if (POSTAL_TO_NAME[m[1]] && !["US", "IN", "OR", "ME", "OK", "HI"].includes(m[1])) out.add(POSTAL_TO_NAME[m[1]]);
  }
  return [...out];
}

/**
 * The extracted area -> what GeoARK can filter on.
 * scope: "national" | "states" | "outside_us" | "unknown".
 */
function resolveArea(area, country) {
  const desc = [area?.description, ...(area?.places || [])].join(" ; ");
  const us = isUnitedStates(country?.name);
  const states = statesIn(desc);
  if (us === false && !states.length) {
    return { scope: "outside_us", states: null,
             note: `The paper studies ${clean(country.name, 60)}; GeoARK's data cover the United States.` };
  }
  if (states.length) {
    return { scope: "states", states, note: null };
  }
  if (/\b(contiguous|continental|conterminous|lower\s*48|conus)\b/i.test(desc)) {
    return { scope: "national", states: LOWER48, note: "the contiguous United States (48 states and DC)" };
  }
  if (US_WORDS.test(desc) || us === true) {
    return { scope: "national", states: null, note: null };
  }
  return { scope: "unknown", states: null, note: "the study area could not be identified" };
}

// --------------------------------------------------------------------------
// Merge the per-chunk answers, keeping only what the text supports
// --------------------------------------------------------------------------

const ROLE_RANK = { outcome: 0, exposure: 1, covariate: 2 };

// Words that say how a variable is expressed, not what it is: "CVD mortality
// rate", "CVD mortality rates" and "CVD mortality" are one variable.
const EXPRESSION_WORDS = new Set(["rate", "rates", "level", "levels", "percent", "percentage", "percentages",
  "proportion", "share", "prevalence", "count", "counts", "number", "county", "counties", "annual", "the", "of", "in", "and"]);

function variableKey(name) {
  const words = key(String(name).replace(/\([^)]*\)/g, " ")).split(" ")
    .filter(w => w && !EXPRESSION_WORDS.has(w))
    .map(w => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  return words.join(" ") || key(name);
}

/**
 * Chunk answers -> one study card. Pure. `index` is quoteIndex(text, pages).
 */
function mergeExtractions(answers, index) {
  const dropped = [];
  let checked = 0;
  const verify = (what, item, quote) => {
    checked++;
    // Variables (table cells) and places ("Taiwan") are short by nature.
    const r = checkQuote(index, quote, { short: ["variable", "country", "study_area"].includes(what) });
    if (!r.ok) { dropped.push({ what, item: clean(item, 80), quote: clean(quote, 160), why: r.why }); return null; }
    return { quote: clean(quote, 600), page: r.page };
  };
  const firstValid = (field, label, pick) => {
    for (const a of answers) {
      const v = a?.[field];
      if (!v || !pick(v)) continue;
      const q = verify(field, label(v), v.quote);
      if (q) return { ...v, ...q };
    }
    return null;
  };

  const title = answers.map(a => clean(a?.title, 300)).find(t => t.length > 8 && checkQuote(index, t).ok) || null;
  const country = firstValid("country", v => v.name, v => clean(v.name));
  const area = firstValid("study_area", v => v.description,
    v => clean(v.description) || (v.places || []).length);
  const unit = firstValid("unit", v => v.value, v => v.value && v.value !== "not_stated");
  const period = firstValid("period", v => `${v.start_year}-${v.end_year}`,
    v => Number.isInteger(v.start_year) || Number.isInteger(v.end_year));

  const variables = [];
  const byName = new Map();
  for (const a of answers) {
    for (const v of Array.isArray(a?.variables) ? a.variables : []) {
      const name = clean(v?.name, 120);
      if (!name || !ROLES.includes(v.role)) continue;
      const q = verify("variable", name, v.quote);
      if (!q) continue;
      const k = variableKey(name);
      const prev = byName.get(k);
      if (prev) {
        // The same variable named in two parts: the more specific role wins
        // (a "covariate" in the abstract may be the "outcome" in the methods).
        if (ROLE_RANK[v.role] < ROLE_RANK[prev.role]) prev.role = v.role;
        if (!prev.measure && v.measure) prev.measure = clean(v.measure, 160);
        if (!prev.source && v.source) prev.source = clean(v.source, 160);
        continue;
      }
      const row = { name, role: v.role, measure: clean(v.measure, 160), source: clean(v.source, 160), ...q };
      byName.set(k, row);
      variables.push(row);
    }
  }
  variables.sort((x, y) => ROLE_RANK[x.role] - ROLE_RANK[y.role]);
  const truncatedVariables = Math.max(0, variables.length - MAX_VARIABLES);
  variables.splice(MAX_VARIABLES);
  variables.forEach((v, i) => { v.id = `v${i + 1}`; });

  const methods = [];
  const byMethod = new Map();
  for (const a of answers) {
    for (const m of Array.isArray(a?.methods) ? a.methods : []) {
      const technique = clean(m?.technique, 120);
      if (!technique) continue;
      // The technique's own standard name settles the family when it can.
      const family = familyFromName(technique) || (METHOD_FAMILIES.includes(m.family) ? m.family : "other");
      const q = verify("method", technique, m.quote);
      if (!q) continue;
      const k = `${family}|${key(technique)}`;
      const prev = byMethod.get(k);
      if (prev) {
        prev.alpha ??= numOrNull(m.alpha);
        prev.permutations ??= intOrNull(m.permutations);
        if (!prev.weights && m.weights) prev.weights = clean(m.weights, 120);
        continue;
      }
      const row = {
        technique, family, applied_to: clean(m.applied_to, 200),
        alpha: numOrNull(m.alpha), permutations: intOrNull(m.permutations),
        weights: clean(m.weights, 120), ...q,
      };
      byMethod.set(k, row);
      methods.push(row);
    }
  }
  methods.splice(MAX_METHODS);
  methods.forEach((m, i) => { m.id = `m${i + 1}`; });

  return {
    title,
    country: country ? { name: clean(country.name, 80), quote: country.quote, page: country.page } : null,
    area: area ? { description: clean(area.description, 200), places: (area.places || []).map(p => clean(p, 80)).filter(Boolean),
                   quote: area.quote, page: area.page, ...resolveArea(area, country) }
      : { description: "", places: [], quote: null, page: null, ...resolveArea(null, country) },
    unit: unit ? { value: unit.value, quote: unit.quote, page: unit.page } : { value: "not_stated", quote: null, page: null },
    period: period ? { start_year: intOrNull(period.start_year), end_year: intOrNull(period.end_year),
                       quote: period.quote, page: period.page } : null,
    variables, methods,
    quotes: { checked, kept: checked - dropped.length, dropped: dropped.length, dropped_items: dropped.slice(0, 40) },
    truncated_variables: truncatedVariables,
  };
}

function numOrNull(x) { const n = Number(x); return x === null || x === undefined || x === "" || !Number.isFinite(n) ? null : n; }
function intOrNull(x) { const n = numOrNull(x); return n === null || !Number.isInteger(n) ? null : n; }

/**
 * The whole extraction: text -> sections -> chunks -> one model call each ->
 * merged, quote-checked study card.
 *
 * @param callLLM (system, user, schema) -> raw string | null
 */
async function extractStudy({ text, pages, title: metaTitle = null, callLLM, log = () => {} }) {
  const sections = splitSections(text);
  const plan = planChunks(text, sections);
  if (!plan.chunks.length) throw new PaperError("no readable sections were found in the paper", 422);
  const answers = [];
  let failed = 0;
  for (let i = 0; i < plan.chunks.length; i++) {
    const c = plan.chunks[i];
    log(`   paper part ${i + 1}/${plan.chunks.length}: ${c.text.length} chars (${c.headings.join("; ").slice(0, 120)})`);
    const raw = await callLLM(EXTRACTION_SYSTEM, extractionPrompt(c.text, i, plan.chunks.length, c.headings),
                              EXTRACTION_SCHEMA);
    const parsed = parseJson(raw);
    if (!parsed) { failed++; log(`   paper part ${i + 1}: no usable answer`); continue; }
    answers.push(parsed);
  }
  if (!answers.length) throw new PaperError("the model returned nothing usable for any part of the paper", 502);
  const index = quoteIndex(text, pages);
  const study = mergeExtractions(answers, index);
  if (!study.title && metaTitle) study.title = metaTitle;
  return {
    ...study,
    reading: {
      chars: text.length,
      pages: pages.length,
      sections: sections.map(s => ({ heading: s.heading, kind: s.kind, chars: s.end - s.start })),
      read: plan.read,
      skipped: plan.skipped,
      parts: plan.chunks.length,
      parts_failed: failed,
    },
  };
}

// --------------------------------------------------------------------------
// U3. Variables -> catalog rows, judged in one call per batch
// --------------------------------------------------------------------------

const MATCH_BATCH = 12;
const CANDIDATES_PER_VARIABLE = 6;

const MATCH_SYSTEM = `You match the variables of a research paper to measures in a data catalog.

For each paper variable you are shown up to ${CANDIDATES_PER_VARIABLE} catalog candidates. Choose the candidate that measures the SAME quantity, or the closest usable stand-in, or none.
- fit "same": the candidate measures this variable (the units or source may differ: a percent of adults and a crude prevalence are the same quantity).
- fit "proxy": a different but closely related quantity a researcher could defend as a stand-in (e.g. "children in poverty" for "poverty").
- fit "none": no candidate measures it. Prefer "none" to a candidate that only shares a word.
Judge by what each candidate MEASURES, not by shared words. Return JSON only.`;

function matchSchema(batch) {
  const varIds = batch.map(b => b.variable.id);
  const candIds = [...new Set(batch.flatMap(b => b.candidates.map(c => c.cid)))];
  return {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            variable: { type: "string", enum: varIds },
            candidate: { type: "string", enum: [...candIds, "none"] },
            fit: { type: "string", enum: ["same", "proxy", "none"] },
          },
          required: ["variable", "candidate", "fit"],
        },
      },
    },
    required: ["matches"],
  };
}

function matchPrompt(batch) {
  return batch.map(b => {
    const v = b.variable;
    const head = `${v.id}: ${v.name}${v.measure ? ` (${v.measure})` : ""}${v.source ? ` [paper's source: ${v.source}]` : ""}`;
    const rows = b.candidates.map(c =>
      `   ${c.cid}: ${c.label}${c.dataset ? ` | ${c.dataset}` : ""}${c.description && c.description !== c.label ? ` | ${clean(c.description, 140)}` : ""}`);
    return [head, ...(rows.length ? rows : ["   (no candidates)"])].join("\n");
  }).join("\n\n");
}

/**
 * Attach catalog matches to each variable.
 *
 * @param search   (phrase) -> [{attr_id, label, dataset, description, kind, coverage, period}]
 * @param callLLM  (system, user, schema) -> raw | null; null disables judging
 */
async function matchVariables(variables, { search, callLLM = null, log = () => {} }) {
  const work = [];
  for (const v of variables) {
    const phrase = [v.name, v.measure].filter(Boolean).join(" ").slice(0, 200);
    const cands = (await search(phrase)).slice(0, CANDIDATES_PER_VARIABLE);
    work.push({ variable: v, candidates: cands.map((c, i) => ({ ...c, cid: `${v.id}c${i + 1}` })) });
  }
  let judged = 0, judgeFailed = 0;
  if (callLLM) {
    for (let i = 0; i < work.length; i += MATCH_BATCH) {
      const batch = work.slice(i, i + MATCH_BATCH).filter(b => b.candidates.length);
      if (!batch.length) continue;
      const parsed = parseJson(await callLLM(MATCH_SYSTEM, matchPrompt(batch), matchSchema(batch)));
      if (!parsed || !Array.isArray(parsed.matches)) { judgeFailed += batch.length; continue; }
      for (const m of parsed.matches) {
        const b = batch.find(x => x.variable.id === m.variable);
        if (!b || b.verdict) continue;
        const cand = b.candidates.find(c => c.cid === m.candidate);
        // A candidate that belongs to another variable, or a "none" with a
        // candidate, is read as what it is: no match unless both agree.
        b.verdict = cand && m.fit !== "none" ? { attr_id: cand.attr_id, fit: m.fit } : { attr_id: null, fit: "none" };
        judged++;
      }
    }
  }
  const out = work.map(({ variable, candidates, verdict }) => {
      const matches = candidates.map(({ cid, ...c }) => c);
      let status, selected, fit;
      if (!matches.length) { status = "missing"; selected = null; fit = "none"; }
      else if (verdict) {
        status = verdict.attr_id ? (verdict.fit === "same" ? "matched" : "proxy") : "missing";
        selected = verdict.attr_id; fit = verdict.fit;
      } else {
        // Not judged (no model, or its answer was unusable): retrieval's top
        // row is offered, marked so the card says nobody checked it.
        status = "unchecked"; selected = matches[0].attr_id; fit = null;
      }
      return { ...variable, matches, selected, fit, status };
  });
  return { variables: collapseSameRow(out), judging: { judged, failed: judgeFailed, enabled: !!callLLM } };
}

/**
 * Two variables matched to the same catalog row are one variable to GeoARK
 * ("CVD mortality" and "county-level CVD mortality predictors" both chose the
 * heart disease death rate). The first, by role, keeps it and lists the
 * others' names; an exposure that chose the OUTCOME's row is folded into the
 * outcome, since an analysis of a measure against itself is meaningless.
 */
function collapseSameRow(vars) {
  const holder = new Map();
  const out = [];
  for (const v of vars.slice().sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role])) {
    const h = v.selected ? holder.get(v.selected) : null;
    if (h) { (h.aliases ||= []).push(v.name); continue; }
    if (v.selected) holder.set(v.selected, v);
    out.push(v);
  }
  // Keep the extraction's order (outcome first) and stable ids.
  return out;
}

module.exports = {
  extractText, splitSections, planChunks, headingOf, squash, quoteIndex, checkQuote,
  mergeExtractions, extractStudy, matchVariables, resolveArea, statesIn, isUnitedStates,
  parseJson, PaperError, EXTRACTION_SCHEMA, EXTRACTION_SYSTEM, METHOD_FAMILIES, UNITS, ROLES,
  MAX_BYTES, LOWER48, FIFTY_DC, familyFromName, variableKey, FAMILY_TEXT,
};
