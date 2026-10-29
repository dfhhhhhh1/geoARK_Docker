#!/usr/bin/env python3
"""
Tests for etl/dataset_meta.py and the catalog-writing half of etl/ingest.py.

    docker compose --profile etl run --rm --entrypoint python3 etl-geo \
        /app/etl/test_dataset_meta.py

Each XML fixture is the smallest real-shaped document of its standard. The
ISO 19115 one uses gmd as the DEFAULT namespace, the way the HSIP files in
geospatial_database_data do; the others prefix it.
"""

from __future__ import annotations

import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import dataset_meta as dm  # noqa: E402

FGDC = """<?xml version="1.0"?>
<metadata>
  <idinfo>
    <citation><citeinfo>
      <origin>U.S. Census Bureau</origin>
      <title>TIGER/Line Shapefile, 2020, Census Tracts</title>
      <onlink>https://www.census.gov/geo/maps-data/data/tiger-line.html</onlink>
    </citeinfo></citation>
    <descript><abstract>Tracts are small, relatively permanent statistical subdivisions.</abstract></descript>
    <timeperd><timeinfo><rngdates><begdate>201906</begdate><enddate>202005</enddate></rngdates></timeinfo></timeperd>
    <keywords><theme><themekey>Census Tract</themekey><themekey>Polygon</themekey></theme></keywords>
    <useconst>None</useconst>
  </idinfo>
  <eainfo><detailed>
    <attr><attrlabl>ALAND</attrlabl><attrdef>Land area</attrdef>
      <attrdomv><rdom><attrunit>square meters</attrunit></rdom></attrdomv></attr>
    <attr><attrlabl>NAMELSAD</attrlabl><attrdef>Name and legal/statistical area description</attrdef></attr>
  </detailed></eainfo>
</metadata>"""

ISO_DEFAULT_NS = """<?xml version="1.0"?>
<MD_Metadata xmlns="http://www.isotc211.org/2005/gmd" xmlns:gco="http://www.isotc211.org/2005/gco">
  <identificationInfo><MD_DataIdentification>
    <citation><CI_Citation>
      <title><gco:CharacterString>National Shelter System Facilities</gco:CharacterString></title>
      <date><CI_Date><date><gco:Date>2017-12-12</gco:Date></date></CI_Date></date>
    </CI_Citation></citation>
    <abstract><gco:CharacterString>&lt;p&gt;Shelters operated &amp;amp; tracked by FEMA.&lt;/p&gt;</gco:CharacterString></abstract>
    <descriptiveKeywords><MD_Keywords>
      <keyword><gco:CharacterString>shelter</gco:CharacterString></keyword>
      <thesaurusName><CI_Citation><title><gco:CharacterString>NOT THE TITLE</gco:CharacterString></title></CI_Citation></thesaurusName>
    </MD_Keywords></descriptiveKeywords>
  </MD_DataIdentification></identificationInfo>
</MD_Metadata>"""

ISO_19110 = """<?xml version="1.0"?>
<gfc:FC_FeatureCatalogue xmlns:gfc="http://www.isotc211.org/2005/gfc" xmlns:gco="http://www.isotc211.org/2005/gco">
  <gfc:featureType><gfc:FC_FeatureType>
    <gfc:carrierOfCharacteristics><gfc:FC_FeatureAttribute>
      <gfc:memberName><gco:LocalName>GEOID</gco:LocalName></gfc:memberName>
      <gfc:definition><gco:CharacterString>Census tract identifier</gco:CharacterString></gfc:definition>
    </gfc:FC_FeatureAttribute></gfc:carrierOfCharacteristics>
  </gfc:FC_FeatureType></gfc:featureType>
</gfc:FC_FeatureCatalogue>"""

ARCGIS = """<?xml version="1.0"?>
<metadata>
  <dataIdInfo>
    <idCitation><resTitle>Hospitals</resTitle><date><pubDate>2023-04-01T00:00:00</pubDate></date></idCitation>
    <idAbs>&lt;DIV&gt;Hospitals in the US.&lt;/DIV&gt;</idAbs>
    <idCredit>HIFLD</idCredit>
    <searchKeys><keyword>health</keyword></searchKeys>
  </dataIdInfo>
  <eainfo><detailed><attr><attrlabl>BEDS</attrlabl><attrdef>Licensed beds</attrdef></attr></detailed></eainfo>
</metadata>"""


def write(folder: Path, name: str, text: str) -> Path:
    p = folder / name
    p.write_text(textwrap.dedent(text), encoding="utf-8")
    return p


class XmlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def test_fgdc(self):
        m = dm.parse_xml(write(self.tmp, "t.xml", FGDC))
        self.assertEqual(m["standard"], "FGDC CSDGM")
        self.assertEqual(m["name"], "TIGER/Line Shapefile, 2020, Census Tracts")
        self.assertEqual(m["originator"], "U.S. Census Bureau")
        self.assertEqual((m["start_year"], m["end_year"]), (2019, 2020))
        self.assertEqual(m["columns"]["ALAND"], {"desc": "Land area", "units": "square meters"})
        # "None" is placeholder text, not a licence.
        self.assertNotIn("license", m)

    def test_iso_default_namespace(self):
        m = dm.parse_xml(write(self.tmp, "s.xml", ISO_DEFAULT_NS))
        self.assertEqual(m["standard"], "ISO 19115")
        # The thesaurus citation has a title too; it must not win.
        self.assertEqual(m["name"], "National Shelter System Facilities")
        # Escaped HTML, double-escaped ampersand: tags stripped, text kept.
        self.assertEqual(m["description"], "Shelters operated & tracked by FEMA.")
        self.assertEqual(m["keywords"], ["shelter"])
        self.assertEqual(m["start_year"], 2017)

    def test_iso_19110_columns(self):
        m = dm.parse_xml(write(self.tmp, "ea.xml", ISO_19110))
        self.assertEqual(m["columns"]["GEOID"]["desc"], "Census tract identifier")

    def test_arcgis(self):
        m = dm.parse_xml(write(self.tmp, "h.xml", ARCGIS))
        self.assertEqual(m["standard"], "ArcGIS")
        self.assertEqual(m["name"], "Hospitals")
        self.assertEqual(m["description"], "Hospitals in the US.")
        self.assertEqual(m["originator"], "HIFLD")
        self.assertEqual(m["columns"]["BEDS"]["desc"], "Licensed beds")

    def test_not_metadata(self):
        self.assertEqual(dm.parse_xml(write(self.tmp, "x.xml", "<foo><bar/></foo>")), {})

    def test_real_hsip_file_if_present(self):
        p = Path(os.environ.get("GEODATA_ROOT", "/data")) / \
            "HSIP_without_tifs/National_Shelter_System_Facilities/National_Shelter_System_Facilities.xml"
        if not p.exists():
            self.skipTest("source archive not mounted")
        m = dm.parse_xml(p)
        self.assertEqual(m["standard"], "ISO 19115")
        self.assertTrue(m["name"])


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        for ext in ("shp", "dbf", "shx", "prj"):
            (self.tmp / f"tracts.{ext}").write_bytes(b"x")
        (self.tmp / "tracts.aux.xml").write_text("<PAMDataset/>")
        write(self.tmp, "tracts.shp.xml", FGDC)

    def test_shapefile_is_one_dataset_and_aux_is_ignored(self):
        parts = dm.find_parts(self.tmp)
        self.assertEqual([p.name for p in parts["data"]], ["tracts.shp"])
        self.assertEqual([p.name for p in parts["xml"]], ["tracts.shp.xml"])
        self.assertEqual(len(dm.files_for(parts["data"][0])), 4)

    def test_xml_only(self):
        m = dm.resolve(self.tmp)
        self.assertEqual(m["sources"]["name"], "xml")
        self.assertEqual(m["sources"]["years"], "xml")

    def test_sidecar_beats_xml_per_field(self):
        write(self.tmp, "tracts.meta.yaml", """
            name: Census Tracts 2020
            vintage: 2020
            columns:
              ALAND: {units: m2}
              NAMELSAD: Tract name
              GEOID: {skip: true}
            exclude: [INTPT*]
        """)
        m = dm.resolve(self.tmp, cli_name="ignored")
        self.assertEqual(m["name"], "Census Tracts 2020")
        self.assertEqual(m["sources"]["name"], "sidecar")
        # description was not in the sidecar, so the XML's survives
        self.assertEqual(m["sources"]["description"], "xml")
        self.assertEqual((m["start_year"], m["end_year"]), (2020, 2020))
        # sidecar added units without retyping the XML's description
        self.assertEqual(dm.column_meta(m, "ALAND")["desc"], "Land area")
        self.assertEqual(dm.column_meta(m, "ALAND")["units"], "m2")
        self.assertEqual(dm.column_meta(m, "namelsad")["desc"], "Tract name")
        self.assertFalse(dm.column_selected(m, "GEOID"))
        self.assertFalse(dm.column_selected(m, "intptlat"))
        self.assertTrue(dm.column_selected(m, "ALAND"))

    def test_include_is_an_allowlist(self):
        write(self.tmp, "tracts.meta.yaml", "name: T\ninclude: [RPL_*, EP_POV]\n")
        m = dm.resolve(self.tmp)
        self.assertTrue(dm.column_selected(m, "rpl_themes"))
        self.assertTrue(dm.column_selected(m, "EP_POV"))
        self.assertFalse(dm.column_selected(m, "EP_UNEMP"))

    def test_unknown_key_is_reported(self):
        write(self.tmp, "tracts.meta.yaml", "name: T\ndescripton: typo\n")
        m = dm.resolve(self.tmp)
        self.assertTrue(any("descripton" in w for w in m["warnings"]))

    def test_bad_kind_refused(self):
        write(self.tmp, "tracts.meta.yaml", "name: T\nkind: vector\n")
        with self.assertRaises(SystemExit):
            dm.resolve(self.tmp)

    def test_two_data_files_refused_unless_named(self):
        (self.tmp / "other.geojson").write_text("{}")
        with self.assertRaises(SystemExit):
            dm.resolve(self.tmp)
        write(self.tmp, "x.meta.yaml", "name: T\nfile: other.geojson\n")
        self.assertEqual(dm.resolve(self.tmp)["data_path"].name, "other.geojson")

    def test_kind_inference(self):
        self.assertEqual(dm.infer_kind({}, True, False), "features")
        self.assertEqual(dm.infer_kind({}, False, False), "table")
        self.assertEqual(dm.infer_kind({}, None, True), "raster")
        self.assertEqual(dm.infer_kind({"kind": "boundaries"}, True, False), "boundaries")


