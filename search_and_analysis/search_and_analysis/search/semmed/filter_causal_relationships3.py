import pandas as pd
from pathlib import Path
import json
import logging
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BASE_DIR / "results"
QUERY_FILE = RESULTS_DIR / "queries.json"
GOOD_PREDICATES = {
    "ASSOCIATED_WITH",
    "PREDISPOSES",
    "CAUSES",
    "AFFECTS",
    "INCREASES",
    "DECREASES",
    "STIMULATES",
    "DISRUPTS",
} # More causal (environmental) relationships

def load_queries():
    try:
        with open(QUERY_FILE, "r", encoding="utf-8") as file:
            return json.load(file)
    except Exception as e:
        raise RuntimeError(f"Error reading query.json: {e}. Ensure 1find_CUI.py is ran before running code.") from e

def filter_relevant_relationships(cui):
    semmed_query_file = RESULTS_DIR / cui / "query_semmed.parquet"
    semmed_query_results = pd.read_parquet(semmed_query_file)
    
    return semmed_query_results[semmed_query_results["PREDICATE"].isin(GOOD_PREDICATES)].copy()

def save_results(relevant, cui):
    cui_dir = RESULTS_DIR / cui
    cui_dir.mkdir(parents=True, exist_ok=True)
    causal_relationships_parquet = cui_dir / "causal_relationships.parquet"
    relevant.to_parquet(causal_relationships_parquet, index=False)
    logger.debug("Saved only causal relationship type CUI matches in SemMed to %s", causal_relationships_parquet)

def filter_relevant_pipeline():
    queries = load_queries()
    for query in queries: 
        try:   
            cui = query["concept"]["cui"]   # Get CUI
        except KeyError:
            raise RuntimeError(f"{QUERY_FILE} doesn't contain 'cui' field.")
        relevant = filter_relevant_relationships(cui)
        save_results(relevant, cui)

if __name__ == "__main__":
     filter_relevant_pipeline()