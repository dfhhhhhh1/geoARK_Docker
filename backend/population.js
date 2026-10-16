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
 * A whole-population COUNT: "Estimate|SEX AND AGE|Total population", the
 * Census POP_ESTIMATE, County Health Rankings "Population". Not a percentage,
 * a margin of error, or a sub-population ("60 years and over"), none of which
 * can stand in for the people a density counts.
 */
const TOTAL_POPULATION =
  /^(?:Estimate[|!]+(?!60 years)[^|!]+[|!]+Total population|(?:Estimate[|!]+)?Total population|POP_ESTIMATE|Population)$/i;

const isTotalPopulation = (desc) => TOTAL_POPULATION.test(String(desc || "").trim());

module.exports = { NEEDS_POPULATION, needsPopulation, isTotalPopulation };
