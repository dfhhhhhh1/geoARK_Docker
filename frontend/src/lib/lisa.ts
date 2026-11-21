/**
 * LISA cluster classes on the map (backend planner/moran.js).
 *
 * A LISA layer's value is a class code, not a measurement: High-High +2,
 * High-Low +1, not significant 0, Low-High -1, Low-Low -2. Quantile or
 * symmetric bins over five integers put edges in arbitrary places, so a class
 * layer gets fixed breaks between the codes and the conventional LISA colours:
 * deep red / light red / grey / light blue / deep blue, taken from the ends
 * of whichever diverging ramp the reader chose, with a neutral grey for "not
 * significant" (a six-step ramp has no middle colour).
 */
import type { MoranClass } from '../types';

export const LISA_BREAKS = [-1.5, -0.5, 0.5, 1.5];

const NEUTRAL_LIGHT = '#e5e7eb';
const NEUTRAL_DARK = '#3f3f46';

/** Five colours, lowest class first, from a diverging ramp's steps. */
export function lisaColours(steps: string[], isDark: boolean): string[] {
  const last = steps.length - 1;
  return [steps[0], steps[1], isDark ? NEUTRAL_DARK : NEUTRAL_LIGHT, steps[last - 1], steps[last]];
}

/** Legend labels in bin order (lowest code first). */
export function lisaLabels(classes: MoranClass[]): string[] {
  return [...classes].sort((a, b) => a.value - b.value).map(c => c.label);
}

/** The scale for a class layer, or null for an ordinary one. */
export function classScale(classes: MoranClass[] | null | undefined, steps: string[], isDark: boolean) {
  if (!classes?.length) return null;
  return { breaks: LISA_BREAKS, colors: lisaColours(steps, isDark), labels: lisaLabels(classes) };
}
