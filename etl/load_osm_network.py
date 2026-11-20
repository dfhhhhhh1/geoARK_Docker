#!/usr/bin/env python3
"""
Routable road graph from OpenStreetMap (docs/GIS_OPS_PLAN.md H5).

    python3 etl/load_osm_network.py --pbf /incoming/osm_us/us-latest.osm.pbf \
        --region stl --region chi

For each region named in etl/osm_network.yaml (or an ad-hoc --bbox with
--name):

1. osmium cuts the region out of the (national) .pbf with complete ways, so a
   road crossing the box edge keeps all its nodes, and keeps only highway
   ways. The cut is written to /dumps/osm/<region>.pbf, which the eval gold
   reads too (an osmium cut is not code under test).
2. pyosmium reads the cut with node locations. A way is kept when a car may
   use it (drive) or a pedestrian may (walk), by the classes and access rules
   in osm_network.yaml; each mode's flags are stored, not separate graphs.
3. Ways are split at every node shared by two kept ways (and at their ends),
   so every junction is a vertex. Vertex ids are OSM node ids.
4. road_edge gets one row per piece: both modes' flags, the drive speed
   (numeric maxspeed, else the class default), geodesic length, and the drive
   time in seconds. road_vertex gets every vertex, flagged when it is in the
   LARGEST component of each mode's graph (strongly connected for drive,
   connected for walk), the only vertices a point is ever snapped to.

Reloading a region replaces it. Nothing is added to the catalog: the network
is not a measure, it is how distance is measured (planner/network.js).
"""

from __future__ import annotations

import argparse
import io
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import osmium
import psycopg2
import yaml

sys.path.insert(0, "/app/etl")
from ingest import pg_dsn  # noqa: E402

HERE = Path(__file__).resolve().parent
CUT_DIR = Path(os.environ.get("OSM_CUT_DIR", "/dumps/osm"))

SCHEMA = """
CREATE EXTENSION IF NOT EXISTS pgrouting;
CREATE TABLE IF NOT EXISTS road_region (
    region      text PRIMARY KEY,
    label       text,
    bbox        geometry(Polygon, 4326) NOT NULL,
    source_file text,
    source_time text,
    edges       integer,
    vertices    integer,
    drive_vertices integer,
    walk_vertices  integer,
    walk_mph    real NOT NULL,
    loaded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS road_edge (
    id         bigserial PRIMARY KEY,
    region     text NOT NULL,
    way_id     bigint NOT NULL,
    source     bigint NOT NULL,
    target     bigint NOT NULL,
    highway    text NOT NULL,
    drive_fwd  boolean NOT NULL,
    drive_bwd  boolean NOT NULL,
    walk       boolean NOT NULL,
    speed_kmh  real,
    length_m   double precision,
    drive_s    double precision,
    geom       geometry(LineString, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS road_edge_region ON road_edge (region);
CREATE INDEX IF NOT EXISTS road_edge_geom ON road_edge USING gist (geom);
CREATE TABLE IF NOT EXISTS road_vertex (
    region   text NOT NULL,
    id       bigint NOT NULL,
    geom     geometry(Point, 4326) NOT NULL,
    drive_cc boolean NOT NULL DEFAULT false,
    walk_cc  boolean NOT NULL DEFAULT false,
    PRIMARY KEY (region, id)
);
-- Snapping is a geodesic nearest-vertex search; a geography KNN index makes
-- `<->` order by true distance (a planar <-> in degrees is not the nearest
-- away from the equator: CLAUDE.md, the nearest_distance correction).
CREATE INDEX IF NOT EXISTS road_vertex_drive_geog ON road_vertex
    USING gist ((geom::geography)) WHERE drive_cc;
CREATE INDEX IF NOT EXISTS road_vertex_walk_geog ON road_vertex
    USING gist ((geom::geography)) WHERE walk_cc;
-- The region whose box covers an extent, smallest first; RAISES when none
-- does. A network question over an area with no graph must fail loudly: a
-- straight-line answer in its place is a confident wrong answer.
CREATE OR REPLACE FUNCTION road_region_for(g geometry) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE r text;
BEGIN
  IF g IS NULL THEN
    RAISE EXCEPTION 'NETWORK: there are no features to route from';
  END IF;
  SELECT region INTO r FROM road_region WHERE ST_Covers(bbox, g) ORDER BY ST_Area(bbox) LIMIT 1;
  IF r IS NULL THEN
    RAISE EXCEPTION 'NETWORK_NOT_LOADED: no road network is loaded for this area (loaded: %)',
      coalesce((SELECT string_agg(label, '; ' ORDER BY region) FROM road_region), 'none');
  END IF;
  RETURN r;
END $$;
"""

