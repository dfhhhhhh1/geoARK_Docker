import pandas as pd
import json
from pathlib import Path
import logging
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
SEMMED_FILE = BASE_DIR / "semmedVER43_2024_R_PREDICATION.csv.gz"
RESULTS_DIR = BASE_DIR / "results"
QUERY_FILE = RESULTS_DIR / "queries.json"
COLUMNS = [
    "PREDICATION_ID",
    "SENTENCE_ID",
    "PMID",
    "PREDICATE",
    "SUBJECT_CUI",
    "SUBJECT_NAME",
    "SUBJECT_SEMTYPE",
    "SUBJECT_NOVELTY",
    "OBJECT_CUI",
    "OBJECT_NAME",
    "OBJECT_SEMTYPE",
    "OBJECT_NOVELTY",
    "EXTRA1",
    "EXTRA2",
    "EXTRA3",
]

def load_queries():
    try:
        with open(QUERY_FILE, "r", encoding="utf-8") as file:
            return json.load(file)
    except Exception as e:
        raise RuntimeError(f"Error reading query.json: {e}. Ensure 1find_CUI.py is ran before running code.") from e


def search_semmed(cui, chunksize=500_000):
    results = []
    for chunk in pd.read_csv(
        SEMMED_FILE,
        compression="gzip",
        header=None,
        names=COLUMNS,
        chunksize=chunksize,
        dtype=str,
        encoding="latin1"
    ):

        matches = chunk[(chunk["SUBJECT_CUI"] == cui) | (chunk["OBJECT_CUI"] == cui)]
        if not matches.empty:
            results.append(matches)
            logger.info("Found %d matches in this chunk", len(matches))
    if results:
        return pd.concat(results, ignore_index=True)
    return pd.DataFrame(columns=COLUMNS)

def save_results(related, cui):
    cui_dir = RESULTS_DIR / cui
    cui_dir.mkdir(parents=True, exist_ok=True)
    query_semmed_parquet = cui_dir / "query_semmed.parquet"
    related.to_parquet(query_semmed_parquet, index=False)
    logger.debug("Saved all CUI matches in SemMed to %s", query_semmed_parquet)

def query_semmed_pipeline():
    queries = load_queries()
    for query in queries: 
        try:   
            cui = query["concept"]["cui"]   # Get CUI
        except KeyError:
            raise RuntimeError(f"{QUERY_FILE} doesn't contain 'cui' field.")
        related = search_semmed(cui)
        save_results(related, cui)

if __name__ == "__main__":
     query_semmed_pipeline()