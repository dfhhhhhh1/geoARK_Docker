"""
ml_service.py: FastAPI AutoML Microservice (AutoGluon)
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
import os
import shutil
import threading
import tempfile
import traceback
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

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
            # Numeric, direct scatter
            sample_idx = (
                test_df.sample(n=min(50, len(test_df)), random_state=42).index
            )
            chart_data = {
                "actual":    [_safe_float(y_true.iloc[i]) for i in range(len(sample_idx))],
                "predicted": [_safe_float(y_pred_series.iloc[i]) for i in range(len(sample_idx))],
            }
        else:
            # Classification, encode labels as integers for the scatter
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
# POST /automl/cv: spatial cross-validation for the data cart
# ---------------------------------------------------------------------------
#
# docs/DATA_CART_PLAN.md Phase 6, option B. /automl/train above splits the
# first 80% of rows from the last 20%; county rows are in FIPS order, so that
# is an accidental split by state with FIPS, name and state as features.
#
# Here the rows arrive with identifiers kept APART from the features (the API
# never sends them as columns), and every county is scored by a model that
# never saw its neighbours: folds hold out whole states, or, when the table has
# fewer than MIN_GROUPS states, contiguous blocks (k-means on centroids). The
# `random` split is the comparison arm, not an option to pick.

MIN_GROUPS = 5
N_FOLDS = 5
FOLD_TIME = int(os.environ.get("AUTOML_FOLD_SECONDS", "25"))
_busy = threading.Lock()


class CvRow(BaseModel):
    id: str
    state: str | None = None
    lon: float | None = None
    lat: float | None = None
    y: float
    x: list[float | None]


class CvRequest(BaseModel):
    target: str
    features: list[str]
    rows: list[CvRow]
    split: str = "spatial"


def _fold_groups(rows: list[CvRow], split: str):
    """Fold index per row, and how it was decided."""
    import numpy as np
    n = len(rows)
    rng = np.random.default_rng(42)
    if split == "random":
        idx = rng.permutation(n)
        folds = np.empty(n, dtype=int)
        folds[idx] = np.arange(n) % N_FOLDS
        return folds, "random", None
    states = [r.state or "" for r in rows]
    uniq = sorted(set(states))
    if len(uniq) >= MIN_GROUPS:
        # Balance fold sizes greedily: largest state first into the lightest fold.
        sizes = {s: states.count(s) for s in uniq}
        load = [0] * N_FOLDS
        assign = {}
        for s in sorted(uniq, key=lambda s: -sizes[s]):
            f = min(range(N_FOLDS), key=lambda i: load[i])
            assign[s] = f
            load[f] += sizes[s]
        return np.array([assign[s] for s in states]), "states", len(uniq)
    # Too few states: contiguous blocks of counties.
    from sklearn.cluster import KMeans
    xy = np.array([[r.lon or 0.0, r.lat or 0.0] for r in rows])
    k = min(N_FOLDS * 3, max(N_FOLDS, n // 10))
    blocks = KMeans(n_clusters=k, n_init=10, random_state=42).fit_predict(xy)
    sizes = np.bincount(blocks, minlength=k)
    load = [0] * N_FOLDS
    assign = {}
    for b in np.argsort(-sizes):
        f = min(range(N_FOLDS), key=lambda i: load[i])
        assign[int(b)] = f
        load[f] += int(sizes[b])
    return np.array([assign[int(b)] for b in blocks]), "blocks", k


@app.post("/automl/cv")
def automl_cv(req: CvRequest):
    import time
    import numpy as np
    t0 = time.time()
    if len(req.rows) < 30:
        raise HTTPException(status_code=400, detail="at least 30 rows are needed")
    if not req.features or any(len(r.x) != len(req.features) for r in req.rows):
        raise HTTPException(status_code=400, detail="every row needs one value per feature")
    if not _busy.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="a model is already training; try again in a few minutes")
    try:
        from autogluon.tabular import TabularPredictor
        # Feature names become column names; keep them unique and apart from the label.
        cols = [f"f{i}" for i in range(len(req.features))]
        df = pd.DataFrame([r.x for r in req.rows], columns=cols, dtype="float64")
        df["__y"] = [r.y for r in req.rows]
        folds, grouping, n_groups = _fold_groups(req.rows, req.split)

        oof = np.full(len(df), np.nan)
        fold_out, imp_runs, model_runs = [], [], []
        for f in range(N_FOLDS):
            test_mask = folds == f
            if test_mask.sum() < 5 or (~test_mask).sum() < 20:
                continue
            train, test = df[~test_mask], df[test_mask]
            tmp = tempfile.mkdtemp(prefix="ag_cv_")
            try:
                pred = TabularPredictor(label="__y", problem_type="regression", eval_metric="r2",
                                        path=tmp, verbosity=0).fit(
                    train, time_limit=FOLD_TIME, presets="medium_quality",
                    excluded_model_types=["NN_TORCH", "FASTAI"],
                )
                p = pred.predict(test).to_numpy()
                oof[test_mask] = p
                yt = test["__y"].to_numpy()
                fold_out.append({
                    "fold": f, "n_test": int(test_mask.sum()),
                    "held_out": sorted({req.rows[i].state or "" for i in np.where(test_mask)[0]})
                                if grouping == "states" else None,
                    "r2": _r2(yt, p, train["__y"].mean()),
                    "rmse": _safe_float(float(np.sqrt(np.mean((yt - p) ** 2)))),
                    "best_model": str(pred.model_best),
                })
                model_runs.append(str(pred.model_best))
                try:
                    fi = pred.feature_importance(test, num_shuffle_sets=3,
                                                 subsample_size=min(1000, len(test)), silent=True)
                    imp_runs.append(fi["importance"].to_dict())
                except Exception:
                    traceback.print_exc()
            finally:
                shutil.rmtree(tmp, ignore_errors=True)

        if not fold_out:
            raise HTTPException(status_code=422, detail="no fold had enough counties to score")
        y = df["__y"].to_numpy()
        ok = ~np.isnan(oof)
        # Overall out-of-fold R2 against the GRAND mean: a model that only learns
        # each state's level would still score here, so the per-fold R2 (each
        # against its own training mean) is reported beside it.
        overall = _r2(y[ok], oof[ok], float(y[ok].mean()))
        importance = []
        for i, name in enumerate(req.features):
            vals = [run.get(cols[i]) for run in imp_runs if run.get(cols[i]) is not None]
            importance.append({
                "feature": name,
                "importance": _safe_float(float(np.mean(vals))) if vals else None,
                "spread": _safe_float(float(np.std(vals))) if len(vals) > 1 else None,
                "folds": len(vals),
            })
        importance.sort(key=lambda d: -(d["importance"] or -1e9))
        idx = np.where(ok)[0]
        sample = np.random.default_rng(7).choice(idx, size=min(300, len(idx)), replace=False)
        from collections import Counter
        return {
            "cv": {
                "split": req.split, "grouping": grouping, "groups": n_groups, "folds": len(fold_out),
                "min_groups": MIN_GROUPS, "r2": overall,
                "r2_fold_mean": _safe_float(float(np.mean([f["r2"] for f in fold_out if f["r2"] is not None]))),
                "rmse": _safe_float(float(np.sqrt(np.mean((y[ok] - oof[ok]) ** 2)))),
                "baseline_rmse": _safe_float(float(np.std(y[ok]))),
                "scored": int(ok.sum()), "seconds_per_fold": FOLD_TIME,
            },
            "folds": fold_out,
            "importance": importance,
            "models": dict(Counter(model_runs)),
            "oof": [{"id": req.rows[i].id, "pred": _safe_float(float(oof[i]))} for i in idx],
            "sample": [{"id": req.rows[i].id, "actual": _safe_float(float(y[i])),
                        "predicted": _safe_float(float(oof[i]))} for i in sample],
            "ms": int((time.time() - t0) * 1000),
        }
    finally:
        _busy.release()


def _r2(y, p, ref_mean):
    import numpy as np
    ss = float(np.sum((y - ref_mean) ** 2))
    return _safe_float(1 - float(np.sum((y - p) ** 2)) / ss) if ss else None


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
    print("  POST /automl/train: Train models on CSV")
    print("  GET  /health: Health check")
    print("=" * 60)

    uvicorn.run(app, host="0.0.0.0", port=8000)
