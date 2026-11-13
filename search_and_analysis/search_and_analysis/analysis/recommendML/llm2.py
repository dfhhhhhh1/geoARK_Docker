import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import RECOMMENDML_DATA_FILEPATH, RECOMMENDML_CONTEXT_FILEPATH, LLM_MODEL, LLM_INSTRUCTIONS_RECOMMEND_LABEL, LLM_INSTRUCTIONS_RECOMMENDML, LLM_METHODOLOGY_SCHEMA, RECOMMENDML_TOTAL_TOKENS, RECOMMENDML_KEYWORDS_TOKENS

from ollama import chat
import json
from datetime import datetime
import pandas as pd
import logging
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BASE_DIR / "results"

def extract_workflow(query: str, context: str, model_name: str=LLM_MODEL, instructions: str=LLM_INSTRUCTIONS_RECOMMENDML, output_schema: dict=LLM_METHODOLOGY_SCHEMA, total_tokens: int=RECOMMENDML_TOTAL_TOKENS, keywords_tokens: int=RECOMMENDML_KEYWORDS_TOKENS) -> dict | None:
    if not query or not context:
        return None
    prompt = f"RESEARCH QUESTION: {query}\nCONTEXT:{context}"
    try:
        completion = chat(model=model_name, messages=[
            {"role": "system", "content": instructions},
            {"role": "user", "content": prompt}
            ], 
            format=output_schema,
            keep_alive="30m",
            think=False, 
            options={
                "temperature": 0,
                "num_ctx": total_tokens,
                "num_predict": keywords_tokens,
            }
        )
        logger.info("Prompt processing: %.2f seconds", completion.prompt_eval_duration / 1e9)
        logger.info("Generation: %.2f seconds", completion.eval_duration / 1e9)
        response = json.loads(completion.message.content)
        return response
    except (json.JSONDecodeError, ValueError) as exc:
        logger.exception("Failed to parse model output: %s", exc)
        return None
    
def extract_label_column(dataframe, model_name: str=LLM_MODEL) -> dict | None:
    column_names = dataframe.columns.tolist()
    if not column_names:
        return None
    
    samples = dataframe.loc[dataframe.notna().sum(axis=1).nlargest(3).index].to_dict(orient="records") # get 3 rows with least nulls
    try: 
        completion = chat(model=model_name,messages=[
            {"role": "system", "content": LLM_INSTRUCTIONS_RECOMMEND_LABEL},
            {"role": "user", "content": f"CSV columns: {column_names}\nSamples: {samples}"}],
            options={"temperature": 0},
            format={"type": "object",
                "properties": {"label_column": {"type": "string", "enum": column_names}},
                "required": ["label_column"]
            }
        )
        response = json.loads(completion.message.content)
        logger.info("Prompt processing: %.2f seconds", completion.prompt_eval_duration / 1e9)
        logger.info("Generation: %.2f seconds", completion.eval_duration / 1e9)
        if response["label_column"] not in column_names:
            raise ValueError(f"Invalid label column: {response['label_column']}")
        return response
    except (json.JSONDecodeError, ValueError) as exc:
        logger.exception("Failed to parse model output: %s", exc)
        return None


def save_results(response):
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    llm_responses_file = RESULTS_DIR / f"llm_workflow_{timestamp}.json"
    with open(llm_responses_file, "w", encoding="utf-8") as file:
        json.dump(response, file, indent=4, ensure_ascii=False)
    logger.debug("Saved prompt response to %s", llm_responses_file)

def llm_extract(query: str, context: str, data_filepath: str, model_name: str, instructions: str, output_schema: dict, total_tokens: int, keywords_tokens: int):
    response = extract_workflow(query, context, model_name, instructions, output_schema, total_tokens, keywords_tokens)
    dataframe = pd.read_csv(data_filepath)
    label = extract_label_column(dataframe, model_name)
    save_results(response)
    return response, label



if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S")
    from extract_text1 import file_to_text
    
    query = "Heart disease in California in 2010"
    text = file_to_text(RECOMMENDML_CONTEXT_FILEPATH)
    response, label = llm_extract(query=query, 
                           context=text, 
                           model_name=LLM_MODEL, 
                           instructions=LLM_INSTRUCTIONS_RECOMMENDML, 
                           output_schema=LLM_METHODOLOGY_SCHEMA, 
                           total_tokens=RECOMMENDML_TOTAL_TOKENS, 
                           keywords_tokens=RECOMMENDML_KEYWORDS_TOKENS,
                           data_filepath=RECOMMENDML_DATA_FILEPATH)
    if response:
        print("Identified workflow:\n", response)
        print("Label: ", label["label_column"])
    else:
        print("No keywords found.")