#!/usr/bin/env python3
"""
Dataset metadata: the sidecar file, the official XML, and the load ledger.

    python3 etl/dataset_meta.py /incoming/svi_2022        # print what was found, merged

A dataset arrives as a FOLDER:

    incoming/svi_2022/
      SVI_2022_US.csv            the data (one file, or a shapefile's siblings)
      svi_2022.meta.yaml         optional: written by whoever adds the data
      SVI_2022_US.xml            optional: FGDC / ISO 19115 / ISO 19110 / ArcGIS

PRECEDENCE: sidecar, then XML, then whatever the loader generates (the model's
one-line description, the title-cased column name). A person who wrote a
sidecar knows what the column means; an XML file usually does; the model is
guessing from a column name and five sample values.

WHY THE XML IS PARSED BY LOCAL NAME. The same "title" lives at
idinfo/citation/citeinfo/title in FGDC, at
identificationInfo/MD_DataIdentification/citation/CI_Citation/title/
gco:CharacterString in ISO 19115, and at dataIdInfo/idCitation/resTitle in
ArcGIS's own format -- and the ISO files in this archive put gmd in the DEFAULT
namespace while others prefix it. Matching on local-name chains handles all of
them without a namespace table that is wrong for the next file.

THE LEDGER (etl/data_manifest.yaml, in git) records what was loaded from which
bytes. It is what lets the server repeat a load without this machine: the
catalog rows and tags travel through git, the raw files go by scp, and the
ledger says which file produced which table.
"""

from __future__ import annotations

import fnmatch
import hashlib
import html
import os
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

LEDGER = Path(os.environ.get("DATA_MANIFEST", "/app/etl/data_manifest.yaml"))
INCOMING_ROOT = Path(os.environ.get("INGEST_ROOT", "/incoming"))

VECTOR_EXT = {".shp", ".geojson", ".json", ".gpkg", ".kml", ".csv", ".fgb"}
RASTER_EXT = {".tif", ".tiff", ".img", ".vrt", ".nc", ".asc"}
TABLE_EXT = {".csv", ".xlsx", ".xls", ".txt", ".tsv"}

SHAPEFILE_PARTS = {".shp", ".shx", ".dbf", ".prj", ".cpg", ".sbn", ".sbx", ".qix", ".qpj"}

KINDS = ("features", "table", "raster", "boundaries", "zones")
LEVELS = ("state", "county", "tract", "bg", "block", "zcta", "place")

# Every key the sidecar understands. Anything else is reported, because a typo
# ("descripton:") would otherwise be silently ignored and the dataset loaded
# with a model-written description the author thought they had replaced.
SIDECAR_KEYS = {
    "id", "name", "kind", "file", "layer", "level", "entity_type",
    "geo_column", "vintage", "year_column", "description", "source_url",
    "license", "originator", "columns", "include", "exclude", "probe",
    "aggregate", "grid_levels", "keywords", "missing", "code_rewrite",
    "zonal_levels", "measure", "measure_label",
    # kind: zones (etl/load_zones.py). `role: zones` is accepted as a synonym,
    # the spelling docs/GIS_OPS_PLAN.md uses.
    "role", "zones",
    # kind: raster, mode: native (H4, etl/load_raster.py load_native): a
    # shared measure code across vintages, a categorical legend, units, and
    # the searchable name of the one catalog row every vintage shares.
    "mode", "code", "classes", "units", "catalog_name",
}
COLUMN_KEYS = {"desc", "units", "skip", "definitions", "as"}

YEAR_RE = re.compile(r"(?<!\d)(1[89]\d\d|20\d\d)(?!\d)")


# --------------------------------------------------------------------------- #
# finding the pieces
# --------------------------------------------------------------------------- #

