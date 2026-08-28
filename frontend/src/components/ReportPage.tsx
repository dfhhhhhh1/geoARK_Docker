
import { useState, useMemo, useCallback } from 'react';
import Papa from 'papaparse';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement,
  BarElement, ArcElement, Title, Tooltip, Legend, Filler,
} from 'chart.js';
import { Line, Bar, Pie, Scatter } from 'react-chartjs-2';
import Skeleton from 'react-loading-skeleton';
import 'react-loading-skeleton/dist/skeleton.css';
import {
  Upload, AlertCircle, TrendingUp, BarChart3, Search, Loader2, Sparkles,
  Database, Brain, GitBranch, ChevronDown, ChevronUp, Table, Activity,
  Zap, Trophy, Target, CheckCircle2,
} from 'lucide-react';
import _ from 'lodash';
import type { UnifiedSearchResponse, UnifiedSearchResultItem } from '../types';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Title, Tooltip, Legend, Filler);

/* ================================================================
   TYPE DEFINITIONS
   ================================================================ */

interface ParsedData { headers: string[]; rows: Record<string, string | number>[]; }

interface ColumnStats {
  column: string; count: number; missing: number; sum: number; avg: number;
  median: number; stdDev: number; min: number; max: number; p25: number; p75: number;
}

interface CategoricalStats {
  column: string; uniqueCount: number;
  topValues: Array<{ value: string; count: number }>; missing: number;
}

interface RegressionResult {
  slope: number; intercept: number; rSquared: number; predictions: number[];
  xColumn: string; yColumn: string;
}

interface AutoMLLeaderboardEntry {
  model: string; score_val: number | null;
  fit_time: number | null; pred_time_val: number | null;
}

interface AutoMLResponse {
  leaderboard: AutoMLLeaderboardEntry[];
  importance: Record<string, number>;
  metrics: Record<string, number | null>;
  chartData: { actual: number[]; predicted: number[]; labelMap?: Record<number, string> };
  problemType: 'regression' | 'binary' | 'multiclass';
  targetColumn: string; evalMetric: string;
}

/* ================================================================
   CLIENT-SIDE ML UTILITIES
   ================================================================ */

function kMeansClustering(data: number[][], k: number, maxIter = 50) {
  if (data.length === 0 || k <= 0) return { assignments: [] as number[], centroids: [] as number[][] };
  const dim = data[0].length;
  const idxs = new Set<number>();
  while (idxs.size < Math.min(k, data.length)) idxs.add(Math.floor(Math.random() * data.length));
  let centroids = Array.from(idxs).map(i => [...data[i]]);
  let asgn = new Array(data.length).fill(0);
  for (let it = 0; it < maxIter; it++) {
    const nxt = data.map(pt => { let md = Infinity, cl = 0; centroids.forEach((c, ci) => { const d = pt.reduce((s, v, dd) => s + (v - c[dd]) ** 2, 0); if (d < md) { md = d; cl = ci; } }); return cl; });
    if (nxt.every((a, i) => a === asgn[i])) break;
    asgn = nxt;
    centroids = centroids.map((_, ci) => { const ps = data.filter((__, pi) => asgn[pi] === ci); if (!ps.length) return centroids[ci]; return Array.from({ length: dim }, (___, d) => ps.reduce((s, p) => s + p[d], 0) / ps.length); });
  }
  return { assignments: asgn, centroids };
}

function linearRegression(xs: number[], ys: number[]) {
  const n = xs.length; if (n < 2) return { slope: 0, intercept: 0, rSquared: 0, predictions: [] as number[] };
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  const slope = dx2 === 0 ? 0 : num / dx2, intercept = my - slope * mx;
  const rSquared = dx2 === 0 || dy2 === 0 ? 0 : (num * num) / (dx2 * dy2);
  return { slope, intercept, rSquared, predictions: xs.map(x => slope * x + intercept) };
}

function zNorm(vals: number[]) {
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const s = Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / vals.length);
  return s === 0 ? vals.map(() => 0) : vals.map(v => (v - m) / s);
}

/* ================================================================
   COLOUR PALETTE
   ================================================================ */

const C = [
  'rgba(59,130,246,.8)', 'rgba(16,185,129,.8)', 'rgba(245,158,11,.8)', 'rgba(239,68,68,.8)',
  'rgba(139,92,246,.8)', 'rgba(236,72,153,.8)', 'rgba(6,182,212,.8)', 'rgba(249,115,22,.8)',
];
const CB = C.map(c => c.replace('.8', '1'));

const AUTOML_URL = '/automl';

/* ================================================================
   MAIN COMPONENT
   ================================================================ */

