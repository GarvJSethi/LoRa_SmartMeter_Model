"""Model B: event-based appliance tracking.

Instead of guessing the appliance combination from each reading, Model B watches for *switch events*
(jumps in power), decides which appliance caused each jump, and keeps an ON/OFF state per appliance.

Pipeline for every new sample (works online, one sample at a time):

1. **Event detector**: |P(t) - P(t-1)| > `threshold_W`  ->  a switch started at t.
   Further jumps during the next `lag` samples belong to the same event (e.g. the straightener's
   surge followed by its fall), so they do not trigger new events.
2. **Event classifier**: describes the event (settled step size, surge, power-factor change, ...)
   and predicts which appliance caused it. A provisional decision is made immediately and refined
   on each of the next `lag` samples as the power settles.
3. **State tracker**: an ON event can only belong to an appliance that is OFF, an OFF event only to
   one that is ON. The most probable *feasible* appliance is switched.
4. **Power-sum check** (optional): if the measured power stays inconsistent with the sum of the
   appliances believed to be ON, the state is re-synchronised to the closest consistent combination
   (preferring the fewest changes). In the hybrid model (notebook 06) Model A provides this correction.
"""
from __future__ import annotations

import itertools

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.preprocessing import StandardScaler

from .config import APPLIANCES
from .features import NO_LOAD_W

COMBOS = np.array(list(itertools.product([0, 1], repeat=4)), dtype=int)  # 16 x 4, same order as '0000'..'1111'
APPLIANCE_LABEL = {"Hair dryer": 0, "Hair straightener": 1, "200W bulb": 2, "100W bulb": 3}

EVENT_FEATURES = [
    "step_W", "abs_step_W", "surge_W", "surge_ratio", "pf_before", "pf_after", "pf_change",
    "q_change_var", "power_before_W", "samples_after",
]


# ---------------------------------------------------------------- helpers
def clean_pf(P, PF):
    P, PF = np.asarray(P, float), np.asarray(PF, float)
    return np.where(np.abs(P) > NO_LOAD_W, np.clip(PF, 0.0, 1.0), 0.0)


def _q(p, pf):
    return p * np.tan(np.arccos(np.clip(pf, 0.5, 1.0))) if pf > 0 else 0.0


def event_features(P, PFc, t0: int, s: int) -> list[float]:
    """Features of an event that first shows at index t0, using data up to index s (t0 <= s)."""
    before, first, after = P[t0 - 1], P[t0], P[s]
    step = after - before
    pf_b, pf_a = PFc[t0 - 1], PFc[s]
    return [
        step, abs(step), first - after, (first - after) / max(abs(step), 1.0),
        pf_b, pf_a, pf_a - pf_b, _q(after, pf_a) - _q(before, pf_b), before, float(s - t0),
    ]


def block_sequences(df: pd.DataFrame) -> dict:
    """{block: DataFrame sorted by counter} - each protocol block is tracked as its own sequence."""
    return {b: g.sort_values("counter").reset_index(drop=True) for b, g in df.groupby("block", observed=True)}


def event_training_table(seqs: dict, events: pd.DataFrame, max_lag: int = 3) -> pd.DataFrame:
    """One row per (true switch event, samples_after in 0..max_lag) with event features and the appliance.

    Rows for every samples_after value let the classifier make calibrated provisional decisions
    before the power has fully settled.
    """
    rows = []
    for block, seq in seqs.items():
        P = seq["power_W"].to_numpy(float)
        PFc = clean_pf(P, seq["pf"].to_numpy(float))
        ev = events[events.block == block]
        pos = {c: i for i, c in enumerate(seq["counter"])}
        for e in ev.itertuples():
            i = pos.get(e.counter)
            if i is None or i == 0:          # switch before the first logged sample: no "before" level
                continue
            for k in range(max_lag + 1):
                s = min(i + k, len(P) - 1)
                rows.append([block, e.counter, APPLIANCE_LABEL[e.appliance], 1 if e.action == "ON" else 0, k]
                            + event_features(P, PFc, i, s))
    cols = ["block", "counter", "appliance", "is_on", "k"] + EVENT_FEATURES
    return pd.DataFrame(rows, columns=cols)


