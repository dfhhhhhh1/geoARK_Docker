from config import PIPELINES
import json
from pathlib import Path
from datetime import datetime
import logging
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent

def get_latest_json(pipeline_name):
    """Get most recent llm_response_datetime.json from each pipeline"""
    results_dir = BASE_DIR / pipeline_name / "results"
    json_files = list(Path(results_dir).glob("llm_response*.json"))
    if not json_files:
        raise FileNotFoundError(f"No JSON files found in {results_dir}")
    return max(json_files, key=lambda f: f.stat().st_mtime) # Select the most recently modified file

def merge(pipelines=PIPELINES):
    merged_responses = {}
    for pipeline in pipelines:
        json_path = get_latest_json(pipeline)
        with json_path.open("r", encoding="utf-8") as file:
            data = json.load(file)
        merged_responses[pipeline] = data
        logger.info(f"Loaded {pipeline}: {json_path}")
    return merged_responses

def save_results(merged_responses):
    """Save the merged output"""
    output_dir = BASE_DIR / "results"
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = output_dir / f"keywords_{timestamp}.json"
    with output_path.open("w", encoding="utf-8") as file:
        json.dump(merged_responses, file, indent=4)
    logger.info(f"Merged result saved to: {output_path}")

def merge_results(pipelines):
    merged_responses = merge(pipelines)
    save_results(merged_responses)

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S")
    merge_results(PIPELINES)
