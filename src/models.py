"""Model A: snapshot / short-history classifiers and their hyper-parameter search spaces.

Every model is built by a function `build_<name>(trial)` that takes an Optuna trial (or a
`FixedTrial` with the best parameters) and returns an unfitted scikit-learn compatible estimator.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, ClassifierMixin, clone
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.neighbors import KNeighborsClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import LabelEncoder, StandardScaler
from sklearn.svm import SVC
from sklearn.tree import DecisionTreeClassifier

from .config import RANDOM_STATE

RS = RANDOM_STATE


# ---------------------------------------------------------------- helpers
class LabelEncodedClassifier(BaseEstimator, ClassifierMixin):
    """Wraps a classifier that needs integer class labels 0..k-1 (e.g. XGBoost)."""

    def __init__(self, estimator):
        self.estimator = estimator

    def fit(self, X, y):
        self.le_ = LabelEncoder().fit(y)
        self.classes_ = self.le_.classes_
        self.estimator_ = clone(self.estimator).fit(X, self.le_.transform(y))
        return self

    def predict(self, X):
        return self.le_.inverse_transform(np.asarray(self.estimator_.predict(X)).astype(int).ravel())

    def predict_proba(self, X):
        return self.estimator_.predict_proba(X)


class PowerSumRuleClassifier(BaseEstimator, ClassifierMixin):
    """Physics baseline (no machine learning on combinations).

    Each appliance's typical power is the median power of the training samples where it is the only
    appliance ON. The expected power of a combination is the sum of its appliances' typical powers.
    A sample is assigned to the combination whose expected power (and, optionally, typical power
    factor) is closest:  distance = |P - P_combo| + pf_weight * |PF - PF_combo|.
    Expects a 4-character combo string as target (dryer, straightener, 200 W, 100 W).
    """

    def __init__(self, pf_weight: float = 0.0):
        self.pf_weight = pf_weight

    @staticmethod
    def _cols(X):
        X = pd.DataFrame(X)
        pf_col = "pf_clean" if "pf_clean" in X.columns else "pf"
        return X["power_W"].to_numpy(float), X[pf_col].clip(0, 1).to_numpy(float)

    def fit(self, X, y):
        P, PF = self._cols(X)
        y = np.asarray(y)
        single = {}
        for k in range(4):
            code = "".join("1" if j == k else "0" for j in range(4))
            single[k] = np.median(P[y == code]) if (y == code).any() else 0.0
        self.combos_ = np.array([format(i, "04b") for i in range(16)])
        self.expected_power_ = np.array([sum(single[k] for k in range(4) if c[k] == "1") for c in self.combos_])
        pf_all = np.median(PF[P > 15]) if (P > 15).any() else 1.0
        self.expected_pf_ = np.array([np.median(PF[y == c]) if (y == c).any() else pf_all for c in self.combos_])
        self.expected_pf_[0] = 0.0
        self.classes_ = self.combos_
        return self

    def predict(self, X):
        P, PF = self._cols(X)
        d = np.abs(P[:, None] - self.expected_power_[None, :]) + self.pf_weight * np.abs(PF[:, None] - self.expected_pf_[None, :])
        return self.combos_[d.argmin(axis=1)]


# ---------------------------------------------------------------- search spaces
def build_rule_based(trial):
    return PowerSumRuleClassifier(pf_weight=trial.suggest_float("pf_weight", 0.0, 3000.0))


def build_logistic_regression(trial):
    return make_pipeline(
        StandardScaler(),
        LogisticRegression(
            C=trial.suggest_float("C", 1e-3, 1e3, log=True),
            class_weight=trial.suggest_categorical("class_weight", [None, "balanced"]),
            max_iter=5000,
        ),
    )


def build_knn(trial):
    return make_pipeline(
        StandardScaler(),
        KNeighborsClassifier(
            n_neighbors=trial.suggest_int("n_neighbors", 1, 40),
            weights=trial.suggest_categorical("weights", ["uniform", "distance"]),
            p=trial.suggest_categorical("p", [1, 2]),
        ),
    )


def build_decision_tree(trial):
    return DecisionTreeClassifier(
        max_depth=trial.suggest_int("max_depth", 2, 20),
        min_samples_leaf=trial.suggest_int("min_samples_leaf", 1, 30),
        criterion=trial.suggest_categorical("criterion", ["gini", "entropy"]),
        class_weight=trial.suggest_categorical("class_weight", [None, "balanced"]),
        random_state=RS,
    )


def _forest_params(trial):
    return dict(
        n_estimators=trial.suggest_int("n_estimators", 100, 500, step=50),
        max_depth=trial.suggest_int("max_depth", 3, 30),
        min_samples_leaf=trial.suggest_int("min_samples_leaf", 1, 20),
        max_features=trial.suggest_categorical("max_features", ["sqrt", 0.5, 1.0]),
        class_weight=trial.suggest_categorical("class_weight", [None, "balanced", "balanced_subsample"]),
        random_state=RS,
        n_jobs=1,
    )


def build_random_forest(trial):
    return RandomForestClassifier(**_forest_params(trial))


def build_extra_trees(trial):
    return ExtraTreesClassifier(**_forest_params(trial))


def build_hist_gradient_boosting(trial):
    return HistGradientBoostingClassifier(
        learning_rate=trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
        max_iter=trial.suggest_int("max_iter", 50, 250, step=25),
        max_leaf_nodes=trial.suggest_int("max_leaf_nodes", 4, 63),
        min_samples_leaf=trial.suggest_int("min_samples_leaf", 5, 50),
        l2_regularization=trial.suggest_float("l2_regularization", 1e-3, 10.0, log=True),
        early_stopping=False,
        random_state=RS,
    )


def build_xgboost(trial):
    from xgboost import XGBClassifier

    return LabelEncodedClassifier(
        XGBClassifier(
            n_estimators=trial.suggest_int("n_estimators", 50, 400, step=25),
            max_depth=trial.suggest_int("max_depth", 2, 8),
            learning_rate=trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
            subsample=trial.suggest_float("subsample", 0.5, 1.0),
            colsample_bytree=trial.suggest_float("colsample_bytree", 0.5, 1.0),
            min_child_weight=trial.suggest_float("min_child_weight", 1.0, 10.0),
            reg_lambda=trial.suggest_float("reg_lambda", 1e-3, 10.0, log=True),
            tree_method="hist",
            n_jobs=1,
            random_state=RS,
            verbosity=0,
        )
    )


def build_lightgbm(trial):
    from lightgbm import LGBMClassifier

    return LGBMClassifier(
        n_estimators=trial.suggest_int("n_estimators", 50, 400, step=25),
        num_leaves=trial.suggest_int("num_leaves", 4, 63),
        learning_rate=trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
        min_child_samples=trial.suggest_int("min_child_samples", 5, 50),
        subsample=trial.suggest_float("subsample", 0.5, 1.0),
        subsample_freq=1,
        colsample_bytree=trial.suggest_float("colsample_bytree", 0.5, 1.0),
        reg_lambda=trial.suggest_float("reg_lambda", 1e-3, 10.0, log=True),
        n_jobs=1,
        random_state=RS,
        verbose=-1,
    )


def build_svm(trial):
    return make_pipeline(
        StandardScaler(),
        SVC(
            C=trial.suggest_float("C", 1e-2, 1e3, log=True),
            gamma=trial.suggest_float("gamma", 1e-4, 10.0, log=True),
            class_weight=trial.suggest_categorical("class_weight", [None, "balanced"]),
        ),
    )


def build_mlp(trial):
    n_layers = trial.suggest_int("n_layers", 1, 2)
    units = trial.suggest_int("units", 16, 128, log=True)
    return make_pipeline(
        StandardScaler(),
        MLPClassifier(
            hidden_layer_sizes=(units,) * n_layers,
            alpha=trial.suggest_float("alpha", 1e-5, 1e-1, log=True),
            learning_rate_init=trial.suggest_float("learning_rate_init", 1e-4, 1e-2, log=True),
            max_iter=800,
            random_state=RS,
        ),
    )


def build_from_params(model_key: str, params: dict, target: str = "combo"):
    """Re-create an unfitted model from tuned parameters (e.g. Optuna best_params)."""
    import optuna
    from sklearn.multioutput import MultiOutputClassifier

    est = MODELS[model_key][1](optuna.trial.FixedTrial(params))
    if target == "multilabel":
        return MultiOutputClassifier(est)
    # Combo labels such as "0010" are encoded as integers 0..15 inside the model: recent scikit-learn
    # versions read number-like string labels as numbers in some steps (e.g. class_weight="balanced").
    # The encoding keeps the sorted class order, so the fitted model is identical.
    return LabelEncodedClassifier(est)


MODELS = {
    "rule_based": ("Rule-based (power sum)", build_rule_based),
    "logistic_regression": ("Logistic Regression", build_logistic_regression),
    "knn": ("k-Nearest Neighbours", build_knn),
    "decision_tree": ("Decision Tree", build_decision_tree),
    "random_forest": ("Random Forest", build_random_forest),
    "extra_trees": ("Extra Trees", build_extra_trees),
    "hist_gradient_boosting": ("Gradient Boosting (HistGB)", build_hist_gradient_boosting),
    "xgboost": ("XGBoost", build_xgboost),
    "lightgbm": ("LightGBM", build_lightgbm),
    "svm": ("SVM (RBF kernel)", build_svm),
    "mlp": ("Neural network (MLP)", build_mlp),
}