# ---------------------------------------------------------------- physics profile
class ApplianceProfile:
    """Steady-state power range of each appliance, learned from single-appliance training samples."""

    def __init__(self, margin_W: float = 10.0):
        self.margin_W = margin_W

    def fit(self, df: pd.DataFrame):
        steady = df[(df.transition == 0) & (df.dryer_medium_setting == 0)]
        lo, hi, typ = [], [], []
        for a in APPLIANCES:
            alone = steady[(steady[a] == 1) & (steady[APPLIANCES].sum(axis=1) == 1)]["power_W"]
            lo.append(alone.min()); hi.append(alone.max()); typ.append(alone.median())
        off = steady[steady[APPLIANCES].sum(axis=1) == 0]["power_W"]
        self.lo_, self.hi_, self.typical_ = np.array(lo), np.array(hi), np.array(typ)
        self.off_lo_, self.off_hi_ = off.min(), off.max()
        # expected power interval of every combination
        self.combo_lo_ = COMBOS @ self.lo_ + self.off_lo_ - self.margin_W
        self.combo_hi_ = COMBOS @ self.hi_ + self.off_hi_ + self.margin_W
        return self

    def residual(self, P: float, combo_idx=None) -> np.ndarray | float:
        """Distance (W) from P to each combination's power interval (0 = consistent)."""
        lo, hi = self.combo_lo_, self.combo_hi_
        if combo_idx is not None:
            lo, hi = lo[combo_idx], hi[combo_idx]
        return np.maximum(np.maximum(lo - P, P - hi), 0.0)

    def resync(self, P: float, current: np.ndarray, change_cost_W: float) -> np.ndarray:
        """Closest consistent combination, preferring few changes from `current`."""
        cost = self.residual(P) + change_cost_W * np.abs(COMBOS - current).sum(axis=1)
        return COMBOS[int(np.argmin(cost))].copy()


def combo_index(state) -> int:
    return int("".join(str(int(v)) for v in state), 2)


# ---------------------------------------------------------------- rule-based event classifier
class NearestCentroidProba(BaseEstimator, ClassifierMixin):
    """Rule-like baseline: each appliance is represented by the mean of its (scaled) event features;
    an event is assigned to the closest one. Probabilities = softmax of negative distances."""

    def __init__(self, temperature: float = 1.0):
        self.temperature = temperature

    def fit(self, X, y):
        self.scaler_ = StandardScaler().fit(X)
        Z = self.scaler_.transform(X)
        y = np.asarray(y)
        self.classes_ = np.unique(y)
        self.centroids_ = np.array([Z[y == c].mean(axis=0) for c in self.classes_])
        return self

    def predict_proba(self, X):
        Z = self.scaler_.transform(X)
        d = np.linalg.norm(Z[:, None, :] - self.centroids_[None], axis=2)
        logits = -d / max(self.temperature, 1e-6)
        logits -= logits.max(axis=1, keepdims=True)
        p = np.exp(logits)
        return p / p.sum(axis=1, keepdims=True)

    def predict(self, X):
        return self.classes_[self.predict_proba(X).argmax(axis=1)]


