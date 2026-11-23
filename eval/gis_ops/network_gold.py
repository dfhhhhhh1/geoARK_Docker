#!/usr/bin/env python3
"""
Gold for the network family of eval/gis_ops.yaml (GIS_OPS_PLAN.md H5),
computed WITHOUT the loader's tables and WITHOUT pgRouting.

The ops under test route over road_edge / road_vertex (etl/load_osm_network.py)
with pgr_drivingDistance. This script reads the region's .osm.pbf itself with
its own pyosmium handler, routes over EVERY OSM node (not the loader's
junction-split edges), measures segments with its own ellipsoid formula (not
PostGIS), and runs scipy's multi-source Dijkstra. The only shared input is
etl/osm_network.yaml, the definition both sides implement, and the osmium cut
of the region (/dumps/osm/<region>.pbf), which is a file cut, not logic.

Conventions (the suite header): a point is snapped to the nearest JUNCTION
(a node shared by two kept ways, or a way's end) of the mode's largest
component, strongly connected for drive, weakly for walk; costs run FROM the
nearest source along the directed graph; the access leg is not costed.

Feature coordinates and zone polygons come from PostGIS (they are the data the
question is about); WorldPop pixel centres from the source GeoTIFF.

Writes eval_network_gold(qid, geoid, value). Run in the etl-geo container:

  docker compose --profile etl run --rm -v <repo>/eval:/app/eval \
      --entrypoint python3 etl-geo /app/eval/gis_ops/network_gold.py
"""

from __future__ import annotations

import math
import re
import sys
import time

import numpy as np
import osmium
import psycopg2
import yaml
from osgeo import gdal, ogr
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components, dijkstra
from scipy.spatial import cKDTree

sys.path.insert(0, "/app/etl")
from ingest import pg_dsn  # noqa: E402

gdal.UseExceptions()
CFG = yaml.safe_load(open("/app/etl/osm_network.yaml"))
WORLDPOP = "/incoming/worldpop/usa_pop_2025_CN_1km_R2025A_UA_v1.tif"
MILE = 1609.344
A, F = 6378137.0, 1 / 298.257223563
E2 = F * (2 - F)
R_MEAN = 6371008.8

DRIVE_KMH = {k: float(v) for k, v in CFG["drive_kmh"].items()}
WALK = set(CFG["walk_classes"])
NO = set(CFG["access_no"])
YES = {"yes", "designated", "permissive", "destination"}
SPEED = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(mph|km/h|kmh|kph)?\s*$", re.I)
WALK_MPS = float(CFG["walk_mph"]) * 0.44704


def seg_len(lon1, lat1, lon2, lat2):
    """Ellipsoidal length of a short segment (local meridian / prime-vertical radii)."""
    phi = math.radians((lat1 + lat2) / 2)
    s = math.sin(phi)
    w = math.sqrt(1 - E2 * s * s)
    m = A * (1 - E2) / w ** 3
    n = A / w
    dy = math.radians(lat2 - lat1) * m
    dx = math.radians(lon2 - lon1) * n * math.cos(phi)
    return math.hypot(dx, dy)


