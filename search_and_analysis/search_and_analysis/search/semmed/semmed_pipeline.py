import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import NUM_QUERIES, NUM_CONCEPTS, NUM_PAPERS, LLM_MODEL, LLM_INSTRUCTIONS_SEMMED, LLM_KEYWORD_SCHEMA 

from semmed.extract_search_info0 import ExtractorPipeline
from semmed.find_CUI1 import write_queries_pipeline
from semmed.query_semmed2 import query_semmed_pipeline
from semmed.filter_causal_relationships3 import filter_relevant_pipeline
from semmed.filter_from_abstract4 import filter_abstracts_pipeline
from semmed.extract_keywords5 import llm_keywords_pipeline

import time
from pprint import pformat
import logging
logger = logging.getLogger(__name__)

# Extract date, location, subject keywords
def semmed_pipeline(query: str, num_queries: int, num_concepts: int, num_papers: int, llm_model: str, llm_instructions: str, llm_keyword_schema: str):
    start = time.perf_counter()
    
    search_info_extractor = ExtractorPipeline()
    logger.info("1. Extracting from natural language query...")
    search_info = search_info_extractor.extract_search_info(query)
    logger.info("Extracted search information: %s", search_info)
    logger.debug("Full search information:\n%s", pformat(search_info))

    logger.info("2. Finding extracted subject's CUI in semmed...")
    queries = write_queries_pipeline(search_info, num_queries, num_concepts)
    logger.info("Generated %d queries", len(queries))
    logger.debug("Generated queries:\n%s", pformat(queries))

    logger.info("3. Using CUI(s) to query into semmed...")
    query_semmed_pipeline()

    logger.info("4. Filtering down semmed results to those that have causal type relationships with subject's CUI...")
    filter_relevant_pipeline()

    logger.info("5. Finding pubmed papers relevant to original query's subject, location, or year...")
    papers, matches = filter_abstracts_pipeline()
    matches_count = len(matches)
    logger.info("Paper filtering complete: %d retrieved, %d matched", len(papers), matches_count)    
    logger.debug("Matching papers:\n%s", pformat(matches.to_dict(orient="records")))
        
    logger.info("6. LLM extract enviornmental factor keywords from %d PubMed papers", num_papers)
    response, used_papers = llm_keywords_pipeline(query, llm_model, llm_instructions, llm_keyword_schema, num_papers)
    
    elapsed = time.perf_counter() - start
    logger.info(f"Semmed pipeline TOTAL EXECUTION TIME: {elapsed:.2f} seconds.")
    return response, used_papers

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S")    
    query = "Heart disease in California in 2010"
    response, used_papers = semmed_pipeline(query, NUM_QUERIES, NUM_CONCEPTS, NUM_PAPERS, LLM_MODEL, LLM_INSTRUCTIONS_SEMMED, LLM_KEYWORD_SCHEMA)
    print(used_papers)
    if response:
        print("Keywords:", response["keywords"])
    else:
        print("No keywords found.")