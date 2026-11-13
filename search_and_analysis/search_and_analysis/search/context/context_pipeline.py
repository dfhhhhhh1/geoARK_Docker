import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import CONTEXT_FILEPATH, CONTEXT_LIMIT, LLM_MODEL, LLM_INSTRUCTIONS_CONTEXT, LLM_KEYWORD_SCHEMA, TOTAL_TOKENS, KEYWORDS_TOKENS
from context.extract_text1 import file_to_text
from context.llm2 import llm_extract

import time
import logging
logger = logging.getLogger(__name__)

def context_pipeline(query: str, context_filepath: str, context_limit: int, llm_model: str, llm_instructions: str, llm_keyword_schema, total_tokens: int, keywords_tokens: int):
    start = time.perf_counter()

    logger.info(" 1. Extracting text from context file '%s'...", context_filepath)
    text = file_to_text(context_filepath, context_limit)
    logger.info("CONTEXT:\n'%s'", text)
    logger.info(" 2. LLM extract enviornmental factor keywords from context file '%s'...", context_filepath)
    response = llm_extract(query, text, llm_model, llm_instructions, llm_keyword_schema, total_tokens, keywords_tokens)
    
    elapsed = time.perf_counter() - start
    logger.info(f"Context RAG pipeline TOTAL EXECUTION TIME: {elapsed:.2f} seconds.")
    return response

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S")

    query = "Heart disease in California in 2010"
    response = context_pipeline(query, CONTEXT_FILEPATH, CONTEXT_LIMIT, LLM_MODEL, LLM_INSTRUCTIONS_CONTEXT, LLM_KEYWORD_SCHEMA, TOTAL_TOKENS, KEYWORDS_TOKENS)
    if response:
            print("\n\nKEYWORDS:", response["keywords"])
    else:
        print("\n\nNo keywords found.")
