import type { AnalysisResponse, AnalysisRow, AttributeOrigin, PlanStep } from '../types';

/**
 * Export builders.
 *
 * Every export carries its provenance, because a downloaded file outlives the
 * screen it came from. A CSV of "poverty rate" is not checkable a month later
 * unless it also says which poverty measure, from which table, produced by
 * which model, when. The numbers and the account of where they came from travel
 * together or the numbers are not worth much.
 */

export function download(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'analysis';

/**
 * Where a number physically came from, in one string.
 *
 * Feature datasets name their geometry column rather than value_column: they
 * are counted or measured against, so quoting the column retrieval happened to
 * match ("website") would misstate the source of the number.
 */
function sourceRef(o: AttributeOrigin): string {
  if (o.census_code) return `acs_county_values · ${o.census_code}`;
  if (o.geometry_column) return `${o.table_name ?? '-'} · ${o.geometry_column} (geometry)`;
  return `${o.table_name ?? '-'}${o.value_column ? ` · ${o.value_column}` : ''}`;
}

const csvEscape = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The attribute narrowing a step applied, for the exported record.
 *
 * A downloaded CSV of "hospitals per county" that silently counted only
 * critical-access ones is not checkable. The filter travels with the file.
 */
const filterSuffix = (step: PlanStep): string => {
  const filters = step.attribute_filters ?? [];
  return filters.length
    ? ` (${filters.map(f => `${f.column} = ${f.value}`).join(', ')})`
    : '';
};

/** Human-readable one-line summary of a step, shared by the report exports. */
export function describeStep(step: PlanStep, nameOf: (id: string) => string,
                             indexOf: (stepId: string) => number): string {
  const from = step.inputs.map(i => `step ${indexOf(i)}`).join(' and ');
  switch (step.op) {
    case 'load': return `Load ${nameOf(step.attr_id)}`;
    case 'count_features':
      return `Count ${nameOf(step.attr_id)}${filterSuffix(step)} features per county`;
    case 'count_near':
      return `Count ${nameOf(step.attr_id)} within ${step.miles} miles of ` +
             `${nameOf(step.near_attr_id ?? '')}, per county`;
    case 'nearest_distance':
      return `Miles from each county to the nearest ${nameOf(step.attr_id)}`;
    case 'select_features': {
      const place = [step.city, ...(step.states ?? [])].filter(Boolean).join(', ');
      return `Locations of ${nameOf(step.attr_id)}${filterSuffix(step)}` +
             `${place ? ` in ${place}` : ''}`;
    }
    case 'filter_area': return `Restrict to ${(step.states ?? []).join(', ')}`;
    case 'filter_place':
      return `Restrict to ${[step.place_name, ...(step.states ?? [])].filter(Boolean).join(', ')} (${step.place_kind ?? 'place'})`;
    case 'per_area': return `Divide ${from} by county land area (per square mile)`;
    case 'filter_attr': return `Keep ${from} where value ${step.operator} ${step.value}`;
    case 'normalize':
      return `Divide ${from}${step.scale && step.scale !== 1 ? `, scaled by ${step.scale}` : ''}`;
    case 'aggregate': return `${step.function} of ${from}`;
    case 'rank':
      return `${step.direction === 'asc' ? 'Lowest' : 'Highest'} ${step.limit ?? 20} of ${from}`;
    case 'join': return `Combine ${from} on county`;
    case 'output': return `Output ${from}`;
    default: return from;
  }
}

function stepHelpers(result: AnalysisResponse) {
  const nameOf = (attrId: string): string => {
    const o = result.provenance?.attribute_origins.find(x => x.attr_id === attrId);
    if (o) return o.dataset ? `${o.dataset}, ${o.description ?? ''}`.trim() : (o.description ?? attrId);
    const c = result.candidates?.find(x => x.attr_id === attrId);
    return c?.attr_desc || attrId;
  };
  const indexOf = (stepId: string) => result.plan.steps.findIndex(s => s.id === stepId) + 1;
  return { nameOf, indexOf };
}

/** Provenance as `#`-prefixed comment lines, the convention CSV readers skip. */
function csvProvenanceHeader(result: AnalysisResponse): string[] {
  const p = result.provenance;
  const lines = [
    `# GeoARK analysis result`,
    `# question: ${result.query}`,
    `# intent: ${result.plan.intent}`,
  ];
  if (p) {
    lines.push(
      `# generated: ${p.generated_at}`,
      `# planner model: ${p.models.planner}`,
      `# decomposition model: ${p.models.decomposition}`,
      `# embedding model: ${p.models.embedding}`,
      `# database: ${p.database ?? 'unknown'}`,
    );
    const { nameOf, indexOf } = stepHelpers(result);
    result.plan.steps.forEach((st, i) => {
      lines.push(`# step ${i + 1}: ${describeStep(st, nameOf, indexOf)}`);
    });
    for (const o of p.attribute_origins) {
      lines.push(`# source: ${o.dataset ?? '?'} | ${o.description ?? ''} | ${sourceRef(o)}`);
    }
    lines.push(`# units: ${p.units_note}`);
  }
  lines.push(`# rows: ${result.row_count ?? 0}`);
  lines.push('#');
  return lines;
}

export function toCsv(result: AnalysisResponse, rows: AnalysisRow[]): string {
  // A select_features result has no fips/value contract: each row is a location
  // with whatever attributes its layer carries, plus a coordinate.
  if (result.output_mode === 'features') return featureCsv(result);
  const body = rows.map(r =>
    [r.fips, r.name, r.state_fp, r.value].map(csvEscape).join(','));
  return [...csvProvenanceHeader(result), 'fips,name,state_fp,value', ...body].join('\n');
}

/** Representative point for a feature, so a CSV row still has a location. */
function centroidish(geom: { type: string; coordinates: unknown } | null): [number, number] | null {
  if (!geom) return null;
  const flat: number[][] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      flat.push(c as number[]);
      return;
    }
    for (const x of c) walk(x);
  };
  walk(geom.coordinates);
  if (!flat.length) return null;
  const lon = flat.reduce((a, c) => a + c[0], 0) / flat.length;
  const lat = flat.reduce((a, c) => a + c[1], 0) / flat.length;
  return [lon, lat];
}

