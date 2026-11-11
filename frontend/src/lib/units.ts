/**
 * What one row of an answer is, in words. "county" unless the question named
 * another unit (backend/planner/levels.js), in which case the API says so in
 * `level`. Used wherever the UI counts or heads rows, so a tract answer does
 * not read "10 counties".
 */
const UNIT: Record<string, [string, string]> = {
  county: ['County', 'counties'],
  tract: ['Census tract', 'census tracts'],
  zcta: ['ZIP code area', 'ZIP code areas'],
  grid4k: ['4 km grid cell', '4 km grid cells'],
  grid16k: ['16 km grid cell', '16 km grid cells'],
  grid64k: ['64 km grid cell', '64 km grid cells'],
};

/** "Census tract" (a column heading). */
export const unitHeading = (level?: string | null) => (UNIT[level ?? 'county'] ?? UNIT.county)[0];

/** "census tracts" (a plural noun for counts). */
export const unitPlural = (level?: string | null) => (UNIT[level ?? 'county'] ?? UNIT.county)[1];
