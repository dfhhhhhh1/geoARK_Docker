
# ========= FOR ALL ANALYSIS PIPELINES =========
LLM_MODEL = "qwen3:1.7b" # Change to newModelName if needed

# ==================== in both RECOMMNEDML TABULAR & TIME SERIES PIPELINE =========
RECOMMENDML_TRAIN_TIME_LIMIT = 300 # Max seconds each model allowed to train for

# ========= RECOMMENDML (uploaded file) PIPELINE ========= 
from pathlib import Path
BASE_DIR = Path(__file__).resolve().parent
RECOMMENDML_CONTEXT_FILEPATH = BASE_DIR / "context_files" / "12889_2026_Article_26571.pdf" #"12889_2026_Article_26571.pdf"
RECOMMENDML_DATA_FILEPATH = BASE_DIR / "data" / "california_pm25.csv"
RECOMMENDML_RESULTS_DIR = BASE_DIR / "recommendML" / "results"
RECOMMENDML_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
GEOSPATIAL_RESULTS_DIR = BASE_DIR / "recommend_geospatial" / "results"
GEOSPATIAL_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
RECOMMENDML_METADATA_FILEPATH = RECOMMENDML_RESULTS_DIR / "recommendML_metadata.json" # Shows ran tabular ML methods & time-series ML methods, accuracy metrics, predictions filepath

RECOMMENDML_CONTEXT_LIMIT  = 10000 # Max # of chars to include from uploaded context file
RECOMMENDML_KEYWORDS_TOKENS = 3000 # Max # of tokens to reserve for llm's output
RECOMMENDML_TOTAL_TOKENS = RECOMMENDML_CONTEXT_LIMIT + RECOMMENDML_KEYWORDS_TOKENS + 1000 # Total # of tokens to reserve for context window
LLM_INSTRUCTIONS_RECOMMEND_LABEL = """Given the CSV columns, identify the most appropriate label column.
Rules:
- Select a numeric target column for machine learning OR time-series forecasting.
- Never invent column names or values.
"""
# Instructions to extract a workflow with specific technique used at each step, categorized into a broader category 
LLM_INSTRUCTIONS_RECOMMENDML = """Extract the research paper's workflow, focusing on data acquisition, preprocessing, feature engineering, machine learning, time series analysis, geospatial analysis, evaluation, and or interpretation.
- SPECIFICITY: Identify the actual Technique, algorithm, statistical method, model, or analytical procedure used, NOT a generic category. Extract the most specific method supported by evidence. When multiple methods are named, extract them individually rather than grouping them under a broad label (e.g., "Global Moran's I" instead of "Geospatial Analysis"). Do not restrict identification to predefined methods or examples; recognize unfamiliar and newly developed techniques. Never guess methods unsupported by evidence.
- Evidence: Support every step with paper evidence. Distinguish performed methods, author-proposed methods, inferred steps, and recommendations. Never invent procedures, results, or feature engineering.
- Categories: Classify methods by what they actually do. SHAP is interpretability. Moran's I and Getis-Ord Gi* are geospatial statistics. ETS, ARIMA, or other similar methods are time series analysis. Model metrics belong to evaluation.
- Workflow: Organize distinct methods logically, preserving reported order and parallel analyses. Avoid duplicate steps unless they represent genuinely different procedures.
- Query relevance: Always extract the workflow regardless of query specificity. Explain how methods apply to the user's query and identify necessary adaptations.
- Gaps: Report only meaningful, evidence-supported limitations or missing details. Do not claim information is absent from the full paper merely because it is absent from the available context.
"""
LLM_METHODOLOGY_SCHEMA = {
    "type": "object",
    "properties": {
        "techniques": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "step": {"type": "integer"},
                    "technique": {"type": "string"},
                    "category": {
                        "type": "string",
                        "enum": [
                            "data_processing",
                            "machine_learning",
                            "geospatial_analysis",
                            "time_series",
                            "evaluation",
                            "interpretability",
                            "other"
                        ]
                    },
                    "status": {
                        "type": "string",
                        "enum": [
                            "performed",
                            "proposed",
                            "inferred",
                            "recommended"
                        ]
                    },
                    "purpose": {"type": "string"},
                    "evidence": {"type": "string"},
                    "query_relevance": {"type": "string"}
                },
                "required": [
                    "step", "technique", "category", "status",
                    "purpose", "evidence", "query_relevance"
                ],
                "additionalProperties": False
            }
        },
        "gaps": {
            "type": "array",
            "items": {"type": "string"}
        }
    },
    "required": ["methods", "gaps"],
    "additionalProperties": False
} # Expected llm output format (stored in "results/")



# ==================== RECOMMNEDML TABULAR PIPELINE =========
LLM_INSTRUCTIONS_MATCH_TABULAR = """Given each ML METHOD, match to the most equivalent AVAILABLE MLs based on algorithmic meaning, not exact wording.
Rules:
- Recognize synonyms, abbreviations, and alternative terminology.
- Preserve input order and return exactly 1 model per ML method.
- Return "unavailable" if no equivalent exists, never invent models.
"""

