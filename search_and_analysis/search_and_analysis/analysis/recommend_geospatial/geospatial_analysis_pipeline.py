import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import GEOSPATIAL_ANALYSIS_METADATA_FILEPATH, GEOSPATIAL_ANALYSIS_OUTPUTS_FILEPATH, RECOMMENDML_DATA_FILEPATH, GEOSPATIAL_ANALYSIS_CANDIDATES, LLM_MODEL, LLM_INSTRUCTIONS_MATCH_GEOSPATIAL_ANALYSIS, LLM_INSTRUCTIONS_GEOSPATIAL_ANALYSIS_CONFIG, GEOSPATIAL_WEIGHT_CANDIDATES

from ollama import chat

import pandas as pd
import numpy as np
from numpy.typing import NDArray
import geopandas as gpd

from libpysal.weights import W, KNN, Queen, DistanceBand
from esda.moran import Moran, Moran_Local
from esda.getisord import G_Local

import json
from tabulate import tabulate
from rich.logging import RichHandler
from rich.pretty import pretty_repr
import logging
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BASE_DIR / "results"


def load_data(data_filepath: str, label_column: str="label", longitude_column: str="longitude", latitude_column: str="latitude", target_crs: str="EPSG:4326"):
    """Load & convert CSV to GeoDataFrame with KNN spatial weights."""
    dataframe = pd.read_csv(data_filepath)
    dataframe.columns = dataframe.columns.str.strip().str.lower()
    label_column = label_column.strip().lower()
    longitude_column = longitude_column.strip().lower()
    latitude_column = latitude_column.strip().lower()

    required = [longitude_column, latitude_column, label_column]
    missing = set(required) - set(dataframe.columns)
    if missing:
        raise ValueError(f"Missing columns: {missing}")

    dataframe.dropna(subset=[latitude_column, longitude_column, label_column], inplace=True)
    
    geo_dataframe = gpd.GeoDataFrame(dataframe, geometry=gpd.points_from_xy(dataframe[longitude_column], dataframe[latitude_column]), crs="EPSG:4326")
    geo_dataframe = geo_dataframe.to_crs(target_crs)

    coordinates = np.column_stack([geo_dataframe.geometry.x, geo_dataframe.geometry.y])
    return geo_dataframe, coordinates

def llm_match_MLs(desired_methods: list[str], available_methods: dict, model_name: str=LLM_MODEL, instructions: str=LLM_INSTRUCTIONS_MATCH_GEOSPATIAL_ANALYSIS):
    prompt = f"AVAILABLE METHODS: {available_methods}.\nDESIRED METHODs: {desired_methods}."
    try:
        completion = chat(model=model_name, messages=[
            {"role": "system","content": instructions},
            {"role": "user","content": prompt}],
            options={"temperature": 0},
            format={
                "type": "array",
                "items": {"type": "string", "enum": [*available_methods.keys(), "unavailable"]}
            }
        )
        logger.info("Prompt processing: %.2f seconds", completion.prompt_eval_duration / 1e9)
        logger.info("Generation: %.2f seconds", completion.eval_duration / 1e9)
        response = json.loads(completion.message.content)
        if not response:
            raise ValueError("No geospatial analysis methods were matched.")
        return response
    except (json.JSONDecodeError, ValueError) as exc:
        logger.exception("Failed to parse model output: %s", exc)
        raise RuntimeError("LLM model matching failed.") from exc

def extract_geospatial_analysis_config(dataframe, model_name: str=LLM_MODEL, instructions: str=LLM_INSTRUCTIONS_GEOSPATIAL_ANALYSIS_CONFIG) -> dict:
    column_names = dataframe.columns.tolist()
    samples = dataframe.loc[dataframe.notna().sum(axis=1).nlargest(3).index].to_dict(orient="records") # get 3 rows with least nulls
    try: 
        completion = chat(model=model_name,messages=[
            {"role": "system", "content": instructions},
            {"role": "user", "content": f"CSV columns: {column_names}\nSamples: {samples}"}],
            options={"temperature": 0},
            format={"type": "object",
                "properties": {
                    "longitude_column": {"type": ["string", "null"], "enum": [*column_names, None]},
                    "latitude_column": {"type": ["string", "null"], "enum": [*column_names, None]},
                    "weight_type": {"type": ["string", "null"], "enum": GEOSPATIAL_WEIGHT_CANDIDATES},
                    "k": {"type": ["integer", "null"], "minimum": 1},
                    "distance_threshold": {"type": ["number", "null"], "minimum": 0},
                    "p_significant_threshold": {"type": ["number"], "minimum": 0, "maximum": 1},
                    "target_crs": {"type": "string"}
                }, "required": ["longitude_column", "latitude_column", "weight_type", "p_significant_threshold", "target_crs"]
            }
        )
        logger.info("Prompt processing: %.2f seconds", completion.prompt_eval_duration / 1e9)
        logger.info("Generation: %.2f seconds", completion.eval_duration / 1e9)
        config = json.loads(completion.message.content)
        logger.info("LLM extracted time series config:\n%s", config)
        if config["longitude_column"] not in column_names or config["latitude_column"] not in column_names:
            raise ValueError(f"LLM selected invalid longitdue or latitude column: {config['longitude_column']} and {config['latitude_column']}")
        if not config["weight_type"] or config["weight_type"] not in GEOSPATIAL_WEIGHT_CANDIDATES:
            config["weight_type"] = "queen_contiguity"
            logger.warning(f"Unavailable spatial weight method: {config['weight_type']}. Default to queen_contiguity.")        
        return config
    except (json.JSONDecodeError, ValueError) as exc:
        logger.exception("Failed to parse model output: %s", exc)
        raise RuntimeError("Geospatial configuration extraction failed.")
    
