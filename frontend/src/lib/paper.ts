import type { AnalysisResponse } from '../types';
import type { CartItem } from './cart';

/**
 * Paper upload (docs/PAPER_AND_CART_INTEGRATION.md P3-P4).
 *
 * POST /api/paper/extract reads the file in memory (never stored) and returns a
 * study card whose every field carries a quote the server found in the text.
 * POST /api/paper/reproduce runs the (possibly edited) card's methods as
 * template plans, each an ordinary analysis the thread can follow up on.
 */

export type VariableRole = 'outcome' | 'exposure' | 'covariate';
export type MatchStatus = 'matched' | 'proxy' | 'missing' | 'unchecked' | 'out_of_area' | 'derived';
export type MethodStatus = 'reproduced' | 'approximated' | 'ask' | 'automl' | 'not_supported' | 'failed';

export interface Quoted { quote: string | null; page: number | null }

export interface PaperMatch {
  attr_id: string;
  label: string;
  description: string | null;
  dataset: string | null;
  kind: 'value' | 'feature' | 'raster';
  coverage: number | null;
  period: string | null;
}

export interface PaperVariable extends Quoted {
  id: string;
  name: string;
  role: VariableRole;
  measure: string;
  source: string;
  matches: PaperMatch[];
  selected: string | null;
  fit: 'same' | 'proxy' | 'none' | null;
  status: MatchStatus;
  /** A cut-off the paper applies to it (an index component), quoted. */
  threshold?: { operator: string; value: number; units: string; quote?: string | null; page?: number | null };
  /** The named set it belongs to when the paper scores sets separately. */
  group?: string;
}

export interface PaperMethod extends Quoted {
  id: string;
  technique: string;
  family: string;
  applied_to: string;
  alpha: number | null;
  permutations: number | null;
  weights: string;
}

export interface StudyCard {
  title: string | null;
  country: ({ name: string } & Quoted) | null;
  area: {
    description: string; places: string[];
    scope: 'national' | 'states' | 'outside_us' | 'unknown';
    states: string[] | null; note: string | null;
  } & Quoted;
  unit: { value: string } & Quoted;
  period: ({ start_year: number | null; end_year: number | null } & Quoted) | null;
  variables: PaperVariable[];
  methods: PaperMethod[];
  quotes: { checked: number; kept: number; dropped: number;
            dropped_items: { what: string; item: string; quote: string; why: string }[] };
  truncated_variables: number;
  matching: { judged: number; failed: number; enabled: boolean };
  reading: {
    chars: number; pages: number; parts: number; parts_failed: number;
    read: string[];
    skipped: { heading: string; kind: string; chars: number; why: string }[];
  };
}

export interface MethodPlan {
  method_id: string;
  technique: string;
  family: string;
  quote: string | null;
  page: number | null;
  status: MethodStatus;
  reason: string;
  runs: { title: string }[];
  question?: string | null;
  automl?: { target: string; features: string[] };
  /** Answered by another method's run (an index's score correlations and map). */
  answered_by?: string;
}

export interface ExtractResponse {
  file: { name: string; format: string; pages: number; chars: number };
  study: StudyCard;
  reproduction: MethodPlan[];
  model_calls: number;
  ms: number;
}

export interface ReproducedMethod extends Omit<MethodPlan, 'runs'> {
  runs: { title: string; response?: AnalysisResponse; error?: string; detail?: string | null; ms: number }[];
}

export const PAPER_EXT = /\.(pdf|docx)$/i;
export const PAPER_ACCEPT = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function readError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return [data.error, data.detail].filter(Boolean).join(': ') || `HTTP ${res.status}`;
}

export async function extractPaper(file: File, signal?: AbortSignal): Promise<ExtractResponse> {
  const res = await fetch(`/api/paper/extract?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', credentials: 'same-origin', body: file, signal,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export async function reproducePaper(study: StudyCard, methods: string[]): Promise<{ methods: ReproducedMethod[]; ms: number }> {
  const res = await fetch('/api/paper/reproduce', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ study, methods }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/** The checkout's own cap (backend/cart.js MAX_ITEMS). */
export const CART_MAX = 20;

/**
 * The variables' chosen rows as cart items, the paper named as the reason.
 * Variables arrive outcome first, then exposures, then covariates, so a cap
 * keeps the ones the analysis is about. `total` says how many there were.
 */
export function paperCartItems(study: StudyCard, title: string): CartItem[] & { total?: number } {
  const seen = new Set<string>();
  const out: CartItem[] = [];
  for (const v of study.variables) {
    const m = v.matches.find(x => x.attr_id === v.selected);
    if (!m || m.kind === 'raster' || seen.has(m.attr_id)) continue;
    seen.add(m.attr_id);
    out.push({ id: m.attr_id, label: m.label, kind: m.kind, dataset: m.dataset,
               why: `${v.role} "${v.name}" in ${title}${v.status === 'proxy' ? ' (stand-in)' : ''}` });
  }
  const capped: CartItem[] & { total?: number } = out.slice(0, CART_MAX);
  capped.total = out.length;
  return capped;
}

/** Statuses recomputed in the browser after an edit, by the server's rules. */
export const STATUS_TEXT: Record<MethodStatus, string> = {
  reproduced: 'Reproduced',
  approximated: 'Approximated',
  ask: 'Needs a choice',
  automl: 'AutoML',
  not_supported: 'Not supported',
  failed: 'Did not run',
};
