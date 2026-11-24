import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Loader2, Plus, Check, X, ShoppingCart, BookOpen, FileText, MessageSquareText,
  Download, Table2, Map as MapIcon, Layers, ChevronDown, ChevronRight, AlertTriangle, Wand2, BookOpenCheck,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import ExpandedSearchControl from './ExpandedSearchControl';
import CartModelPanel from './CartModelPanel';
import PaperPanel from './PaperPanel';
import type { PaperRunRequest } from './AnalysisPage';
import { CART_MAX } from '../lib/paper';
import type { CartMapRequest } from './AnalysisPage';
import { useExpandedSearch } from '../hooks/useExpandedSearch';
import { STATES } from '../lib/places';
import {
  suggest, checkout, loadCart, saveCart, toCartItem, cartCsv, cartDictionary, cartGeoJson, downloadCart,
  type SuggestResponse, type ShelfItem, type ShelfRole, type CartItem, type CartTable,
} from '../lib/cart';

/**
 * Browse data, as a data cart (docs/DATA_CART_PLAN.md, slice 1).
 *
 * Ask for data -> the shelf (everything retrieval found that holds data, with
 * why each item is there) -> a cart, pre-filled with a suggested set chosen by
 * code -> one table, downloaded with its provenance and a data dictionary.
 *
 * The suggestion is code, not a model, on purpose: an LLM picker is Phase 2 and
 * has to beat this list first (an LLM filter has lost recall here before).
 * Mapping (Phase 5) hands the cart to /analysis as map_measure edits; AutoML
 * (Phase 6, CartModelPanel) trains on the checkout's own table with spatial CV.
 */

const ROLE_TITLE: Record<ShelfRole, { title: string; hint: string }> = {
  subject: { title: 'What you asked about', hint: 'Matched the words of your question' },
  linked: { title: 'Linked in the literature', hint: 'Found through Expanded search: risk factors and related conditions' },
  denominator: { title: 'Denominators', hint: 'For turning counts into rates' },
  context: { title: 'Other matches', hint: '' },
};
const ROLE_ORDER: ShelfRole[] = ['subject', 'linked', 'denominator', 'context'];

const EXAMPLES = [
  'coronary heart disease in each county',
  'asthma rates by county',
  'diabetes prevalence across the South',
  'where is COPD most common',
];

