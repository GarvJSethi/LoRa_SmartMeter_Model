"""Re-create models/final_model.joblib (the selected hybrid model) from the tuned settings.

Reads the model description in models/final_model.json (written by the last model-selection notebook),
trains on all training blocks and saves the model used by realtime/live_predict.py.

Usage:
    python scripts/build_final_model.py
"""
import json
import sys
import warnings
from pathlib import Path

import joblib
import optuna
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.config import APPLIANCES, MODELS_DIR  # noqa: E402
from src.data_loader import load_events, load_labelled  # noqa: E402
from src.evaluation import labels_to_combo  # noqa: E402
from src.event_model import block_sequences, event_training_table, make_tracker  # noqa: E402
from src.features import FEATURE_SETS, build_features  # noqa: E402
from src.hybrid import ModelACorrector  # noqa: E402
from src.models import build_from_params  # noqa: E402


def main():
    warnings.filterwarnings("ignore")
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    final_meta = json.loads((MODELS_DIR / "final_model.json").read_text())
    meta_a, meta_b = final_meta["model_a"], final_meta["model_b"]
    version = int(final_meta.get("tracker_version", 2))

    df = load_labelled()
    seqs = block_sequences(df)
    table = event_training_table(seqs, load_events(), max_lag=3)

    # Model A on all training blocks (features computed inside each block, as live)
    parts = []
    for b, s in seqs.items():
        if b == "F_test":
            continue
        F = build_features(s.assign(source_file="seq"), group_col="source_file")
        parts.append(pd.concat([s, F.drop(columns=["power_W", "current_A", "pf"])], axis=1))
    train = pd.concat(parts, ignore_index=True)
    cols = FEATURE_SETS[meta_a["feature_set"]]
    model_a = build_from_params(meta_a["model"], meta_a["params"], "combo")
    model_a.fit(train[cols], labels_to_combo(train[APPLIANCES].to_numpy()))

    # Model B (event tracker) with Model A as corrector = hybrid
    final = make_tracker(optuna.trial.FixedTrial(meta_b["params"]), meta_b["classifier"],
                         df[df.split == "train"], table[table.block != "F_test"],
                         corrector=ModelACorrector(model_a, cols), version=version)
    final.reset()
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(final, MODELS_DIR / "final_model.joblib")
    print(f"Saved {MODELS_DIR / 'final_model.joblib'}  ({final_meta['name']}, tracker v{version})")


if __name__ == "__main__":
    main()
