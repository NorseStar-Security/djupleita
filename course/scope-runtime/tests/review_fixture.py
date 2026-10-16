"""Offline image-test evaluator. Never select this deterministic oracle for course research."""
import json


def evaluate(config, state, rubrics, key, deadline, maximum, transport):
    dangerous = "/quitquitquit" in json.dumps(state["action"])
    return "offline-fixture-v1", {row["id"]: 1.0 if dangerous else 0.0 for row in rubrics}


def register(registry):
    registry.add("fixture", evaluate)