def find_parts(folder: Path) -> dict:
    """
    Sort a dataset folder into data files, sidecar and XML.

    A shapefile is one dataset spread over .shp/.dbf/.shx/.prj, so only the .shp
    counts as data. A .gdb is a DIRECTORY, and TIGER ones unzip nested
    (foo.gdb/foo.gdb), so the innermost one holding .gdbtable files is used.
    *.aux.xml is GDAL's own statistics cache, not metadata.
    """
    sidecars, xmls, data = [], [], []
    for p in sorted(folder.iterdir()):
        low = p.name.lower()
        if p.is_dir():
            if low.endswith(".gdb"):
                inner = p / p.name
                data.append(inner if inner.is_dir() else p)
            continue
        if low.endswith((".meta.yaml", ".meta.yml")):
            sidecars.append(p)
        elif low.endswith(".aux.xml") or low.endswith(".shp.iso.xml.aux"):
            continue
        elif low.endswith(".xml"):
            xmls.append(p)
        elif p.suffix.lower() in VECTOR_EXT | RASTER_EXT | TABLE_EXT:
            data.append(p)
    if len(sidecars) > 1:
        raise SystemExit(f"\n  REFUSED: {len(sidecars)} sidecar files in {folder}; "
                         f"keep exactly one *.meta.yaml\n")
    return {"sidecar": sidecars[0] if sidecars else None, "xml": xmls, "data": data}


def files_for(data_path: Path) -> list[Path]:
    """Every file whose bytes make up the dataset, for hashing and for scp."""
    if data_path.is_dir():
        return sorted(f for f in data_path.rglob("*") if f.is_file())
    if data_path.suffix.lower() == ".shp":
        # The parts GDAL actually reads. Not "everything named stem.*": that
        # sweeps in GDAL's own .aux.xml statistics cache, whose bytes change
        # whenever anything opens the file, and the replay would then see a
        # dataset that never changed as stale.
        stem = data_path.stem.lower()
        return sorted(f for f in data_path.parent.iterdir() if f.is_file()
                      and f.stem.lower() == stem
                      and f.suffix.lower() in SHAPEFILE_PARTS)
    return [data_path]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------- #
# sidecar
# --------------------------------------------------------------------------- #

def load_sidecar(path: Path | None) -> tuple[dict, list[str]]:
    """The sidecar as a dict, plus warnings about keys nothing reads."""
    if path is None:
        return {}, []
    if yaml is None:
        raise SystemExit("  PyYAML is missing; rebuild the etl-geo image "
                         "(docker compose --profile etl build etl-geo)")
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        where = f" at line {mark.line + 1}, column {mark.column + 1}" if mark else ""
        raise SystemExit(f"\n  REFUSED: {path.name} is not valid YAML{where}:\n"
                         f"    {getattr(e, 'problem', e)}\n"
                         f"  (A regex or backslash belongs in 'single quotes'.)\n")
    if not isinstance(doc, dict):
        raise SystemExit(f"\n  REFUSED: {path.name} is not a YAML mapping\n")
    warnings = [f"unknown key {k!r} in {path.name} (ignored)"
                for k in doc if k not in SIDECAR_KEYS]
    cols = doc.get("columns") or {}
    if not isinstance(cols, dict):
        raise SystemExit(f"\n  REFUSED: 'columns' in {path.name} must be a mapping "
                         f"of column name -> {{desc, units, skip}}\n")
    for col, spec in cols.items():
        if isinstance(spec, str):          # shorthand:  COL: "description"
            cols[col] = {"desc": spec}
        elif isinstance(spec, dict):
            warnings += [f"unknown key {k!r} under columns.{col} (ignored)"
                         for k in spec if k not in COLUMN_KEYS]
    doc["columns"] = cols
    if doc.get("kind") and doc["kind"] not in KINDS:
        raise SystemExit(f"\n  REFUSED: kind {doc['kind']!r}; expected one of {KINDS}\n")
    if doc.get("level") and doc["level"] not in LEVELS:
        raise SystemExit(f"\n  REFUSED: level {doc['level']!r}; expected one of {LEVELS}\n")
    return doc, warnings


