import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import SEARCH_LIMIT, SEARCH_URL, HTTP_TIMEOUT_LIMIT, MAX_WEB_CONTEXT, LLM_MODEL, LLM_INSTRUCTIONS_ONLINE, LLM_KEYWORD_SCHEMA
from searxng.online_search1 import online_search
from searxng.llm2 import llm_extract

import time
import logging
logger = logging.getLogger(__name__)

def online_rag_pipeline(query: str, limit: int, search_url: str, http_timeout_limit: int, max_web_context: int, llm_model: str, llm_instructions, llm_keyword_schema) -> tuple[dict | None, list[str]]:
    start = time.perf_counter()
    
    if not query:
        return None, []
    text, sources = online_search(query + " environmental factors", limit, search_url, http_timeout_limit, max_web_context)
    response = llm_extract(query, text, llm_model, llm_instructions, llm_keyword_schema)
    
    elapsed = time.perf_counter() - start
    logger.info(f"Online RAG pipeline TOTAL EXECUTION TIME: {elapsed:.2f} seconds.")
    return response, sources


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S")
    query = "Heart disease California 2010"

    print("\n\nGeoARK uses AI and can mistakes.\n\n")

    response, sources = online_rag_pipeline(query, SEARCH_LIMIT, SEARCH_URL, HTTP_TIMEOUT_LIMIT, MAX_WEB_CONTEXT, LLM_MODEL, LLM_INSTRUCTIONS_ONLINE, LLM_KEYWORD_SCHEMA)
    
    if response:
        print("Keywords:", response["keywords"])
    else:
        print("No keywords found.")
    print("\nSources:", sources)