MAXSPEED = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(mph|km/h|kmh|kph)?\s*$", re.I)
YES = {"yes", "designated", "permissive", "destination"}


def load_config() -> dict:
    return yaml.safe_load((HERE / "osm_network.yaml").read_text())


class Rules:
    """osm_network.yaml as predicates over a way's tags."""

    def __init__(self, cfg: dict):
        self.drive_kmh = {k: float(v) for k, v in cfg["drive_kmh"].items()}
        self.walk = set(cfg["walk_classes"])
        self.access_no = set(cfg["access_no"])
        self.ow_hw = set(cfg["implied_oneway_highway"])
        self.ow_junction = set(cfg["implied_oneway_junction"])
        self.maxspeed_factor = float(cfg.get("maxspeed_factor", 1.0))

    def drive(self, t) -> tuple[bool, bool, float | None]:
        hw = t.get("highway")
        if hw not in self.drive_kmh or t.get("area") == "yes":
            return False, False, None
        own = t.get("motorcar") or t.get("motor_vehicle")
        if own in self.access_no:
            return False, False, None
        if t.get("access") in self.access_no and own not in YES:
            return False, False, None
        ow = (t.get("oneway") or "").lower()
        if ow in ("yes", "true", "1"):
            fwd, bwd = True, False
        elif ow == "-1":
            fwd, bwd = False, True
        elif ow == "no":
            fwd, bwd = True, True
        elif hw in self.ow_hw or t.get("junction") in self.ow_junction:
            fwd, bwd = True, False
        else:
            fwd, bwd = True, True
        speed = self.drive_kmh[hw]
        m = MAXSPEED.match(t.get("maxspeed") or "")
        if m and float(m.group(1)) > 0:
            v = float(m.group(1))
            speed = (v * 1.609344 if (m.group(2) or "").lower() == "mph" else v) * self.maxspeed_factor
        return fwd, bwd, speed

    def walks(self, t) -> bool:
        hw = t.get("highway")
        if hw not in self.walk or t.get("area") == "yes":
            return False
        foot = t.get("foot")
        if foot in self.access_no:
            return False
        if t.get("access") in self.access_no and foot not in YES:
            return False
        return True


class Ways(osmium.SimpleHandler):
    def __init__(self, rules: Rules):
        super().__init__()
        self.rules = rules
        self.ways = []          # (way_id, highway, fwd, bwd, walk, speed, [(ref, lon, lat)])
        self.uses: dict[int, int] = {}

    def way(self, w):
        t = w.tags
        fwd, bwd, speed = self.rules.drive(t)
        walk = self.rules.walks(t)
        if not (fwd or bwd or walk):
            return
        nodes = []
        for n in w.nodes:
            if not n.location.valid():
                return          # a node outside the cut: complete_ways should prevent it
            nodes.append((n.ref, n.location.lon, n.location.lat))
        if len(nodes) < 2:
            return
        self.ways.append((w.id, t.get("highway"), fwd, bwd, walk, speed, nodes))
        for ref, _, _ in nodes:
            self.uses[ref] = self.uses.get(ref, 0) + 1