const KindBadge: React.FC<{ kind: ShelfItem['kind'] }> = ({ kind }) => {
  const k = kind === 'feature'
    ? { icon: <MapIcon className="w-3 h-3" />, text: 'locations', cls: 'bg-amber-100 text-amber-800' }
    : kind === 'raster'
      ? { icon: <Layers className="w-3 h-3" />, text: 'raster', cls: 'bg-slate-200 text-slate-700' }
      : { icon: <Table2 className="w-3 h-3" />, text: 'by county', cls: 'bg-brand-100 text-brand-700' };
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded ${k.cls}`}>
      {k.icon}{k.text}
    </span>
  );
};

const WhyChip: React.FC<{ why: ShelfItem['why'][number] }> = ({ why }) => {
  const icon = why.kind === 'literature' ? <BookOpen className="w-3 h-3 shrink-0" />
    : why.kind === 'pubmed' || why.kind === 'web' ? <FileText className="w-3 h-3 shrink-0" />
      : <MessageSquareText className="w-3 h-3 shrink-0" />;
  const cls = why.kind === 'question' ? 'text-slate-500' : 'text-brand-700';
  return <span className={`inline-flex items-start gap-1 text-xs ${cls}`}>{icon}<span>{why.text}</span></span>;
};

const DataCartPage: React.FC = () => {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useExpandedSearch();
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [shelf, setShelf] = useState<SuggestResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The LLM curator (backend/curator.js), opt-in: it beat the rule-based pick
  // on dev but not clearly on held-out questions (DATA_CART_PLAN.md Phase 2).
  const [curate, setCurate] = useState(false);
  // Start from a paper (components/PaperPanel.tsx).
  const [paperOpen, setPaperOpen] = useState(false);
  const [modelTarget, setModelTarget] = useState<string | null>(null);

  const [cart, setCart] = useState<CartItem[]>(() => loadCart());
  useEffect(() => saveCart(cart), [cart]);
  const inCart = useMemo(() => new Set(cart.map(c => c.id)), [cart]);

  const [state, setState] = useState<string>('');
  const [table, setTable] = useState<CartTable | null>(null);
  const [building, setBuilding] = useState(false);
  const [tableError, setTableError] = useState<string | null>(null);
  // A table belongs to the cart it was built from; any change makes it stale.
  const builtFor = useRef<string>('');
  const cartKey = `${cart.map(c => c.id).join(',')}|${state}`;
  const stale = table !== null && builtFor.current !== cartKey;

  useEffect(() => {
    if (!searching) return;
    const t0 = Date.now();
    const id = window.setInterval(() => setElapsed(Date.now() - t0), 200);
    return () => window.clearInterval(id);
  }, [searching]);

  const run = async (q: string) => {
    const text = q.trim();
    if (!text || searching) return;
    setQuery(text);
    setSearching(true); setError(null); setElapsed(0);
    try {
      // Unticked sends nothing, so the server's CART_CURATOR setting decides.
      const res = await suggest(text, expanded, curate || undefined);
      setShelf(res);
      setAsked(text);
      // An empty cart takes the suggestion; a cart in progress is never
      // overwritten, the suggestion is offered instead.
      if (!cart.length) {
        const byId = new Map(res.items.map(i => [i.id, i]));
        setCart(res.default_cart.flatMap(id => (byId.has(id) ? [toCartItem(byId.get(id)!)] : [])));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const add = (it: ShelfItem | Omit<ShelfItem, 'variants'>) => {
    if (it.checkout || inCart.has(it.id)) return;
    setCart(c => [...c, toCartItem(it)]);
  };
  const remove = (id: string) => setCart(c => c.filter(x => x.id !== id));
  const useSuggested = () => {
    if (!shelf) return;
    const byId = new Map(shelf.items.map(i => [i.id, i]));
    setCart(shelf.default_cart.flatMap(id => (byId.has(id) ? [toCartItem(byId.get(id)!)] : [])));
  };

  const build = async () => {
    if (!cart.length || building) return;
    setBuilding(true); setTableError(null);
    try {
      const t = await checkout(cart.map(c => c.id), state ? [state] : null);
      builtFor.current = cartKey;
      setTable(t);
    } catch (e) {
      setTableError((e as Error).message);
    } finally {
      setBuilding(false);
    }
  };

  const grouped = useMemo(() => {
    const m = new Map<ShelfRole, ShelfItem[]>();
    for (const it of shelf?.items ?? []) {
      if (!m.has(it.role)) m.set(it.role, []);
      m.get(it.role)!.push(it);
    }
    return ROLE_ORDER.filter(r => m.has(r)).map(r => [r, m.get(r)!] as const);
  }, [shelf]);

  return (
    <main className="relative z-10 container mx-auto px-4 pt-24 pb-12 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-ink">Data cart</h1>
        <p className="text-slate-600 mt-1 max-w-3xl">
          Ask for data on a topic. GeoARK finds the measures that hold data, suggests a set, and
          builds one county table you can download with its sources.
        </p>
      </div>

      <form onSubmit={e => { e.preventDefault(); void run(query); }}
            className="bg-white/80 rounded-xl border border-slate-300 p-2 focus-within:ring-2 focus-within:ring-brand-400">
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-slate-500 ml-1 shrink-0" />
          <input value={query} onChange={e => setQuery(e.target.value)}
                 aria-label="What data are you looking for"
                 placeholder="e.g. coronary heart disease in each county"
                 className="flex-1 min-w-0 bg-transparent focus:outline-none text-ink py-1.5 text-sm" />
          <button type="submit" disabled={searching || !query.trim()}
                  className="shrink-0 rounded-lg bg-ink text-white text-sm font-medium px-3 py-1.5
                             hover:bg-brand-700 disabled:bg-slate-400/60 flex items-center gap-1.5">
            {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            <span className="hidden sm:inline">Find data</span>
          </button>
        </div>
        <div className="pt-2 px-1">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <ExpandedSearchControl value={expanded} onChange={setExpanded} disabled={searching} />
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600"
                   title="A local model judges every item and picks the cart. Adds about 20-35 s. On held-out questions it was only slightly better than the rule-based pick.">
              <input type="checkbox" checked={curate} disabled={searching}
                     onChange={e => setCurate(e.target.checked)} className="accent-brand-700" />
              Let the model pick the cart
            </label>
          </div>
        </div>
      </form>

      <div className="mt-2">
        {!paperOpen ? (
          <button type="button" onClick={() => setPaperOpen(true)}
                  className="inline-flex items-center gap-1.5 text-sm text-brand-700 hover:underline">
            <BookOpenCheck className="w-4 h-4" /> Or start from a paper (PDF or Word)
          </button>
        ) : (
          <PaperPanel
            onClose={() => setPaperOpen(false)}
            cartHint="The cart is on the right; build the table to download or model it."
            onAddToCart={(items, states) => {
              setCart(c => {
                const have = new Set(c.map(x => x.id));
                // The checkout holds at most CART_MAX items.
                return [...c, ...items.filter(x => !have.has(x.id))].slice(0, CART_MAX);
              });
              // One state in the paper's area becomes the table's area; several
              // stay national here (the table filter takes one state).
              if (states?.length === 1) setState(states[0]);
            }}
            onReplicate={(study, methods, title) => {
              const req: PaperRunRequest = { study, methods, title };
              navigate('/analysis', { state: { paperRun: req } });
            }}
            onAsk={(q) => navigate(`/analysis?q=${encodeURIComponent(q)}`)}
            onModel={(target) => setModelTarget(target)}
          />
        )}
      </div>

      {!shelf && !searching && !paperOpen && (
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <span className="text-slate-500">Try:</span>
          {EXAMPLES.map(ex => (
            <button key={ex} type="button" onClick={() => void run(ex)}
                    className="px-2.5 py-1 rounded-full bg-white/70 border border-slate-300 text-slate-700 hover:bg-white">
              {ex}
            </button>
          ))}
        </div>
      )}

      {searching && (
        <p className="mt-4 text-sm text-slate-600 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Searching{expanded.on ? ' with expanded search' : ''}… {(elapsed / 1000).toFixed(0)}s
          {expanded.on && (expanded.pubmed || expanded.web) && <span className="text-slate-500">(reading PubMed or the web takes 10-20 s)</span>}
        </p>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {error}
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] items-start">
        {/* ---------------- the shelf ---------------- */}
        <section aria-label="Data found" className="min-w-0 space-y-5">
          {shelf && (
            <div className="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-1">
              <span>{shelf.items.length} items with data for "{asked}"</span>
              {shelf.expansion && shelf.expansion.concepts.length > 0 && (
                <span>literature: {shelf.expansion.concepts.join(', ')}</span>
              )}
              {shelf.research && shelf.research.keywords.length > 0 && (
                <span>PubMed keywords: {shelf.research.keywords.join(', ')}</span>
              )}
              <span>{(shelf.ms / 1000).toFixed(1)} s</span>
              {shelf.curated && (
                <span title={shelf.curated.notes.join('; ') || undefined}>
                  {shelf.curated.fallback
                    ? `model pick failed (${shelf.curated.fallback}); rule-based set shown`
                    : `cart picked by the model in ${(shelf.curated.ms / 1000).toFixed(0)} s`}
                </span>
              )}
            </div>
          )}
          {shelf && !shelf.items.length && (
            <p className="text-sm text-slate-600 bg-white/70 rounded-xl border border-slate-200 p-4">
              Nothing loaded matches this. Try other words, or turn on Expanded search for related measures.
            </p>
          )}
          {grouped.map(([role, items]) => (
            <div key={role}>
              <h2 className="text-sm font-semibold text-ink">{ROLE_TITLE[role].title}</h2>
              {ROLE_TITLE[role].hint && <p className="text-xs text-slate-500 mb-2">{ROLE_TITLE[role].hint}</p>}
              <ul className="space-y-2">
                {items.map(it => (
                  <ShelfRow key={it.id} item={it} inCart={inCart} onAdd={add}
                            verdict={shelf?.curated?.verdicts[it.id]} />
                ))}
              </ul>
            </div>
          ))}
          {shelf && !expanded.on && (
            <p className="text-xs text-slate-500">
              Expanded search is off, so only measures matching your words are listed. Turn it on to
              add risk factors and related conditions from the medical literature.
            </p>
          )}
        </section>

        {/* ---------------- the cart ---------------- */}
        <aside aria-label="Your cart"
               className="lg:sticky lg:top-24 bg-white/85 rounded-2xl border border-slate-200 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <ShoppingCart className="w-4 h-4 text-ink" />
            <h2 className="font-semibold text-ink">Your cart</h2>
            <span className="text-xs text-slate-500">{cart.length} item{cart.length === 1 ? '' : 's'}</span>
            {cart.length > 0 && (
              <button type="button" onClick={() => { setCart([]); setTable(null); }}
                      className="ml-auto text-xs text-slate-500 hover:text-ink">Empty</button>
            )}
          </div>

          {shelf && shelf.default_cart.length > 0 && (
            <button type="button" onClick={useSuggested}
                    className="w-full text-xs flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg
                               border border-brand-300 text-brand-700 hover:bg-brand-50">
              <Wand2 className="w-3.5 h-3.5" />
              Use the {shelf.selection === 'curator' ? "model's" : 'suggested'} set ({shelf.default_cart.length})
            </button>
          )}

          {!cart.length && (
            <p className="text-sm text-slate-500">Search for data, then add items from the list.</p>
          )}
          <ul className="space-y-1.5">
            {cart.map(c => (
              <li key={c.id} className="flex items-start gap-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="text-ink leading-snug">{c.label}</div>
                  <div className="text-[11px] text-slate-500 truncate" title={c.why}>{c.why}</div>
                </div>
                <button type="button" onClick={() => remove(c.id)} aria-label={`Remove ${c.label}`}
                        className="shrink-0 p-1 rounded text-slate-500 hover:text-ink hover:bg-slate-100">
                  <X className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>

          {cart.length > 0 && (
            <div className="pt-2 border-t border-slate-200 space-y-2">
              <label className="flex items-center gap-2 text-xs text-slate-600">
                Area
                <select value={state} onChange={e => setState(e.target.value)}
                        className="flex-1 min-w-0 bg-white border border-slate-300 rounded px-1.5 py-1 text-xs">
                  <option value="">All counties (national)</option>
                  {STATES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <button type="button" onClick={() => void build()} disabled={building}
                      className="w-full rounded-lg bg-ink text-white text-sm font-medium px-3 py-2 hover:bg-brand-700
                                 disabled:bg-slate-400/60 flex items-center justify-center gap-2">
                {building ? <Loader2 className="w-4 h-4 animate-spin" /> : <Table2 className="w-4 h-4" />}
                {table && !stale ? 'Rebuild table' : 'Build the table'}
              </button>
              {tableError && <p className="text-xs text-red-700">{tableError}</p>}
            </div>
          )}

          {table && (
            <TableSummary table={table} stale={stale} cart={cart} query={asked}
                          onMap={() => {
                            const ids = new Set(table.columns.map(c => c.item));
                            const req: CartMapRequest = {
                              items: cart.filter(c => ids.has(c.id)).map(c => ({ id: c.id, label: c.label, kind: c.kind })),
                              states: state ? [state] : null,
                            };
                            navigate('/analysis', { state: { cartMap: req } });
                          }} />
          )}
        </aside>
      </div>

      {table && !stale && (
        <CartModelPanel table={table} items={table.columns.map(c => c.item)} states={state ? [state] : null}
                        defaultTarget={modelTarget} />
      )}
    </main>
  );
};

const VERDICT: Record<string, { text: string; cls: string }> = {
  direct: { text: 'model: what you asked about', cls: 'bg-green-50 text-green-800 border-green-200' },
  related: { text: 'model: related', cls: 'bg-brand-50 text-brand-700 border-brand-200' },
  denominator: { text: 'model: denominator', cls: 'bg-slate-50 text-slate-700 border-slate-200' },
  none: { text: 'model: not useful here', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
};

const ShelfRow: React.FC<{
  item: ShelfItem;
  inCart: Set<string>;
  onAdd: (it: ShelfItem | Omit<ShelfItem, 'variants'>) => void;
  verdict?: string;
}> = ({ item, inCart, onAdd, verdict }) => {
  const [open, setOpen] = useState(false);
  const added = inCart.has(item.id);
  return (
    <li className="bg-white/80 rounded-xl border border-slate-200 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-ink text-sm leading-snug">{item.label}</span>
            <KindBadge kind={item.kind} />
            {verdict && VERDICT[verdict] && (
              <span className={`text-[11px] px-1.5 py-0.5 rounded border ${VERDICT[verdict].cls}`}>
                {VERDICT[verdict].text}
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {item.dataset ?? 'catalog'}
            {item.coverage != null && <>, {item.coverage.toLocaleString()} counties</>}
            {item.period && <>, {item.period}</>}
          </div>
          <div className="mt-1 flex flex-col gap-0.5">
            {item.why.slice(0, 2).map((w, i) => <WhyChip key={i} why={w} />)}
          </div>
          {item.variants.length > 0 && (
            <button type="button" onClick={() => setOpen(o => !o)}
                    className="mt-1 text-xs text-slate-600 hover:text-ink inline-flex items-center gap-0.5">
              {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {item.variants.length} other version{item.variants.length > 1 ? 's' : ''}
            </button>
          )}
          {open && (
            <ul className="mt-1 space-y-1 pl-3 border-l border-slate-200">
              {item.variants.map(v => (
                <li key={v.id} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 min-w-0 text-slate-700">
                    {v.label} <span className="text-slate-500">({v.dataset ?? 'catalog'}
                    {v.coverage != null && `, ${v.coverage.toLocaleString()} counties`})</span>
                  </span>
                  <AddButton small added={inCart.has(v.id)} disabled={!!v.checkout} onClick={() => onAdd(v)} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <AddButton added={added} disabled={!!item.checkout} title={item.checkout ?? undefined}
                   onClick={() => onAdd(item)} />
      </div>
    </li>
  );
};

const AddButton: React.FC<{ added: boolean; disabled?: boolean; small?: boolean; title?: string;
                            onClick: () => void }> = ({ added, disabled, small, title, onClick }) => (
  <button type="button" onClick={onClick} disabled={added || disabled} title={title}
          className={`shrink-0 inline-flex items-center gap-1 rounded-lg border font-medium
            ${small ? 'text-[11px] px-1.5 py-0.5' : 'text-xs px-2 py-1'}
            ${added ? 'border-green-300 text-green-700 bg-green-50'
              : disabled ? 'border-slate-200 text-slate-400'
                : 'border-slate-300 text-ink hover:bg-slate-50'}`}>
    {added ? <><Check className="w-3 h-3" /> In cart</>
      : disabled ? 'Map only' : <><Plus className="w-3 h-3" /> Add</>}
  </button>
);

const TableSummary: React.FC<{ table: CartTable; stale: boolean; cart: CartItem[]; query: string | null;
                               onMap: () => void }> =
  ({ table, stale, cart, query, onMap }) => {
    const [busy, setBusy] = useState(false);
    const geo = async () => {
      setBusy(true);
      try { downloadCart('geojson', await cartGeoJson(table, cart, query), query); }
      finally { setBusy(false); }
    };
    return (
      <div className="pt-2 border-t border-slate-200 space-y-2">
        <p className="text-xs text-slate-600">
          {table.row_count.toLocaleString()} counties × {table.columns.length} columns
          {stale && <span className="text-amber-700">, the cart changed since this was built</span>}
        </p>
        <ul className="text-xs space-y-0.5">
          {table.columns.map(c => (
            <li key={c.item} className="flex gap-2">
              <span className="flex-1 min-w-0 truncate text-slate-700" title={c.header}>{c.header}</span>
              <span className={c.missing ? 'text-amber-700' : 'text-slate-500'}>
                {c.missing ? `${c.missing} empty` : 'complete'}
              </span>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-3 gap-1.5">
          <DlButton onClick={() => downloadCart('csv', cartCsv(table, cart, query), query)}>CSV</DlButton>
          <DlButton onClick={() => void geo()} busy={busy}>GeoJSON</DlButton>
          <DlButton onClick={() => downloadCart('dictionary', cartDictionary(table, cart, query), query)}>
            Dictionary
          </DlButton>
        </div>
        <button type="button" onClick={onMap} disabled={stale}
                title={stale ? 'Rebuild the table first' : 'Open in Analysis: the first measure as the map, the rest as layers'}
                className="w-full inline-flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 rounded-lg border
                           border-brand-300 text-brand-700 hover:bg-brand-50 disabled:opacity-50">
          <MapIcon className="w-3.5 h-3.5" /> Map in Analysis
        </button>
      </div>
    );
  };

const DlButton: React.FC<{ onClick: () => void; busy?: boolean; children: React.ReactNode }> =
  ({ onClick, busy, children }) => (
    <button type="button" onClick={onClick} disabled={busy}
            className="inline-flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded-lg border
                       border-slate-300 text-ink hover:bg-slate-50 disabled:opacity-60">
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}{children}
    </button>
  );

export default DataCartPage;