# ---------------------------------------------------------------- online tracker
class EventTracker:
    """Online Model B. Call `step(power_W, current_A, pf)` for every new sample; it returns the state."""

    def __init__(self, classifier, profile: ApplianceProfile, threshold_W: float = 40.0, lag: int = 2,
                 self_correct: bool = True, tolerance_W: float = 40.0, persist: int = 2,
                 change_cost_W: float = 30.0, corrector=None, split_events: bool = True):
        self.clf = classifier
        self.profile = profile
        self.threshold_W, self.lag = threshold_W, lag
        self.self_correct, self.tolerance_W, self.persist = self_correct, tolerance_W, persist
        self.change_cost_W = change_cost_W
        self.corrector = corrector    # optional callable(P, I, PF, state) -> state  (hybrid with Model A)
        # v2: a new jump during the settling window starts a new event (unless it is a surge fading away)
        self.split_events = split_events
        self.reset()

    def reset(self):
        self.P, self.PFc, self.I, self.PF = [], [], [], []
        self.state = np.zeros(4, int)
        self.pending = None
        self.last_event = -10**9
        self.bad = 0
        self.log = []                 # (index, kind, appliance or None)

    # -- internals
    def _decide(self, t0: int, s: int, before_state: np.ndarray) -> np.ndarray:
        P, PFc = np.asarray(self.P), np.asarray(self.PFc)
        feats = np.array([event_features(P, PFc, t0, s)])
        step = feats[0, 0]
        if abs(step) < self._min_step_W():            # jump disappeared again / too small: no real switch
            return before_state.copy()
        feasible = (before_state == 0) if step > 0 else (before_state == 1)
        if not feasible.any():
            return before_state.copy()
        proba = np.zeros(4)
        p = self.clf.predict_proba(pd.DataFrame(feats, columns=EVENT_FEATURES))[0]
        proba[np.asarray(self.clf.classes_, int)] = p
        proba = np.where(feasible, proba + 1e-9, -1.0)
        k = int(np.argmax(proba))
        new = before_state.copy()
        new[k] = 1 if step > 0 else 0
        return new

    def _min_step_W(self) -> float:
        """Smallest settled step accepted as a switch.

        v1: half the detection threshold. v2: also at least half of the smallest appliance's learned
        power, so power wobble (e.g. the dryer's +-40 W) is never mistaken for a switch.
        """
        if not self.split_events:
            return self.threshold_W / 2
        return max(self.threshold_W / 2, 0.5 * float(np.min(self.profile.lo_)))

    def _new_jump_in_window(self, t: int) -> bool:
        """True if sample t shows a second switch inside the settling window of the pending event.

        A drop after an upward event is NOT a new switch while power stays above the pre-event level:
        that is the straightener's switch-on surge fading away.
        """
        if not self.split_events:
            return False
        jump = self.P[t] - self.P[t - 1]
        if abs(jump) <= self.threshold_W:
            return False
        t0 = self.pending["t0"]
        up_event = self.P[t0] - self.P[t0 - 1] > 0
        surge_fading = up_event and jump < 0 and self.P[t] - self.P[t0 - 1] > self.threshold_W / 2
        return not surge_fading

    def _resync(self, t: int) -> np.ndarray:
        if self.corrector is not None:
            return np.asarray(self.corrector(self.P[t], self.I[t], self.PF[t], self.state), int)
        return self.profile.resync(self.P[t], self.state, self.change_cost_W)

    # -- public
    def step(self, power_W: float, current_A: float, pf: float) -> np.ndarray:
        self.P.append(float(power_W)); self.I.append(float(current_A)); self.PF.append(float(pf))
        self.PFc.append(float(clean_pf([power_W], [pf])[0]))
        t = len(self.P) - 1

        if t == 0:                                   # initial state from the first reading
            self.state = self._resync(0) if self.corrector is not None else \
                self.profile.resync(power_W, np.zeros(4, int), self.change_cost_W)
            return self.state.copy()

        if self.pending is not None and t - self.pending["t0"] <= self.lag and self._new_jump_in_window(t):
            # close the current event with the data before this jump, then start a new event at t
            self.state = self._decide(self.pending["t0"], t - 1, self.pending["before"])
            self.log.append((self.pending["t0"], "event", self.state.copy()))
            self.pending = {"t0": t, "before": self.state.copy()}
            self.last_event = t
            self.state = self._decide(t, t, self.pending["before"])
        elif self.pending is not None and t - self.pending["t0"] <= self.lag:
            self.state = self._decide(self.pending["t0"], t, self.pending["before"])
            if t - self.pending["t0"] == self.lag:
                self.log.append((self.pending["t0"], "event", self.state.copy()))
                self.pending = None
        elif abs(self.P[t] - self.P[t - 1]) > self.threshold_W and t - self.last_event > self.lag:
            self.pending = {"t0": t, "before": self.state.copy()}
            self.last_event = t
            self.state = self._decide(t, t, self.pending["before"])
        elif self.self_correct:
            if self.profile.residual(self.P[t], combo_index(self.state)) > self.tolerance_W:
                self.bad += 1
            else:
                self.bad = 0
            if self.bad >= self.persist:
                new = self._resync(t)
                if not np.array_equal(new, self.state):
                    self.log.append((t, "resync", new.copy()))
                self.state = new
                self.bad = 0
        return self.state.copy()

    def run(self, seq: pd.DataFrame) -> np.ndarray:
        """Track a whole sequence (offline evaluation). Returns an (n, 4) state matrix."""
        self.reset()
        return np.array([self.step(p, i, pf) for p, i, pf in seq[["power_W", "current_A", "pf"]].to_numpy()])


def detected_events(P, threshold_W: float, lag: int) -> list[int]:
    """Indices where the detector fires (same rule as EventTracker)."""
    out, last = [], -10**9
    for t in range(1, len(P)):
        if abs(P[t] - P[t - 1]) > threshold_W and t - last > lag:
            out.append(t); last = t
    return out


def event_detection_scores(seqs: dict, events: pd.DataFrame, threshold_W: float, lag: int, tol: int = 1) -> dict:
    """Precision / recall of the event detector against the true switch events (+-tol samples)."""
    tp = fp = fn = 0
    for block, seq in seqs.items():
        P = seq["power_W"].to_numpy(float)
        det = detected_events(P, threshold_W, lag)
        pos = {c: i for i, c in enumerate(seq["counter"])}
        true = [pos[c] for c in events[events.block == block]["counter"] if pos.get(c, 0) > 0]
        used = set()
        for d in det:
            match = [j for j, ti in enumerate(true) if abs(ti - d) <= tol and j not in used]
            if match:
                used.add(match[0]); tp += 1
            else:
                fp += 1
        fn += len(true) - len(used)
    return {"precision": tp / max(tp + fp, 1), "recall": tp / max(tp + fn, 1), "tp": tp, "fp": fp, "fn": fn}


