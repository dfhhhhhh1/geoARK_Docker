"""
Build the literature-expansion index from SemMedDB.

WHY THIS EXISTS
---------------
Tags and embeddings only find attributes that are described with words close to
the question. "heart disease in Kentucky" will find heart-disease columns, and
will never find the smoking, obesity and physical-inactivity measures that the
biomedical literature says drive it -- even though those ARE loaded, and are
often what the person needs next.

SemMedDB (NLM) holds ~130M subject-PREDICATE-object triples extracted from
PubMed. The prototype in searchImprovement/ scanned the whole 3.3 GB gzip per
query (minutes) and then called PubMed over the network. Neither works on the
query path, so this script does the expensive part ONCE:

    semmedVER43_2024_R_PREDICATION.csv.gz
        -> keep causal predicates, specific (novelty=1) concepts, health types
        -> semmed_stage          (UNLOGGED, dropped at the end)
        -> semmed_relation       one row per (subject, predicate, object),
                                 n_pmids = distinct supporting papers
        -> semmed_concept        seeds: concepts a question can link to
        -> semmed_alias          normalized surface form -> seed CUI

At query time backend/expansion.js does two indexed lookups (milliseconds).
Measured: the scan keeps 1,894,930 of 130,480,195 predications, in 109s.

THE UMLS LINKER IS NOT NEEDED AT RUNTIME
-----------------------------------------
The prototype used scispaCy's UMLS linker to map "heart cancer" to C0153500.
That loads several GB and would compete with the resident LLM for RAM. What the
linker contributes is the ALIAS list, and that is a data file: pass
--umls-kb umls_2022_ab_cat0129.jsonl (scispaCy's KB, one JSON concept per line)
and every alias of every seed concept is loaded into semmed_alias. Without it,
only SemMedDB's preferred names are aliases ("Malignant neoplasm of heart"), so
colloquial phrasings link less often.

The KB file is scispaCy's own download (a one-time data fetch, not inference):
    https://ai2-s2-scispacy.s3-us-west-2.amazonaws.com/data/kbs/2023-04-23/umls_2022_ab_cat0129.jsonl

WHAT IS FILTERED, AND WHY
-------------------------
- Predicates: the causal set the prototype used (CAUSES, PREDISPOSES, ...).
  ISA, PROCESS_OF, LOCATION_OF etc. relate a concept to its taxonomy or anatomy,
  which never corresponds to a county-level measure.
- Novelty: SemMedDB flags generic concepts ("Disease", "Patients", "Human") with
  novelty 0. They are hubs connected to everything, and would be the top
  "related concept" for every seed.
- Semantic types: a seed must be a condition (disease, neoplasm, injury, a
  health behavior ...), so "poverty rate" or "median income" never triggers
  expansion. A neighbor may additionally be a finding, social behavior, food or
  activity. Genes, proteins, drugs and anatomy are dropped: no county data will
  ever be about them.

Usage:
    python etl/build_semmed_index.py --semmed PATH.csv.gz                  # dry run
    python etl/build_semmed_index.py --semmed PATH.csv.gz --commit
    python etl/build_semmed_index.py --semmed ... --umls-kb KB.jsonl --commit
    python etl/build_semmed_index.py --aliases-only --umls-kb KB.jsonl --commit
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import re
import sys
import time
from pathlib import Path

CAUSAL = {
    "CAUSES", "PREDISPOSES", "ASSOCIATED_WITH", "AFFECTS",
    "INCREASES", "DECREASES", "STIMULATES", "DISRUPTS",
}

# SemMedDB semantic-type abbreviations.
SEED_TYPES = {
    "dsyn",  # Disease or Syndrome
    "neop",  # Neoplastic Process
    "mobd",  # Mental or Behavioral Dysfunction
    "patf",  # Pathologic Function
    "sosy",  # Sign or Symptom
    "inpo",  # Injury or Poisoning
    "acab",  # Acquired Abnormality
    "cgab",  # Congenital Abnormality
    "anab",  # Anatomical Abnormality
    "inbe",  # Individual Behavior          (smoking, alcohol use)
    "eehu",  # Environmental Effect of Humans (air pollution)
    "hops",  # Hazardous or Poisonous Substance
}
NEIGHBOR_TYPES = SEED_TYPES | {
    "fndg",  # Finding
    "socb",  # Social Behavior
    "food",  # Food
    "dora",  # Daily or Recreational Activity (exercise)
    "ocac",  # Occupational Activity
    "orga",  # Organism Attribute (body weight)
    "clna",  # Clinical Attribute (blood pressure)
    "npop",  # Natural Phenomenon or Process
}

# The quick pre-filter: most lines are rejected on the predicate alone, before
# paying for a CSV parse.
PRED_RE = re.compile(r'","(' + "|".join(sorted(CAUSAL)) + r')","')

# Aliases that are real UMLS surface forms and ordinary English words. Linking
# them would fire expansion on questions that are not about health at all.
ALIAS_STOP = {
    "rate", "rates", "cold", "lead", "fall", "falls", "rest", "shock", "stress",
    "burn", "burns", "cancer", "tumor", "tumour", "disease", "diseases",
    "disorder", "disorders", "syndrome", "injury", "injuries", "pain", "death",
    "deaths", "poverty", "income", "population", "density", "change", "growth",
    "crime", "housing", "education", "employment", "unemployment", "age",
    "aging", "sex", "race", "drought", "flood", "floods", "heat", "fire",
    "smoke", "water", "drinking", "use", "abuse",
}


def norm(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def keep_alias(a: str) -> bool:
    if len(a) < 4 or a.isdigit() or a in ALIAS_STOP:
        return False
    # UMLS carries long "... NOS" / "[D]" bookkeeping variants; a question will
    # never contain a 9-word alias.
    return len(a.split()) <= 6


DDL = """
CREATE UNLOGGED TABLE IF NOT EXISTS semmed_stage (
    pmid      TEXT,
    predicate TEXT,
    subj_cui  TEXT, subj_name TEXT, subj_type TEXT,
    obj_cui   TEXT, obj_name  TEXT, obj_type  TEXT
);
CREATE TABLE IF NOT EXISTS semmed_relation (
    subj_cui  TEXT NOT NULL,
    subj_name TEXT NOT NULL,
    subj_type TEXT NOT NULL,
    predicate TEXT NOT NULL,
    obj_cui   TEXT NOT NULL,
    obj_name  TEXT NOT NULL,
    obj_type  TEXT NOT NULL,
    n_pmids   INTEGER NOT NULL,
    PRIMARY KEY (subj_cui, predicate, obj_cui)
);
CREATE TABLE IF NOT EXISTS semmed_concept (
    cui     TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    semtype TEXT NOT NULL,
    n_rel   INTEGER NOT NULL      -- distinct partners; picks the sense of an ambiguous alias
);
CREATE TABLE IF NOT EXISTS semmed_alias (
    alias_norm TEXT NOT NULL,
    cui        TEXT NOT NULL REFERENCES semmed_concept(cui) ON DELETE CASCADE,
    source     TEXT NOT NULL,     -- 'semmed' preferred name, or 'umls' alias
    PRIMARY KEY (alias_norm, cui)
);
CREATE TABLE IF NOT EXISTS semmed_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def scan(path: Path, seed_types: set[str], neighbor_types: set[str]):
    """Yield filtered (pmid, predicate, s_cui, s_name, s_type, o_cui, o_name, o_type)."""
    with gzip.open(path, "rt", encoding="utf-8", errors="replace", newline="") as f:
        for line in f:
            if not PRED_RE.search(line):
                continue
            try:
                r = next(csv.reader([line]))
            except (csv.Error, StopIteration):
                continue
            if len(r) < 12:
                continue
            pmid, pred = r[2], r[3]
            s_cui, s_name, s_type, s_nov = r[4], r[5], r[6], r[7]
            o_cui, o_name, o_type, o_nov = r[8], r[9], r[10], r[11]
            if pred not in CAUSAL or s_nov != "1" or o_nov != "1":
                continue
            if s_cui == o_cui or not s_cui.startswith("C") or not o_cui.startswith("C"):
                continue
            if "|" in s_cui or "|" in o_cui:      # gene entries: "C123|4567"
                continue
            if s_type not in neighbor_types or o_type not in neighbor_types:
                continue
            if s_type not in seed_types and o_type not in seed_types:
                continue
            yield (pmid, pred, s_cui, s_name, s_type, o_cui, o_name, o_type)


