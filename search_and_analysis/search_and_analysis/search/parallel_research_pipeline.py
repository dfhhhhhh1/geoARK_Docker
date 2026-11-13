from concurrent.futures import ThreadPoolExecutor, as_completed

from config import (NUM_QUERIES, NUM_CONCEPTS, NUM_PAPERS, LLM_INSTRUCTIONS_SEMMED,
SEARCH_LIMIT, SEARCH_URL, HTTP_TIMEOUT_LIMIT, MAX_WEB_CONTEXT, LLM_INSTRUCTIONS_ONLINE,
CONTEXT_FILEPATH, CONTEXT_LIMIT, TOTAL_TOKENS, KEYWORDS_TOKENS, LLM_INSTRUCTIONS_CONTEXT,
LLM_MODEL, LLM_KEYWORD_SCHEMA, PIPELINES)
from merge_results import merge_results
from semmed.semmed_pipeline import semmed_pipeline
from searxng.online_rag_pipeline import online_rag_pipeline
from context.context_pipeline import context_pipeline

import logging
logger = logging.getLogger(__name__)

def run_research_pipeline(query: str, num_queries: int, num_concepts: int, num_papers: int, llm_instructions_semmed: str, 
                          search_limit: int, search_url: str, http_timeout_limit: int, max_web_context: int, llm_insructions_online: str,
                          context_filepath: str, context_limit: int, total_tokens: int, keywords_tokens: int, llm_insructions_context: str,
                          llm_model: str, llm_keyword_schema, pipelines) -> dict:
    """Run SemMed and online search concurrently."""

    results = {"semmed": None, "online_rag": None, "context": None, "errors": {}}
    tasks = {
        "semmed": lambda: semmed_pipeline(query=query, num_queries=num_queries, num_concepts=num_concepts, num_papers=num_papers, llm_model=llm_model, llm_instructions=llm_instructions_semmed, llm_keyword_schema=llm_keyword_schema),
        "online_rag": lambda: online_rag_pipeline(query=query, limit=search_limit, search_url=search_url, http_timeout_limit=http_timeout_limit, max_web_context=max_web_context, llm_model=llm_model, llm_instructions=llm_insructions_online, llm_keyword_schema=llm_keyword_schema),
        "context": lambda: context_pipeline(query=query, context_filepath=context_filepath, context_limit=context_limit, llm_model=llm_model, llm_instructions=llm_insructions_context, llm_keyword_schema=llm_keyword_schema, total_tokens=total_tokens, keywords_tokens=keywords_tokens),
    }

    with ThreadPoolExecutor(max_workers=len(tasks)) as executor:
        future_to_name = {executor.submit(task): name for name, task in tasks.items()}

        for future in as_completed(future_to_name):
            name = future_to_name[future]

            try:
                results[name] = future.result()
                logger.info("%s pipeline completed", name)

            except Exception as exc:
                logger.exception("%s pipeline failed", name)
                results["errors"][name] = {
                    "type": type(exc).__name__,
                    "message": str(exc),
                }
    merge_results(pipelines)
    return results

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S")
 
    query = "Heart disease in California in 2010"
    results = run_research_pipeline(query, NUM_QUERIES, NUM_CONCEPTS, NUM_PAPERS, LLM_INSTRUCTIONS_SEMMED,
                                    SEARCH_LIMIT, SEARCH_URL, HTTP_TIMEOUT_LIMIT, MAX_WEB_CONTEXT, LLM_INSTRUCTIONS_ONLINE,
                                    CONTEXT_FILEPATH, CONTEXT_LIMIT, TOTAL_TOKENS, KEYWORDS_TOKENS, LLM_INSTRUCTIONS_CONTEXT,
                                    LLM_MODEL, LLM_KEYWORD_SCHEMA)

    semmed_result = results["semmed"]
    if semmed_result is not None:
        papers, semmed_response = semmed_result
        print("\nSemMed papers:")
        print(papers)
        print("\nSemMed keywords:", semmed_response)

    online_result = results["online_rag"]
    if online_result is not None:
        online_response, sources = online_result
        print("\nOnline RAG keywords:", online_response)
        print("Sources:", sources)

    context_result = results["context"]
    if context_result is not None:
        context = context_result
        print("\nContext keywords:", context)

    if results["errors"]:
        print("\nPipeline errors:", results["errors"])