def create_weights(weight_type: str, coordinates=None, geo_dataframe=None, k: int=8, threshold: float=5000):
    """Create spatial weights using KNN, Distance Band, or Queen contiguity."""
    if weight_type == "knn":
        if coordinates is None:
            raise ValueError("Coordinates are required for KNN.")
        weights = KNN.from_array(coordinates, k=k)
    elif weight_type == "distance_bands":
        if threshold is None:
            raise ValueError("Distance threshold is required. Ex: threshold=5000 means 5 km bands if coordinates are in meters")
        weights = DistanceBand.from_array(coordinates, threshold=threshold)
    elif weight_type == "queen_contiguity":
        if geo_dataframe is None: 
            raise ValueError("GeoDataFrame is required for Queen weights.") 
        weights = Queen.from_dataframe(geo_dataframe)
    else: 
        raise ValueError("Invalid weight_type. Choose from current available options: knn, distance_band, queen.")

    if weights.islands:
        logger.warning("%d observations have no neighbors.", len(weights.islands))
        print(f"Warning: {len(weights.islands)} observations have no neighbors.")
        if weight_type != "knn":
            logger.warning("Defaulting to KNN with k=%d", k)
            weight_type = "knn"
            return create_weights(weight_type, coordinates, geo_dataframe, k, threshold)
        
    return weights


def global_moran(y: NDArray[np.float64], w: W, permutations: int=999) -> dict[str, float]:
    """Global Moran's I using spatial weights and permutation-based significance testing.
    Parameters:
        y = Observations (in label column)
        w = spatial weight matrix
        permutations = # of permutations"""
    result = Moran(y, w, transformation="R", permutations=permutations)
    global_result = {
        "Moran_I": result.I,
        "Expected_I": result.EI,
        "Z_score": result.z_sim,
        "P_value": result.p_sim}
    logger.info("Global Moran's I\n%s", pretty_repr({"Global Moran's I": global_result}))
    return global_result


def local_moran(y: NDArray[np.float64], w: W, p_significant_threshold: float=0.05, permutations: int=999) -> tuple[pd.DataFrame, dict]:
    """Local Moran's I (LISA)
    Parameters:
        y = Observations (in label column)
        w = spatial weight matrix
        p_significant_threshold = Observations with LISA p_values < threshold = Observation considered statistically significant
        permutations = # of permutations"""
    
    result = Moran_Local(y, w, transformation="R", permutations=permutations)
    significant = result.p_sim < p_significant_threshold
    labels = {1: "Hot Spot (High surrounded by Highs)",
              2: "Low Outlier (Low surrounded by Highs)",
              3: "Cold Spot (Low surrounded by Lows)",
              4: "High Outlier (High surrounded by Lows)"}

    lisa_result = {"local_moran_I": result.Is,
            "lisa_pvalue": result.p_sim,
            "lisa_clusters": np.where(significant, [labels[i] for i in result.q], "Not Significant"),
            "significant": significant}
    lisa_dataframe = pd.DataFrame(lisa_result)
    logger.info("Local Moran's I\n%s\n", tabulate(lisa_dataframe.head(5),headers="keys",tablefmt="rounded_grid",showindex=False,floatfmt=".4f"))

    cluster_array = np.array([labels[i] for i in result.q])

    metadata = {
        "observations": len(y),
        "p-value threshold": p_significant_threshold,
        "significant": int(np.sum(significant)),
        "clusters": {cluster: int(np.sum((cluster_array == cluster) & significant)) for cluster in labels.values()}
    }
    
    logger.info("Local Moran's I\n%s", pretty_repr({"Local Moran's I": metadata}))
    return lisa_dataframe, metadata


