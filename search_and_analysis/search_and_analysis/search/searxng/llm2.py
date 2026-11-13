import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import LLM_MODEL, LLM_INSTRUCTIONS_ONLINE, LLM_KEYWORD_SCHEMA    
from parallel_llm import safe_chat

import json
from datetime import datetime
import logging
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BASE_DIR / "results"

def extract_keywords(query: str, context: str, model_name: str=LLM_MODEL, instructions: str=LLM_INSTRUCTIONS_ONLINE, output_schema: dict=LLM_KEYWORD_SCHEMA) -> dict | None:
    if not query or not context:
        return None
    prompt = f"RESEARCH QUESTION: {query}\nWEB RESULTS:{context}"
    try: 
        completion = safe_chat(model=model_name, messages=[
            {"role": "system", "content": instructions},
            {"role": "user", "content": prompt}
            ],
            format=output_schema,
            keep_alive="30m",
            think=False
        )
        logger.info("Prompt processing: %.2f seconds", completion.prompt_eval_duration / 1e9)
        logger.info("Generation: %.2f seconds", completion.eval_duration / 1e9)
        response = json.loads(completion.message.content)
        return response
    
    except (json.JSONDecodeError, ValueError) as exc:
        logger.exception("Failed to parse model output: %s", exc)
        return None

def save_results(response):
    RESULTS_DIR.mkdir(parents=True, exist_ok=True) 
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    llm_responses_file = RESULTS_DIR / f"llm_responses_{timestamp}.json"
    
    with open(llm_responses_file, "w", encoding="utf-8") as file:
        json.dump(response, file, indent=4, ensure_ascii=False)
    logger.debug("Saved prompt response to %s", llm_responses_file)

def llm_extract(query: str, text: str, model_name: str, instructions: str, output_schema: dict):
    response = extract_keywords(query, text, model_name, instructions, output_schema)
    save_results(response)
    return response