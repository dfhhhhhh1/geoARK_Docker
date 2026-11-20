"""Fold assignment for /automl/cv (ml_service.py). Runs inside the automl image:

    docker compose --profile automl run --rm automl python test_ml_cv.py
"""
import numpy as np

from ml_service import CvRow, MIN_GROUPS, N_FOLDS, _fold_groups, _r2


def rows(states, n_per=20):
    out, k = [], 0
    for si, s in enumerate(states):
        for j in range(n_per):
            out.append(CvRow(id=str(k), state=s, lon=-100 + si * 3 + j * 0.01, lat=35 + j * 0.01, y=1.0, x=[1.0]))
            k += 1
    return out


def test_states_never_split():
    rs = rows([f"S{i}" for i in range(12)], n_per=10 + 0)
    folds, grouping, n = _fold_groups(rs, "spatial")
    assert grouping == "states" and n == 12
    for s in {r.state for r in rs}:
        assert len({folds[i] for i, r in enumerate(rs) if r.state == s}) == 1, s
    assert set(folds) == set(range(N_FOLDS))


def test_few_states_use_blocks():
    rs = rows(["A", "B"], n_per=60)
    folds, grouping, k = _fold_groups(rs, "spatial")
    assert grouping == "blocks" and k >= N_FOLDS
    assert len(set(folds)) == N_FOLDS
    assert MIN_GROUPS > 2


def test_random_is_balanced():
    rs = rows([f"S{i}" for i in range(6)], n_per=50)
    folds, grouping, _ = _fold_groups(rs, "random")
    assert grouping == "random"
    counts = np.bincount(folds)
    assert counts.max() - counts.min() <= 1


def test_r2():
    y = np.array([1.0, 2.0, 3.0, 4.0])
    assert _r2(y, y, y.mean()) == 1.0
    assert _r2(y, np.full(4, y.mean()), y.mean()) == 0.0


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
