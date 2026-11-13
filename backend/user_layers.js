/**
 * Feature layers a user uploads, for this session only (docs/GIS_OPS_PLAN.md
 * H2: "user layers first-class").
 *
 *   POST /api/layers         body: the file, ?name=<file name>
 *                            -> { id, name, geometry, features, columns, bbox }
 *   POST /api/analyze ...    { user_layers: ["<id>", ...] }
 *   GET  /api/analyze/stream ?layers=<id>,<id>
 *
 * NOTHING IS WRITTEN TO THE DATABASE OR TO DISK. The file is converted in a
 * temporary directory that is removed before the response, and the features
 * are held in this process's memory for a few hours, keyed by an unguessable
 * id that only the uploader's browser has. An analysis that uses a layer binds
 * its geometries into the query as an array parameter, the same way uploaded
 * CSV values are (backend/followup.js), inside the READ ONLY transaction. A
 * restart forgets every layer, and the UI says to upload again.
 *
 * To the planner an uploaded layer is one more feature dataset, `layer:<id>`,
 * with its own name and attribute values, so every features op (count_features,
 * select_features, within, summarize, the distance ops) reads it unchanged.
 * The compiler turns it into a table expression (`fromSql` below) where a
 * catalog layer would be a table name.
 *
 * "Our ..." / "my ..." in a question prefers the user's layer over a catalog
 * layer of the same kind (preferUserLayer): "how many of our clinics are in
 * each Chicago ward" must count the clinics the user uploaded, not HIFLD's.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const PREFIX = "layer:";
const MAX_BYTES = Number(process.env.USER_LAYER_MAX_BYTES ?? 25 * 1024 * 1024);
const MAX_FEATURES = Number(process.env.USER_LAYER_MAX_FEATURES ?? 20000);
const MAX_LAYERS = Number(process.env.USER_LAYER_MAX_LAYERS ?? 50);     // across all sessions
const TTL_MS = Number(process.env.USER_LAYER_TTL_MIN ?? 240) * 60 * 1000;
const MAX_COLUMNS = 25;
const MAX_FILTER_VALUES = 40;
// The label columns select_features reports, and the filterable ones the
// planner is shown values for, the same lists catalog layers use.
const LABELS = ["name", "city", "state", "county", "address", "type", "status"];
const FILTERABLE = ["type", "status", "owner"];
const SAFE = /^[a-z_][a-z0-9_]{0,39}$/;
const ID_RE = /^[a-f0-9]{24}$/;

const store = new Map();     // id -> layer

function sweep(now = Date.now()) {
  for (const [id, l] of store) if (now - l.used > TTL_MS) store.delete(id);
  while (store.size > MAX_LAYERS) {
    const oldest = [...store.values()].sort((a, b) => a.used - b.used)[0];
    store.delete(oldest.id);
  }
}

/** ogr2ogr, if this image has it (deploy/api.Dockerfile installs gdal-bin). */
function ogrToGeoJSON(file) {
  return new Promise((resolve, reject) => {
    execFile("ogr2ogr", ["-f", "GeoJSON", "-t_srs", "EPSG:4326", "-lco", "RFC7946=YES",
                         "-dim", "XY", "/vsistdout/", file],
      { maxBuffer: 512 * 1024 * 1024, timeout: 120000 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === "ENOENT") {
            return reject(new UploadError("this server cannot read that format (no GDAL); upload GeoJSON instead"));
          }
          return reject(new UploadError(`could not read the file: ${String(stderr || err.message).split("\n")[0].slice(0, 200)}`));
        }
        try { resolve(JSON.parse(stdout)); } catch { reject(new UploadError("the converted file is not valid GeoJSON")); }
      });
  });
}

class UploadError extends Error {}