def cut(pbf: str, region: str, bbox: list[float]) -> Path:
    CUT_DIR.mkdir(parents=True, exist_ok=True)
    box = CUT_DIR / f"{region}.box.pbf"
    out = CUT_DIR / f"{region}.pbf"
    b = ",".join(str(x) for x in bbox)
    t0 = time.time()
    subprocess.run(["osmium", "extract", "-b", b, "--strategy", "complete_ways",
                    pbf, "-o", str(box), "--overwrite"], check=True)
    subprocess.run(["osmium", "tags-filter", str(box), "w/highway", "-o", str(out), "--overwrite"],
                   check=True)
    box.unlink()
    print(f"  cut {region} {b}: {out.stat().st_size / 1e6:.1f} MB in {time.time() - t0:.0f}s")
    return out


def source_time(pbf: str) -> str:
    r = subprocess.run(["osmium", "fileinfo", "-g", "header.option.osmosis_replication_timestamp", pbf],
                       capture_output=True, text=True)
    return r.stdout.strip() or ""


def pieces(ways: Ways):
    """Each kept way split at shared nodes: (way, highway, fwd, bwd, walk, speed, nodes)."""
    for wid, hw, fwd, bwd, walk, speed, nodes in ways.ways:
        start = 0
        for i in range(1, len(nodes)):
            if i == len(nodes) - 1 or ways.uses.get(nodes[i][0], 0) >= 2:
                seg = nodes[start:i + 1]
                if seg[0][0] != seg[-1][0] or len(seg) > 2:
                    yield wid, hw, fwd, bwd, walk, speed, seg
                start = i


