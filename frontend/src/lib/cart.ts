import { download, slug } from './exports';
import type { ExpandedSearch } from '../hooks/useAnalyzeStream';
import { expandedBody } from '../hooks/useExpandedSearch';

/**
 * The data cart (docs/DATA_CART_PLAN.md, slice 1).
 *
 * The shelf comes from POST /api/cart/suggest, the checkout from POST
 * /api/cart/table. Every download is built from the checkout's table, never
 * from what the browser believes is in the cart, so a file cannot claim a
 * column the server did not produce.
 */

export type ShelfRole = 'subject' | 'linked' | 'denominator' | 'context';

export interface ShelfWhy { kind: 'question' | 'literature' | 'pubmed' | 'web'; text: string }

export interface ShelfItem {
  id: string;
  label: string;
  description: string | null;
  dataset: string | null;
  kind: 'value' | 'feature' | 'raster';
  role: ShelfRole;
  why: ShelfWhy[];
  score: number;
  coverage: number | null;
  period: string | null;
  /** Set when the item cannot be in a checkout table (rasters, slice 1). */
  checkout: string | null;
  variants: Omit<ShelfItem, 'variants'>[];
}

export interface SuggestResponse {
  query: string;
  items: ShelfItem[];
  default_cart: string[];
  dropped: Record<string, number>;
  expansion: { concepts: string[] } | null;
  research: { sources: string[]; keywords: string[] } | null;
  /** Who picked default_cart: the code rules, or the LLM curator (Phase 2). */
  selection: 'rules' | 'curator' | 'rules (curator failed)';
  curated: {
    cart: string[];
    verdicts: Record<string, 'direct' | 'related' | 'denominator' | 'none'>;
    notes: string[];
    ms: number;
    fallback?: string;
  } | null;
  ms: number;
}

/** What the cart remembers about an item: enough to show it with no shelf. */
export interface CartItem {
  id: string;
  label: string;
  kind: ShelfItem['kind'];
  dataset: string | null;
  /** Why it was added: the shelf's first reason, or "added by hand". */
  why: string;
}

export interface CartColumn {
  item: string;
  header: string;
  description: string | null;
  dataset: string | null;
  source_kind: string;
  table_name: string | null;
  census_code: string | null;
  period: string | null;
  range: { min: number; max: number } | null;
  missing: number;
}

export interface CartTable {
  columns: CartColumn[];
  rows: { fips: string; name: string; state: string | null; values: (number | null)[] }[];
  row_count: number;
  provenance: {
    generated_at: string; database: string; corpus_cache_key: string | null;
    states: string[] | null; level: string; note: string;
  };
  ms: number;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error([data.error, data.detail].filter(Boolean).join(': ') || `HTTP ${res.status}`);
  return data as T;
}

export const suggest = (q: string, expanded: ExpandedSearch, curate?: boolean) =>
  post<SuggestResponse>('/api/cart/suggest', {
    q, ...expandedBody(expanded), ...(curate !== undefined ? { curate } : {}),
  });

export const checkout = (items: string[], states: string[] | null) =>
  post<CartTable>('/api/cart/table', { items, ...(states?.length ? { states } : {}) });

// ---------------------------------------------------------------------------
// AutoML with spatial cross-validation (POST /api/cart/model; plan Phase 6, B).

export interface ModelResult {
  target: string;
  target_item: string;
  split: 'spatial' | 'random';
  counties: number;
  features: string[];
  cv: {
    split: string; grouping: 'states' | 'blocks' | 'random'; groups: number | null; folds: number;
    min_groups: number; r2: number | null; r2_fold_mean: number | null;
    rmse: number | null; baseline_rmse: number | null; scored: number; seconds_per_fold: number;
  };
  folds: { fold: number; n_test: number; held_out: string[] | null; r2: number | null; rmse: number | null;
           best_model: string }[];
  importance: { feature: string; importance: number | null; spread: number | null; folds: number }[];
  models: Record<string, number>;
  sample: { id: string; actual: number | null; predicted: number | null }[];
  spatial: { target_moran: number | null; residual_moran: number | null };
  companion: {
    feature: string; status: string; rho: number | null; partial_rho: number | null;
    ci_low: number | null; ci_high: number | null; n: number | null; n_effective: number | null;
    same_as: string | null;
  }[];
  warnings: string[];
  provenance: CartTable['provenance'] & { service: string; ml_ms: number };
  ms: number;
}

export const trainModel = (items: string[], states: string[] | null, target: string,
                           split: 'spatial' | 'random' = 'spatial') =>
  post<ModelResult>('/api/cart/model', { items, target, split, ...(states?.length ? { states } : {}) });

// ---------------------------------------------------------------------------
// The cart itself: kept per browser. Storage can be blocked; the cart then
// lives for the page, which is still usable.

const KEY = 'geoark.cart.v1';

export function loadCart(): CartItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter(x => x && typeof x.id === 'string') : [];
  } catch { return []; }
}

export function saveCart(items: CartItem[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* not worth failing */ }
}

