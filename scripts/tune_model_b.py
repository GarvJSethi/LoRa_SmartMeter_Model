"""Hyper-parameter tuning for Model B (event-based tracker) with Optuna.

Tracker version 2 (power-sum check always on, second switches inside the settling window start a new
event). Version 1 results are archived in reports/model_b/v1/.

One study per event classifier. Each trial tunes the detector / tracker settings together with the
classifier's own hyper-parameters. Objective: exact match (all 4 appliances correct) when tracking
each held-out training block with a model fitted on the other blocks (leave-one-block-out CV).
The test block is never used here.

Each study runs at least MIN_TRIALS trials, then stops once the best score has not improved for
PATIENCE consecutive trials (hard cap MAX_TRIALS). Finished studies are not re-run (resume after an
interruption); delete reports/model_b/trials/ to start from scratch.

Usage:
    python scripts/tune_model_b.py
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import warnings
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.config import APPLIANCES, RANDOM_STATE  # noqa: E402
from src.data_loader import load_events, load_labelled  # noqa: E402
from src.evaluation import score  # noqa: E402
from src.event_model import EVENT_CLASSIFIERS, block_sequences, event_training_table, make_tracker  # noqa: E402

OUT_DIR = ROOT / "reports" / "model_b"
TRIALS_DIR = OUT_DIR / "trials"
MIN_TRIALS, PATIENCE, MAX_TRIALS = 100, 30, 250


def load():
    df = load_labelled()
    events = load_events()
    seqs = block_sequences(df)
    table = event_training_table(seqs, events, max_lag=3)
    return df, seqs, table


def lobo_track(trial, clf_key, df, seqs, table, report=None):
    """Leave-one-block-out tracking on the training blocks. Returns (y_true, y_pred)."""
    blocks = [b for b in seqs if b != "F_test"]
    Y, P = [], []
    for step, b in enumerate(blocks):
        train_df = df[(df.split == "train") & (df.block != b)]
        tab = table[(table.block != b) & (table.block != "F_test")]
        tracker = make_tracker(trial, clf_key, train_df, tab)
        seq = seqs[b]
        Y.append(seq[APPLIANCES].to_numpy(int))
        P.append(tracker.run(seq))
        if report is not None:
            report(np.vstack(Y), np.vstack(P), step)
    return np.vstack(Y), np.vstack(P)


def _clean(v):
    """Restore Python types for a parameter read back from a trials CSV."""
    if isinstance(v, float) and np.isnan(v):
        return None
    if isinstance(v, np.bool_):
        return bool(v)
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.floating):
        return float(v)
    if isinstance(v, str):
        if v in ("True", "False"):
            return v == "True"
        try:
            return float(v)
        except ValueError:
            return v
    return v


def summarise(clf_key, trials: pd.DataFrame) -> dict:
    done = trials[trials.state == "COMPLETE"]
    best = done.loc[done["value"].idxmax()]
    params = {c[len("params_"):]: _clean(best[c]) for c in trials.columns if c.startswith("params_")}
    params = {k: v for k, v in params.items() if v is not None}
    attrs = {c[len("user_attrs_"):]: float(best[c]) for c in trials.columns if c.startswith("user_attrs_")}
    start = pd.to_datetime(trials.datetime_start).min()
    end = pd.to_datetime(trials.datetime_complete).max()
    return {
        "classifier": clf_key,
        "classifier_name": EVENT_CLASSIFIERS[clf_key][0],
        "cv_exact_match": float(best["value"]),
        **{f"cv_{k}": v for k, v in attrs.items() if k != "exact_match"},
        "best_params": json.dumps(params),
        "n_trials": int(len(trials)),
        "n_pruned": int((trials.state == "PRUNED").sum()),
        "best_trial_number": int(best["number"]),
        "tuning_seconds": round((end - start).total_seconds(), 1),
    }


def run_study(clf_key, min_trials, patience, max_trials):
    import optuna

    warnings.filterwarnings("ignore")
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    trials_file = TRIALS_DIR / f"{clf_key}.csv"
    if trials_file.exists():
        return summarise(clf_key, pd.read_csv(trials_file))

    df, seqs, table = load()

    def objective(trial):
        def report(Y, P, step):
            trial.report(float((Y == P).all(axis=1).mean()), step)
            if trial.should_prune():
                raise optuna.TrialPruned()

        Y, P = lobo_track(trial, clf_key, df, seqs, table, report)
        m = score(Y, P)
        for k, v in m.items():
            trial.set_user_attr(k, v)
        return m["exact_match"]

    def plateau_stop(study, trial):
        done = [t for t in study.trials if t.state.is_finished()]
        try:
            best_no = study.best_trial.number
        except ValueError:
            return
        if len(done) >= min_trials and trial.number - best_no >= patience:
            study.stop()

    study = optuna.create_study(
        direction="maximize",
        sampler=optuna.samplers.TPESampler(seed=RANDOM_STATE),
        pruner=optuna.pruners.MedianPruner(n_startup_trials=10, n_warmup_steps=4),
        study_name=clf_key,
    )
    study.optimize(objective, n_trials=max(max_trials, min_trials), callbacks=[plateau_stop])
    TRIALS_DIR.mkdir(parents=True, exist_ok=True)
    study.trials_dataframe().to_csv(trials_file, index=False)
    return summarise(clf_key, pd.read_csv(trials_file))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--min-trials", type=int, default=MIN_TRIALS)
    ap.add_argument("--patience", type=int, default=PATIENCE)
    ap.add_argument("--max-trials", type=int, default=MAX_TRIALS)
    ap.add_argument("--classifiers", nargs="*", default=list(EVENT_CLASSIFIERS))
    args = ap.parse_args()
    print(f"Trials per study: min {args.min_trials}, stop after {args.patience} trials without improvement, "
          f"max {args.max_trials}", flush=True)

    t0 = time.time()
    results = []
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(run_study, c, args.min_trials, args.patience, args.max_trials): c
                for c in args.classifiers}
        for i, fut in enumerate(as_completed(futs), 1):
            c = futs[fut]
            try:
                r = fut.result()
                results.append(r)
                print(f"[{i}/{len(futs)}] {c:20s} CV exact={r['cv_exact_match']:.3f}  trials={r['n_trials']} "
                      f"({r['n_pruned']} pruned) best@{r['best_trial_number']}  {r['tuning_seconds']:.0f}s",
                      flush=True)
            except Exception as e:  # keep the other studies running
                print(f"[{i}/{len(futs)}] FAILED {c}: {e!r}", flush=True)

    res = pd.DataFrame(results).sort_values("cv_exact_match", ascending=False)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    res.to_csv(OUT_DIR / "tuning_results.csv", index=False)
    print(f"Done in {(time.time() - t0) / 60:.1f} min. Saved {OUT_DIR.relative_to(ROOT) / 'tuning_results.csv'}")
    print(res[["classifier", "cv_exact_match", "cv_macro_f1", "n_trials"]].to_string(index=False))


if __name__ == "__main__":
    main()
