import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import TIME_SERIES_CANDIDATES, LLM_MODEL, LLM_INSTRUCTIONS_MATCH_TIME_SERIES, LLM_INSTRUCTIONS_TIME_SERIES_CONFIG, RECOMMENDML_DATA_FILEPATH, RECOMMENDML_TRAIN_TIME_LIMIT
import json
from importlib.util import find_spec
from autogluon.timeseries import TimeSeriesDataFrame, TimeSeriesPredictor
from ollama import chat
import pandas as pd
import logging
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BASE_DIR / "results"

def module_available(module_name: str) -> bool:
    try:
        return find_spec(module_name) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False

def get_model_diagnostics(model_candidates: dict=TIME_SERIES_CANDIDATES, available_ram_gb: float=0.0) -> dict[str, str]:
    """Return only models passing dependency and RAM checks."""
    diagnostics = {
        alias: key for alias, (key, dependencies, min_ram) in model_candidates.items()
        if available_ram_gb >= min_ram and all(module_available(dep) for dep in dependencies)
    }
    if not diagnostics:
        raise RuntimeError("No available forecasting models.")
    logger.info("Available MLs: %s", diagnostics)
    return diagnostics

def llm_match_MLs(needed_MLs: list[str], available_MLs: dict, model_name: str=LLM_MODEL, instructions: str=LLM_INSTRUCTIONS_MATCH_TIME_SERIES):
    prompt = f"AVAILABLE MLs: {available_MLs}.\nML METHODs: {needed_MLs}."
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

def extract_time_series_config(dataframe, model_name: str=LLM_MODEL, instructions: str=LLM_INSTRUCTIONS_TIME_SERIES_CONFIG) -> dict:
    column_names = dataframe.columns.tolist()
    samples = dataframe.loc[dataframe.notna().sum(axis=1).nlargest(3).index].to_dict(orient="records") # get 3 rows with least nulls
    try: 
        completion = chat(model=model_name,messages=[
            {"role": "system", "content": instructions},
            {"role": "user", "content": f"CSV columns: {column_names}\nSamples: {samples}"}],
            options={"temperature": 0},
            format={"type": "object",
                "properties": {
                    "time_column": {"type": ["string", "null"], "enum": [*column_names, None]},
                    "id_columns": {"type": "array", "items": {"type": "string", "enum": column_names}},
                    "frequency": {"type": "string", "enum": ["D", "B", "W", "M", "Q", "Y", "h", "min", "s"]}
                }, "required": ["label_column", "time_column", "id_columns", "frequency"]
            }
        )
        logger.info("Prompt processing: %.2f seconds", completion.prompt_eval_duration / 1e9)
        logger.info("Generation: %.2f seconds", completion.eval_duration / 1e9)
        config = json.loads(completion.message.content)
        logger.info("LLM extracted time series config:\n%s", config)
        if config["time_column"] and config["time_column"] not in column_names:
            raise ValueError(f"LLM selected invalid time column: {config['time_column']}")
        if not set(config["id_columns"]).issubset(column_names):
            raise ValueError(f"LLM selected invalid ID columns: {config['id_columns']}")
        return config
    except (json.JSONDecodeError, ValueError) as exc:
        logger.exception("Failed to parse model output: %s", exc)
        return None