export const toCartItem = (it: ShelfItem | Omit<ShelfItem, 'variants'>, why?: string): CartItem => ({
  id: it.id, label: it.label, kind: it.kind, dataset: it.dataset,
  why: why ?? it.why[0]?.text ?? 'added by hand',
});

// ---------------------------------------------------------------------------
// Downloads. Each carries its provenance (exports.ts says why).

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function provenanceLines(t: CartTable, cart: CartItem[], query: string | null): string[] {
  const why = new Map(cart.map(c => [c.id, c.why]));
  return [
    `GeoARK data cart${query ? ` for "${query}"` : ''}`,
    `generated ${t.provenance.generated_at}, database ${t.provenance.database}, corpus ${t.provenance.corpus_cache_key ?? 'unknown'}`,
    `level: ${t.provenance.level}${t.provenance.states ? `, states: ${t.provenance.states.join(', ')}` : ''}`,
    t.provenance.note,
    ...t.columns.map((c, i) =>
      `column ${i + 4} "${c.header}": ${c.description ?? ''} [${c.dataset ?? c.source_kind}; ` +
      `${c.census_code ?? c.table_name ?? c.item}${c.period ? `; ${c.period}` : ''}] ` +
      `${c.missing} counties empty. In cart because: ${why.get(c.item) ?? 'added by hand'}`),
  ];
}

export function cartCsv(t: CartTable, cart: CartItem[], query: string | null): string {
  const head = ['fips', 'county', 'state', ...t.columns.map(c => c.header)];
  return [
    ...provenanceLines(t, cart, query).map(l => `# ${l.replace(/\n/g, ' ')}`),
    head.map(csvCell).join(','),
    ...t.rows.map(r => [r.fips, r.name, r.state, ...r.values].map(csvCell).join(',')),
  ].join('\n') + '\n';
}

export function cartDictionary(t: CartTable, cart: CartItem[], query: string | null): string {
  const why = new Map(cart.map(c => [c.id, c.why]));
  const out = [
    `# Data dictionary${query ? `: ${query}` : ''}`, '',
    `Generated ${t.provenance.generated_at} from GeoARK (database \`${t.provenance.database}\`, ` +
      `corpus \`${t.provenance.corpus_cache_key ?? 'unknown'}\`).`, '',
    `One row per county (${t.row_count} rows${t.provenance.states ? `, ${t.provenance.states.join(', ')}` : ', national'}). ` +
      'An empty cell means the source has no value for that county; nothing is filled in.', '',
    '| Column | Meaning |', '|---|---|',
    '| `fips` | 5-digit county FIPS code |', '| `county` | County name |', '| `state` | State name |',
    ...t.columns.map(c => `| ${c.header.replace(/\|/g, '/')} | ${(c.description ?? '').replace(/\|/g, '/')} |`),
    '',
  ];
  for (const c of t.columns) {
    out.push(`## ${c.header}`, '');
    out.push(`- **Source:** ${c.dataset ?? 'catalog'} (${c.source_kind === 'feature_table'
      ? `count of features in \`${c.table_name}\` per county` : `\`${c.census_code ?? c.item}\``})`);
    if (c.period) out.push(`- **Period:** ${c.period}`);
    if (c.range) {
      out.push(`- **National range, latest year:** ${c.range.min} to ${c.range.max}` +
        (c.range.max <= 1 && c.range.min >= 0 ? ' (a 0-1 fraction, not a percentage)' : ''));
    }
    out.push(`- **Counties without a value:** ${c.missing} of ${t.row_count}`);
    out.push(`- **Why it is in this cart:** ${why.get(c.item) ?? 'added by hand'}`, '');
  }
  return out.join('\n');
}

let countiesCache: Promise<GeoJSON.FeatureCollection> | null = null;

export async function cartGeoJson(t: CartTable, cart: CartItem[], query: string | null): Promise<string> {
  countiesCache ??= fetch('/counties.geojson').then(r => r.json());
  const counties = await countiesCache;
  const byFips = new Map(t.rows.map(r => [r.fips, r]));
  const features = counties.features.flatMap(f => {
    const fips = String((f.properties as Record<string, unknown>)?.GEOID ?? '');
    const r = byFips.get(fips);
    if (!r) return [];
    return [{
      type: 'Feature' as const, geometry: f.geometry,
      properties: { fips, county: r.name, state: r.state,
                    ...Object.fromEntries(t.columns.map((c, i) => [c.header, r.values[i]])) },
    }];
  });
  return JSON.stringify({
    type: 'FeatureCollection',
    metadata: { provenance: provenanceLines(t, cart, query), geometry: 'Census cartographic boundary 2018, 1:500k' },
    features,
  });
}

export function downloadCart(kind: 'csv' | 'dictionary' | 'geojson', content: string, query: string | null) {
  const base = `geoark-cart-${slug(query || 'data')}`;
  if (kind === 'csv') download(`${base}.csv`, content, 'text/csv');
  else if (kind === 'dictionary') download(`${base}-dictionary.md`, content, 'text/markdown');
  else download(`${base}.geojson`, content, 'application/geo+json');
}
