"""Hybrid model: Model B (event tracker) corrected by Model A (snapshot classifier).

Model B is accurate as long as it sees every switch, but it has to *start* somewhere and it needs a way
back if a switch is missed. In plain Model B both are handled by physics (closest consistent combination,
preferring few changes). In the hybrid, Model A decides instead:

- at start-up, the initial state is Model A's prediction for the first reading;
- whenever the power-sum check finds the tracked state inconsistent for a while, the state is reset to
  Model A's prediction for the current reading.

Between those moments, Model B's event logic is in charge.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .evaluation import combo_to_labels
from .features import features_from_window


class ModelACorrector:
    """Callable used by `EventTracker(corrector=...)`: returns Model A's state for one reading."""

    def __init__(self, model, feature_columns: list[str], target: str = "combo"):
        self.model = model
        self.feature_columns = list(feature_columns)
        self.target = target

    def predict_state(self, power_W: float, current_A: float, pf: float) -> np.ndarray:
        # the snapshot feature sets only need the current reading (window of length 1)
        f = features_from_window(np.array([[power_W, current_A, pf]]))
        X = pd.DataFrame([[f[c] for c in self.feature_columns]], columns=self.feature_columns)
        pred = self.model.predict(X)
        if self.target == "combo":
            return combo_to_labels(pred)[0]
        return np.asarray(pred, int)[0]

    def __call__(self, power_W, current_A, pf, state=None) -> np.ndarray:
        return self.predict_state(power_W, current_A, pf)