class LedgerTests(unittest.TestCase):
    def test_upsert_by_id(self):
        path = Path(tempfile.mkdtemp()) / "m.yaml"
        dm.record_load({"id": "a", "rows": 1}, path)
        dm.record_load({"id": "b", "rows": 2}, path)
        dm.record_load({"id": "a", "rows": 3}, path)
        doc = dm.read_ledger(path)
        self.assertEqual([(d["id"], d["rows"]) for d in doc["datasets"]], [("b", 2), ("a", 3)])


class CatalogWriteTests(unittest.TestCase):
    """The catalog half of ingest.py. Needs GDAL to import, so container-only."""

    def setUp(self):
        try:
            import ingest  # noqa: F401
        except SystemExit:
            self.skipTest("GDAL not available")
        import ingest
        self.ingest = ingest
        self.tmp = Path(tempfile.mkdtemp())
        ingest.BACKUP_DIR = self.tmp / "_backups"
        self.cat = self.tmp / "cat.csv"
        self.cat.write_bytes(b'dataset_id,attr_label,attr_desc,gen_desc\r\n'
                             b'X,X_01,"multi\r\nline",\r\n'
                             b'ing_t_01,ing_t_01_01,old,\r\n')

    def test_columns_follow_header_and_endings_are_kept(self):
        self.ingest.write_rows(self.cat, [{"dataset_id": "ing_u_01", "attr_label": "ing_u_01_01",
                                           "attr_desc": "a", "gen_desc": "g", "extra": "dropped"}])
        raw = self.cat.read_bytes()
        self.assertTrue(raw.endswith(b"ing_u_01,ing_u_01_01,a,g\r\n"))
        self.assertNotIn(b"dropped", raw)

    def test_replace_removes_only_that_dataset(self):
        self.ingest.write_rows(self.cat, [{"dataset_id": "ing_t_01", "attr_label": "ing_t_01_01",
                                           "attr_desc": "new", "gen_desc": ""}],
                               replace_prefix="ing_t_01,")
        raw = self.cat.read_bytes()
        self.assertNotIn(b",old,", raw)
        self.assertIn(b'"multi\r\nline"', raw)
        self.assertEqual(raw.count(b"ing_t_01_01"), 1)

    def test_one_line(self):
        self.assertEqual(self.ingest.one_line(" a\r\n b\t c "), "a b c")

    def test_describe_appends_units_once(self):
        meta = {"columns": {"EAL": {"desc": "Expected annual loss", "units": "USD",
                                    "_from": "sidecar"},
                            "POP": {"desc": "Population (persons)", "units": "persons"}}}
        self.assertEqual(self.ingest.describe(meta, "eal"),
                         ("Expected annual loss (USD)", "sidecar"))
        self.assertEqual(self.ingest.describe(meta, "POP")[0], "Population (persons)")
        self.assertEqual(self.ingest.describe(meta, "street_addr"),
                         ("Street Addr", "column name"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
