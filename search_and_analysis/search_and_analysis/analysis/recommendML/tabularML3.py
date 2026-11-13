import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import TABULAR_CANDIDATES, LLM_MODEL, LLM_INSTRUCTIONS_MATCH_TABULAR, RECOMMENDML_DATA_FILEPATH, RECOMMENDML_TRAIN_TIME_LIMIT
import json
from importlib.util import find_spec
from autogluon.tabular import TabularPredictor
from autogluon.tabular.registry import ag_model_registry
from ollama import chat
import pandas as pd
from sklearn.model_selection import train_test_split
import logging
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BASE_DIR / "results"

def module_available(module_name: str) -> bool:
    try:
        return find_spec(module_name) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False

def get_model_diagnostics(model_candidates: dict=TABULAR_CANDIDATES, available_ram_gb: float=0.0) -> dict[str, str]:
    """Return only models passing registration, dependency, and RAM checks."""
    registered = ag_model_registry.key_to_cls_map()

    return {
        alias: key for alias, (key, dependencies, min_ram) in model_candidates.items()
        if key in registered and available_ram_gb >= min_ram and all(module_available(dep) for dep in dependencies)
    }

def llm_match_MLs(result: list[str], available_MLs: dict, model_name: str=LLM_MODEL, instructions: str=LLM_INSTRUCTIONS_MATCH_TABULAR):
    prompt = f"AVAILABLE MLs: {available_MLs}.\nML METHODs: {result}."
    try:
        completion = chat(model=model_name, messages=[
            {"role": "system","content": instructions},
            {"role": "user","content": prompt}],
            options={"temperature": 0},
            format={
                "type": "array",
                "items": {"type": "string", "enum": [*available_MLs.keys(), "unavailable"]}
            }
        )
        logger.info("Prompt processing: %.2f seconds", completion.prompt_eval_duration / 1e9)
        logger.info("Generation: %.2f seconds", completion.eval_duration / 1e9)
        response = json.loads(completion.message.content)
        if not response:
            raise ValueError("No ML methods were matched.")
        return response
    except (json.JSONDecodeError, ValueError) as exc:
        logger.exception("Failed to parse model output: %s", exc)
        raise RuntimeError("LLM model matching failed.") from exc
    
    
def train_model(ml_methods: list[str], train_data, label: str, registry: dict, hardware: dict, time_limit: int=RECOMMENDML_TRAIN_TIME_LIMIT, preset: str="good_quality"):
    """Train each available AutoGluon model."""
    predictions = []
    available_MLs = registry.keys()
    for ml_method in ml_methods:
        ml_method = ml_method.lower().strip()
        if ml_method not in available_MLs:
            logger.warning("Unavailable model: %s. Available models: %s", ml_method, sorted(registry))
            continue

        fit_kwargs = {
            "train_data": train_data,
            "hyperparameters": {registry[ml_method]: {}},
            "fit_weighted_ensemble": False,
            "num_cpus": hardware["num_cpu"] or 1,
            "num_gpus": hardware["num_gpu"],
            "time_limit": time_limit,
            "presets": preset
        }
        logger.info("Training model: %s", ml_method)
        predictor = TabularPredictor(label=label).fit(**fit_kwargs)
        predictions.append({"ml_method": ml_method, "predictor": predictor})
    return predictions

def predict_model(predictors, label_column, test_data):
    metadata = {}
    for predictor in predictors:
        model = predictor["predictor"]
        ml_method = predictor["ml_method"]
        filepath = RESULTS_DIR / f"{ml_method}_predictions.csv"

        predictions = model.predict(test_data.drop(columns=[label_column]))
        result = test_data.copy()
        result[ml_method] = predictions
        result.to_csv(filepath, index=False)
        performance = model.evaluate(test_data)
        logger.info("%s performance: %s", ml_method, performance)
        metadata[ml_method] = {"performance": performance, "predictions_filepath": str(filepath)}
    return metadata

        
def tabular_pipeline(ml_methods: list[str], label_column: str, time_limit: int, hardware: dict, data_filepath: str=RECOMMENDML_DATA_FILEPATH):
    registry = get_model_diagnostics(TABULAR_CANDIDATES, hardware["available_ram_gb"])
    logger.info("Available MLs: %s", registry)

    data = pd.read_csv(data_filepath)
    if label_column not in data.columns:
        raise ValueError(f"Target column '{label_column}' not found.")
    train_data, test_data = train_test_split(data, test_size=0.2, random_state=42)

    ml_methods = llm_match_MLs(ml_methods, registry, LLM_MODEL, LLM_INSTRUCTIONS_MATCH_TABULAR)
    logger.info("Matched ML methods: %s", ml_methods)
    
    predictors = train_model(ml_methods=ml_methods, train_data=train_data, label=label_column, registry=registry, hardware=hardware, time_limit=time_limit, preset="medium_quality")
    return predict_model(predictors, label_column, test_data)