/** A column name the SQL can use: lower-case identifier, unique. */
function safeColumns(keys) {
  const out = new Map();
  for (const k of keys) {
    let c = String(k).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    if (!c || /^[0-9]/.test(c)) c = `c_${c}`.slice(0, 40);
    if (["geom", "value", "fips", "ctid"].includes(c)) c = `${c}_`;
    let n = c, i = 2;
    while ([...out.values()].includes(n)) n = `${c}_${i++}`.slice(0, 40);
    if (SAFE.test(n)) out.set(k, n);
    if (out.size >= MAX_COLUMNS) break;
  }
  return out;
}

const GEOM_FAMILY = (t) => /point/i.test(t) ? "point" : /line/i.test(t) ? "line" : /polygon/i.test(t) ? "polygon" : null;

/**
 * Turn an uploaded file into a stored layer. Throws UploadError with a
 * message the user can act on.
 */
async function ingest(buffer, fileName, displayName) {
  sweep();
  if (!buffer?.length) throw new UploadError("the file is empty");
  if (buffer.length > MAX_BYTES) {
    throw new UploadError(`the file is ${(buffer.length / 1e6).toFixed(1)} MB; the limit is ${(MAX_BYTES / 1e6).toFixed(0)} MB`);
  }
  const ext = path.extname(String(fileName || "")).toLowerCase();
  let fc;
  if (ext === ".geojson" || ext === ".json") {
    try { fc = JSON.parse(buffer.toString("utf8")); }
    catch { throw new UploadError("the file is not valid JSON"); }
    // RFC 7946 GeoJSON is WGS84 by definition; an old-style named CRS that
    // is not means the coordinates are projected, and drawing them as degrees
    // would put every feature off the map. GDAL can reproject; JSON.parse cannot.
    const crs = fc?.crs?.properties?.name;
    if (crs && !/CRS84|4326/.test(String(crs))) {
      fc = await convertWithGdal(buffer, ".geojson");
    }
  } else if ([".zip", ".gpkg", ".kml", ".gml", ".shp"].includes(ext)) {
    if (ext === ".shp") throw new UploadError("a shapefile is several files: upload them together as one .zip");
    fc = await convertWithGdal(buffer, ext);
  } else {
    throw new UploadError("upload GeoJSON (.geojson), a zipped shapefile (.zip), a GeoPackage (.gpkg) or KML");
  }
  const features = Array.isArray(fc?.features) ? fc.features.filter(f => f && f.geometry) : null;
  if (!features) throw new UploadError("no features were found in the file");
  if (!features.length) throw new UploadError("the file has no features with a geometry");
  if (features.length > MAX_FEATURES) {
    throw new UploadError(`the file has ${features.length.toLocaleString()} features; the limit is ${MAX_FEATURES.toLocaleString()}`);
  }
  const families = new Set(features.map(f => GEOM_FAMILY(f.geometry.type)));
  families.delete(null);
  if (!families.size) throw new UploadError("no point, line or polygon geometry was found");
  if (families.size > 1) {
    throw new UploadError(`the file mixes ${[...families].join(" and ")} features; upload one kind per file`);
  }
  // Coordinates must be degrees. A projected file without a CRS (a common
  // shapefile without its .prj) arrives as metres and would land in the sea.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c) => {
    if (typeof c[0] === "number") {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
    } else for (const x of c) visit(x);
  };
  for (const f of features) {
    if (f.geometry.type === "GeometryCollection") throw new UploadError("geometry collections are not supported");
    visit(f.geometry.coordinates || []);
  }
  if (!(minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90)) {
    throw new UploadError("the coordinates are not longitude / latitude. If this is a shapefile, include its .prj in the zip");
  }

  const keys = [];
  for (const f of features.slice(0, 2000)) {
    for (const k of Object.keys(f.properties || {})) if (!keys.includes(k)) keys.push(k);
  }
  const cols = safeColumns(keys);
  const props = features.map(f => {
    const o = {};
    for (const [k, c] of cols) {
      const v = f.properties?.[k];
      if (v === null || v === undefined || v === "") continue;
      o[c] = typeof v === "object" ? JSON.stringify(v).slice(0, 200) : String(v).slice(0, 200);
    }
    return JSON.stringify(o);
  });
  const columns = [...cols.values()];
  const filterValues = {};
  for (const c of FILTERABLE.filter(x => columns.includes(x))) {
    const counts = new Map();
    for (const p of props) { const v = JSON.parse(p)[c]; if (v) counts.set(v, (counts.get(v) || 0) + 1); }
    if (counts.size && counts.size <= MAX_FILTER_VALUES) {
      filterValues[c] = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
    }
  }
  const base = String(displayName || fileName || "uploaded layer")
    .replace(/\.(geojson|json|zip|gpkg|kml|gml)$/i, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[_]+/g, " ").trim().slice(0, 80) || "uploaded layer";
  const id = crypto.randomBytes(12).toString("hex");
  const layer = {
    id, name: base, file: String(fileName || "").slice(0, 200),
    geometry: [...families][0], features: features.length,
    bbox: [minX, minY, maxX, maxY], columns,
    label_columns: LABELS.filter(c => columns.includes(c)),
    filter_values: filterValues,
    geoms: features.map(f => JSON.stringify(f.geometry)),
    props,
    created: Date.now(), used: Date.now(),
  };
  store.set(id, layer);
  sweep();
  return describe(layer);
}

