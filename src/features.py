"""Feature engineering shared by offline training and real-time inference.

Design rules
------------
1. **Causal**: a feature at sample t only uses samples <= t (nothing from the future), so the
   exact same value can be computed live.
2. **One implementation**: every feature is computed by `features_from_window`, which only sees
   the last `WINDOW` samples. Offline we slide that window over each recording; live we keep the
   last `WINDOW` samples in a buffer. Both paths therefore give identical features.
3. **Appliance properties only**: power, current and power factor. Voltage, frequency, energy and
   the sample counter are not used.

All windows are counted in samples of the 5-second log (1 sample = 5 s). A live 1-second stream is
downsampled to the same 5-second grid before calling these functions.
"""
from __future__ import annotations

from collections import deque

import numpy as np
import pandas as pd

WINDOW = 120            # samples of history kept (= 10 minutes at 5 s per sample)
STEP_THRESHOLD_W = 40   # a power change larger than this between two samples is a "step" (switch)
NO_LOAD_W = 15          # below this the power factor reading is noise
CURRENT_OFFSET_A = 0.098

INPUT_COLUMNS = ["power_W", "current_A", "pf"]

# ---------------------------------------------------------------- feature groups
BASE = ["power_W", "current_A", "pf"]
INSTANT = ["pf_clean", "current_net_A", "q_est_var"]
ROLLING = [
    "dP_1", "dP_2",
    "P_mean_3", "P_std_3", "P_mean_6", "P_std_6", "P_mean_12", "P_std_12",
    "P_min_12", "P_max_12", "P_slope_6", "pf_mean_6",
]
EVENT = [
    "last_up_step_W", "last_up_surge_W", "last_up_pf_change", "samples_since_up",
    "post_up_drift_W", "last_down_step_W", "samples_since_down",
]

COMPACT_HISTORY = ["pf_mean_6", "P_std_3", "dP_1"]   # short (<= 30 s) history only

FEATURE_SETS = {
    "snapshot": BASE,                                  # one reading only
    "snapshot_plus": BASE + INSTANT,                   # one reading + derived quantities
    "compact_history": BASE + INSTANT + COMPACT_HISTORY,  # + a few short-history features
    "rolling": BASE + INSTANT + ROLLING,               # + all short history statistics
    "full": BASE + INSTANT + ROLLING + EVENT,          # + memory of the last switch events
}
ALL_FEATURES = FEATURE_SETS["full"]


def _clean_pf(p: np.ndarray, pf: np.ndarray) -> np.ndarray:
    return np.where(np.abs(p) > NO_LOAD_W, np.clip(pf, 0.0, 1.0), 0.0)


def features_from_window(win: np.ndarray) -> dict:
    """Compute all features for the LAST row of `win`.

    win: array of shape (n, 3) with columns power_W, current_A, pf (oldest first), n >= 1.
    Only the last WINDOW rows are used.
    """
    win = np.asarray(win, dtype=float)[-WINDOW:]
    P, I, PF = win[:, 0], win[:, 1], win[:, 2]
    n = len(P)
    t = n - 1
    pfc = _clean_pf(P, PF)
    f: dict[str, float] = {}

    # --- base and instantaneous
    f["power_W"], f["current_A"], f["pf"] = P[t], I[t], PF[t]
    f["pf_clean"] = pfc[t]
    f["current_net_A"] = max(I[t] - CURRENT_OFFSET_A, 0.0)
    if pfc[t] > 0:
        f["q_est_var"] = P[t] * np.tan(np.arccos(np.clip(pfc[t], 0.5, 1.0)))
    else:
        f["q_est_var"] = 0.0

    # --- short history
    f["dP_1"] = P[t] - P[t - 1] if n >= 2 else 0.0
    f["dP_2"] = P[t] - P[t - 2] if n >= 3 else f["dP_1"]
    for k in (3, 6, 12):
        seg = P[-k:]
        f[f"P_mean_{k}"] = seg.mean()
        f[f"P_std_{k}"] = seg.std(ddof=0)
    f["P_min_12"], f["P_max_12"] = P[-12:].min(), P[-12:].max()
    seg = P[-6:]
    f["P_slope_6"] = np.polyfit(np.arange(len(seg)), seg, 1)[0] if len(seg) >= 3 else 0.0
    f["pf_mean_6"] = pfc[-6:].mean()

    # --- memory of the most recent switch events inside the window
    dP = np.diff(P)                       # dP[j] = P[j+1] - P[j]  (step that appears at sample j+1)
    up = np.where(dP > STEP_THRESHOLD_W)[0]
    down = np.where(dP < -STEP_THRESHOLD_W)[0]

    if len(up):
        i = up[-1] + 1                    # sample where the up-step first shows
        before = P[i - 1]
        settled_idx = min(i + 2, t)       # level 10 s after the step (or now, if not yet available)
        f["last_up_step_W"] = P[settled_idx] - before
        f["last_up_surge_W"] = P[i] - P[settled_idx]
        f["last_up_pf_change"] = pfc[settled_idx] - pfc[i - 1]
        f["samples_since_up"] = float(t - i)
        f["post_up_drift_W"] = P[t] - P[min(i + 1, t)]
    else:
        f["last_up_step_W"] = f["last_up_surge_W"] = f["last_up_pf_change"] = 0.0
        f["samples_since_up"] = float(WINDOW)
        f["post_up_drift_W"] = 0.0

    if len(down):
        j = down[-1] + 1
        f["last_down_step_W"] = P[j] - P[j - 1]
        f["samples_since_down"] = float(t - j)
    else:
        f["last_down_step_W"] = 0.0
        f["samples_since_down"] = float(WINDOW)

    return {k: float(f[k]) for k in ALL_FEATURES}


def build_features(df: pd.DataFrame, group_col: str = "source_file") -> pd.DataFrame:
    """Slide the window over every recording (group) and return one feature row per sample.

    `df` must be sorted in time order inside each group. The result has the same index as `df`.
    """
    out = []
    for _, g in df.groupby(group_col, observed=True, sort=False):
        arr = g[INPUT_COLUMNS].to_numpy(dtype=float)
        rows = [features_from_window(arr[max(0, k - WINDOW + 1): k + 1]) for k in range(len(arr))]
        out.append(pd.DataFrame(rows, index=g.index))
    return pd.concat(out).loc[df.index, ALL_FEATURES]


class StreamingFeatureBuilder:
    """Real-time version: push one reading at a time, get the feature vector for it."""

    def __init__(self, window: int = WINDOW):
        self.buffer: deque = deque(maxlen=window)

    def reset(self) -> None:
        self.buffer.clear()

    def push(self, power_W: float, current_A: float, pf: float) -> dict:
        self.buffer.append((power_W, current_A, pf))
        return features_from_window(np.array(self.buffer))