class Graph(osmium.SimpleHandler):
    """Every node pair of every kept way, per mode, with its own reading of the rules."""

    def __init__(self):
        super().__init__()
        self.ways = []   # (nodes[(id, lon, lat)], drive_fwd, drive_bwd, speed_mps, walk)
        # Junctions over ALL kept ways, either mode (the convention, and what
        # the loader splits at): a way's ends count twice, interior nodes once.
        self.uses: dict[int, int] = {}

    def way(self, w):
        t = {k: v for k, v in w.tags}
        hw = t.get("highway")
        if hw is None or t.get("area") == "yes":
            return
        own = t.get("motorcar") or t.get("motor_vehicle")
        drive = hw in DRIVE_KMH and own not in NO and not (t.get("access") in NO and own not in YES)
        fwd = bwd = False
        speed = None
        if drive:
            ow = (t.get("oneway") or "").lower()
            if ow in ("yes", "true", "1"):
                fwd = True
            elif ow == "-1":
                bwd = True
            elif ow == "no":
                fwd = bwd = True
            elif hw in CFG["implied_oneway_highway"] or t.get("junction") in CFG["implied_oneway_junction"]:
                fwd = True
            else:
                fwd = bwd = True
            kmh = DRIVE_KMH[hw]
            m = SPEED.match(t.get("maxspeed") or "")
            if m and float(m.group(1)) > 0:
                kmh = float(m.group(1)) * (1.609344 if (m.group(2) or "").lower() == "mph" else 1)                     * float(CFG.get("maxspeed_factor", 1.0))
            speed = kmh / 3.6
        foot = t.get("foot")
        walk = hw in WALK and foot not in NO and not (t.get("access") in NO and foot not in YES)
        if not (fwd or bwd or walk):
            return
        nodes = []
        for nd in w.nodes:
            if not nd.location.valid():
                return
            nodes.append((nd.ref, nd.location.lon, nd.location.lat))
        if len(nodes) >= 2:
            self.ways.append((nodes, fwd, bwd, speed, walk))
            for k, (ref, _, _) in enumerate(nodes):
                self.uses[ref] = self.uses.get(ref, 0) + (2 if k in (0, len(nodes) - 1) else 1)


class Net:
    """One mode's routable graph: CSR matrix over node indices, junction KD-tree."""

    def __init__(self, g: Graph, mode: str, cost: str):
        idx, lon, lat = {}, [], []
        uses = g.uses
        rows, cols, vals = [], [], []

        def ix(ref, x, y):
            i = idx.get(ref)
            if i is None:
                i = idx[ref] = len(lon)
                lon.append(x)
                lat.append(y)
            return i

        for nodes, fwd, bwd, speed, walk in g.ways:
            if mode == "drive" and not (fwd or bwd):
                continue
            if mode == "walk" and not walk:
                continue
            for (r1, x1, y1), (r2, x2, y2) in zip(nodes, nodes[1:]):
                a, b = ix(r1, x1, y1), ix(r2, x2, y2)
                d = seg_len(x1, y1, x2, y2)
                if mode == "walk":
                    c = d
                    rows += [a, b]; cols += [b, a]; vals += [c, c]
                else:
                    c = d / speed if cost == "time" else d
                    if fwd:
                        rows.append(a); cols.append(b); vals.append(c)
                    if bwd:
                        rows.append(b); cols.append(a); vals.append(c)
        n = len(lon)
        # Zero-length segments (duplicate coordinates) still connect: a tiny cost.
        vals = [max(v, 1e-9) for v in vals]
        # Parallel ways between the same two nodes: keep the cheaper (a csr
        # matrix would SUM duplicates).
        order = {}
        for r, c, v in zip(rows, cols, vals):
            k = (r, c)
            if k not in order or v < order[k]:
                order[k] = v
        rr, cc = zip(*order.keys())
        self.m = csr_matrix((list(order.values()), (rr, cc)), shape=(n, n))
        ncomp, lab = connected_components(self.m, directed=True,
                                          connection="strong" if mode == "drive" else "weak")
        big = np.bincount(lab).argmax()
        self.lon, self.lat = np.array(lon), np.array(lat)
        refs = np.empty(n, dtype=np.int64)
        for ref, i in idx.items():
            refs[i] = ref
        junction = np.array([uses.get(r, 0) >= 2 for r in refs])
        self.cand = np.where((lab == big) & junction)[0]
        self.tree = cKDTree(unit(self.lon[self.cand], self.lat[self.cand]))
        print(f"    {mode}/{cost}: {n:,} nodes, {self.m.nnz:,} arcs, "
              f"largest component {np.sum(lab == big):,}, snap targets {len(self.cand):,}")

    def snap(self, lon, lat):
        _, k = self.tree.query(unit(np.asarray(lon), np.asarray(lat)))
        return self.cand[k]

    def cost_from(self, src_lon, src_lat, lon, lat):
        """Cost from the nearest source to each point (inf when unreachable)."""
        s = np.unique(self.snap(src_lon, src_lat))
        d = dijkstra(self.m, directed=True, indices=s, min_only=True)
        return d[self.snap(lon, lat)]

    def cost_to(self, dst_lon, dst_lat, lon, lat):
        """Cost from each point to its nearest destination (route's "to the
        nearest"): Dijkstra from the destinations over the REVERSED arcs."""
        s = np.unique(self.snap(dst_lon, dst_lat))
        d = dijkstra(self.m.T.tocsr(), directed=True, indices=s, min_only=True)
        return d[self.snap(lon, lat)]

    def node_costs(self, src_lon, src_lat):
        """Cost from the nearest source to EVERY node of the graph (service areas)."""
        s = np.unique(self.snap(src_lon, src_lat))
        return dijkstra(self.m, directed=True, indices=s, min_only=True)