# ---------------------------------------------------------------- search spaces (Optuna)
def tracker_params(trial, version: int = 2) -> dict:
    """Hyper-parameters of the detector / tracker / power-sum check.

    version 1: the power-sum check could be switched off and second switches inside the settling
               window were ignored.
    version 2: the power-sum check is always on and second switches start a new event.
    """
    p = {
        "threshold_W": trial.suggest_float("threshold_W", 25.0, 100.0),
        "lag": trial.suggest_int("lag", 1, 3),
        "self_correct": trial.suggest_categorical("self_correct", [True, False]) if version == 1 else True,
        "margin_W": trial.suggest_float("margin_W", 0.0, 40.0),
    }
    if p["self_correct"]:
        p["tolerance_W"] = trial.suggest_float("tolerance_W", 5.0, 120.0)
        p["persist"] = trial.suggest_int("persist", 1, 6)
        p["change_cost_W"] = trial.suggest_float("change_cost_W", 5.0, 100.0)
    return p


def _scaled(est):
    from sklearn.pipeline import make_pipeline
    return make_pipeline(StandardScaler(), est)


def build_rule(trial):
    return NearestCentroidProba(temperature=trial.suggest_float("temperature", 0.1, 5.0, log=True))


def build_logreg(trial):
    from sklearn.linear_model import LogisticRegression
    return _scaled(LogisticRegression(C=trial.suggest_float("C", 1e-3, 1e3, log=True), max_iter=5000))


def build_knn(trial):
    from sklearn.neighbors import KNeighborsClassifier
    return _scaled(KNeighborsClassifier(n_neighbors=trial.suggest_int("n_neighbors", 1, 25),
                                        weights=trial.suggest_categorical("weights", ["uniform", "distance"])))


def build_tree(trial):
    from sklearn.tree import DecisionTreeClassifier
    return DecisionTreeClassifier(max_depth=trial.suggest_int("max_depth", 2, 12),
                                  min_samples_leaf=trial.suggest_int("min_samples_leaf", 1, 15), random_state=42)


def build_forest(trial):
    from sklearn.ensemble import RandomForestClassifier
    return RandomForestClassifier(n_estimators=trial.suggest_int("n_estimators", 50, 400, step=50),
                                  max_depth=trial.suggest_int("max_depth", 2, 20),
                                  min_samples_leaf=trial.suggest_int("min_samples_leaf", 1, 10),
                                  max_features=trial.suggest_categorical("max_features", ["sqrt", 0.5, 1.0]),
                                  random_state=42, n_jobs=1)


def build_svm(trial):
    from sklearn.svm import SVC
    return _scaled(SVC(C=trial.suggest_float("C", 1e-2, 1e3, log=True),
                       gamma=trial.suggest_float("gamma", 1e-3, 10.0, log=True),
                       probability=True, random_state=42))


def build_xgb(trial):
    from xgboost import XGBClassifier
    from .models import LabelEncodedClassifier
    return LabelEncodedClassifier(XGBClassifier(
        n_estimators=trial.suggest_int("n_estimators", 50, 300, step=25),
        max_depth=trial.suggest_int("max_depth", 2, 6),
        learning_rate=trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
        subsample=trial.suggest_float("subsample", 0.5, 1.0),
        reg_lambda=trial.suggest_float("reg_lambda", 1e-3, 10.0, log=True),
        tree_method="hist", n_jobs=1, random_state=42, verbosity=0))


EVENT_CLASSIFIERS = {
    "rule": ("Nearest-centroid rule", build_rule),
    "logistic_regression": ("Logistic Regression", build_logreg),
    "knn": ("k-Nearest Neighbours", build_knn),
    "decision_tree": ("Decision Tree", build_tree),
    "random_forest": ("Random Forest", build_forest),
    "svm": ("SVM (RBF kernel)", build_svm),
    "xgboost": ("XGBoost", build_xgb),
}


def make_tracker(trial, clf_key: str, train_df: pd.DataFrame, event_table: pd.DataFrame,
                 corrector=None, version: int = 2) -> EventTracker:
    """Build and fit a tracker from an Optuna trial (or a FixedTrial holding tuned parameters).

    train_df: labelled samples used to learn the appliance power profile.
    event_table: rows from `event_training_table` used to train the event classifier.
    corrector: optional callable used instead of the physics re-sync (hybrid with Model A).
    version: tracker version (see `tracker_params`).
    """
    p = tracker_params(trial, version)
    clf = EVENT_CLASSIFIERS[clf_key][1](trial)
    tab = event_table[event_table.k <= p["lag"]]
    clf.fit(tab[EVENT_FEATURES], tab["appliance"])
    profile = ApplianceProfile(margin_W=p["margin_W"]).fit(train_df)
    kw = {k: p[k] for k in ("tolerance_W", "persist", "change_cost_W") if k in p}
    return EventTracker(clf, profile, threshold_W=p["threshold_W"], lag=p["lag"],
                        self_correct=p["self_correct"], corrector=corrector, split_events=(version >= 2), **kw)
