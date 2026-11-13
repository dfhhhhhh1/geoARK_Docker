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

/**
 * A unit the server named for a level it alone knows: a zone set a user
 * loaded ("ward" for z_stl_wards), sent as `level_unit` with the answer.
 */
export function rememberUnit(level: string | undefined | null, unit?: { singular: string; plural: string } | null) {
  if (!level || !unit?.singular || UNIT[level]) return;
  UNIT[level] = [unit.singular.charAt(0).toUpperCase() + unit.singular.slice(1), unit.plural];
}

/** "Census tract" (a column heading). */
export const unitHeading = (level?: string | null) => (UNIT[level ?? 'county'] ?? UNIT.county)[0];

/** "census tracts" (a plural noun for counts). */
export const unitPlural = (level?: string | null) => (UNIT[level ?? 'county'] ?? UNIT.county)[1];