def copy_rows(cur, rows: list[tuple]):
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    buf.seek(0)
    cur.copy_expert(
        "COPY semmed_stage (pmid, predicate, subj_cui, subj_name, subj_type, "
        "obj_cui, obj_name, obj_type) FROM STDIN WITH (FORMAT csv)", buf)


def load_relations(conn, args, seed_types, neighbor_types):
    cur = conn.cursor()
    cur.execute("TRUNCATE semmed_stage")
    t0 = time.time()
    batch, kept = [], 0
    for row in scan(args.semmed, seed_types, neighbor_types):
        batch.append(row)
        if len(batch) >= 200_000:
            copy_rows(cur, batch)
            kept += len(batch)
            batch.clear()
            print(f"  staged {kept:,} rows ({time.time() - t0:.0f}s)", flush=True)
    if batch:
        copy_rows(cur, batch)
        kept += len(batch)
    print(f"  staged {kept:,} predications in {time.time() - t0:.0f}s")

    print("  aggregating to one row per (subject, predicate, object) ...")
    cur.execute("TRUNCATE semmed_relation CASCADE")
    cur.execute("""
        INSERT INTO semmed_relation
        SELECT subj_cui, min(subj_name), min(subj_type), predicate,
               obj_cui, min(obj_name), min(obj_type), count(DISTINCT pmid)
        FROM semmed_stage
        GROUP BY subj_cui, predicate, obj_cui
        HAVING count(DISTINCT pmid) >= %s
    """, (args.min_support,))
    print(f"  {cur.rowcount:,} relations with >= {args.min_support} supporting papers")
    cur.execute("DROP TABLE semmed_stage")

    cur.execute("CREATE INDEX IF NOT EXISTS semmed_relation_obj ON semmed_relation (obj_cui)")

    # Seeds: every concept on either side whose type makes it linkable.
    cur.execute("TRUNCATE semmed_concept CASCADE")
    cur.execute("""
        INSERT INTO semmed_concept (cui, name, semtype, n_rel)
        SELECT cui, min(name), min(type), count(DISTINCT partner)
        FROM (
            SELECT subj_cui cui, subj_name name, subj_type type, obj_cui partner FROM semmed_relation
            UNION ALL
            SELECT obj_cui, obj_name, obj_type, subj_cui FROM semmed_relation
        ) x
        WHERE type = ANY(%s)
        GROUP BY cui
    """, (sorted(seed_types),))
    print(f"  {cur.rowcount:,} seed concepts")

    cur.execute("""
        INSERT INTO semmed_meta VALUES
            ('source', %s), ('min_support', %s), ('built_at', now()::text)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    """, (args.semmed.name, str(args.min_support)))