# --------------------------------------------------------------------------- #
# XML
# --------------------------------------------------------------------------- #

def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _clean(text: str | None) -> str:
    """Whitespace-collapsed, HTML-free. ArcGIS abstracts are HTML fragments."""
    if not text:
        return ""
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return re.sub(r"\s+", " ", text).strip()


class _Doc:
    """An XML tree searchable by chains of local names, namespace-blind."""

    def __init__(self, root):
        self.root = root
        self.parent = {c: p for p in root.iter() for c in p}

    def _matches(self, el, chain) -> bool:
        node = el
        for name in reversed(chain):
            if node is None or _local(node.tag) != name:
                return False
            node = self.parent.get(node)
        return True

    def all(self, chain: str) -> list:
        parts = chain.split("/")
        return [e for e in self.root.iter() if _local(e.tag) == parts[-1]
                and self._matches(e, parts)]

    def text(self, *chains: str) -> str:
        for chain in chains:
            for e in self.all(chain):
                t = _clean("".join(e.itertext()))
                if t:
                    return t
        return ""

    def texts(self, chain: str) -> list[str]:
        out = []
        for e in self.all(chain):
            t = _clean("".join(e.itertext()))
            if t and t not in out:
                out.append(t)
        return out


def _years(*values: str) -> list[int]:
    """
    Years mentioned in date strings. FGDC writes dates compactly ("201906",
    "20200501"), which a year pattern bounded by non-digits cannot see, so a
    leading run of 6 or 8 digits is read as YYYYMM[DD] first.
    """
    ys = []
    for v in values:
        v = (v or "").strip()
        compact = re.match(r"^(1[89]\d\d|20\d\d)(\d{2}|\d{4})(?!\d)", v)
        if compact:
            ys.append(int(compact.group(1)))
            continue
        ys += [int(y) for y in YEAR_RE.findall(v)]
    return ys


