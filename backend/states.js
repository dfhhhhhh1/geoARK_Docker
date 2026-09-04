/**
 * State name -> FIPS prefix.
 *
 * county_geom.state_fp holds the two-digit code and is indexed, but nothing in
 * the database maps it to a name, so "counties in Missouri" had no way to
 * become a predicate. This is that mapping, in one place, used by two callers
 * that must agree:
 *
 *   - schemas.js constrains the planner's `states` field to these keys, so the
 *     decoder cannot emit a state that does not exist;
 *   - compile.js turns them into the FIPS prefixes the SQL filters on.
 *
 * Territories are included because county_geom carries 56 distinct state_fp
 * values, not 50 -- dropping them would silently make "all counties" and "every
 * state" disagree.
 */

const STATE_FIPS = {
  "Alabama": "01", "Alaska": "02", "Arizona": "04", "Arkansas": "05",
  "California": "06", "Colorado": "08", "Connecticut": "09", "Delaware": "10",
  "District of Columbia": "11", "Florida": "12", "Georgia": "13", "Hawaii": "15",
  "Idaho": "16", "Illinois": "17", "Indiana": "18", "Iowa": "19",
  "Kansas": "20", "Kentucky": "21", "Louisiana": "22", "Maine": "23",
  "Maryland": "24", "Massachusetts": "25", "Michigan": "26", "Minnesota": "27",
  "Mississippi": "28", "Missouri": "29", "Montana": "30", "Nebraska": "31",
  "Nevada": "32", "New Hampshire": "33", "New Jersey": "34", "New Mexico": "35",
  "New York": "36", "North Carolina": "37", "North Dakota": "38", "Ohio": "39",
  "Oklahoma": "40", "Oregon": "41", "Pennsylvania": "42", "Rhode Island": "44",
  "South Carolina": "45", "South Dakota": "46", "Tennessee": "47", "Texas": "48",
  "Utah": "49", "Vermont": "50", "Virginia": "51", "Washington": "53",
  "West Virginia": "54", "Wisconsin": "55", "Wyoming": "56",
  "American Samoa": "60", "Guam": "66", "Northern Mariana Islands": "69",
  "Puerto Rico": "72", "U.S. Virgin Islands": "78",
};

/**
 * Postal abbreviation -> full name.
 *
 * Feature layers store the two-letter code in their `state` column, but the
 * planner's `states` field takes full names. Anything turning a result back
 * into a follow-up question ("narrow this to MO") has to cross that gap, and it
 * belongs here rather than duplicated in the browser.
 */
const POSTAL_TO_NAME = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  AS: "American Samoa", GU: "Guam", MP: "Northern Mariana Islands",
  PR: "Puerto Rico", VI: "U.S. Virgin Islands",
};

/**
 * Multi-state regions, so "the Midwest" is one token for the planner instead of
 * twelve state names it has to recall correctly. Census divisions.
 */
const REGIONS = {
  "Midwest": ["Illinois", "Indiana", "Iowa", "Kansas", "Michigan", "Minnesota",
              "Missouri", "Nebraska", "North Dakota", "Ohio", "South Dakota",
              "Wisconsin"],
  "Northeast": ["Connecticut", "Maine", "Massachusetts", "New Hampshire",
                "New Jersey", "New York", "Pennsylvania", "Rhode Island",
                "Vermont"],
  "South": ["Alabama", "Arkansas", "Delaware", "District of Columbia", "Florida",
            "Georgia", "Kentucky", "Louisiana", "Maryland", "Mississippi",
            "North Carolina", "Oklahoma", "South Carolina", "Tennessee", "Texas",
            "Virginia", "West Virginia"],
  "West": ["Alaska", "Arizona", "California", "Colorado", "Hawaii", "Idaho",
           "Montana", "Nevada", "New Mexico", "Oregon", "Utah", "Washington",
           "Wyoming"],
};

/** Every value the planner's `states` field may contain. */
const AREA_NAMES = [...Object.keys(STATE_FIPS), ...Object.keys(REGIONS)];

/**
 * Expand a list of state and/or region names to distinct FIPS prefixes.
 * Unknown names are returned separately rather than dropped, so the validator
 * can tell the model exactly what it got wrong.
 */