TABULAR_CANDIDATES = { # Model name: (AutoGluon model key, required modules, minimum RAM in GB)
    "xgboost": ("XGB", ("xgboost",), 1),
    "lightgbm": ("GBM", ("lightgbm",), 1),
    "catboost": ("CAT", ("catboost",), 2),
    "random_forest": ("RF", ("sklearn",), 1),
    "extra_trees": ("XT", ("sklearn",), 1),
    "knn": ("KNN", ("sklearn",), 1),
    "linear": ("LR", ("sklearn",), 0.5),
    "dummy": ("DUMMY", (), 0),

    # Optional models
    "neural_net": ("NN_TORCH", ("torch",), 2),
    "fastai": ("FASTAI", ("fastai", "torch"), 2),
    "real_mlp": ("REALMLP", ("realmlp",), 2),
    "tabm": ("TABM", ("torch",), 2),
    "ft_transformer": ("FT_TRANSFORMER", ("torch",), 2),
    "ebm": ("EBM", ("interpret",), 1),
    "lightgbm_prep": ("GBM_PREP", ("lightgbm",), 1),
}

# ==================== RECOMMNEDML TIME SERIES PIPELINE =========
LLM_INSTRUCTIONS_TIME_SERIES_CONFIG = """Given the CSV columns, identify the most appropriate time-series forecasting configuration.
Rules:
- Identify the timestamp column, or return null if unavailable.
- Select columns that uniquely identify individual time series (including geographic or location attributes). Return an empty list if none.
- Infer observation frequency from timestamp values and return only the corresponding frequency alias: D = daily, B = business daily, W = weekly, M = monthly, Q = quarterly, Y = yearly, h = hourly, min = every minute, s = every second.
- Never invent column names or values.
"""

LLM_INSTRUCTIONS_MATCH_TIME_SERIES = """Given each ML METHOD, match to the most equivalent AVAILABLE MLs for time-series forecasting, based on forecasting methodology and algorithmic
meaning, not exact wording.
Rules:
- Match based on forecasting capabilities, not general ML similarities.
- Recognize synonyms, time-series forecasting abbreviations, and alternative terminology.
- Preserve input order and return exactly 1 model per ML method.
- Return "unavailable" if no equivalent exists forecasting model exists, never invent models.
"""

TIME_SERIES_CANDIDATES = { # Model name: (AutoGluon model key, required modules, minimum RAM in GB)
    "naive": ("Naive", [], 0.1),
    "seasonal_naive": ("SeasonalNaive", [], 0.1),
    "theta": ("Theta", [], 0.1),
    "ets": ("AutoETS", [], 0.1),
    "arima": ("AutoARIMA", ["statsforecast"], 0.5),
    "deepar": ("DeepAR", ["torch"], 2.0),
    "tft": ("TemporalFusionTransformer", ["torch"], 2.0),
    "patchtst": ("PatchTST", ["torch"], 2.0),
    "chronos": ("Chronos", ["torch"], 2.0),
    "direct_tabular": ("DirectTabular", ["lightgbm"], 1.0),
    "recursive_tabular": ("RecursiveTabular", ["lightgbm"], 1.0),
}



# ========= GEOSPATIAL_ANALYSIS PIPELINE ========= 
GEOSPATIAL_ANALYSIS_METADATA_FILEPATH = GEOSPATIAL_RESULTS_DIR / "geospatial_analysis_metadata.json"
GEOSPATIAL_ANALYSIS_OUTPUTS_FILEPATH = GEOSPATIAL_RESULTS_DIR / "geospatial_analysis_outputs.csv"

LLM_INSTRUCTIONS_MATCH_GEOSPATIAL_ANALYSIS = """Given each GEOSPATIAL ANALYSIS METHOD, match to the most equivalent AVAILABLE METHOD based on spatial statistical methodology and algorithmic
meaning, not exact wording.
Rules:
- Match based on spatial  analysis capabilities, not general similarities.
- Recognize synonyms, spatial statistics abbreviations, and alternative terminology.
- Preserve input order and return exactly 1 model per ML method.
- Return "unavailable" if no equivalent exists geospatial analysis method exists, never invent methods.
"""
LLM_INSTRUCTIONS_GEOSPATIAL_ANALYSIS_CONFIG = """Given the CSV columns, identify the most appropriate geospatial analysis configuration.
Rules:
- Identify longitude column. Return null if unavailable.
- Identify latitude column. Return null if unavailable.
- Infer spatial_weight method based on geographic data, if point-based geospatial analysis, use KNN or DistanceBand. If polygon-based geospatial analysis (neighbor areas share an edge or vertex) use Queen contiguity. Return 'knn' if unsure.
- Infer k for knn if spatial_weight='knn'.
- Infer distance_threshold for knn if spatial_weight='distance_bands'.
- Infer target_crs to use based on geographic coordinates and analysis requirements. Return EPSG:4326 if unsure. 
- Infer appropriate p_value_threshold for statistical significance. Return 0.05 if unsure. 
- Never invent column names.
"""
GEOSPATIAL_WEIGHT_CANDIDATES = ["knn", "queen_contiguity", "distance_bands"]
GEOSPATIAL_ANALYSIS_CANDIDATES = { # Method name: (model key, required modules, minimum RAM in GB)
    "moran": ("Moran", ["esda", "libpysal"], 0.1),
    "moran_local": ("Moran_Local", ["esda", "libpysal"], 0.1),
    "getis_ord_local": ("G_Local", ["esda", "libpysal"], 0.1)
}