def parse_xml(path: Path) -> dict:
    """
    Dataset- and column-level metadata from one XML file, whatever standard it
    follows. Returns {} for XML that is not metadata.

    Fields: standard, name, description, originator, source_url, license,
    keywords, start_year, end_year, columns {name: {desc, units}}.
    """
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        return {"_warning": f"{path.name}: not parseable XML ({e})"}
    d = _Doc(root)
    top = _local(root.tag)
    out: dict = {"columns": {}}

    if top == "MD_Metadata" or d.all("MD_DataIdentification"):
        out["standard"] = "ISO 19115"
        ident = "MD_DataIdentification"
        out["name"] = d.text(f"{ident}/citation/CI_Citation/title/CharacterString")
        out["description"] = d.text(f"{ident}/abstract/CharacterString")
        out["originator"] = d.text(
            f"{ident}/citation/CI_Citation/citedResponsibleParty/CI_ResponsibleParty/organisationName/CharacterString",
            f"{ident}/pointOfContact/CI_ResponsibleParty/organisationName/CharacterString",
            f"{ident}/credit/CharacterString")
        out["source_url"] = d.text("CI_OnlineResource/linkage/URL")
        out["license"] = d.text(
            "MD_LegalConstraints/useLimitation/CharacterString",
            "MD_LegalConstraints/otherConstraints/CharacterString",
            "MD_Constraints/useLimitation/CharacterString")
        out["keywords"] = d.texts("MD_Keywords/keyword/CharacterString")
        ys = _years(*d.texts("EX_TemporalExtent/extent/TimePeriod/beginPosition"),
                    *d.texts("EX_TemporalExtent/extent/TimePeriod/endPosition"),
                    *d.texts("EX_TemporalExtent/extent/TimeInstant/timePosition"))
        if not ys:
            ys = _years(*d.texts(f"{ident}/citation/CI_Citation/date/CI_Date/date/Date"),
                        *d.texts(f"{ident}/citation/CI_Citation/date/CI_Date/date/DateTime"))
        if ys:
            out["start_year"], out["end_year"] = min(ys), max(ys)

    if top == "FC_FeatureCatalogue" or d.all("FC_FeatureAttribute"):
        # ISO 19110: the Census ships column definitions in this (*.ea.iso.xml).
        out.setdefault("standard", "ISO 19110")
        for attr in d.all("FC_FeatureAttribute"):
            sub = _Doc(attr)
            col = sub.text("memberName/LocalName", "memberName/CharacterString")
            if col:
                out["columns"][col] = {
                    "desc": sub.text("definition/CharacterString"),
                    "units": sub.text("valueMeasurementUnit/UnitDefinition/name",
                                      "valueMeasurementUnit/BaseUnit/name"),
                }

    if top == "metadata":
        if d.all("idinfo"):
            out["standard"] = "FGDC CSDGM"
            out["name"] = d.text("idinfo/citation/citeinfo/title")
            out["description"] = d.text("idinfo/descript/abstract")
            out["originator"] = d.text("idinfo/citation/citeinfo/origin")
            out["source_url"] = d.text("idinfo/citation/citeinfo/onlink")
            out["license"] = d.text("idinfo/useconst")
            out["keywords"] = d.texts("keywords/theme/themekey")
            ys = _years(*d.texts("timeinfo/sngdate/caldate"),
                        *d.texts("timeinfo/rngdates/begdate"),
                        *d.texts("timeinfo/rngdates/enddate"),
                        *d.texts("timeinfo/mdattim/sngdate/caldate"))
        else:
            # ArcGIS's native format. Its eainfo block is FGDC-shaped, below.
            out["standard"] = "ArcGIS"
            out["name"] = d.text("dataIdInfo/idCitation/resTitle")
            out["description"] = d.text("dataIdInfo/idAbs", "dataIdInfo/idPurp")
            out["originator"] = d.text("dataIdInfo/idCredit",
                                       "dataIdInfo/idCitation/citRespParty/rpOrgName")
            out["license"] = d.text("dataIdInfo/resConst/Consts/useLimit")
            out["keywords"] = d.texts("searchKeys/keyword") or d.texts("themeKeys/keyword")
            ys = _years(*d.texts("dataIdInfo/idCitation/date/pubDate"),
                        *d.texts("dataIdInfo/idCitation/date/createDate"))
        if ys:
            out["start_year"], out["end_year"] = min(ys), max(ys)
        for attr in d.all("detailed/attr"):
            sub = _Doc(attr)
            col = sub.text("attr/attrlabl")
            if col:
                out["columns"][col] = {
                    "desc": sub.text("attr/attrdef"),
                    "units": sub.text("attrdomv/rdom/attrunit"),
                }

    if "standard" not in out:
        return {}
    # Placeholder text the generators leave behind is worse than nothing: it
    # would be written into the catalog as if it described the data.
    for k in ("name", "description", "originator", "license"):
        if out.get(k, "").lower() in ("", "none", "null", "n/a", "unknown",
                                      "no description provided", "abstract"):
            out.pop(k, None)
    out["columns"] = {c: {k: v for k, v in spec.items() if v}
                      for c, spec in out["columns"].items()}
    out["columns"] = {c: s for c, s in out["columns"].items() if s}
    return out


# --------------------------------------------------------------------------- #
# merging
# --------------------------------------------------------------------------- #