def unit(lon, lat):
    lo, la = np.radians(lon), np.radians(lat)
    return np.column_stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])


def euclid_m(src_lon, src_lat, lon, lat):
    t = cKDTree(unit(np.asarray(src_lon), np.asarray(src_lat)))
    chord, _ = t.query(unit(np.asarray(lon), np.asarray(lat)))
    return 2 * R_MEAN * np.arcsin(np.minimum(chord / 2, 1))


def q(cur, sql, args=()):
    cur.execute(sql, args)
    return cur.fetchall()


FKEY = ("round(ST_X(ST_GeometryN(f.geom, 1))::numeric, 5) || ',' || "
        "round(ST_Y(ST_GeometryN(f.geom, 1))::numeric, 5)")


def table_for(cur, pattern):
    r = q(cur, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' "
               "AND table_name ~ %s", (pattern,))
    assert len(r) == 1, (pattern, r)
    return r[0][0]


def features_in(cur, table, area_sql, area_args=()):
    """(fkey, lon, lat, zone) for the layer's points inside each area polygon."""
    return q(cur, f"SELECT {FKEY}, ST_X(ST_GeometryN(f.geom,1)), ST_Y(ST_GeometryN(f.geom,1)), a.zone "
                  f"FROM {table} f JOIN ({area_sql}) a ON ST_Intersects(a.geom, f.geom)", area_args)


def sources_in(cur, table, bbox):
    x0, y0, x1, y1 = bbox
    r = q(cur, f"SELECT ST_X(ST_GeometryN(geom,1)), ST_Y(ST_GeometryN(geom,1)) FROM {table} "
               f"WHERE geom && ST_MakeEnvelope(%s,%s,%s,%s,4326)", (x0, y0, x1, y1))
    return np.array([a for a, _ in r]), np.array([b for _, b in r])


def pixels_in(cur, area_sql):
    """(zone, lon, lat, pop) of WorldPop pixel centres inside each polygon (OGR test)."""
    polys = [(z, ogr.CreateGeometryFromWkt(w)) for z, w in q(cur, f"SELECT zone, ST_AsText(geom) FROM ({area_sql}) a")]
    ds = gdal.Open(WORLDPOP)
    gt = ds.GetGeoTransform()
    band = ds.GetRasterBand(1)
    nd = band.GetNoDataValue()
    out = []
    for z, g in polys:
        x0, x1, y0, y1 = g.GetEnvelope()
        c0, c1 = int((x0 - gt[0]) / gt[1]), int((x1 - gt[0]) / gt[1]) + 1
        r0, r1 = int((y1 - gt[3]) / gt[5]), int((y0 - gt[3]) / gt[5]) + 1
        arr = band.ReadAsArray(c0, r0, c1 - c0, r1 - r0).astype(float)
        for i in range(arr.shape[0]):
            for j in range(arr.shape[1]):
                v = arr[i, j]
                if (nd is not None and v == nd) or not (v > 0):
                    continue
                cx = gt[0] + (c0 + j + 0.5) * gt[1]
                cy = gt[3] + (r0 + i + 0.5) * gt[5]
                p = ogr.Geometry(ogr.wkbPoint)
                p.AddPoint_2D(cx, cy)
                if g.Contains(p):
                    out.append((z, cx, cy, v))
    return out


