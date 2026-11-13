import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import RECOMMENDML_CONTEXT_FILEPATH, RECOMMENDML_CONTEXT_LIMIT, LLM_MODEL, LLM_INSTRUCTIONS_RECOMMENDML, LLM_METHODOLOGY_SCHEMA, RECOMMENDML_TOTAL_TOKENS, RECOMMENDML_KEYWORDS_TOKENS, RECOMMENDML_DATA_FILEPATH, RECOMMENDML_METADATA_FILEPATH, RECOMMENDML_TRAIN_TIME_LIMIT

from recommendML.extract_text1 import file_to_text
from recommendML.llm2 import llm_extract
from recommendML.run_ML3 import ML_pipeline

from recommend_geospatial.geospatial_analysis_pipeline import geospatial_analysis_pipeline

import time
from rich.logging import RichHandler
from rich.pretty import pretty_repr
import logging
logger = logging.getLogger(__name__)

def recommendML_pipeline(query: str, data_filepath: str, metadata_filepath: str, context_filepath: str, context_limit: int, llm_model: str, instructions: str, llm_methodology_schema, total_tokens: int, keywords_tokens: int, train_time_limit: int):
    start = time.perf_counter()

    logger.info(" 1. Extracting text from context file '%s'...", context_filepath)
    text = file_to_text(context_filepath, context_limit)
    logger.info("CONTEXT:\n'%s'", text)
    logger.info(" 2. LLM extract ML/geospatial workflow from context file '%s'...", context_filepath)
    workflow, label = llm_extract(query=query, 
                                  context=text, 
                                  data_filepath=data_filepath, 
                                  model_name=llm_model, 
                                  instructions=instructions, 
                                  output_schema=llm_methodology_schema, 
                                  total_tokens=total_tokens, 
                                  keywords_tokens=keywords_tokens)
    label_column  = label.get("label_column")
    techniques = workflow.get("techniques", [])
    if not techniques: 
        logger.warning("LLM did not extract a workflow.")

    geospatial_results = geospatial_analysis_pipeline(techniques=techniques,
                                     data_filepath=data_filepath, 
                                     label_column=label_column)
    
    recommendML_results = ML_pipeline(techniques=techniques,
                data_filepath=data_filepath, 
                metadata_filepath=metadata_filepath,
                label_column=label_column,
                prediction_length=7, 
                time_limit=train_time_limit)

    elapsed = time.perf_counter() - start
    logger.info("RecommendML pipeline TOTAL EXECUTION TIME: %.2f seconds.", elapsed)

    return {"LLM extracted workflow": workflow, "RecommendML results": recommendML_results, "Geospatial analysis results": geospatial_results}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S", handlers=[RichHandler(rich_tracebacks=True)])

    query = "Heart disease in California in 2010"
    response = recommendML_pipeline(query=query, 
                                    data_filepath=RECOMMENDML_DATA_FILEPATH, metadata_filepath=RECOMMENDML_METADATA_FILEPATH,
                                    context_filepath=RECOMMENDML_CONTEXT_FILEPATH, context_limit=RECOMMENDML_CONTEXT_LIMIT, 
                                    llm_model=LLM_MODEL, instructions=LLM_INSTRUCTIONS_RECOMMENDML, llm_methodology_schema=LLM_METHODOLOGY_SCHEMA, 
                                    total_tokens=RECOMMENDML_TOTAL_TOKENS, keywords_tokens=RECOMMENDML_KEYWORDS_TOKENS, train_time_limit=RECOMMENDML_TRAIN_TIME_LIMIT)
    
    if response:
            logger.info("\n\nRESPONSE\n%s", pretty_repr({"RESPONSE": response}))
    else:
        print("\n\nNo keywords found.")