function featureCsv(result: AnalysisResponse): string {
  const features = result.features ?? [];
  // Union of keys, because layers are inconsistent: `name` exists on about half
  // of them, `city` on 41%, and a fixed column list would drop real data.
  const keys = [...new Set(features.flatMap(f => Object.keys(f.properties ?? {})))];
  const header = [...keys, 'longitude', 'latitude'].join(',');
  const body = features.map(f => {
    const pt = centroidish(f.geometry as never);
    return [
      ...keys.map(k => csvEscape(f.properties?.[k] ?? '')),
      pt ? pt[0] : '', pt ? pt[1] : '',
    ].join(',');
  });
  return [...csvProvenanceHeader(result), header, ...body].join('\n');
}

/**
 * GeoJSON with the provenance attached as a foreign member.
 *
 * RFC 7946 permits members beyond the specified ones, and consumers that do not
 * understand `metadata` ignore it -- so this stays a valid FeatureCollection
 * while still carrying its own account of where it came from.
 */
export function toGeoJson(
  result: AnalysisResponse,
  rows: AnalysisRow[],
  counties: { features: Array<{ properties?: Record<string, unknown> }> },
): string {
  // Feature results already ARE geometry -- pass them straight through rather
  // than joining anything to county boundaries.
  if (result.output_mode === 'features') {
    return JSON.stringify({
      type: 'FeatureCollection',
      metadata: {
        title: result.plan.intent,
        question: result.query,
        ...(result.provenance ?? {}),
        sql: result.sql,
        feature_count: result.features?.length ?? 0,
      },
      features: result.features ?? [],
    });
  }

  const byFips = new Map(rows.map(r => [String(r.fips).padStart(5, '0'), r]));
  const features = counties.features
    .filter(f => byFips.has((f.properties as { GEOID?: string })?.GEOID ?? ''))
    .map(f => {
      const row = byFips.get((f.properties as { GEOID?: string }).GEOID as string)!;
      return {
        ...f,
        properties: {
          GEOID: row.fips,
          name: row.name,
          state_fp: row.state_fp,
          value: row.value,
        },
      };
    });
  return JSON.stringify({
    type: 'FeatureCollection',
    metadata: {
      title: result.plan.intent,
      question: result.query,
      ...(result.provenance ?? {}),
      sql: result.sql,
      row_count: result.row_count,
    },
    features,
  });
}