def main():
    conn = psycopg2.connect(pg_dsn())
    cur = conn.cursor()
    cur.execute("CREATE TABLE IF NOT EXISTS eval_network_gold (qid text, geoid text, value double precision)")
    rows = []

    def put(qid, pairs):
        cur.execute("DELETE FROM eval_network_gold WHERE qid = %s", (qid,))
        rows.extend((qid, g, float(v)) for g, v in pairs)
        print(f"  {qid}: {len(pairs)} rows" + (f", value {pairs[0][1]:.1f}" if len(pairs) == 1 else ""))

    T = {k: table_for(cur, p) for k, p in {
        "schools": r"^public_schools_nces$", "fire": r"_fire_stations$", "hosp": r"^table_[0-9a-f]{32}_hospitals$",
        "cc": r"_childcarecenters$", "transit": r"^transit_stops$", "snap": r"^snap_retailers$",
        "police": r"_local_law_enforcement$"}.items()}
    STL_CITY = "SELECT 'city' AS zone, geom FROM county_geom WHERE fips = '29510'"
    CHI = ("SELECT 'city' AS zone, ST_Union(geom) AS geom FROM place_geom "
           "WHERE kind = 'place' AND name = 'Chicago' AND state_fp = '17'")
    zones = lambda lvl: f"SELECT geoid AS zone, geom FROM geo_unit WHERE level = '{lvl}'"

    for region in ("stl", "chi"):
        t0 = time.time()
        bbox = CFG["regions"][region]["bbox"]
        print(f"region {region}: reading /dumps/osm/{region}.pbf")
        g = Graph()
        g.apply_file(f"/dumps/osm/{region}.pbf", locations=True, idx="flex_mem")
        drive_t, drive_l, walk = Net(g, "drive", "time"), Net(g, "drive", "length"), Net(g, "walk", "length")

        if region == "stl":
            sx, sy = sources_in(cur, T["fire"], bbox)
            sch = features_in(cur, T["schools"], STL_CITY)
            lon, lat = np.array([r[1] for r in sch]), np.array([r[2] for r in sch])
            dt = drive_t.cost_from(sx, sy, lon, lat)
            dl = drive_l.cost_from(sx, sy, lon, lat)
            de = euclid_m(sx, sy, lon, lat)
            put("stl-schools-fire-drive-gt2_5", [(r[0], dt[i] / 60) for i, r in enumerate(sch) if dt[i] > 150])
            put("stl-schools-fire-euclid-gt1_25mi", [(r[0], de[i] / MILE) for i, r in enumerate(sch) if de[i] > 1.25 * MILE])
            put("stl-schools-fire-drive-gt2_5mi", [(r[0], dl[i] / MILE) for i, r in enumerate(sch) if dl[i] > 2.5 * MILE])

            hx, hy = sources_in(cur, T["hosp"], bbox)
            fs = features_in(cur, T["fire"], STL_CITY)
            lon, lat = np.array([r[1] for r in fs]), np.array([r[2] for r in fs])
            dl = drive_l.cost_from(hx, hy, lon, lat)
            de = euclid_m(hx, hy, lon, lat)
            put("stl-fire-hospital-roadmiles", [(r[0], dl[i] / MILE) for i, r in enumerate(fs) if np.isfinite(dl[i])])
            put("stl-fire-hospital-euclid-miles", [(r[0], de[i] / MILE) for i, r in enumerate(fs)])

            px = pixels_in(cur, zones("z_stl_wards"))
            lon, lat = np.array([p[1] for p in px]), np.array([p[2] for p in px])
            dt = drive_t.cost_from(hx, hy, lon, lat)
            tot, ins = {}, {}
            for i, (z, _, _, v) in enumerate(px):
                tot[z] = tot.get(z, 0) + v
                ins[z] = ins.get(z, 0) + (v if dt[i] <= 300 else 0)
            put("stl-ward-pop-hospital-drive-le5-pct", [(z, 100 * ins[z] / tot[z]) for z in tot])
            put("stl-ward-pop-hospital-drive-le5-count", [(z, ins[z]) for z in tot])

            # Service areas (ops/service_area.js): drive minutes from the St.
            # Louis city fire stations to a fixed sample of 4,000 OSM nodes of
            # the drive graph (every node, not only junctions: no snapping, the
            # node's own cost). The check tests which band polygon holds each
            # node. Seeded, so the sample is the same on every run.
            fx = features_in(cur, T["fire"], STL_CITY)
            fsx, fsy = np.array([r[1] for r in fx]), np.array([r[2] for r in fx])
            dn = drive_t.node_costs(fsx, fsy)
            rng = np.random.default_rng(20261123)
            near = np.where(np.isfinite(dn) & (dn <= 1500))[0]
            pick = rng.choice(near, size=min(4000, len(near)), replace=False)
            put("stl-sa-fire-city-nodes", [(f"{drive_t.lon[i]:.6f},{drive_t.lat[i]:.6f}", dn[i] / 60) for i in pick])

            # Routes (ops/route.js): drive minutes and road miles from each
            # city fire station to its nearest hospital, on the reversed graph.
            hx2, hy2 = sources_in(cur, T["hosp"], bbox)
            rt = drive_t.cost_to(hx2, hy2, fsx, fsy)
            put("stl-route-fire-hospital-minutes", [(r[0], rt[i] / 60) for i, r in enumerate(fx) if np.isfinite(rt[i])])
        else:
            tx, ty = sources_in(cur, T["snap"], bbox)
            cc = features_in(cur, T["cc"], zones("z_chi_community_areas"))
            lon, lat = np.array([r[1] for r in cc]), np.array([r[2] for r in cc])
            dw = walk.cost_from(tx, ty, lon, lat)
            dd = drive_t.cost_from(tx, ty, lon, lat)
            areas = [z for (z,) in q(cur, "SELECT geoid FROM geo_unit WHERE level = 'z_chi_community_areas'")]
            def per(cond):
                c = {z: 0 for z in areas}
                for i, r in enumerate(cc):
                    if cond(i):
                        c[r[3]] += 1
                return list(c.items())
            put("chi-ca-childcare-walk3-snap", per(lambda i: dw[i] <= 180 * WALK_MPS))
            put("chi-ca-childcare-all", per(lambda i: True))
            put("chi-ca-childcare-drive3-snap", per(lambda i: dd[i] <= 180))

            snx, sny = sources_in(cur, T["snap"], bbox)
            px = pixels_in(cur, CHI)
            lon, lat = np.array([p[1] for p in px]), np.array([p[2] for p in px])
            dw = walk.cost_from(snx, sny, lon, lat)
            de = euclid_m(snx, sny, lon, lat)
            pop = np.array([p[3] for p in px])
            lim = 600 * WALK_MPS
            put("chi-pop-snap-walk-gt10", [(None, pop[dw > lim].sum())])
            put("chi-pop-snap-walk-le10", [(None, pop[dw <= lim].sum())])
            put("chi-pop-snap-euclid-gt05mi", [(None, pop[de > 0.5 * MILE].sum())])

            hx, hy = sources_in(cur, T["hosp"], bbox)
            po = features_in(cur, T["police"], CHI)
            lon, lat = np.array([r[1] for r in po]), np.array([r[2] for r in po])
            dl = drive_l.cost_from(hx, hy, lon, lat)
            put("chi-police-hospital-drive-le3km", [(None, int(np.sum(dl <= 3000)))])
            put("chi-police-hospital-drive-le3mi", [(None, int(np.sum(dl <= 3 * MILE)))])
        print(f"  region {region} done in {time.time() - t0:.0f}s")

    cur.executemany("INSERT INTO eval_network_gold (qid, geoid, value) VALUES (%s, %s, %s)", rows)
    conn.commit()


if __name__ == "__main__":
    main()
