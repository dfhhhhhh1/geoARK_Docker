/**
 * Questions whose answer is defined in terms of a population count.
 *
 * A density is people per unit of area and a per-person rate is a count over
 * people, so for these questions a TOTAL POPULATION series is part of what was
 * asked, whether or not the word "population" appears. Two places need the
 * same test, and they must agree:
 *
 *   - retrieval (unified_search_server.js) adds a "total population" search,
 *     because the decomposer splits "population density" into terms that never
 *     retrieve one;
 *   - the relevance check (planner/relevance.js) must not then reject that
 *     series as "a thing the question does not name". Measured 2026-10-15,
 *     qwen3:14b: "how densely populated are the counties in Texas" and "people
 *     per square mile by county" planned load(Total population) -> per_area,
 *     and the check refused both, because "populated" and "people" share no
 *     exact word with "Total population".
 *
 * "per square mile" alone does not count: "hospitals per square mile" is a
 * land-area question and needs no population.
 */
const NEEDS_POPULATION =
  /\b(?:densit(?:y|ies)|densely|(?:people|persons|residents|population)\s+per\s|per\s+capita|per\s+(?:person|people|persons|resident|residents|inhabitant|inhabitants|head)|per\s+(?:1|10|100)?,?0{3}(?:,?0{3})?\b|per\s+(?:a\s+)?(?:thousand|million)|population[- ]adjusted)/i;

const needsPopulation = (query) => NEEDS_POPULATION.test(String(query || ""));

/**
 * A question ABOUT population size: "the 50 least populous counties", "the
 * most populated", "counties by population". The relevance check refused
 * Total population for "least populous" (2026-11-11): "population" is generic
 * in sharedWords and "populous" is a different word, so nothing overruled the
 * model's "none", and the first step of a three-step workflow was refused.
 */
const POPULATION_SIZE =
  /\b(?:populous|populated|population\s+size|by\s+population|(?:most|fewest|least)\s+(?:people|residents|inhabitants))\b/i;

const asksPopulationSize = (query) => POPULATION_SIZE.test(String(query || ""));

/**
 * A whole-population COUNT: "Estimate|SEX AND AGE|Total population", the
 * Census POP_ESTIMATE, County Health Rankings "Population". Not a percentage,
 * a margin of error, or a sub-population ("60 years and over"), none of which
 * can stand in for the people a density counts.
 *
 * ERS rows describe themselves from etl/ers_variables.yaml as "Total
 * population (<which estimate>)"; before that file they were the bare code,
 * which is why POP_ESTIMATE is still accepted on its own.
 */
const TOTAL_POPULATION =
  /^(?:Estimate[|!]+(?!60 years)[^|!]+[|!]+Total population|(?:Estimate[|!]+)?Total population(?: \([^()]*\))?|POP_ESTIMATE|Population)$/i;

const isTotalPopulation = (desc) => TOTAL_POPULATION.test(String(desc || "").trim());

/**
 * A population COUNT a density can be built on: a total population, or the
 * WorldPop gridded count, which is the only population at the grid level and
 * which levels.js falls back to elsewhere.
 *
 * Used by the relevance check's population rule only, not by series_stats:
 * there, isTotalPopulation decides which ACS series are coverage equivalents,
 * and a grid estimate is not one. The rule missed WorldPop until 2026-11-11:
 * "Where are the most densely populated 4 km grid cells in Colorado?" was
 * refused as "population, which the question does not name" once a reasoning
 * budget let the check finish. Before that the check timed out and failed
 * open, so the miss never showed.
 */
const POPULATION_GRID = /^Estimated population from the WorldPop\b/i;
const isPopulationCount = (desc) =>
  isTotalPopulation(desc) || POPULATION_GRID.test(String(desc || "").trim());

/**
 * A question that COUNTS people: "how many people live more than 20 miles
 * from a hospital", "what share of Colorado's population lives within 5
 * miles". A population count is the subject, not a stand-in. The relevance
 * check refused Total population for the first of those (2026-11-11), the
 * same false "none" the density questions got: "people" is generic in
 * sharedWords, so nothing overruled it.
 */
const COUNTS_PEOPLE =
  /\b[Hh]ow\s+many\s+(?:people|persons|residents|inhabitants)\b|\b(?:share|percent(?:age)?|proportion|fraction)\s+of\s+(?:the\s+)?(?:[A-Z][\w.]*(?:'s)?\s+){0,3}population\b/;
const countsPeople = (query) => COUNTS_PEOPLE.test(String(query || ""));

module.exports = { NEEDS_POPULATION, needsPopulation, asksPopulationSize, countsPeople, isTotalPopulation, isPopulationCount };