/** Human-readable report. Markdown so it opens anywhere and diffs cleanly. */
export function toMarkdownReport(result: AnalysisResponse, rows: AnalysisRow[]): string {
  const p = result.provenance;
  const { nameOf, indexOf } = stepHelpers(result);
  const out: string[] = [];

  out.push(`# ${result.plan.intent}`, '');
  out.push(`**Question asked:** ${result.query}`, '');
  if (p) out.push(`**Generated:** ${new Date(p.generated_at).toUTCString()}`, '');

  out.push('## Steps taken', '');
  result.plan.steps.forEach((st, i) => {
    out.push(`${i + 1}. ${describeStep(st, nameOf, indexOf)}`);
  });
  out.push('');

  out.push('## Data sources', '');
  if (p?.attribute_origins.length) {
    out.push('| Dataset | Attribute | Physical source | Period |');
    out.push('|---|---|---|---|');
    for (const o of p.attribute_origins) {
      const period = o.start_date
        ? `${o.start_date}${o.end_date && o.end_date !== o.start_date ? `, ${o.end_date}` : ''}`
        : '-';
      const src = sourceRef(o);
      out.push(`| ${o.dataset ?? '-'} | ${(o.description ?? '-').replace(/\|/g, '›')} | \`${src}\` | ${period} |`);
    }
  } else {
    out.push('_No attribute origins recorded._');
  }
  out.push('');

  out.push('## How it was produced', '');
  if (p) {
    out.push(`- **Planner model:** \`${p.models.planner}\``);
    out.push(`- **Decomposition model:** \`${p.models.decomposition}\``);
    out.push(`- **Embedding model:** \`${p.models.embedding}\``);
    out.push(`- **Catalog searched:** ${p.retrieval.catalog_rows.toLocaleString()} attributes`);
    out.push(`- **Candidates retrieved / executable:** ${p.retrieval.retrieved} / ${p.retrieval.executable}`);
    out.push(`- **Plan repairs needed:** ${p.retrieval.plan_repairs}`);
    out.push(`- **Database:** \`${p.database ?? 'unknown'}\``);
    if (p.retrieval.corpus_cache_key) {
      out.push(`- **Embedding corpus:** \`${p.retrieval.corpus_cache_key}\``);
    }
  }
  out.push(`- **Rows returned:** ${result.row_count ?? 0}`);
  out.push(`- **Total time:** ${(result.ms / 1000).toFixed(1)}s` +
           (result.execution_ms !== undefined ? ` (query ${result.execution_ms}ms)` : ''));
  out.push('');

  if (p) out.push(`> **Units.** ${p.units_note}`, '');

  if (result.sql) {
    out.push('## Generated SQL', '', '```sql', result.sql, '```', '');
  }

  if (result.output_mode === 'features') {
    const feats = (result.features ?? []).slice(0, 25);
    if (feats.length) {
      const keys = [...new Set(feats.flatMap(f => Object.keys(f.properties ?? {})))];
      out.push(`## Locations (first ${feats.length} of ${result.features?.length ?? 0})`, '');
      out.push(`| ${keys.join(' | ')} |`, `|${keys.map(() => '---').join('|')}|`);
      for (const f of feats) {
        out.push(`| ${keys.map(k => (f.properties?.[k] ?? '-')).join(' | ')} |`);
      }
      out.push('');
    }
  } else {
    const shown = rows.slice(0, 25);
    if (shown.length) {
      out.push(`## Results (first ${shown.length} of ${result.row_count})`, '');
      out.push('| County | FIPS | Value |', '|---|---|---:|');
      for (const r of shown) {
        out.push(`| ${r.name ?? '-'} | ${r.fips} | ${r.value === null ? '-' : r.value} |`);
      }
      out.push('');
    }
  }

  out.push('---', '',
    '_Produced by GeoARK from a natural-language question. The plan above is ' +
    'the full account of what was computed; check the data sources against the ' +
    'question before relying on the numbers._');
  return out.join('\n');
}

/** Everything, machine-readable: provenance, plan, SQL and every row. */
export function toBundle(result: AnalysisResponse, rows: AnalysisRow[]): string {
  return JSON.stringify({
    schema: 'geoark.analysis.bundle/1',
    question: result.query,
    intent: result.plan.intent,
    provenance: result.provenance ?? null,
    decomposition: result.decomposition,
    plan: result.plan,
    sql: result.sql ?? null,
    params: result.params ?? null,
    output_mode: result.output_mode ?? 'values',
    row_count: result.row_count ?? 0,
    timings_ms: { total: result.ms, execution: result.execution_ms ?? null },
    ...(result.output_mode === 'features'
      ? { features: result.features ?? [] }
      : { rows }),
  }, null, 2);
}
