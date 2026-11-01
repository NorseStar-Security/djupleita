"""Offline replay of operator-labelled crawl candidates. No network or safety knobs."""
import argparse
import hashlib
import json
import pathlib
import optuna

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
request = json.loads(pathlib.Path(args.input).read_text())
dataset = request["dataset"]
rows = dataset["rows"]
features = ("auth", "object", "query", "novelty")
baseline = {"auth": 4.0, "object": 3.0, "query": 2.0, "novelty": 1.0}

def score(parameters, split):
    candidates = [row for row in rows if row["split"] == split]
    ordered = sorted(candidates, key=lambda row: (-sum(parameters[name] * row["features"][name] for name in features), row["id"]))
    chosen = ordered[:dataset["requestBudget"]]
    # Reward is an operator label, never a model's assertion that a finding is true.
    return sum(row["reward"] for row in chosen) / max(1.0, sum(row["cost"] for row in chosen))

optuna.logging.set_verbosity(optuna.logging.WARNING)
root = pathlib.Path(args.output).parent
study = optuna.create_study(study_name=request["runId"], direction="maximize",
    storage="sqlite:///" + str(root / "study.sqlite"),
    sampler=optuna.samplers.TPESampler(seed=request["seed"]), load_if_exists=False)
study.enqueue_trial(baseline)

def objective(trial):
    parameters = {name: trial.suggest_float(name, 0.0, 8.0) for name in features}
    return score(parameters, "train")

study.optimize(objective, n_trials=request["trials"], timeout=240)
parameters = study.best_params
report = {"runId": request["runId"], "datasetHash": request["datasetHash"], "seed": request["seed"],
    "engine": "optuna/" + optuna.__version__, "parameters": parameters,
    "scores": {split: {"baseline": score(baseline, split), "candidate": score(parameters, split)} for split in ("train", "validation", "test")},
    "trials": [{"number": trial.number, "value": trial.value, "parameters": trial.params, "state": trial.state.name} for trial in study.trials],
    "limitation": "Offline ranking estimate on operator-labelled recorded candidates. Validate live efficiency separately."}
destination = pathlib.Path(args.output)
temporary = destination.with_suffix(".tmp")
temporary.write_text(json.dumps(report, sort_keys=True))
temporary.replace(destination)
print(json.dumps({"runId": request["runId"], "trials": len(study.trials)}))
