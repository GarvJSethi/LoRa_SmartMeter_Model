"""Metrics and cross-validation helpers shared by all models."""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, f1_score
from sklearn.model_selection import LeaveOneGroupOut

from .config import APPLIANCES


def combo_to_labels(combos) -> np.ndarray:
    """'0110' -> [0, 1, 1, 0] for an array of combo strings."""
    return np.array([[int(c) for c in s] for s in combos], dtype=int)


def labels_to_combo(y: np.ndarray) -> np.ndarray:
    return np.array(["".join(str(int(v)) for v in row) for row in np.asarray(y)])


def score(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    """Multi-label scores. y_* have shape (n, 4) in APPLIANCES order."""
    y_true, y_pred = np.asarray(y_true, int), np.asarray(y_pred, int)
    out = {
        "exact_match": float((y_true == y_pred).all(axis=1).mean()),
        "hamming_acc": float((y_true == y_pred).mean()),
        "macro_f1": float(np.mean([f1_score(y_true[:, k], y_pred[:, k], zero_division=0) for k in range(4)])),
    }
    for k, a in enumerate(APPLIANCES):
        out[f"acc_{a}"] = float(accuracy_score(y_true[:, k], y_pred[:, k]))
        out[f"f1_{a}"] = float(f1_score(y_true[:, k], y_pred[:, k], zero_division=0))
    return out


def lobo_splits(groups):
    """Leave-one-block-out splits (one protocol block per fold)."""
    return list(LeaveOneGroupOut().split(np.zeros(len(groups)), groups=groups))


def cross_val_predict_labels(make_model, X: pd.DataFrame, y: np.ndarray, groups, fit_target="combo"):
    """Out-of-fold predictions with leave-one-block-out CV.

    make_model: callable returning a fresh, unfitted estimator.
    fit_target: "combo" -> model predicts the 16-class combo string;
                "multilabel" -> model predicts the (n, 4) label matrix directly.
    Returns an (n, 4) prediction matrix.
    """
    y = np.asarray(y, int)
    pred = np.zeros_like(y)
    for tr, va in lobo_splits(groups):
        model = make_model()
        if fit_target == "combo":
            model.fit(X.iloc[tr], labels_to_combo(y[tr]))
            pred[va] = combo_to_labels(model.predict(X.iloc[va]))
        else:
            model.fit(X.iloc[tr], y[tr])
            pred[va] = np.asarray(model.predict(X.iloc[va]), int)
    return pred