def load_aliases(conn, args):
    cur = conn.cursor()
    cur.execute("TRUNCATE semmed_alias")
    cur.execute("SELECT cui, name FROM semmed_concept")
    seeds = dict(cur.fetchall())
    if not seeds:
        raise SystemExit("semmed_concept is empty; build relations first")

    pairs: set[tuple[str, str, str]] = set()
    for cui, name in seeds.items():
        a = norm(name)
        if keep_alias(a):
            pairs.add((a, cui, "semmed"))
    n_semmed = len(pairs)

    if args.umls_kb:
        with open(args.umls_kb, encoding="utf-8") as f:
            for line in f:
                c = json.loads(line)
                cui = c.get("concept_id")
                if cui not in seeds:
                    continue
                for alias in [c.get("canonical_name", "")] + (c.get("aliases") or []):
                    a = norm(alias)
                    if keep_alias(a):
                        pairs.add((a, cui, "umls"))
    print(f"  aliases: {n_semmed:,} from SemMedDB names, "
          f"{len(pairs) - n_semmed:,} more from {args.umls_kb or 'no UMLS KB'}")

    # One row per (alias, cui): the SemMedDB name wins over the identical UMLS
    # alias, so `source` says where a link could have come from without UMLS.
    best: dict[tuple[str, str], str] = {}
    for a, cui, src in pairs:
        if best.get((a, cui)) != "semmed":
            best[(a, cui)] = src
    rows = sorted((a, cui, src) for (a, cui), src in best.items())
    for i in range(0, len(rows), 50_000):
        buf = io.StringIO()
        csv.writer(buf).writerows(rows[i:i + 50_000])
        buf.seek(0)
        cur.copy_expert("COPY semmed_alias (alias_norm, cui, source) FROM STDIN "
                        "WITH (FORMAT csv)", buf)
    cur.execute("SELECT count(*) FROM semmed_alias")
    print(f"  {cur.fetchone()[0]:,} alias rows")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--semmed", type=Path, help="semmedVER43_*_PREDICATION.csv.gz")
    ap.add_argument("--umls-kb", type=Path, help="scispaCy UMLS KB .jsonl (optional)")
    ap.add_argument("--min-support", type=int, default=3,
                    help="distinct PubMed papers a relation needs (default 3)")
    ap.add_argument("--aliases-only", action="store_true",
                    help="rebuild semmed_alias from the existing semmed_concept")
    ap.add_argument("--dsn", help="libpq DSN; default uses PG* environment variables")
    ap.add_argument("--commit", action="store_true", help="write; default is a dry run")
    args = ap.parse_args()

    if not args.aliases_only and not args.semmed:
        ap.error("--semmed is required unless --aliases-only")

    if not args.commit:
        if args.aliases_only:
            print("dry run: --aliases-only needs the database; nothing to report")
            return 0
        print(f"dry run: scanning {args.semmed} (nothing is written)")
        t0, n, preds, types = time.time(), 0, {}, {}
        for row in scan(args.semmed, SEED_TYPES, NEIGHBOR_TYPES):
            n += 1
            preds[row[1]] = preds.get(row[1], 0) + 1
            for t in (row[4], row[7]):
                types[t] = types.get(t, 0) + 1
            if n % 1_000_000 == 0:
                print(f"  {n:,} kept ({time.time() - t0:.0f}s)", flush=True)
        print(f"{n:,} predications would be staged ({time.time() - t0:.0f}s)")
        print("by predicate:", json.dumps(dict(sorted(preds.items(), key=lambda x: -x[1]))))
        print("by semtype:  ", json.dumps(dict(sorted(types.items(), key=lambda x: -x[1]))))
        return 0

    import psycopg2                                             # noqa: PLC0415
    conn = psycopg2.connect(args.dsn) if args.dsn else psycopg2.connect()
    with conn:
        conn.cursor().execute(DDL)
        if not args.aliases_only:
            load_relations(conn, args, SEED_TYPES, NEIGHBOR_TYPES)
        load_aliases(conn, args)
    with conn, conn.cursor() as cur:
        cur.execute("ANALYZE semmed_relation; ANALYZE semmed_concept; ANALYZE semmed_alias")
    print("done. Restart the API (or it re-checks within a minute) to enable expansion.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