def load_region(conn, region: str, label: str, bbox: list[float], pbf: str, cfg: dict,
                reuse_cut: bool = False) -> None:
    t0 = time.time()
    existing = CUT_DIR / f"{region}.pbf"
    cut_pbf = existing if reuse_cut and existing.exists() else cut(pbf, region, bbox)
    ways = Ways(Rules(cfg))
    ways.apply_file(str(cut_pbf), locations=True, idx="flex_mem")
    print(f"  {len(ways.ways):,} ways kept")

    buf = io.StringIO()
    vertices: dict[int, tuple[float, float]] = {}
    n = 0
    for wid, hw, fwd, bwd, walk, speed, seg in pieces(ways):
        wkt = "SRID=4326;LINESTRING(" + ",".join(f"{lon:.7f} {lat:.7f}" for _, lon, lat in seg) + ")"
        sp = "" if speed is None else f"{speed:.3f}"
        buf.write(f"{region}\t{wid}\t{seg[0][0]}\t{seg[-1][0]}\t{hw}\t{fwd}\t{bwd}\t{walk}\t{sp or chr(92) + 'N'}\t{wkt}\n")
        vertices.setdefault(seg[0][0], seg[0][1:])
        vertices.setdefault(seg[-1][0], seg[-1][1:])
        n += 1
    print(f"  {n:,} edges, {len(vertices):,} vertices")

    with conn.cursor() as cur:
        cur.execute("DELETE FROM road_edge WHERE region = %s", (region,))
        cur.execute("DELETE FROM road_vertex WHERE region = %s", (region,))
        buf.seek(0)
        cur.copy_expert("COPY road_edge (region, way_id, source, target, highway, drive_fwd, drive_bwd, "
                        "walk, speed_kmh, geom) FROM STDIN", buf)
        cur.execute("UPDATE road_edge SET length_m = ST_Length(geom::geography), "
                    "drive_s = CASE WHEN speed_kmh > 0 THEN ST_Length(geom::geography) / (speed_kmh / 3.6) END "
                    "WHERE region = %s", (region,))
        vb = io.StringIO()
        for vid, (lon, lat) in vertices.items():
            vb.write(f"{region}\t{vid}\tSRID=4326;POINT({lon:.7f} {lat:.7f})\n")
        vb.seek(0)
        cur.copy_expert("COPY road_vertex (region, id, geom) FROM STDIN", vb)

        # Largest component of each mode's graph (pgRouting). Into an
        # ANALYZEd temp table first: as one UPDATE ... FROM over the function,
        # the freshly inserted vertices had no statistics, Postgres estimated
        # one row and nested-looped ~1M x ~1M (Chicago, 28 min and counting,
        # 2026-11-19). Analyzed, it is a hash join.
        cur.execute("ANALYZE road_vertex")
        r = psycopg2.extensions.QuotedString(region).getquoted().decode()
        for flag, fn, edges in (
            ("drive_cc", "pgr_strongComponents",
             "SELECT id, source, target, CASE WHEN drive_fwd THEN 1 ELSE -1 END AS cost, "
             "CASE WHEN drive_bwd THEN 1 ELSE -1 END AS reverse_cost "
             "FROM road_edge WHERE region = %s AND (drive_fwd OR drive_bwd)"),
            ("walk_cc", "pgr_connectedComponents",
             "SELECT id, source, target, 1 AS cost, 1 AS reverse_cost "
             "FROM road_edge WHERE region = %s AND walk")):
            t1 = time.time()
            cur.execute("DROP TABLE IF EXISTS net_comp")
            cur.execute(f"CREATE TEMP TABLE net_comp AS SELECT component, node FROM {fn}(%s)",
                        (edges % r,))
            cur.execute("ANALYZE net_comp")
            cur.execute(f"""
                UPDATE road_vertex v SET {flag} = true FROM net_comp c
                 WHERE v.region = {r} AND v.id = c.node
                   AND c.component = (SELECT component FROM net_comp GROUP BY 1 ORDER BY count(*) DESC LIMIT 1)""")
            print(f"  {flag}: {cur.rowcount:,} vertices in {time.time() - t1:.0f}s")
        cur.execute("SELECT count(*) FILTER (WHERE drive_cc), count(*) FILTER (WHERE walk_cc) "
                    "FROM road_vertex WHERE region = %s", (region,))
        dv, wv = cur.fetchone()
        x0, y0, x1, y1 = bbox
        cur.execute("""
            INSERT INTO road_region (region, label, bbox, source_file, source_time, edges, vertices,
                                     drive_vertices, walk_vertices, walk_mph)
            VALUES (%s, %s, ST_MakeEnvelope(%s, %s, %s, %s, 4326), %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (region) DO UPDATE SET label = EXCLUDED.label, bbox = EXCLUDED.bbox,
              source_file = EXCLUDED.source_file, source_time = EXCLUDED.source_time,
              edges = EXCLUDED.edges, vertices = EXCLUDED.vertices,
              drive_vertices = EXCLUDED.drive_vertices, walk_vertices = EXCLUDED.walk_vertices,
              walk_mph = EXCLUDED.walk_mph, loaded_at = now()""",
                    (region, label, x0, y0, x1, y1, os.path.basename(pbf), source_time(pbf),
                     n, len(vertices), dv, wv, float(cfg["walk_mph"])))
    conn.commit()
    print(f"  {region}: drive component {dv:,} vertices, walk component {wv:,}; {time.time() - t0:.0f}s")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pbf", required=True)
    ap.add_argument("--region", action="append", default=[], help="a region in osm_network.yaml")
    ap.add_argument("--bbox", help="ad hoc: lon_min,lat_min,lon_max,lat_max (with --name)")
    ap.add_argument("--name")
    ap.add_argument("--cut", action="store_true", help="reuse /dumps/osm/<region>.pbf if present")
    args = ap.parse_args()
    cfg = load_config()
    todo = [(r, cfg["regions"][r]["label"], cfg["regions"][r]["bbox"]) for r in args.region]
    if args.bbox:
        if not args.name:
            ap.error("--bbox needs --name")
        todo.append((args.name, args.name, [float(x) for x in args.bbox.split(",")]))
    if not todo:
        ap.error("name a --region or give --bbox")
    conn = psycopg2.connect(pg_dsn())
    with conn.cursor() as cur:
        cur.execute(SCHEMA)
    conn.commit()
    for region, label, bbox in todo:
        print(f"region {region}: {label}")
        load_region(conn, region, label, bbox, args.pbf, cfg, reuse_cut=args.cut)
    with conn.cursor() as cur:
        cur.execute("ANALYZE road_edge; ANALYZE road_vertex")
    conn.commit()


if __name__ == "__main__":
    main()
