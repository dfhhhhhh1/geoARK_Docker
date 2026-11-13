import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import RECOMMENDML_DATA_FILEPATH, RECOMMENDML_METADATA_FILEPATH
from recommendML.tabularML3 import tabular_pipeline
from recommendML.time_seriesML3 import time_series_pipeline

import json
import psutil
import torch
import logging
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BASE_DIR / "results"


def get_MLs(result: dict, category: str="machine_learning") -> list[str]:
    """Extract explicitly performed ML techniques."""
    return [item["technique"] for item in result.get("techniques", []) if item.get("category") == category and item.get("status") != "inferred"]

def get_hardware() -> dict:
    """Return available CPU, RAM, and CUDA information."""
    memory = psutil.virtual_memory()
    hardware = {
        "num_cpu": psutil.cpu_count(logical=True) or 1,
        "total_ram_gb": round(memory.total / 1024**3, 2),
        "available_ram_gb": round(memory.available / 1024**3, 2),
        "num_gpu": int(torch.cuda.is_available())
    }
    logger.info("Hardware: %s", hardware)
    return hardware
    
def save_output(metadata, filepath: str=RECOMMENDML_METADATA_FILEPATH): 
    with open(filepath, "w") as file:
        json.dump(metadata, file, indent=4, default=str)
    logger.info("Saved ML metadata to %s", filepath)


def ML_pipeline(techniques: list[dict], data_filepath: str, metadata_filepath: str, prediction_length: int, label_column: str="", time_limit: int=300):
    ml_methods = [technique["technique"] for technique in techniques if technique.get("category") == "machine_learning"]
    time_series_methods = [technique["technique"] for technique in techniques if technique.get("category") == "time_series"]
    logger.info("Extracted ML methods: %s", ml_methods)
    logger.info("Extracted Time Series analysis methods: %s", time_series_methods)
    hardware = get_hardware()
    metadata = {}
    if ml_methods: 
        metadata["Tabular Machine Learning"] = tabular_pipeline(ml_methods=ml_methods,
                                                                label_column=label_column,
                                                                hardware=hardware,
                                                                data_filepath=data_filepath,
                                                                time_limit=time_limit)
    if time_series_methods:
        metadata["Time Series analysis"] = time_series_pipeline(ml_methods=time_series_methods,
                                                                label_column=label_column,
                                                                prediction_length=prediction_length,
                                                                hardware=hardware,
                                                                data_filepath=data_filepath,
                                                                time_limit=time_limit)
    save_output(metadata, metadata_filepath)
    return metadata

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S")
    techniques = [{"technique": "XGBoost", "category": "machine_learning", "status": "performed"},
                  {"technique": "Artificial Neural Network (ANN)", "category": "machine_learning", "status": "performed"},
                  {"technique": "Support Vector Machine (SVM)", "category": "machine_learning", "status": "inferred"},
                  {"technique": "Automatic Autoregressive Integrated Moving Average", "category": "time_series", "status": "performed"},
                  {"technique": "Automatic Error, Trend, and Seasonal Exponential Smoothing", "category": "time_series", "status": "performed"}
    ]
    label = "Arithmetic Mean"
    ML_pipeline(techniques, RECOMMENDML_DATA_FILEPATH, RECOMMENDML_METADATA_FILEPATH, 7, label)
    #ML_pipeline("tabular", "Arithmetic Mean", TABULAR_CANDIDATES, RECOMMENDML_DATA_FILEPATH, TABULAR_RECOMMENDML_METADATA_FILEPATH)


