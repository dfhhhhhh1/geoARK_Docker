import type { AnalysisResponse, AnalysisRow } from '../types';

/**
 * The measures a values result carries, and what to call them.
 *
 * A `join` step keeps both of its inputs, so "population and poverty rate"
 * comes back as ONE result with two numbers per county rather than two
 * analyses. The compiler emits the second as `value_b`; the labels are worked
 * out here, because the server sends attribute identifiers and the browser
 * already holds the candidate descriptions needed to turn those into words.
 */

export interface Series {
  key: 'value' | 'value_b';
  label: string;
}

/**
 * ACS descriptions are `!!`-delimited paths, e.g.
 *   "Estimate!!INCOME AND BENEFITS!!Total households!!Median household income"
 * The leading segments are shared across hundreds of attributes, so a label cut
 * from the front distinguishes nothing. The last two segments are the part that
 * differs, and they fit in a legend.
 */
export function shortLabel(desc: string, max = 52): string {
  const parts = desc.split(/\s*(?:!!|\|\|)\s*/).filter(Boolean);
  let label = parts.length > 1 ? parts.slice(-2).join(' › ') : (parts[0] ?? desc);
  label = label.replace(/[|!]{1,2}/g, ' › ').replace(/\s+/g, ' ').trim();
  if (label.length > max) label = `${label.slice(0, max - 1).trimEnd()}…`;
  return label || desc;
}

/**
 * Walk back from a step to the attribute it ultimately reads.
 *
 * A join input is often a bare `load`, but it can be a chain -- `load` then
 * `filter_area`, say -- and only the leaf carries an attr_id. Following
 * inputs[0] finds it. The visited set guards against a malformed plan cycling;
 * a plan is validated before it reaches here, but this runs in the browser on
 * data from the network, and an infinite loop would take the page down.
 */
function attrOfStep(result: AnalysisResponse, stepId: string): string | null {
  const seen = new Set<string>();
  let id: string | undefined = stepId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const step = result.plan.steps.find(s => s.id === id);
    if (!step) return null;
    if (step.attr_id) return step.attr_id;
    id = step.inputs?.[0];
  }
  return null;
}

function describeAttr(result: AnalysisResponse, attrId: string | null): string | null {
  if (!attrId) return null;
  const origin = result.provenance?.attribute_origins.find(o => o.attr_id === attrId);
  if (origin?.description) return shortLabel(origin.description);
  const cand = result.candidates?.find(c => c.attr_id === attrId);
  if (cand?.attr_desc) return shortLabel(cand.attr_desc);
  return cand?.attr_orig ?? null;
}

/**
 * One entry for a single-measure result, two when a `join` reached the output.
 *
 * Presence of `value_b` on the rows is the test rather than the plan shape: the
 * rows are what the map actually draws, and a plan whose join was consumed by a
 * later step returns one column no matter what the steps say.
 */
export function deriveSeries(result: AnalysisResponse, rows: AnalysisRow[]): Series[] {
  const single: Series[] = [{ key: 'value', label: result.plan.intent }];
  if (!rows.some(r => r.value_b !== undefined && r.value_b !== null)) return single;

  const output = result.plan.steps.find(s => s.op === 'output');
  const joinId = output?.inputs?.[0];
  const join = result.plan.steps.find(s => s.id === joinId && s.op === 'join');
  if (!join || (join.inputs?.length ?? 0) < 2) {
    // The column is there but the plan does not explain it. Show both anyway
    // with honest placeholder names: dropping a series the user asked for is
    // worse than labelling it generically.
    return [
      { key: 'value', label: 'First measure' },
      { key: 'value_b', label: 'Second measure' },
    ];
  }

  return [
    {
      key: 'value',
      label: describeAttr(result, attrOfStep(result, join.inputs[0])) ?? 'First measure',
    },
    {
      key: 'value_b',
      label: describeAttr(result, attrOfStep(result, join.inputs[1])) ?? 'Second measure',
    },
  ];
}