def getis_ord_gi_star(y, w, p_significant_threshold: float=0.05, permutations=999) -> tuple[pd.DataFrame, dict]:
    """Getis-Ord Gi Star
        Parameters:
            y = Observations (in label column)
            w = spatial weight matrix
            p_significant_threshold = Observations with Getis-Ord Gi Star p_values < threshold = Observation considered statistically significant
            permutations = # of permutations"""
    result = G_Local(y, w, transform="B", star=True, permutations=permutations)
    
    significant = result.p_sim < p_significant_threshold
    clusters = np.select(
        [significant & (result.Zs > 0), significant & (result.Zs < 0)],
        ["Hot Spot", "Cold Spot"],
        default="Not Significant")
    gi_results = {"gi_star": result.Gs,
            "gi_zscore": result.Zs,
            "gi_pvalue": result.p_sim,
            "gi_cluster": clusters
    } 
    gi_dataframe = pd.DataFrame(gi_results)
    logger.info("Getis-Ord Gi*\n%s\n", tabulate(gi_dataframe.head(5),headers="keys",tablefmt="rounded_grid",showindex=False,floatfmt=".4f"))
    
    metadata = {
        "observations": len(y),
        "p-value threshold": p_significant_threshold,
        "significant": int(np.sum(significant)),
        "clusters": {cluster: int(np.sum(clusters == cluster)) for cluster in ["Hot Spot", "Cold Spot"]}
    }
    logger.info("Getis-Ord Gi Star\n%s", pretty_repr({"Getis-Ord Gi Star": metadata}))

    return gi_dataframe, metadata

def save_output(metadata, filepath: str=GEOSPATIAL_ANALYSIS_METADATA_FILEPATH): 
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    with open(filepath, "w") as file:
        json.dump(metadata, file, indent=4, default=str)
    logger.info("Saved geospatial analysis metadata to %s", filepath)

def geospatial_analysis_pipeline(techniques: list[str], data_filepath: str, label_column: str):
    geospatial_analysis_methods = [technique["technique"] for technique in techniques if technique.get("category") == "geospatial_analysis"]
    logger.info("Extracted geospatial analysis methods: %s", geospatial_analysis_methods)
    geospatial_analysis_methods = llm_match_MLs(desired_methods=geospatial_analysis_methods, 
                                                available_methods=GEOSPATIAL_ANALYSIS_CANDIDATES, 
                                                model_name=LLM_MODEL, 
                                                instructions=LLM_INSTRUCTIONS_MATCH_GEOSPATIAL_ANALYSIS)
    logger.info("Matched geospatial analysis methods: %s", geospatial_analysis_methods)
    dataframe = pd.read_csv(data_filepath)
    config = extract_geospatial_analysis_config(dataframe=dataframe, model_name=LLM_MODEL, instructions=LLM_INSTRUCTIONS_GEOSPATIAL_ANALYSIS_CONFIG)

    
    geodataframe, coordinates = load_data(data_filepath=data_filepath, label_column=label_column, 
                                          latitude_column=config["latitude_column"], longitude_column=config["longitude_column"],
                                          target_crs=config["target_crs"])
    label_column = label_column.strip().lower()
    y = pd.to_numeric(geodataframe[label_column],errors="coerce").to_numpy(dtype=float)
    w = create_weights(weight_type=config["weight_type"], coordinates=coordinates, k=config["k"], threshold=config["distance_threshold"], geo_dataframe=geodataframe)

    global_metadata = global_moran(y, w)
    lisa_dataframe, lisa_metadata = local_moran(y, w, config["p_significant_threshold"])
    gi_dataframe, gi_metadata = getis_ord_gi_star(y, w, config["p_significant_threshold"])
    
    
    # Combine LISA & Getis-Ord Gi Star results
    combined_dataframe = pd.concat([geodataframe.drop(columns="geometry").reset_index(drop=True), lisa_dataframe, gi_dataframe], axis=1)
    combined_dataframe.to_csv(GEOSPATIAL_ANALYSIS_OUTPUTS_FILEPATH, index=False)
    
    metadata = {"Global Moran's I": global_metadata,"Local Moran's I": lisa_metadata, "Getis-Ord Gi*": gi_metadata, "predictions_filepath": str(GEOSPATIAL_ANALYSIS_OUTPUTS_FILEPATH)}
    save_output(metadata, GEOSPATIAL_ANALYSIS_METADATA_FILEPATH)

    logger.info("\n%s", tabulate(combined_dataframe.head(5), headers="keys", tablefmt="rounded_grid", showindex=False, floatfmt=".4f", maxcolwidths=20))
    return metadata

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S", handlers=[RichHandler(rich_tracebacks=True)])
    techniques = ["moran", "moran_local", "getis_ord_local"]
    data_filepath = RECOMMENDML_DATA_FILEPATH
    label_column = "Arithmetic Mean"

    geospatial_analysis_pipeline(techniques=techniques,
                                 data_filepath=data_filepath, 
                                 label_column=label_column)
