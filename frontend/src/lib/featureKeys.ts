/**
 * Display names for the columns an op computes onto a feature layer
 * (backend planner/compile.js featureValueOf): within's distance or travel
 * time, enrich's value of the unit a feature lies in, zonal over features,
 * overlay's amount inside. The server sends the column under a short key and
 * says what it is in `value_label`; shown raw, "zonal_value: 41.237..." tells
 * a reader nothing.
 */
const COMPUTED =
  /^(zonal_value|amount_inside|(county|tract|bg|zcta|place|zone)_value|((drive|walk)_minutes|(walk|road)_miles|miles)_to_nearest)$/;

export const isComputedKey = (k: string): boolean => COMPUTED.test(k);

/** The label to show for a property key. */
export const featureKeyLabel = (k: string, valueLabel?: string | null): string =>
  isComputedKey(k) ? (valueLabel || k.replace(/_/g, ' ')) : k;

/** Computed values arrive at full float precision; source attributes are left as stored. */
export const featureValueText = (k: string, v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (isComputedKey(k)) {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2 });
    }
  }
  return String(v);
};