def process_time_data(dataframe, label_column: str, time_column: str, id_columns: list[str] | None=None, prediction_length: int=7):
    if not time_column or time_column not in dataframe.columns:
        raise ValueError("Time-series forecasting requires a valid timestamp column.")
    dataframe = dataframe.dropna(subset=[time_column, label_column])
    dataframe[time_column] = pd.to_datetime(dataframe[time_column], errors="coerce")
    dataframe[label_column] = pd.to_numeric(dataframe[label_column], errors="coerce")
    dataframe.dropna(subset=[time_column, label_column], inplace=True)
    # Create unique time-series IDs
    if id_columns and set(id_columns).issubset(dataframe.columns):
        dataframe["item_id"] = dataframe[id_columns].astype(str).agg("_".join, axis=1)
    else:
        logger.warning("ID columns missing or invalid! Using a single time series...")
        dataframe["item_id"] = "series_0"

    dataframe[time_column] = pd.to_datetime(dataframe[time_column])
    if dataframe.duplicated(["item_id", time_column]).any():
        dataframe = dataframe.groupby(["item_id", time_column], as_index=False).agg({label_column: "mean"})
        logger.warning("Automatically grouped duplicate items using mean.")
    dataframe.sort_values(["item_id", time_column], inplace=True)
    if (dataframe.groupby("item_id").size() <= prediction_length).any():
        raise ValueError("Some time series have insufficient observations.")
    ts_data = TimeSeriesDataFrame.from_data_frame(dataframe, id_column="item_id", timestamp_column=time_column)
    train_data, test_data = ts_data.train_test_split(prediction_length=prediction_length)
    return  train_data, test_data
    
def train_model(ml_methods: list[str], train_data, label: str, registry: dict, prediction_length: int, frequency: str="D", time_limit: int=RECOMMENDML_TRAIN_TIME_LIMIT):
    """Train each available AutoGluon model."""
    predictors = []
    available_MLs = registry.keys()
    for ml_method in ml_methods:
        ml_method = ml_method.lower().strip()
        if ml_method not in available_MLs:
            if ml_method != "unavailable":
                logger.warning("Unavailable model: %s. Available models: %s", ml_method, sorted(registry))
            continue
        try: 
            logger.info("Training model: %s", ml_method)
            predictor = TimeSeriesPredictor(target=label, prediction_length=prediction_length, freq=frequency, path=str(RESULTS_DIR / ml_method))
            predictor.fit(train_data=train_data, hyperparameters={registry[ml_method]: {}}, time_limit=time_limit)
            predictors.append({"ml_method": ml_method, "predictor": predictor})
        except Exception:
            logger.exception("Failed to train model: %s", ml_method)

    return predictors

def predict_model(predictors, train_data, test_data):
    metadata = {}
    for predictor in predictors:
        ml_method = predictor["ml_method"]
        model = predictor["predictor"]
        filepath = RESULTS_DIR / f"{ml_method}_predictions.csv"

        predictions = model.predict(train_data, model=model.model_best)
        predictions.reset_index(inplace=True)
        predictions.to_csv(filepath, index=False)
        performance = model.evaluate(test_data)

        logger.info("%s performance: %s", ml_method, performance)
        metadata[ml_method] = {"performance": performance, "predictions_filepath": str(filepath)}

    return metadata
        
def time_series_pipeline(ml_methods: list[str], hardware: dict, label_column: str, prediction_length: int, time_limit: int, data_filepath: str=RECOMMENDML_DATA_FILEPATH):
    registry = get_model_diagnostics(TIME_SERIES_CANDIDATES, hardware["available_ram_gb"])
    dataframe = pd.read_csv(data_filepath)
    config = extract_time_series_config(dataframe=dataframe, model_name=LLM_MODEL, instructions=LLM_INSTRUCTIONS_TIME_SERIES_CONFIG)
    train_data, test_data = process_time_data(dataframe=dataframe,
                                              label_column=label_column,
                                              prediction_length=prediction_length, 
                                              time_column=config["time_column"], 
                                              id_columns=config["id_columns"])
    ml_methods = llm_match_MLs(needed_MLs=ml_methods, 
                               available_MLs=registry, 
                               model_name=LLM_MODEL, 
                               instructions=LLM_INSTRUCTIONS_MATCH_TIME_SERIES)
    logger.info("Matched ML methods: %s", ml_methods)
    
    predictors = train_model(ml_methods=ml_methods, 
                             train_data=train_data, 
                             label=label_column, 
                             registry=registry, 
                             prediction_length=prediction_length, 
                             frequency=config["frequency"],  
                             time_limit=time_limit)
    if not predictors:
        raise RuntimeError("No forecasting models were successfully trained.")
    return predict_model(predictors, train_data, test_data)