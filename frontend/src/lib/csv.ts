/**
 * Reading a user's county CSV.
 *
 * Deliberately forgiving about format and strict about meaning. Files come out
 * of Excel, R and census downloads, so quoting, a BOM, `$`/`%`/thousands
 * separators and 4-digit FIPS (a leading zero lost to a spreadsheet) are all
 * accepted. What is NOT guessed at is which county a row is: a row without a
 * recognisable FIPS code is reported, never matched by name, because two
 * "Washington County"s in one state list is exactly the ambiguity this project
 * keeps paying for.
 */

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF, comma/semicolon/tab. */
export function parseCsv(text: string): ParsedCsv {
  // A byte-order mark from Excel would otherwise become part of the first header.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = clean.slice(0, clean.search(/\r?\n|$/));
  const delim = [',', '\t', ';']
    .map(d => [d, firstLine.split(d).length] as const)
    .sort((a, b) => b[1] - a[1])[0][0];

  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(f => f.trim() !== '')) rows.push(row);

  const [headers = [], ...body] = rows;
  return { headers: headers.map((h, i) => h.trim() || `column ${i + 1}`), rows: body };
}

/**
 * A county FIPS code from a cell, or null.
 *   "29001" -> "29001"    "9001" -> "09001" (leading zero lost)
 *   "0500000US29001" -> "29001" (census GEO_ID)
 */
export function toFips(cell: string): string | null {
  const v = cell.trim();
  const geo = v.match(/US(\d{5})$/);
  if (geo) return geo[1];
  if (/^\d{5}$/.test(v)) return v;
  if (/^\d{4}$/.test(v)) return `0${v}`;
  if (/^\d{4,5}\.0+$/.test(v)) return v.split('.')[0].padStart(5, '0');
  return null;
}

/** A number from a cell, tolerating "$1,234", "12.5%", " 3 ". Blank is null. */
export function toNumber(cell: string): number | null | undefined {
  const v = cell.trim().replace(/^\$/, '').replace(/%$/, '').replace(/,/g, '');
  if (v === '' || /^(na|n\/a|null|-|\.)$/i.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;   // undefined: present but not a number
}

/** The column most likely to hold county FIPS codes, or -1. */
export function detectFipsColumn(p: ParsedCsv): number {
  const score = (i: number) => {
    const sample = p.rows.slice(0, 200).map(r => r[i] ?? '');
    const ok = sample.filter(c => toFips(c)).length;
    const named = /fips|geoid|geo_id|county_?code|cnty/i.test(p.headers[i]) ? 0.25 : 0;
    return sample.length ? ok / sample.length + named : 0;
  };
  let best = -1, bestScore = 0.6;   // most rows must parse, not merely a few
  p.headers.forEach((_, i) => {
    const s = score(i);
    if (s > bestScore) { best = i; bestScore = s; }
  });
  return best;
}

/** Columns where most non-blank cells are numbers, excluding the FIPS column. */
export function numericColumns(p: ParsedCsv, fipsCol: number): number[] {
  return p.headers.map((_, i) => i).filter(i => {
    if (i === fipsCol) return false;
    const cells = p.rows.slice(0, 300).map(r => r[i] ?? '').filter(c => c.trim() !== '');
    if (!cells.length) return false;
    const nums = cells.filter(c => typeof toNumber(c) === 'number').length;
    return nums / cells.length >= 0.9;
  });
}

export interface ExtractedSeries {
  fips: string[];
  values: (number | null)[];
  badFips: number;
  badValues: number;
  duplicates: number;
}

/** One value column keyed by FIPS. First occurrence of a county wins, and is counted. */
export function extractSeries(p: ParsedCsv, fipsCol: number, valueCol: number): ExtractedSeries {
  const seen = new Set<string>();
  const out: ExtractedSeries = { fips: [], values: [], badFips: 0, badValues: 0, duplicates: 0 };
  for (const r of p.rows) {
    const f = toFips(r[fipsCol] ?? '');
    if (!f) { out.badFips++; continue; }
    if (seen.has(f)) { out.duplicates++; continue; }
    seen.add(f);
    const n = toNumber(r[valueCol] ?? '');
    if (n === undefined) out.badValues++;
    out.fips.push(f);
    out.values.push(typeof n === 'number' ? n : null);
  }
  return out;
}

/** Every county FIPS on the map, from the boundaries the map already draws. */
let countyFipsCache: Promise<Set<string>> | null = null;
export function countyFips(): Promise<Set<string>> {
  if (!countyFipsCache) {
    countyFipsCache = fetch('/counties.geojson')
      .then(r => r.json())
      .then((fc: { features: Array<{ properties?: { GEOID?: string } }> }) =>
        new Set(fc.features.map(f => f.properties?.GEOID ?? '').filter(Boolean)))
      .catch(err => { countyFipsCache = null; throw err; });
  }
  return countyFipsCache;
}