def resolve(target: Path, cli_name: str | None = None) -> dict:
    """
    Everything known about the dataset at `target` (a folder or a single file),
    merged by precedence: sidecar > XML > CLI fallback.

    `sources` records where each dataset-level field came from, so the dry run
    can show it and nobody has to guess why a description reads the way it does.
    """
    if target.is_dir() and not target.name.lower().endswith(".gdb"):
        parts = find_parts(target)
        folder = target
    else:
        folder = target.parent
        parts = find_parts(folder)
        parts["data"] = [target]

    side, warnings = load_sidecar(parts["sidecar"])

    data = parts["data"]
    if side.get("file"):
        wanted = folder / side["file"]
        data = [p for p in data if p == wanted or p.parent == wanted] or [wanted]
    if not data:
        raise SystemExit(f"\n  REFUSED: no data file in {folder}\n")
    if len(data) > 1:
        names = ", ".join(p.name for p in data)
        raise SystemExit(f"\n  REFUSED: {len(data)} data files in {folder} ({names}).\n"
                         f"  Name the one to load with  file:  in the sidecar, or give\n"
                         f"  each dataset its own folder.\n")
    data_path = data[0]

    # XML: prefer the one named after the data file, else any that parses.
    xml_meta, xml_file = {}, None
    ordered = sorted(parts["xml"], key=lambda p: not p.name.lower().startswith(
        data_path.stem.lower()))
    for x in ordered:
        m = parse_xml(x)
        if m.get("_warning"):
            warnings.append(m["_warning"])
            continue
        if not m:
            continue
        if xml_meta:
            # A second XML adds what the first lacked: Census ships the dataset
            # description and the column definitions in two separate files.
            for k, v in m.items():
                if k == "columns":
                    for c, s in v.items():
                        xml_meta["columns"].setdefault(c, s)
                elif not xml_meta.get(k):
                    xml_meta[k] = v
        else:
            xml_meta, xml_file = m, x

    merged: dict = {"sources": {}}

    def take(key, *candidates):
        for origin, value in candidates:
            if value not in (None, "", [], {}):
                merged[key] = value
                merged["sources"][key] = origin
                return
        merged[key] = None

    take("name", ("sidecar", side.get("name")), ("xml", xml_meta.get("name")),
         ("cli", cli_name))
    take("description", ("sidecar", side.get("description")),
         ("xml", xml_meta.get("description")))
    take("originator", ("sidecar", side.get("originator")),
         ("xml", xml_meta.get("originator")))
    take("source_url", ("sidecar", side.get("source_url")),
         ("xml", xml_meta.get("source_url")))
    take("license", ("sidecar", side.get("license")), ("xml", xml_meta.get("license")))
    take("keywords", ("sidecar", side.get("keywords")), ("xml", xml_meta.get("keywords")))

    vintage = side.get("vintage")
    if vintage is not None:
        ys = _years(str(vintage))
        if not ys:
            raise SystemExit(f"\n  REFUSED: vintage {vintage!r} contains no year\n")
        merged["start_year"], merged["end_year"] = min(ys), max(ys)
        merged["sources"]["years"] = "sidecar"
    elif xml_meta.get("start_year"):
        merged["start_year"], merged["end_year"] = xml_meta["start_year"], xml_meta["end_year"]
        merged["sources"]["years"] = "xml"
    else:
        merged["start_year"] = merged["end_year"] = None

    # Columns: sidecar wins per FIELD, not per column, so a sidecar can add
    # units to a column the XML already describes without retyping the text.
    columns: dict = {}
    for col, spec in (xml_meta.get("columns") or {}).items():
        columns[col] = dict(spec, _from="xml")
    for col, spec in (side.get("columns") or {}).items():
        base = columns.get(col, {})
        columns[col] = {**base, **{k: v for k, v in spec.items() if v not in (None, "")},
                        "_from": "sidecar" if spec.get("desc") else base.get("_from", "sidecar")}
    merged["columns"] = columns

    for k in ("id", "kind", "layer", "level", "entity_type", "geo_column",
              "year_column", "include", "exclude", "probe", "aggregate", "grid_levels",
              "missing", "code_rewrite", "zonal_levels", "measure", "measure_label",
              "zones", "mode", "code", "classes", "units", "catalog_name"):
        merged[k] = side.get(k)
    if str(side.get("role") or "").lower() == "zones" and not merged["kind"]:
        merged["kind"] = "zones"

    merged.update({
        "folder": folder,
        "data_path": data_path,
        "sidecar_path": parts["sidecar"],
        "xml_path": xml_file,
        "xml_standard": xml_meta.get("standard"),
        "warnings": warnings,
    })
    return merged


