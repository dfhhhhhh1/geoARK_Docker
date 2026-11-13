import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import NUM_QUERIES, NUM_CONCEPTS
from semmed.umls_setup import linker
from semmed.extract_search_info0 import ExtractorPipeline

from pprint import pprint
from pathlib import Path
import json
import logging
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BASE_DIR / "results"
QUERY_FILE = RESULTS_DIR / "queries.json"


def link_biomed_entities(entities, num_concepts: int=NUM_CONCEPTS):
    biomedical_entities = []
    for entity in entities:
        # candidate concepts considered per entity
        candidates = entity._.kb_ents[:num_concepts]
        if candidates:
            cui, score = candidates[0]
            concept = linker.kb.cui_to_entity[cui]
            biomedical_entities.append({
                "text": entity.text,
                "cui": cui,
                "score": score,
                "canonical_name": concept.canonical_name,
                "types": concept.types
            })
    return biomedical_entities

def create_queries(search_info, num_concepts: int, num_queries: int=NUM_QUERIES):
    natural_language_query = search_info["natural_language_query"]
    locations = search_info["locations"]
    dates = search_info["dates"]
    entities = search_info["entities"]
    keywords = search_info["keywords"]
    biomedical_entities = link_biomed_entities(entities, num_concepts)
    queries = []
    for entity in biomedical_entities[:num_queries]:
        query = {"query": natural_language_query,
                "location": locations,
                "year": dates,
                "concept": {
                    "text": entity["text"],
                    "cui": entity["cui"],
                    "canonical_name": entity["canonical_name"],
                    "semantic_types": entity["types"],
                    "linking_score": entity["score"]
                }
        }
        queries.append(query)

    return queries

def write_queries_pipeline(search_info, num_queries: int, num_concepts: int):
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    queries = create_queries(search_info, num_queries, num_concepts)
    with open(QUERY_FILE, "w", encoding="utf-8") as file:
        json.dump(queries, file, indent=4, ensure_ascii=False)
    logger.info("Saving queries to %s", QUERY_FILE)
    return queries
    
if __name__ == "__main__": # test only this file's components out!
    natural_language_query = "Heart disease in California in 2010"
    search_info_extractor = ExtractorPipeline()
    search_info = search_info_extractor.extract_search_info(natural_language_query)
    queries = write_queries_pipeline(search_info, NUM_CONCEPTS, NUM_QUERIES)
    print("Queries:")
    pprint(queries)