async function convertWithGdal(buffer, ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geoark-upload-"));
  try {
    const file = path.join(dir, `upload${ext}`);
    fs.writeFileSync(file, buffer);
    return await ogrToGeoJSON(ext === ".zip" ? `/vsizip/${file}` : file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const describe = (l) => ({
  id: l.id, name: l.name, file: l.file, geometry: l.geometry, features: l.features,
  bbox: l.bbox.map(x => Math.round(x * 1e5) / 1e5), columns: l.columns,
  filter_values: l.filter_values,
});

/** The layer ids a request names, as `layer:<id>` sources. Unknown ids are reported. */
function sourcesFor(ids) {
  sweep();
  const sources = new Map();
  const missing = [];
  for (const raw of [].concat(ids || []).flatMap(x => String(x).split(",")).map(x => x.trim()).filter(Boolean).slice(0, 5)) {
    const id = raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw;
    const l = ID_RE.test(id) ? store.get(id) : null;
    if (!l) { missing.push(raw); continue; }
    l.used = Date.now();
    sources.set(PREFIX + id, {
      attr_id: PREFIX + id, source_kind: "feature_table", user_layer: id,
      table_name: null, geom_column: "geom", srid: 4326,
      description: l.name, dataset: `Your uploaded layer: ${l.name}`,
      label_columns: l.label_columns, filter_values: l.filter_values,
      columns: l.columns, geometry: l.geometry, file: l.file, row_count: l.features,
      geoms: l.geoms, props: l.props,
    });
  }
  return { sources, missing };
}

const isUserLayer = (id) => String(id || "").startsWith(PREFIX);

/** A resolver that answers `layer:` ids from this request's layers. */
function withLayers(resolve, sources) {
  if (!sources?.size) return resolve;
  return async (ids) => {
    const mine = ids.filter(isUserLayer);
    const rest = ids.filter(id => !isUserLayer(id));
    const out = rest.length ? await resolve(rest) : new Map();
    for (const id of mine) if (sources.has(id)) out.set(id, sources.get(id));
    return out;
  };
}

/** A candidate row for the planner and the UI, shaped like a catalog feature layer. */
function candidate(src) {
  return {
    attr_id: src.attr_id,
    attr_desc: `${src.description} (your uploaded layer, ${src.row_count} ${src.geometry}s, mapped locations)`,
    dataset_clean: src.description,
    attr_orig: src.file || "",
    entity_type: "COUNTY",
    search_purpose: "user",
    is_feature_table: true,
    is_user_layer: true,
    // The catalog's spelling, so overlay's gate (a polygon or line layer on
    // offer, planner/features.js) sees an uploaded flood zone or road layer.
    spatial_rep: String(src.geometry || "").toUpperCase(),
    filter_values: src.filter_values || {},
  };
}

/**
 * The SQL a feature step reads FROM: the catalog table, or for an uploaded
 * layer a table expression over the bound arrays. Every column name in it was
 * made safe at upload (safeColumns) and is checked again here.
 */
function fromSql(src, bind) {
  if (!src?.user_layer) return src.table_name;
  const cols = (src.columns || []).filter(c => SAFE.test(c))
    .map(c => `u.p->>'${c}' AS ${c}`);
  return `(SELECT ST_SetSRID(ST_GeomFromGeoJSON(u.g), 4326) AS geom` +
         (cols.length ? `, ${cols.join(", ")}` : "") +
         ` FROM unnest(${bind(src.geoms)}::text[], ${bind(src.props)}::jsonb[]) AS u(g, p))`;
}

/**
 * "Our clinics", "my sites": when the question speaks of its own data and a
 * user layer is loaded, a feature reference the planner pointed at a CATALOG
 * layer goes to the user's layer instead. Which user layer: the only one, or
 * the one whose name shares a word with what follows "our". Deterministic and
 * logged; nothing happens without both an uploaded layer and the possessive.
 */
const OURS = /\b(?:our|my|we|us)\b\s*((?:[A-Za-z-]+\s*){0,4})/i;
const stem = (w) => w.toLowerCase().replace(/[^a-z]/g, "").replace(/(?:ies)$/, "y").replace(/s$/, "");
const FEATURE_FIELDS = ["attr_id", "near_attr_id"];
const STOP = /^(?:in|within|near|nearest|by|per|of|for|from|to|at|on|that|which|who|are|is|were|was|have|has|with|without|across|inside|outside|around|and|or)$/i;

function preferUserLayer(plan, query, sources, candidates = []) {
  if (!sources?.size) return null;
  const m = String(query || "").match(OURS);
  if (!m) return null;
  // The noun phrase only: "our sites near fire stations" is about sites.
  const phrase = [];
  for (const w of String(m[1] || "").split(/\s+/)) {
    if (STOP.test(w)) break;
    phrase.push(w);
  }
  const words = new Set(phrase.map(stem).filter(w => w.length > 2));
  const layers = [...sources.values()];
  const target = layers.length === 1 ? layers[0]
    : layers.find(l => String(l.description).split(/[\s_-]+/).map(stem).some(w => words.has(w)));
  if (!target) return null;
  const catalog = new Map((candidates || []).filter(c => c.is_feature_table && !c.is_user_layer)
    .map(c => [c.attr_id, c]));
  // Already reading the user's layer: the planner understood; touch nothing.
  if ((plan.steps || []).some(s => FEATURE_FIELDS.some(f => s[f] === target.attr_id))) return null;
  const refs = [];
  for (const st of plan.steps || []) {
    for (const f of FEATURE_FIELDS) if (catalog.has(st[f])) refs.push({ st, f, c: catalog.get(st[f]) });
  }
  const shares = (c) => String(c.dataset_clean || c.attr_desc || "").split(/[\s_-]+/).map(stem)
    .some(w => words.has(w));
  // The catalog layer the possessive names ("our clinics" -> a Clinics layer);
  // else, with one layer uploaded and one layer read, that one. "Our clinics
  // within 5 miles of a hospital" with two references and no shared word is
  // left alone: which of them is "ours" is not decidable from the words.
  const pick = refs.find(r => shares(r.c)) || (refs.length === 1 && layers.length === 1 ? refs[0] : null);
  if (!pick) return null;
  const { st, f, c } = pick;
  st[f] = target.attr_id;
  if (Array.isArray(st.attribute_filters)) {
    st.attribute_filters = st.attribute_filters.filter(x => (target.filter_values?.[x.column] || []).includes(x.value));
    if (!st.attribute_filters.length) delete st.attribute_filters;
  }
  return `step ${st.id} reads your uploaded layer "${target.description}" instead of ${c.dataset_clean || c.attr_id}`;
}

module.exports = {
  ingest, sourcesFor, withLayers, candidate, fromSql, preferUserLayer, isUserLayer,
  UploadError, PREFIX, MAX_BYTES, _store: store, _sweep: sweep,
};