function toFipsPrefixes(names) {
  const codes = new Set();
  const unknown = [];
  for (const raw of names || []) {
    const name = String(raw).trim();
    if (REGIONS[name]) {
      for (const s of REGIONS[name]) codes.add(STATE_FIPS[s]);
    } else if (STATE_FIPS[name]) {
      codes.add(STATE_FIPS[name]);
    } else {
      unknown.push(name);
    }
  }
  return { codes: [...codes], unknown };
}

/**
 * Does this question actually name a place?
 *
 * Used to decide whether filter_area is offered at all. Op-set size costs a
 * small model accuracy even on ops it cannot use, and most questions are
 * national -- so offering a state filter to every one of them would be paying
 * that cost constantly for a feature rarely wanted.
 *
 * Word-boundary matched, because a substring test puts "Indiana" inside
 * "Indianapolis" and, worse, finds "Ohio" in "Ohio River" -- but it also finds
 * the state name in "Washington County, Oregon", which is the right call: the
 * op being available does not oblige the planner to use it.
 */
/**
 * Place names this question mentions, longest match first.
 *
 * Longest-first matters: "South Carolina" contains "South", so a naive scan
 * reports both and the caller sees two places where the user named one. Any
 * name wholly inside an already-matched longer one is dropped.
 */
function statesMentioned(query) {
  if (!query) return [];
  const text = String(query);
  const hits = [];
  for (const name of [...AREA_NAMES].sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`\\b${escaped}\\b`, "i").test(text)) continue;
    if (hits.some(h => h.toLowerCase().includes(name.toLowerCase()))) continue;
    hits.push(name);
  }
  return hits;
}

/**
 * Words that only appear when a question is talking about a REGION.
 *
 * Not a list of regions. Listing regions is what this is trying to avoid: it
 * would mean "New England" works and "the Rust Belt" does not, forever, one
 * commit at a time. These are the shapes regional names take, so a phrase built
 * from them is recognisable without knowing which phrase it is.
 */
const REGION_WORDS = /\b(coast|coastal|belt|valley|region|seaboard|plains|heartland|delta|basin|peninsula|northwest|northeast|southwest|southeast|midwest|midwestern|new england|appalachia|appalachian|deep south|great lakes|gulf|rockies|rocky mountains|pacific|atlantic|sun belt|bible belt|corn belt|rust belt|tri-state)\b/i;

/**
 * Named boundaries that are not regions: ZIP codes and metros.
 *
 * "counties in ZIP code 63101" matched none of the patterns above -- ZIP is
 * all-caps so the capitalised-phrase rule skipped it -- so filter_place was
 * never offered and the answer came back with all 3,220 counties and no
 * indication a restriction had been dropped.
 *
 * Word-based rather than matching a bare five-digit number: "income above
 * 75000" is also five digits, and offering the op there is a false positive
 * for no benefit.
 */
const BOUNDARY_WORDS = /\b(zip|zcta|postal\s*code|metro|metropolitan|micropolitan|city limits|urbanized)\b/i;

/**
 * A capitalised phrase after a locative preposition: "in New England",
 * "across the Pacific Northwest". Deliberately loose. A false positive costs
 * one extra op in the decoding schema; a false negative means the question
 * silently returns national results, which is far worse and is exactly what
 * "counties in New England" did, 0 rows from a plan that looked fine.
 */
const LOCATIVE_PHRASE =
  /\b(?:in|across|within|throughout|around|near|for)\s+(?:the\s+)?((?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+){0,3})\b/;

/**
 * Does this question restrict to a place at all?
 *
 * Gates whether filter_area is offered. It used to be a match against the 60
 * names in AREA_NAMES, which meant any region not on that list was not merely
 * unsupported but INVISIBLE: filter_area never appeared in the schema, the
 * planner had no way to express the restriction, and the answer came back
 * national with nothing to indicate a restriction had been dropped.
 */
function queryMentionsArea(query) {
  if (!query) return false;
  const text = String(query);
  return statesMentioned(text).length > 0
      || REGION_WORDS.test(text)
      || BOUNDARY_WORDS.test(text)
      || LOCATIVE_PHRASE.test(text);
}

module.exports = {
  STATE_FIPS, REGIONS, AREA_NAMES, POSTAL_TO_NAME, toFipsPrefixes,
  queryMentionsArea, statesMentioned,
};
