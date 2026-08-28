"""
ml_service.py — FastAPI AutoML Microservice (AutoGluon)
=======================================================

Exposes a single endpoint:
    POST /automl/train
        - Accepts: multipart/form-data with `file` (CSV) and `target_column` (str)
        - Returns: JSON with leaderboard, feature importance, eval metrics,
                   and a 50‑point actual‑vs‑predicted sample for scatter plots.

Run:
    pip install "fastapi[standard]" uvicorn autogluon.tabular pandas
    uvicorn ml_service:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import io
import json
import shutil
import tempfile
import traceback
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# App / CORS
# ---------------------------------------------------------------------------

app = FastAPI(
    title="GeoArk AutoML Service",
    version="1.0.0",
    description="AutoGluon‑powered AutoML for CSV datasets",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",   # Vite default
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok", "service": "automl"}


# ---------------------------------------------------------------------------
# POST /automl/train
# ---------------------------------------------------------------------------

@app.post("/automl/train")
async def train_automl(
    file: UploadFile = File(...),
    target_column: str = Form(...),
):
    """
    Train an AutoGluon TabularPredictor on the uploaded CSV.

    Returns
    -------
    {
        "leaderboard": [ { "model": str, "score_val": float, "fit_time": float, "pred_time_val": float }, ... ],
        "importance":  { feature_name: importance_score, ... },
        "metrics":     { metric_name: value, ... },
        "chartData":   { "actual": [float, ...], "predicted": [float, ...] },
        "problemType": "regression" | "binary" | "multiclass",
        "targetColumn": str,
        "evalMetric":  str
    }
    """

    # --- 1. Read & validate CSV ------------------------------------------------

    try:
        raw = await file.read()
        df = pd.read_csv(io.BytesIO(raw))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not parse CSV: {exc}")

    if target_column not in df.columns:
        raise HTTPException(
            status_code=400,
            detail=f"Target column '{target_column}' not found. "
                   f"Available columns: {list(df.columns)}",
        )

    if len(df) < 10:
        raise HTTPException(
            status_code=400,
            detail="Dataset must contain at least 10 rows for meaningful training.",
        )

    # Drop rows where target is null
    df = df.dropna(subset=[target_column])

    # --- 2. Train / test split (80/20 chronological) --------------------------

    split_idx = int(len(df) * 0.8)
    train_df = df.iloc[:split_idx].reset_index(drop=True)
    test_df  = df.iloc[split_idx:].reset_index(drop=True)

    # --- 3. Train AutoGluon ---------------------------------------------------

    # Import here so the module loads even if autogluon isn't installed yet
    # (allows health‑check to work while installing)
    try:
        from autogluon.tabular import TabularPredictor
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="AutoGluon is not installed on this server. "
                   "Run: pip install autogluon.tabular",
        )

    tmp_dir = tempfile.mkdtemp(prefix="ag_model_")

    try:
        predictor = TabularPredictor(
            label=target_column,
            path=tmp_dir,
            verbosity=0,                        # keep logs quiet
        ).fit(
            train_data=train_df,
            time_limit=120,                      # hard 120‑second budget
            presets="medium_quality",            # fast, decent accuracy
        )

        # --- 4. Evaluate on held‑out test set ---------------------------------

        problem_type: str = predictor.problem_type  # regression | binary | multiclass
        eval_metric: str  = predictor.eval_metric.name

        # Leaderboard (all trained models)
        lb = predictor.leaderboard(test_df, silent=True)
        leaderboard = []
        for _, row in lb.iterrows():
            leaderboard.append({
                "model":          str(row.get("model", "")),
                "score_val":      _safe_float(row.get("score_val")),
                "fit_time":       _safe_float(row.get("fit_time")),
                "pred_time_val":  _safe_float(row.get("pred_time_val")),
            })

        # Feature importance (permutation‑based, top 20)
        try:
            fi = predictor.feature_importance(test_df, silent=True)
            importance = {
                str(feat): _safe_float(score)
                for feat, score in fi["importance"].head(20).items()
            }
        except Exception:
            importance = {}

        # Evaluation metrics dict
        try:
            perf = predictor.evaluate(test_df, silent=True)
            if isinstance(perf, dict):
                metrics = {str(k): _safe_float(v) for k, v in perf.items()}
            else:
                metrics = {eval_metric: _safe_float(perf)}
        except Exception:
            metrics = {}

        # Actual vs Predicted (sample up to 50 points)
        y_true = test_df[target_column]
        y_pred_series = predictor.predict(test_df)

        if problem_type == "regression":
            # Numeric — direct scatter
            sample_idx = (
                test_df.sample(n=min(50, len(test_df)), random_state=42).index
            )
            chart_data = {
                "actual":    [_safe_float(y_true.iloc[i]) for i in range(len(sample_idx))],
                "predicted": [_safe_float(y_pred_series.iloc[i]) for i in range(len(sample_idx))],
            }
        else:
            # Classification — encode labels as integers for the scatter
            from sklearn.preprocessing import LabelEncoder
            le = LabelEncoder()
            all_labels = pd.concat([y_true, y_pred_series]).astype(str)
            le.fit(all_labels)
            actual_enc    = le.transform(y_true.astype(str))
            predicted_enc = le.transform(y_pred_series.astype(str))
            sample_idx = list(range(min(50, len(test_df))))
            chart_data = {
                "actual":    [int(actual_enc[i]) for i in sample_idx],
                "predicted": [int(predicted_enc[i]) for i in sample_idx],
                "labelMap":  {int(le.transform([c])[0]): str(c) for c in le.classes_},
            }

    except HTTPException:
        raise
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Training failed: {exc}")
    finally:
        # Clean up temp model artefacts
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return JSONResponse(content={
        "leaderboard":  leaderboard,
        "importance":   importance,
        "metrics":      metrics,
        "chartData":    chart_data,
        "problemType":  problem_type,
        "targetColumn": target_column,
        "evalMetric":   eval_metric,
    })


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_float(val) -> float | None:
    """Convert a value to a JSON‑safe float (handles NaN / Inf)."""
    if val is None:
        return None
    try:
        f = float(val)
        if f != f or f == float("inf") or f == float("-inf"):
            return None
        return round(f, 6)
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Entrypoint (for `python ml_service.py` convenience)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    print("=" * 60)
    print("  GeoArk AutoML Service")
    print("=" * 60)
    print("  POST /automl/train   — Train models on CSV")
    print("  GET  /health         — Health check")
    print("=" * 60)

    uvicorn.run(app, host="0.0.0.0", port=8000)
