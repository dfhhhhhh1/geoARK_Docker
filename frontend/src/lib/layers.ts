import type { AnalysisResponse, AnalysisRow, MappedFeature } from '../types';
import { attrOfStep, describeAttr, deriveSeries, stripCoverage } from './series';

/**
 * One drawable layer in the map's layer stack (components/LayerStack.tsx).
 *
 * Everything that can be put on the map becomes one of these: each output of a
 * multi-output plan, each measure of a two-measure join, a workflow step, an
 * earlier answer in the thread, or a measure or facility dataset added from
 * the catalog. One shape is what lets them be stacked, reordered and styled
 * the same way regardless of where they came from.
 */
export interface StackLayer {
  /** Unique across the stack; stable for the same data. */
  key: string;
  label: string;
  /** Where it came from: "This answer", "Step 1", "Earlier answer", "Catalog". */
  source: string;
  mode: 'values' | 'features';
  rows?: AnalysisRow[];
  /** Which column of `rows` this layer colours by (a join carries two). */
  valueKey?: 'value' | 'value_b';
  features?: MappedFeature[];
  diverging?: boolean;
  valueLabel?: string | null;
  /** Added by the user, so it can be removed. The answer's own layers cannot. */
  removable: boolean;
}

/** The measure a step of a plan reads, as a short name. */
function nameOfStep(result: AnalysisResponse, stepId: string): string | null {
  const d = describeAttr(result, attrOfStep(result, stepId));
  return d ? stripCoverage(d) : null;
}

/**
 * The layers one answer puts on the map, top first.
 *
 * Several outputs: one layer each, the planner's own layers before the
 * components the compiler added beside an arithmetic result. A join: its two
 * measures as two layers, which is the point of asking for both. Otherwise one.
 * Statistics and factor tables have no county layer and give none.
 */
export function layersOf(result: AnalysisResponse | null | undefined, keyPrefix: string,
                         source: string, removable = false): StackLayer[] {
  if (!result || result.execution_error || result.stats || result.explain) return [];
  const base = { source, removable };

  if (result.layers && result.layers.length > 1) {
    // Points and lines above fills, the cartographic default: a county fill
    // drawn over a point layer hides it. Then the planner's own layers before
    // the components the compiler added beside an arithmetic result.
    const rank = (l: { mode: string; part?: boolean }) => (l.mode === 'features' ? 0 : l.part ? 2 : 1);
    const ordered = [...result.layers].sort((a, b) => rank(a) - rank(b));
    return ordered.flatMap((l, i): StackLayer[] => {
      const name = nameOfStep(result, l.step) ?? `${result.plan.intent} (${i + 1})`;
      if (l.mode === 'features') {
        if (!l.features?.length) return [];
        return [{ ...base, key: `${keyPrefix}:${l.id}`, label: name, mode: 'features', features: l.features }];
      }
      if (!l.rows?.length) return [];
      return [{
        ...base, key: `${keyPrefix}:${l.id}`, label: l.part ? `${name} (component)` : name,
        mode: 'values', rows: l.rows, valueKey: 'value', diverging: l.diverging,
        valueLabel: l.value_label ?? null,
      }];
    });
  }

  if (result.output_mode === 'features') {
    return result.features?.length
      ? [{ ...base, key: `${keyPrefix}:features`, label: result.plan.intent, mode: 'features',
           features: result.features }]
      : [];
  }

  const rows = result.rows ?? [];
  if (!rows.length) return [];
  const series = deriveSeries(result, rows);
  if (series.length > 1) {
    return series.map(s => ({
      ...base, key: `${keyPrefix}:${s.key}`, label: s.label, mode: 'values' as const,
      rows, valueKey: s.key,
    }));
  }
  const output = result.plan.steps.find(s => s.op === 'output');
  return [{
    ...base, key: `${keyPrefix}:value`,
    label: (result.comparison || !output ? null : nameOfStep(result, output.inputs[0])) ?? result.plan.intent,
    mode: 'values', rows, valueKey: 'value', diverging: result.diverging,
    valueLabel: result.value_label ?? null,
  }];
}
