"""Hyper-parameter tuning for Model A (all classifiers x all feature sets) with Optuna.

Objective: share of samples with all 4 appliances correct ("exact match"), measured with
leave-one-block-out cross-validation on the TRAINING blocks only. The test block is never used here.

Each study runs at least MIN_TRIALS trials, then stops once the best score has not improved for
PATIENCE consecutive trials (hard cap MAX_TRIALS). Bad trials are pruned after a few folds.

Stage 1: every model x every feature set, target = 16-class combination.
Stage 2: the 3 best model types (on their best feature set) re-tuned as 4 separate yes/no
         predictions (multilabel framing), to compare the two ways of framing the problem.

Studies that already have a trials file in reports/model_a/trials/ are not re-run (resume after an
interruption); delete that folder to start from scratch.

Usage:
    python scripts/tune_model_a.py                 # full run (or resume)
    python scripts/tune_model_a.py --min-trials 3 --patience 2 --max-trials 3   # quick smoke test
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
from src.data_loader import load_labelled  # noqa: E402
from src.evaluation import combo_to_labels, labels_to_combo, lobo_splits, score  # noqa: E402
from src.features import FEATURE_SETS, build_features  # noqa: E402
from src.models import MODELS  # noqa: E402

OUT_DIR = ROOT / "reports" / "model_a"
TRIALS_DIR = OUT_DIR / "trials"

MIN_TRIALS = 100   # every study runs at least this many trials
PATIENCE = 30      # ...then stops once the best score has not improved for this many trials
MAX_TRIALS = 250   # hard cap

# order matters only for scheduling: slow models first
SLOW_FIRST = ["mlp", "random_forest", "extra_trees", "xgboost", "lightgbm", "hist_gradient_boosting",
              "svm", "knn", "logistic_regression", "decision_tree", "rule_based"]


def load_training_data():
    df = load_labelled()
    feats = build_features(df)
    data = pd.concat([df, feats.drop(columns=["power_W", "current_A", "pf"])], axis=1)
    train = data[data.split == "train"].reset_index(drop=True)
    y = train[APPLIANCES].to_numpy(int)
    groups = train["block"].astype(str).to_numpy()
    return train, y, groups


def _clean_param(v):
    """Restore Python types for a parameter read back from a trials CSV."""
    if isinstance(v, float) and np.isnan(v):
        return None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return v
    return v


def summarise_trials(model_key: str, feature_set: str, target: str, trials: pd.DataFrame,
                     max_trials: int) -> dict:
    """Build the result row of a study from its trials table."""
    done = trials[trials.state == "COMPLETE"]
    best = done.loc[done["value"].idxmax()]
    params = {c[len("params_"):]: _clean_param(best[c]) for c in trials.columns if c.startswith("params_")}
    attrs = {c[len("user_attrs_"):]: float(best[c]) for c in trials.columns if c.startswith("user_attrs_")}
    start = pd.to_datetime(trials["datetime_start"]).min()
    end = pd.to_datetime(trials["datetime_complete"]).max()
    return {
        "model": model_key,
        "model_name": MODELS[model_key][0],
        "feature_set": feature_set,
        "n_features": len(FEATURE_SETS[feature_set]),
        "target": target,
        "cv_exact_match": float(best["value"]),
        **{f"cv_{k}": v for k, v in attrs.items() if k != "exact_match"},
        "best_params": json.dumps(params),
        "n_trials": int(len(trials)),
        "n_pruned": int((trials.state == "PRUNED").sum()),
        "best_trial_number": int(best["number"]),
        "stopped": "max trials" if len(trials) >= max_trials else "plateau",
        "tuning_seconds": round((end - start).total_seconds(), 1),
    }


def run_study(model_key: str, feature_set: str, target: str,
              min_trials: int, patience: int, max_trials: int) -> dict:
    # resume: a study whose trials file already exists has finished, so reuse it
    trials_file = TRIALS_DIR / f"{model_key}__{feature_set}__{target}.csv"
    if trials_file.exists():
        return summarise_trials(model_key, feature_set, target, pd.read_csv(trials_file), max_trials)

    import optuna
    from sklearn.multioutput import MultiOutputClassifier

    warnings.filterwarnings("ignore")
    optuna.logging.set_verbosity(optuna.logging.WARNING)

    train, y, groups = load_training_data()
    X = train[FEATURE_SETS[feature_set]]
    folds = lobo_splits(groups)
    y_combo = labels_to_combo(y)
    _, build = MODELS[model_key]

    def make(trial):
        est = build(trial)
        return MultiOutputClassifier(est, n_jobs=4) if target == "multilabel" else est

    def objective(trial):
        pred = np.zeros_like(y)
        done = np.zeros(len(y), bool)
        for step, (tr, va) in enumerate(folds):
            model = make(trial)
            if target == "combo":
                model.fit(X.iloc[tr], y_combo[tr])
                pred[va] = combo_to_labels(model.predict(X.iloc[va]))
            else:
                model.fit(X.iloc[tr], y[tr])
                pred[va] = np.asarray(model.predict(X.iloc[va]), int)
            done[va] = True
            running = float((pred[done] == y[done]).all(axis=1).mean())
            trial.report(running, step)
            if trial.should_prune():
                raise optuna.TrialPruned()
        m = score(y, pred)
        for k, v in m.items():
            trial.set_user_attr(k, v)
        return m["exact_match"]

    def plateau_stop(study, trial):
        """Stop once min_trials are done and the best score has not improved for `patience` trials."""
        done = [t for t in study.trials if t.state.is_finished()]
        try:
            best_no = study.best_trial.number
        except ValueError:
            return
        if len(done) >= min_trials and trial.number - best_no >= patience:
            study.set_user_attr("stopped", f"plateau (no improvement for {patience} trials)")
            study.stop()

    study = optuna.create_study(
        direction="maximize",
        sampler=optuna.samplers.TPESampler(seed=RANDOM_STATE),
        pruner=optuna.pruners.MedianPruner(n_startup_trials=10, n_warmup_steps=4),
        study_name=f"{model_key}__{feature_set}__{target}",
    )
    study.optimize(objective, n_trials=max(max_trials, min_trials), callbacks=[plateau_stop])

    TRIALS_DIR.mkdir(parents=True, exist_ok=True)
    study.trials_dataframe().to_csv(TRIALS_DIR / f"{study.study_name}.csv", index=False)

    return summarise_trials(model_key, feature_set, target, pd.read_csv(trials_file), max_trials)


def run_jobs(jobs, workers):
    results = []
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(run_study, *job): job for job in jobs}
        for i, fut in enumerate(as_completed(futs), 1):
            job = futs[fut]
            try:
                r = fut.result()
                results.append(r)
                print(f"[{i}/{len(jobs)}] {job[0]:24s} {job[1]:16s} {job[2]:10s} "
                      f"CV exact={r['cv_exact_match']:.3f}  trials={r['n_trials']} ({r['n_pruned']} pruned) "
                      f"best@{r['best_trial_number']}  {r['tuning_seconds']:.0f}s", flush=True)
            except Exception as e:  # keep the other studies running
                print(f"[{i}/{len(jobs)}] FAILED {job}: {e!r}", flush=True)
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--min-trials", type=int, default=MIN_TRIALS)
    ap.add_argument("--patience", type=int, default=PATIENCE)
    ap.add_argument("--max-trials", type=int, default=MAX_TRIALS)
    ap.add_argument("--models", nargs="*", default=None)
    args = ap.parse_args()

    models = args.models or SLOW_FIRST
    budget = (args.min_trials, args.patience, args.max_trials)
    print(f"Trials per study: min {budget[0]}, stop after {budget[1]} trials without improvement, max {budget[2]}")

    # ---- stage 1
    jobs = []
    for m in [k for k in SLOW_FIRST if k in models]:
        fsets = ["snapshot_plus"] if m == "rule_based" else list(FEATURE_SETS)
        jobs += [(m, fs, "combo", *budget) for fs in fsets]
    print(f"Stage 1: {len(jobs)} studies", flush=True)
    t0 = time.time()
    stage1 = run_jobs(jobs, args.workers)

    # ---- stage 2: multilabel framing for the 3 best model types
    s1 = pd.DataFrame(stage1)
    best_per_model = (s1[s1.model != "rule_based"].sort_values("cv_exact_match", ascending=False)
                      .drop_duplicates("model").head(3))
    jobs2 = [(r.model, r.feature_set, "multilabel", *budget) for r in best_per_model.itertuples()]
    print(f"Stage 2: {len(jobs2)} studies", flush=True)
    stage2 = run_jobs(jobs2, args.workers)

    res = pd.DataFrame(stage1 + stage2).sort_values("cv_exact_match", ascending=False)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    res.to_csv(OUT_DIR / "tuning_results.csv", index=False)
    print(f"Done in {(time.time() - t0) / 60:.1f} min. Saved {OUT_DIR / 'tuning_results.csv'}")
    print(res[["model", "feature_set", "target", "cv_exact_match", "cv_macro_f1"]].head(15).to_string(index=False))


if __name__ == "__main__":
    main()