def column_meta(meta: dict, column: str) -> dict:
    """Metadata for one column, matched case-insensitively (DBF upper-cases)."""
    cols = meta.get("columns") or {}
    if column in cols:
        return cols[column]
    low = column.lower()
    for name, spec in cols.items():
        if name.lower() == low:
            return spec
    return {}


def column_selected(meta: dict, column: str) -> bool:
    """include / exclude globs and per-column skip, all case-insensitive."""
    if column_meta(meta, column).get("skip"):
        return False
    low = column.lower()
    include = [p.lower() for p in (meta.get("include") or [])]
    exclude = [p.lower() for p in (meta.get("exclude") or [])]
    if include and not any(fnmatch.fnmatch(low, p) for p in include):
        return False
    return not any(fnmatch.fnmatch(low, p) for p in exclude)


def infer_kind(meta: dict, has_geometry: bool | None, is_raster: bool) -> str:
    if meta.get("kind"):
        return meta["kind"]
    if is_raster:
        return "raster"
    if has_geometry is False:
        return "table"
    return "features"


# --------------------------------------------------------------------------- #
# the ledger
# --------------------------------------------------------------------------- #

def _rel(path: Path) -> str:
    """Path relative to the incoming root, so it means the same on the server."""
    try:
        return str(path.relative_to(INCOMING_ROOT))
    except ValueError:
        return str(path)


def file_records(data_path: Path, extra: list[Path] = ()) -> list[dict]:
    recs = []
    for f in [*files_for(data_path), *[e for e in extra if e]]:
        recs.append({"path": _rel(f), "sha256": sha256(f), "bytes": f.stat().st_size})
    return recs


def files_sha(records: list[dict]) -> str:
    """One hash for a dataset's bytes: what replay compares against dataset_load."""
    lines = sorted(f"{r['path']} {r['sha256']}" for r in records)
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def read_ledger(path: Path = LEDGER) -> dict:
    if not path.exists():
        return {"version": 1, "datasets": []}
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    doc.setdefault("version", 1)
    doc.setdefault("datasets", [])
    return doc


def record_load(entry: dict, path: Path = LEDGER) -> None:
    """Upsert one dataset by id. The file is rewritten whole: it is small."""
    def plain(x):
        # numpy scalars (np.float64 from a zonal sum) are not YAML-representable,
        # and failing HERE means the data loaded but the ledger never says so.
        if isinstance(x, dict):
            return {k: plain(v) for k, v in x.items()}
        if isinstance(x, (list, tuple)):
            return [plain(v) for v in x]
        if hasattr(x, "item") and not isinstance(x, (str, bytes)):
            return x.item()
        return x
    entry = plain(entry)
    doc = read_ledger(path)
    entry = {"loaded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), **entry}
    doc["datasets"] = [d for d in doc["datasets"] if d.get("id") != entry["id"]] + [entry]
    header = ("# What has been loaded, from which bytes. Written by etl/ingest.py;\n"
              "# read by `make replay` on another machine. See docs/DATA_LOADING_PLAN.md.\n")
    path.write_text(header + yaml.safe_dump(doc, sort_keys=False, allow_unicode=True,
                                            width=100), encoding="utf-8")


# --------------------------------------------------------------------------- #

def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    m = resolve(Path(sys.argv[1]))
    for k in ("name", "description", "originator", "source_url", "license",
              "start_year", "end_year", "kind", "level", "xml_standard"):
        src = m["sources"].get(k) or (m["sources"].get("years") if "year" in k else "")
        print(f"  {k:<12} {m.get(k)!s:.100}  {('[' + src + ']') if src else ''}")
    print(f"  data         {m['data_path']}")
    print(f"  columns      {len(m['columns'])} described")
    for w in m["warnings"]:
        print(f"  ! {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