function ReportPage() {
  /* --- state --- */
  const [csvData, setCsvData] = useState<ParsedData | null>(null);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');

  const [labelColumn, setLabelColumn] = useState('');
  const [selectedNumericColumns, setSelectedNumericColumns] = useState<string[]>([]);
  const [selectedCategoricalColumns, setSelectedCategoricalColumns] = useState<string[]>([]);

  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResponse, setSearchResponse] = useState<UnifiedSearchResponse | null>(null);
  const [searchError, setSearchError] = useState('');

  const [clusterCount, setClusterCount] = useState(3);
  const [clusterResults, setClusterResults] = useState<{ assignments: number[]; centroids: number[][] } | null>(null);
  const [regressionX, setRegressionX] = useState('');
  const [regressionY, setRegressionY] = useState('');
  const [regressionResult, setRegressionResult] = useState<RegressionResult | null>(null);

  const [automlTarget, setAutomlTarget] = useState('');
  const [isAutomlTraining, setIsAutomlTraining] = useState(false);
  const [automlResult, setAutomlResult] = useState<AutoMLResponse | null>(null);
  const [automlError, setAutomlError] = useState('');
  const [automlProgress, setAutomlProgress] = useState('');

  const [activeTab, setActiveTab] = useState<'data' | 'search' | 'ml' | 'automl'>('data');
  const [exp, setExp] = useState<Record<string, boolean>>({
    stats: true, charts: true, clustering: true, regression: true,
    decomposition: true, results: true, anomalies: true,
    automlLeaderboard: true, automlImportance: true, automlScatter: true, automlMetrics: true,
  });
  const tog = (k: string) => setExp(p => ({ ...p, [k]: !p[k] }));

  /* --- CSV upload --- */
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    if (!file.name.endsWith('.csv')) { setError('Please upload a valid CSV file'); event.target.value = ''; return; }
    setError(''); setFileName(file.name); setIsLoading(true); setCsvFile(file);
    setClusterResults(null); setRegressionResult(null); setAutomlResult(null); setAutomlError('');
    Papa.parse(file, {
      header: true, dynamicTyping: true, skipEmptyLines: true,
      complete: (r) => {
        if (r.data?.length) {
          const headers = (r.meta.fields || []).map(h => h.trim());
          const rows = r.data.filter(row => Object.values(row as Record<string, unknown>).some(v => v !== null && v !== '')) as Record<string, string | number>[];
          setCsvData({ headers, rows });
          if (headers.length) setLabelColumn(headers[0]);
          const nc = headers.filter(h => rows.length > 0 && typeof rows[0][h] === 'number');
          setSelectedNumericColumns(nc.slice(0, 3));
          setSelectedCategoricalColumns(headers.filter(h => rows.length > 0 && typeof rows[0][h] === 'string').slice(0, 1));
          if (nc.length >= 2) { setRegressionX(nc[0]); setRegressionY(nc[1]); }
          setAutomlTarget(nc[0] || headers[headers.length - 1] || '');
          setTimeout(() => setIsLoading(false), 400);
        } else { setError('CSV file is empty or invalid'); setIsLoading(false); }
        event.target.value = '';
      },
      error: (e) => { setError(`Error parsing CSV: ${e.message}`); setIsLoading(false); event.target.value = ''; },
    });
  };

  /* --- unified search --- */
  const handleUnifiedSearch = useCallback(async (q: string) => {
    if (!q.trim()) return; setIsSearching(true); setSearchError(''); setSearchResponse(null);
    try {
      const r = await fetch('/api/unified-search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: q.trim(), use_llm_filter: false, top_k: 20 }) });
      if (!r.ok) throw new Error(`Server error: ${r.status}`);
      setSearchResponse(await r.json());
    } catch (e: any) { setSearchError(e.message || 'Search failed'); } finally { setIsSearching(false); }
  }, []);

  /* --- automl train --- */
  const handleAutomlTrain = useCallback(async () => {
    if (!csvFile || !automlTarget) return;
    setIsAutomlTraining(true); setAutomlError(''); setAutomlResult(null);
    setAutomlProgress('Uploading CSV and starting AutoGluon training (up to 60 s)…');
    try {
      const fd = new FormData(); fd.append('file', csvFile); fd.append('target_column', automlTarget);
      const r = await fetch(`${AUTOML_URL}/automl/train`, { method: 'POST', body: fd });
      if (!r.ok) { const b = await r.json().catch(() => ({ detail: r.statusText })); throw new Error(b.detail || `Server ${r.status}`); }
      setAutomlResult(await r.json()); setAutomlProgress('');
    } catch (e: any) { setAutomlError(e.message || 'AutoML training failed'); setAutomlProgress(''); } finally { setIsAutomlTraining(false); }
  }, [csvFile, automlTarget]);

  /* --- statistics helpers --- */
  const columnTypes = useMemo(() => {
    if (!csvData?.rows.length) return { numeric: [] as string[], categorical: [] as string[] };
    const numeric: string[] = [], categorical: string[] = [];
    csvData.headers.forEach(h => typeof csvData.rows[0][h] === 'number' ? numeric.push(h) : categorical.push(h));
    return { numeric, categorical };
  }, [csvData]);

  const calcStats = (col: string): ColumnStats | null => {
    if (!csvData) return null;
    const vals = csvData.rows.map(r => r[col]).filter(v => v !== null && v !== undefined && v !== '');
    const nums = vals.map(v => Number(v)).filter(v => !isNaN(v)); if (!nums.length) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    const sum = nums.reduce((a, b) => a + b, 0), avg = sum / nums.length;
    const med = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)];
    const vr = nums.reduce((a, v) => a + (v - avg) ** 2, 0) / nums.length;
    return { column: col, count: nums.length, missing: csvData.rows.length - vals.length, sum, avg, median: med, stdDev: Math.sqrt(vr), min: Math.min(...nums), max: Math.max(...nums), p25: sorted[Math.floor(sorted.length * .25)], p75: sorted[Math.floor(sorted.length * .75)] };
  };

  const calcCatStats = (col: string): CategoricalStats | null => {
    if (!csvData) return null;
    const vals = csvData.rows.map(r => r[col]).filter(v => v !== null && v !== undefined && v !== '');
    const g = _.groupBy(vals, v => String(v));
    return { column: col, uniqueCount: Object.keys(g).length, topValues: _.orderBy(Object.entries(g).map(([v, i]) => ({ value: v, count: i.length })), 'count', 'desc').slice(0, 20), missing: csvData.rows.length - vals.length };
  };

  const calcCorr = (c1: string, c2: string): number | null => {
    if (!csvData) return null;
    const ps = csvData.rows.map(r => [Number(r[c1]), Number(r[c2])]).filter(([a, b]) => !isNaN(a) && !isNaN(b));
    if (ps.length < 2) return null;
    const m1 = ps.reduce((s, [a]) => s + a, 0) / ps.length, m2 = ps.reduce((s, [, b]) => s + b, 0) / ps.length;
    let n = 0, d1 = 0, d2 = 0; ps.forEach(([a, b]) => { const x = a - m1, y = b - m2; n += x * y; d1 += x * x; d2 += y * y; });
    const d = Math.sqrt(d1 * d2); return d === 0 ? 0 : n / d;
  };

  /* --- ML actions --- */
  const runClustering = useCallback(() => {
    if (!csvData || selectedNumericColumns.length < 2) return;
    const vr = csvData.rows.filter(r => selectedNumericColumns.every(c => !isNaN(Number(r[c]))));
    const cols = selectedNumericColumns.map(c => zNorm(vr.map(r => Number(r[c]))));
    setClusterResults(kMeansClustering(vr.map((_, i) => cols.map(c => c[i])), clusterCount));
  }, [csvData, selectedNumericColumns, clusterCount]);

  const runRegression = useCallback(() => {
    if (!csvData || !regressionX || !regressionY) return;
    const ps = csvData.rows.map(r => ({ x: Number(r[regressionX]), y: Number(r[regressionY]) })).filter(p => !isNaN(p.x) && !isNaN(p.y));
    if (ps.length < 2) return;
    const res = linearRegression(ps.map(p => p.x), ps.map(p => p.y));
    setRegressionResult({ ...res, xColumn: regressionX, yColumn: regressionY });
  }, [csvData, regressionX, regressionY]);

  /* --- memoised stats --- */
  const numStats = useMemo(() => selectedNumericColumns.map(c => calcStats(c)).filter(Boolean) as ColumnStats[], [csvData, selectedNumericColumns]);
  const catStats = useMemo(() => selectedCategoricalColumns.map(c => calcCatStats(c)).filter(Boolean) as CategoricalStats[], [csvData, selectedCategoricalColumns]);
  const corrs = useMemo(() => {
    const out: { col1: string; col2: string; correlation: number }[] = [];
    if (selectedNumericColumns.length >= 2) for (let i = 0; i < selectedNumericColumns.length; i++) for (let j = i + 1; j < selectedNumericColumns.length; j++) { const c = calcCorr(selectedNumericColumns[i], selectedNumericColumns[j]); if (c !== null) out.push({ col1: selectedNumericColumns[i], col2: selectedNumericColumns[j], correlation: c }); }
    return out;
  }, [csvData, selectedNumericColumns]);

  /* --- chart data generators --- */
  const mkLine = () => { if (!csvData || !selectedNumericColumns.length || !labelColumn) return null; const lb = csvData.rows.slice(0, 100).map(r => String(r[labelColumn] || '')); return { labels: lb, datasets: selectedNumericColumns.map((col, i) => ({ label: col, data: csvData.rows.slice(0, 100).map(r => Number(r[col]) || 0), borderColor: CB[i % CB.length], backgroundColor: C[i % C.length].replace('.8', '.15'), fill: true, tension: .3, pointRadius: lb.length > 50 ? 0 : 3 })) }; };
  const mkBar = () => { if (!csvData || !selectedNumericColumns.length || !labelColumn) return null; const g = _.groupBy(csvData.rows, r => String(r[labelColumn] || 'Other')); const lb = Object.keys(g).slice(0, 30); return { labels: lb, datasets: selectedNumericColumns.map((col, i) => ({ label: col, data: lb.map(l => { const v = g[l].map(r => Number(r[col])).filter(n => !isNaN(n)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }), backgroundColor: C[i % C.length], borderColor: CB[i % CB.length], borderWidth: 1 })) }; };
  const mkPie = () => { if (!csvData || !selectedNumericColumns.length) return null; const col = selectedNumericColumns[0]; const g = _.groupBy(csvData.rows, r => String(r[labelColumn] || 'Other')); const e = Object.entries(g).map(([l, rs]) => ({ label: l, total: rs.reduce((s, r) => s + (Number(r[col]) || 0), 0) })).sort((a, b) => b.total - a.total).slice(0, 10); return { labels: e.map(x => x.label), datasets: [{ data: e.map(x => Math.abs(x.total)), backgroundColor: e.map((_, i) => C[i % C.length]), borderColor: e.map((_, i) => CB[i % CB.length]), borderWidth: 1 }] }; };
  const mkRegScatter = () => { if (!csvData || !regressionResult) return null; const ps = csvData.rows.map(r => ({ x: Number(r[regressionResult.xColumn]), y: Number(r[regressionResult.yColumn]) })).filter(p => !isNaN(p.x) && !isNaN(p.y)).slice(0, 500); const sl = [...ps].sort((a, b) => a.x - b.x); return { datasets: [{ label: 'Data', data: ps, backgroundColor: 'rgba(59,130,246,.5)', pointRadius: 3, type: 'scatter' as const }, { label: `Reg (R²=${regressionResult.rSquared.toFixed(3)})`, data: sl.map(p => ({ x: p.x, y: regressionResult.slope * p.x + regressionResult.intercept })), borderColor: 'rgba(239,68,68,1)', backgroundColor: 'transparent', pointRadius: 0, type: 'line' as const, borderWidth: 2, showLine: true }] }; };
  const mkCluster = () => { if (!csvData || !clusterResults || selectedNumericColumns.length < 2) return null; const [c1, c2] = selectedNumericColumns; const vr = csvData.rows.filter(r => !isNaN(Number(r[c1])) && !isNaN(Number(r[c2]))).slice(0, 500); return { datasets: Array.from({ length: clusterCount }, (_, ci) => ({ label: `Cluster ${ci + 1}`, data: vr.filter((__, i) => clusterResults.assignments[i] === ci).map(r => ({ x: Number(r[c1]), y: Number(r[c2]) })), backgroundColor: C[ci % C.length], pointRadius: 4 })) }; };

  const lineData = useMemo(mkLine, [csvData, selectedNumericColumns, labelColumn]);
  const barData = useMemo(mkBar, [csvData, selectedNumericColumns, labelColumn]);
  const pieData = useMemo(mkPie, [csvData, selectedNumericColumns, labelColumn]);
  const regScatter = useMemo(mkRegScatter, [csvData, regressionResult]);
  const clScatter = useMemo(mkCluster, [csvData, clusterResults, selectedNumericColumns, clusterCount]);

  /* --- AutoML chart data --- */
  const amlLbChart = useMemo(() => {
    if (!automlResult?.leaderboard.length) return null;
    const s = [...automlResult.leaderboard].filter(e => e.score_val !== null).sort((a, b) => Math.abs(b.score_val!) - Math.abs(a.score_val!));
    return { labels: s.map(e => e.model), datasets: [{ label: `Score (${automlResult.evalMetric})`, data: s.map(e => Math.abs(e.score_val!)), backgroundColor: s.map((_, i) => C[i % C.length]), borderColor: s.map((_, i) => CB[i % CB.length]), borderWidth: 1 }] };
  }, [automlResult]);

  const amlImpChart = useMemo(() => {
    if (!automlResult || !Object.keys(automlResult.importance).length) return null;
    const s = Object.entries(automlResult.importance).sort(([, a], [, b]) => b - a).slice(0, 15);
    return { labels: s.map(([k]) => k), datasets: [{ label: 'Importance', data: s.map(([, v]) => v), backgroundColor: 'rgba(16,185,129,.75)', borderColor: 'rgba(16,185,129,1)', borderWidth: 1 }] };
  }, [automlResult]);

  const amlScatterChart = useMemo(() => {
    if (!automlResult?.chartData) return null;
    const { actual: ac, predicted: pr } = automlResult.chartData;
    const pts = ac.map((a, i) => ({ x: a, y: pr[i] }));
    const mn = Math.min(...ac, ...pr), mx = Math.max(...ac, ...pr);
    return { datasets: [{ label: 'Actual vs Predicted', data: pts, backgroundColor: 'rgba(139,92,246,.6)', pointRadius: 5, pointHoverRadius: 7 }, { label: 'Perfect', data: [{ x: mn, y: mn }, { x: mx, y: mx }], borderColor: 'rgba(239,68,68,.8)', backgroundColor: 'transparent', pointRadius: 0, type: 'line' as const, borderWidth: 2, borderDash: [6, 4], showLine: true }] };
  }, [automlResult]);

  /* --- toggles --- */
  const togNum = (c: string) => setSelectedNumericColumns(p => p.includes(c) ? p.filter(x => x !== c) : [...p, c]);
  const togCat = (c: string) => setSelectedCategoricalColumns(p => p.includes(c) ? p.filter(x => x !== c) : [...p, c]);

  /* --- shared renderers --- */
  const SecHead = ({ title, k, icon }: { title: string; k: string; icon: React.ReactNode }) => (
    <button onClick={() => tog(k)} className="w-full flex items-center justify-between py-3 text-left group">
      <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">{icon}{title}</h3>
      {exp[k] ? <ChevronUp className="w-5 h-5 text-gray-400 group-hover:text-gray-600" /> : <ChevronDown className="w-5 h-5 text-gray-400 group-hover:text-gray-600" />}
    </button>
  );

  const Badge = ({ purpose }: { purpose: string }) => {
    const s: Record<string, string> = { primary: 'bg-blue-100 text-blue-700 border-blue-200', normalization: 'bg-green-100 text-green-700 border-green-200', filter: 'bg-amber-100 text-amber-700 border-amber-200', related: 'bg-purple-100 text-purple-700 border-purple-200' };
    return <span className={`px-2 py-0.5 text-xs font-medium rounded-full border ${s[purpose] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>{purpose}</span>;
  };

  // [Search around line 273]
  const SCard = ({ item, index }: { item: UnifiedSearchResultItem; index: number }) => (
    <div key={`${item.attr_id}-${index}`} className="bg-white border border-gray-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-md transition-all relative overflow-hidden group">
      {/* HIGHLIGHT: Add a subtle green accent to show it passed verification */}
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-500 to-teal-500"></div>
      
      <div className="flex items-start justify-between mb-2 pl-2">
        <div className="flex-1 min-w-0">
          <h5 className="font-semibold text-gray-800 text-sm truncate" title={item.attr_desc}>{item.attr_desc}</h5>
          <p className="text-xs text-gray-500 mt-0.5 font-mono">{item.attr_orig}</p>
        </div>
        <Badge purpose={item.search_purpose} />
      </div>
      
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 mt-2 pl-2">
        <span>Dataset: <b className="text-gray-700">{item.dataset_clean}</b></span>
        <span>Entity: <b className="text-gray-700">{item.entity_type}</b></span>
      </div>

      {/* Match Score Bar */}
      <div className="flex items-center gap-3 mt-3 pl-2">
        <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
          <div className="h-full bg-gradient-to-r from-blue-500 to-teal-500 rounded-full" style={{ width: `${(item.hybrid_score * 100).toFixed(0)}%` }} />
        </div>
        <div className="flex flex-col items-end">
          <span className="text-xs font-mono font-medium text-gray-600">{(item.hybrid_score * 100).toFixed(1)}%</span>
        </div>
      </div>
    </div>
  );

  /* ================================================================
     RENDER
     ================================================================ */
  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-7xl mx-auto">

        {/* ── Header + Tabs ── */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-6">
          <h1 className="text-3xl font-bold text-gray-900 mb-1">Advanced Data Report & Search</h1>
          <p className="text-gray-500 text-sm">Upload CSV for analysis, search the geospatial catalog, run client-side ML, or train AutoGluon models.</p>
          <div className="flex gap-1 mt-5 bg-gray-100 p-1 rounded-lg w-fit flex-wrap">
            {([
              { id: 'data' as const, label: 'CSV Analysis', icon: <Table className="w-4 h-4" /> },
              { id: 'search' as const, label: 'Unified Search', icon: <Search className="w-4 h-4" /> },
              { id: 'ml' as const, label: 'ML & Insights', icon: <Brain className="w-4 h-4" /> },
              { id: 'automl' as const, label: 'AutoML', icon: <Zap className="w-4 h-4" /> },
            ]).map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)} className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>{t.icon}{t.label}</button>
            ))}
          </div>
        </div>

        {/* ================================================================
            TAB — CSV Analysis
            ================================================================ */}
        {activeTab === 'data' && (<div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-400 transition-colors cursor-pointer">
              <label htmlFor="csv-upload" className="cursor-pointer flex flex-col items-center">
                <Upload className="w-12 h-12 text-gray-400 mb-3" /><span className="text-sm text-gray-600 mb-1">Click to upload CSV file</span><span className="text-xs text-gray-400">Supports any CSV with headers</span>
                {fileName && <span className="mt-2 text-sm font-medium text-blue-600">{fileName}</span>}
                <input id="csv-upload" type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
              </label>
            </div>
            {error && <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-center gap-2"><AlertCircle className="w-4 h-4 flex-shrink-0" />{error}</div>}
          </div>
          {isLoading && <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-4"><Skeleton count={4} height={24} /></div>}

          {!isLoading && csvData && (<>
            {/* columns */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-4">Configure Columns</h3>
              <div className="space-y-4">
                <div><label className="block text-sm font-medium text-gray-700 mb-2">Label Column (X-axis)</label><select value={labelColumn} onChange={e => setLabelColumn(e.target.value)} className="w-full p-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-300 outline-none">{csvData.headers.map(h => <option key={h} value={h}>{h}</option>)}</select></div>
                <div><label className="block text-sm font-medium text-gray-700 mb-2">Numeric Columns</label><div className="flex flex-wrap gap-2">{columnTypes.numeric.map(c => <button key={c} onClick={() => togNum(c)} className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${selectedNumericColumns.includes(c) ? 'bg-blue-100 text-blue-700 border-blue-300' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}>{c}</button>)}</div></div>
                <div><label className="block text-sm font-medium text-gray-700 mb-2">Categorical Columns</label><div className="flex flex-wrap gap-2">{columnTypes.categorical.map(c => <button key={c} onClick={() => togCat(c)} className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${selectedCategoricalColumns.includes(c) ? 'bg-green-100 text-green-700 border-green-300' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}>{c}</button>)}</div></div>
              </div>
            </div>
            {/* stats */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <SecHead title="Statistical Summary" k="stats" icon={<BarChart3 className="w-5 h-5 text-blue-600" />} />
              {exp.stats && (<div className="space-y-4 mt-2">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div className="bg-blue-50 rounded-lg p-3 text-center"><div className="text-2xl font-bold text-blue-700">{csvData.rows.length}</div><div className="text-xs text-blue-500">Rows</div></div>
                  <div className="bg-green-50 rounded-lg p-3 text-center"><div className="text-2xl font-bold text-green-700">{csvData.headers.length}</div><div className="text-xs text-green-500">Columns</div></div>
                  <div className="bg-amber-50 rounded-lg p-3 text-center"><div className="text-2xl font-bold text-amber-700">{columnTypes.numeric.length}</div><div className="text-xs text-amber-500">Numeric</div></div>
                  <div className="bg-purple-50 rounded-lg p-3 text-center"><div className="text-2xl font-bold text-purple-700">{columnTypes.categorical.length}</div><div className="text-xs text-purple-500">Categorical</div></div>
                </div>
                {numStats.length > 0 && <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-gray-200">{['Column','Count','Mean','Std','Min','P25','Med','P75','Max'].map(h => <th key={h} className={`py-2 px-3 text-gray-600 font-medium ${h==='Column'?'text-left':'text-right'}`}>{h}</th>)}</tr></thead><tbody>{numStats.map(s => <tr key={s.column} className="border-b border-gray-100 hover:bg-gray-50"><td className="py-2 px-3 font-medium text-gray-800">{s.column}</td>{[s.count, s.avg, s.stdDev, s.min, s.p25, s.median, s.p75, s.max].map((v, i) => <td key={i} className="text-right py-2 px-3">{typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : v}</td>)}</tr>)}</tbody></table></div>}
                {corrs.length > 0 && <div><h4 className="text-sm font-semibold text-gray-700 mb-2">Correlations</h4><div className="space-y-1">{corrs.map((c, i) => <div key={i} className="flex items-center justify-between text-sm bg-gray-50 rounded px-3 py-1.5"><span className="text-gray-700">{c.col1} ↔ {c.col2}</span><span className={`font-mono font-medium ${Math.abs(c.correlation) > .7 ? 'text-red-600' : Math.abs(c.correlation) > .4 ? 'text-amber-600' : 'text-gray-500'}`}>r = {c.correlation.toFixed(3)}</span></div>)}</div></div>}
              </div>)}
            </div>
            {/* charts */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <SecHead title="Visualizations" k="charts" icon={<TrendingUp className="w-5 h-5 text-green-600" />} />
              {exp.charts && <div className="space-y-6 mt-2">
                {lineData && <div><h4 className="text-sm font-semibold text-gray-700 mb-3">Line Chart</h4><Line data={lineData} options={{ responsive: true, plugins: { legend: { position: 'top' } }, scales: { y: { beginAtZero: true } } }} /></div>}
                {barData && <div><h4 className="text-sm font-semibold text-gray-700 mb-3">Bar Chart</h4><Bar data={barData} options={{ responsive: true, plugins: { legend: { position: 'top' } }, scales: { y: { beginAtZero: true } } }} /></div>}
                {pieData && <div className="max-w-md mx-auto"><h4 className="text-sm font-semibold text-gray-700 mb-3">Distribution</h4><Pie data={pieData} options={{ responsive: true, plugins: { legend: { position: 'bottom' } } }} /></div>}
              </div>}
            </div>
          </>)}
          {!isLoading && !csvData && <div className="text-center py-16 text-gray-400"><Upload className="w-16 h-16 mx-auto mb-4 opacity-30" /><p>Upload a CSV file to begin analysis</p></div>}
        </div>)}

        {/* ================================================================
            TAB — Unified Search
            ================================================================ */}
        {activeTab === 'search' && (<div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="flex items-center gap-2 mb-4"><Database className="w-5 h-5 text-blue-600" /><h3 className="text-lg font-semibold text-gray-800">Geospatial Catalog Search</h3></div>
            <p className="text-sm text-gray-500 mb-4">AI query decomposition + semantic/keyword hybrid search + LLM verification.</p>
            <div className="flex gap-2"><div className="relative flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /><input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleUnifiedSearch(searchQuery)} placeholder="e.g. unemployment, education, median income…" className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-300 outline-none" disabled={isSearching} /></div>
            <button onClick={() => handleUnifiedSearch(searchQuery)} disabled={isSearching || !searchQuery.trim()} className="px-6 py-3 bg-gradient-to-r from-blue-600 to-teal-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">{isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}Search</button></div>
            <div className="flex flex-wrap gap-2 mt-3">{['poverty rates per capita by county','cancer rates and healthcare access','environmental pollution near waterways'].map((ex, i) => <button key={i} onClick={() => { setSearchQuery(ex); handleUnifiedSearch(ex); }} className="px-2.5 py-1 text-xs bg-gray-100 text-gray-600 rounded-full hover:bg-gray-200" disabled={isSearching}>{ex}</button>)}</div>
            {searchError && <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-center gap-2"><AlertCircle className="w-4 h-4" />{searchError}</div>}
          </div>
          {isSearching && <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center"><Loader2 className="w-8 h-8 text-blue-500 animate-spin mx-auto mb-3" /><p className="text-gray-500 text-sm">Running unified search pipeline…</p></div>}
          {searchResponse && !isSearching && (<>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <SecHead title="Query Decomposition" k="decomposition" icon={<GitBranch className="w-5 h-5 text-purple-600" />} />
              {exp.decomposition && <div className="mt-2 bg-gray-50 rounded-lg p-4"><div className="text-sm text-gray-600 mb-3">Query "<b className="text-gray-800">{searchResponse.query}</b>" decomposed:</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div><div className="text-xs font-medium text-blue-600 uppercase mb-1">Primary</div><div className="flex flex-wrap gap-1">{searchResponse.decomposition.primary_concepts.map((c,i) => <span key={i} className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">{c}</span>)}</div></div>
                  <div><div className="text-xs font-medium text-green-600 uppercase mb-1">Normalization</div><div className="flex flex-wrap gap-1">{searchResponse.decomposition.normalization_concepts.length ? searchResponse.decomposition.normalization_concepts.map((c,i) => <span key={i} className="px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs">{c}</span>) : <span className="text-xs text-gray-400">None</span>}</div></div>
                  <div><div className="text-xs font-medium text-amber-600 uppercase mb-1">Filters</div><div className="flex flex-wrap gap-1">{searchResponse.decomposition.filter_concepts.length ? searchResponse.decomposition.filter_concepts.map((c,i) => <span key={i} className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded text-xs">{c}</span>) : <span className="text-xs text-gray-400">None</span>}</div></div>
                </div>
                <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-gray-200 text-xs text-gray-500"><span className="flex items-center gap-1"><Activity className="w-3 h-3" />{searchResponse.stats.total_results} results</span><span>{searchResponse.stats.processing_time_ms}ms</span>{searchResponse.stats.llm_filtered && <span className="px-1.5 py-0.5 bg-purple-100 text-purple-600 rounded text-[10px]">LLM Verified</span>}</div>
              </div>}
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <SecHead title={`Results (${searchResponse.all_results.length})`} k="results" icon={<Database className="w-5 h-5 text-blue-600" />} />

              {exp.results && <div className="mt-2 space-y-6">
                {searchResponse.llm_reasoning && (
                  <div className="bg-gradient-to-r from-indigo-50 to-blue-50 border border-blue-100 rounded-lg p-4 mb-5">
                    <div className="flex items-start gap-3">
                      <div className="mt-1 bg-white p-1.5 rounded-full shadow-sm border border-blue-100">
                        <Brain className="w-4 h-4 text-indigo-600" />
                      </div>
                      <div>
                        <h4 className="text-sm font-semibold text-indigo-900 mb-1">AI Verification Logic</h4>
                        <p className="text-sm text-indigo-800 leading-relaxed">
                          {searchResponse.llm_reasoning}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                {searchResponse.results_by_query.map((rq, qi) => <div key={qi}><div className="flex items-center gap-2 mb-2"><span className="text-sm font-semibold text-gray-700">"{rq.query}"</span><Badge purpose={rq.purpose} /><span className="text-xs text-gray-400">({rq.results.length})</span></div><div className="grid grid-cols-1 md:grid-cols-2 gap-3">{rq.results.map((it, i) => <SCard key={i} item={it} index={i} />)}</div></div>)}</div>}
            </div>
          </>)}
          {!searchResponse && !isSearching && <div className="text-center py-16 text-gray-400"><Search className="w-16 h-16 mx-auto mb-4 opacity-30" /><p>Enter a query to search the geospatial catalog</p></div>}
        </div>)}

        {/* ================================================================
            TAB — ML & Insights
            ================================================================ */}
        {activeTab === 'ml' && (<div className="space-y-6">
          {!csvData && <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center"><Brain className="w-16 h-16 text-gray-300 mx-auto mb-4" /><h3 className="text-lg font-semibold text-gray-700 mb-2">Upload Data First</h3><p className="text-gray-400 text-sm mb-4">Switch to CSV Analysis tab first.</p><button onClick={() => setActiveTab('data')} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">Go to CSV Upload</button></div>}
          {csvData && (<>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <SecHead title="K-Means Clustering" k="clustering" icon={<Brain className="w-5 h-5 text-violet-600" />} />
              {exp.clustering && <div className="mt-2 space-y-4">
                <p className="text-sm text-gray-500">Cluster data on selected numeric columns (Z-score normalised).</p>
                <div className="flex flex-wrap items-end gap-4">
                  <div><label className="block text-xs font-medium text-gray-600 mb-1">K</label><select value={clusterCount} onChange={e => setClusterCount(Number(e.target.value))} className="p-2 border border-gray-300 rounded-lg text-sm">{[2,3,4,5,6,7,8].map(k => <option key={k} value={k}>{k}</option>)}</select></div>
                  <div className="text-xs text-gray-500">Using: {selectedNumericColumns.join(', ') || '—'}</div>
                  <button onClick={runClustering} disabled={selectedNumericColumns.length < 2} className="px-4 py-2 bg-violet-600 text-white rounded-lg text-sm font-medium hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed">Run</button>
                </div>
                {clusterResults && clScatter && <div><h4 className="text-sm font-semibold text-gray-700 mb-2">Clusters ({selectedNumericColumns[0]} vs {selectedNumericColumns[1]})</h4><Scatter data={clScatter} options={{ responsive: true, plugins: { legend: { position: 'top' } }, scales: { x: { title: { display: true, text: selectedNumericColumns[0] } }, y: { title: { display: true, text: selectedNumericColumns[1] } } } }} /></div>}
              </div>}
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <SecHead title="Linear Regression" k="regression" icon={<TrendingUp className="w-5 h-5 text-red-600" />} />
              {exp.regression && <div className="mt-2 space-y-4">
                <div className="flex flex-wrap items-end gap-4">
                  <div><label className="block text-xs font-medium text-gray-600 mb-1">X</label><select value={regressionX} onChange={e => setRegressionX(e.target.value)} className="p-2 border border-gray-300 rounded-lg text-sm"><option value="">—</option>{columnTypes.numeric.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
                  <div><label className="block text-xs font-medium text-gray-600 mb-1">Y</label><select value={regressionY} onChange={e => setRegressionY(e.target.value)} className="p-2 border border-gray-300 rounded-lg text-sm"><option value="">—</option>{columnTypes.numeric.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
                  <button onClick={runRegression} disabled={!regressionX || !regressionY} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed">Run</button>
                </div>
                {regressionResult && <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <div className="bg-red-50 rounded-lg p-3 text-center"><div className="text-xl font-bold text-red-700">{regressionResult.rSquared.toFixed(4)}</div><div className="text-xs text-red-500">R²</div></div>
                    <div className="bg-gray-50 rounded-lg p-3 text-center"><div className="text-xl font-bold text-gray-700">{regressionResult.slope.toFixed(4)}</div><div className="text-xs text-gray-500">Slope</div></div>
                    <div className="bg-gray-50 rounded-lg p-3 text-center"><div className="text-xl font-bold text-gray-700">{regressionResult.intercept.toFixed(4)}</div><div className="text-xs text-gray-500">Intercept</div></div>
                  </div>
                  <div className="text-xs text-gray-500 bg-gray-50 rounded p-2 font-mono">{regressionResult.yColumn} = {regressionResult.slope.toFixed(4)} × {regressionResult.xColumn} + {regressionResult.intercept.toFixed(4)}</div>
                  {regScatter && <Scatter data={regScatter as any} options={{ responsive: true, plugins: { legend: { position: 'top' } }, scales: { x: { title: { display: true, text: regressionResult.xColumn } }, y: { title: { display: true, text: regressionResult.yColumn } } } }} />}
                </div>}
              </div>}
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <SecHead title="Outlier Detection" k="anomalies" icon={<AlertCircle className="w-5 h-5 text-amber-600" />} />
              {exp.anomalies && selectedNumericColumns.length > 0 && <div className="mt-2 space-y-3"><p className="text-sm text-gray-500">Z-score &gt; 2.5 outliers.</p>
                {selectedNumericColumns.map(col => { const st = calcStats(col); if (!st || st.stdDev === 0) return null; const ol = csvData.rows.map((r, i) => ({ i, v: Number(r[col]), z: Math.abs((Number(r[col]) - st.avg) / st.stdDev) })).filter(o => !isNaN(o.z) && o.z > 2.5).sort((a, b) => b.z - a.z).slice(0, 10); if (!ol.length) return null; return <div key={col} className="bg-amber-50 rounded-lg p-3"><div className="text-sm font-medium text-amber-800 mb-1">{col} — {ol.length} outlier(s)</div><div className="space-y-1 text-xs">{ol.map((o, j) => <div key={j} className="flex justify-between text-amber-700"><span>Row {o.i + 1}: {o.v.toFixed(2)}</span><span className="font-mono">z={o.z.toFixed(2)}</span></div>)}</div></div>; })}
              </div>}
            </div>
          </>)}
        </div>)}

        {/* ================================================================
            TAB — AutoML  (NEW)
            ================================================================ */}
        {activeTab === 'automl' && (<div className="space-y-6">
          {!csvData && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
              <Zap className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-gray-700 mb-2">Upload Data First</h3>
              <p className="text-gray-400 text-sm mb-4">Switch to <span className="font-medium text-gray-600">CSV Analysis</span> tab, upload a dataset, then return here.</p>
              <button onClick={() => setActiveTab('data')} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">Go to CSV Upload</button>
            </div>
          )}

          {csvData && (<>
            {/* Config panel */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
              <div className="flex items-center gap-2 mb-1"><Zap className="w-5 h-5 text-amber-500" /><h3 className="text-lg font-semibold text-gray-800">AutoGluon AutoML</h3></div>
              <p className="text-sm text-gray-500 mb-5">Select a target column and train an ensemble of models (60 s, medium_quality). Requires the <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded font-mono">automl</code> service (start it with <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded font-mono">make automl</code>).</p>
              <div className="flex flex-wrap items-end gap-4">
                <div className="flex-1 min-w-[200px]">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Target Column</label>
                  <select value={automlTarget} onChange={e => setAutomlTarget(e.target.value)} className="w-full p-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-300 outline-none">
                    <option value="">— select target —</option>
                    {csvData.headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
                <button onClick={handleAutomlTrain} disabled={isAutomlTraining || !automlTarget || !csvFile} className="px-6 py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-lg text-sm font-semibold hover:from-amber-600 hover:to-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2 shadow-sm">
                  {isAutomlTraining ? <><Loader2 className="w-4 h-4 animate-spin" />Training…</> : <><Zap className="w-4 h-4" />Train Models</>}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-3 mt-4 text-xs text-gray-500">
                <span className="flex items-center gap-1"><Table className="w-3 h-3" />{csvData.rows.length} rows × {csvData.headers.length} cols</span>
                {fileName && <span className="px-2 py-0.5 bg-gray-100 rounded-full">{fileName}</span>}
                {automlTarget && <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full font-medium flex items-center gap-1"><Target className="w-3 h-3" />{automlTarget}</span>}
              </div>
              {automlError && <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-center gap-2"><AlertCircle className="w-4 h-4 flex-shrink-0" />{automlError}</div>}
            </div>

            {/* Training loader */}
            {isAutomlTraining && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8">
                <div className="flex flex-col items-center">
                  <div className="w-20 h-20 rounded-full border-4 border-amber-200 flex items-center justify-center mb-5"><Loader2 className="w-10 h-10 text-amber-500 animate-spin" /></div>
                  <p className="text-gray-700 font-medium mb-1">Training in progress</p>
                  <p className="text-gray-400 text-sm text-center max-w-md">{automlProgress}</p>
                  <div className="w-full max-w-lg mt-6 space-y-3"><Skeleton height={18} /><Skeleton height={18} style={{ width: '85%' }} /><Skeleton height={18} style={{ width: '65%' }} /><div className="grid grid-cols-3 gap-3 mt-4"><Skeleton height={80} /><Skeleton height={80} /><Skeleton height={80} /></div></div>
                </div>
              </div>
            )}

            {/* Results */}
            {automlResult && !isAutomlTraining && (<>
              {/* Success banner */}
              <div className="bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 rounded-xl p-5 flex items-center gap-4">
                <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center flex-shrink-0"><CheckCircle2 className="w-6 h-6 text-emerald-600" /></div>
                <div><h4 className="font-semibold text-emerald-800">Training Complete</h4><p className="text-sm text-emerald-600">{automlResult.leaderboard.length} model{automlResult.leaderboard.length !== 1 ? 's' : ''} · {automlResult.problemType} · {automlResult.evalMetric}</p></div>
              </div>

              {/* Metrics */}
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <SecHead title="Evaluation Metrics" k="automlMetrics" icon={<Target className="w-5 h-5 text-teal-600" />} />
                {exp.automlMetrics && <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">{Object.entries(automlResult.metrics).map(([k, v]) => <div key={k} className="bg-teal-50 rounded-lg p-4 text-center border border-teal-100"><div className="text-xl font-bold text-teal-700 font-mono">{v !== null ? v.toFixed(4) : 'N/A'}</div><div className="text-xs text-teal-500 mt-1 uppercase tracking-wide">{k}</div></div>)}</div>}
              </div>

              {/* Leaderboard */}
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <SecHead title="Model Leaderboard" k="automlLeaderboard" icon={<Trophy className="w-5 h-5 text-amber-500" />} />
                {exp.automlLeaderboard && <div className="mt-3 space-y-4">
                  {amlLbChart && <Bar data={amlLbChart} options={{ indexAxis: 'y' as const, responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `Score: ${ctx.parsed.x.toFixed(4)}` } } }, scales: { x: { title: { display: true, text: `|${automlResult.evalMetric}|` }, beginAtZero: true } } }} />}
                  <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-gray-200"><th className="text-left py-2 px-3 text-gray-600 font-medium">#</th><th className="text-left py-2 px-3 text-gray-600 font-medium">Model</th><th className="text-right py-2 px-3 text-gray-600 font-medium">Score</th><th className="text-right py-2 px-3 text-gray-600 font-medium">Fit (s)</th><th className="text-right py-2 px-3 text-gray-600 font-medium">Pred (s)</th></tr></thead>
                  <tbody>{automlResult.leaderboard.map((e, i) => <tr key={e.model} className={`border-b border-gray-100 hover:bg-gray-50 ${i === 0 ? 'bg-amber-50/50' : ''}`}><td className="py-2 px-3 text-gray-500">{i + 1}</td><td className="py-2 px-3 font-medium text-gray-800 flex items-center gap-1.5">{i === 0 && <Trophy className="w-3.5 h-3.5 text-amber-500" />}{e.model}</td><td className="text-right py-2 px-3 font-mono">{e.score_val?.toFixed(4) ?? '—'}</td><td className="text-right py-2 px-3 text-gray-500">{e.fit_time?.toFixed(1) ?? '—'}</td><td className="text-right py-2 px-3 text-gray-500">{e.pred_time_val?.toFixed(3) ?? '—'}</td></tr>)}</tbody></table></div>
                </div>}
              </div>

              {/* Feature Importance */}
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <SecHead title="Feature Importance" k="automlImportance" icon={<BarChart3 className="w-5 h-5 text-emerald-600" />} />
                {exp.automlImportance && <div className="mt-3">{amlImpChart ? <Bar data={amlImpChart} options={{ indexAxis: 'y' as const, responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `Importance: ${ctx.parsed.x.toFixed(4)}` } } }, scales: { x: { title: { display: true, text: 'Permutation Importance' }, beginAtZero: true } } }} /> : <p className="text-sm text-gray-400">No importance data available.</p>}</div>}
              </div>

              {/* Actual vs Predicted */}
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <SecHead title="Actual vs Predicted" k="automlScatter" icon={<Activity className="w-5 h-5 text-violet-600" />} />
                {exp.automlScatter && <div className="mt-3">{amlScatterChart ? <div><p className="text-sm text-gray-500 mb-3">50-point sample from the test set. Dashed red line = perfect prediction.</p><Scatter data={amlScatterChart as any} options={{ responsive: true, plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: ctx => `Actual: ${ctx.parsed.x.toFixed(2)}, Pred: ${ctx.parsed.y.toFixed(2)}` } } }, scales: { x: { title: { display: true, text: 'Actual' } }, y: { title: { display: true, text: 'Predicted' } } } }} /></div> : <p className="text-sm text-gray-400">No scatter data.</p>}</div>}
              </div>
            </>)}

            {/* Ready state */}
            {!automlResult && !isAutomlTraining && !automlError && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
                <div className="w-20 h-20 mx-auto mb-4 bg-amber-50 rounded-full flex items-center justify-center"><Zap className="w-10 h-10 text-amber-400" /></div>
                <h3 className="text-lg font-semibold text-gray-700 mb-2">Ready to Train</h3>
                <p className="text-gray-400 text-sm max-w-md mx-auto">Select a target column and click <span className="font-medium text-amber-600">Train Models</span>. AutoGluon will try multiple algorithms and return the best ensemble.</p>
              </div>
            )}
          </>)}
        </div>)}

      </div>
    </div>
  );
}

export default ReportPage;
