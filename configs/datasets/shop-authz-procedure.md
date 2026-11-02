# Shop authorization procedure dataset

This synthetic dataset improves a concrete task: deciding whether a second, equivalent-role account received another account's private object. It uses recorded observations; optimization sends no target requests and changes no model weights.

The deliberately weak baseline reports a flaw whenever the second account receives HTTP 200. GEPA reflects on the baseline's outputs and fixed evaluator feedback, then proposes a better testing procedure. A useful procedure establishes object ownership, compares equivalent-role identities, inspects the actual object data and keeps missing owner evidence inconclusive.

[JSON dataset](shop-authz-procedure.json) · [walkthrough](../../docs/tutorials/learning.mp4)

| Case in each split | Recorded observations | Operator ground truth |
| --- | --- | --- |
| Private object leak | A owns the object; B receives the same private data | vulnerable |
| Denied request | A reads its object; B receives 403 | safe for this recorded comparison |
| Misleading success status | B receives 200 with an authorization-error body | safe for this recorded comparison |
| Missing owner baseline | A's baseline is unavailable; B receives an object with unknown owner | inconclusive |

There are four rows in each of train, validation and test. All applications, row IDs and evidence IDs are isolated across splits. Each row contains `appId`, `split`, redacted `input`, `evidenceIds` and an operator-controlled `expected` verdict with `requiredEvidence`. Inputs are serialized observations, not executable instructions. Do not put tokens or other secrets in this dataset.

The versioned deterministic evaluator (`authz-evidence-v1`) awards 1 only when the output has the expected verdict, all required observation references and a nonempty explanation. Other outputs score 0, including invalid JSON and correct guesses missing ownership/role controls. It checks structured verdicts and references; it does not independently verify the prose explanation or execute an exploit. Real labels and evidence need independent review.

Only training traces and evaluator feedback reach reflection. Validation selects candidates. Test rows are evaluated after search and do not influence reflection or selection. Baseline and candidate use the same cases and per-call output limit. GEPA caches identical procedure/case evaluations within a study. Do not reuse the same held-out test repeatedly to choose subsequent experiments; retain a separate final audit set when doing real development.

## Run and review

1. Run `pnpm setup:tools --only learning` from the built project. This pins Optuna 5.0.0 and GEPA 0.1.4.
2. Open **Plugins → Djupleita · Optuna learning → Plugins → Load local setup**. Check `learning.gepaScript` alongside Python, the Optuna script and dataset directory.
3. In **Studies**, select **GEPA · authz procedure**, then **Shop authz · ownership evidence (12 synthetic cases)**. Use a search evaluation budget of 24.
4. GEPA uses the selected chat model for task evaluation and reflection, so provider charges apply. The offline worker receives no API keys or assessment tools. Model calls go through the existing provider adapter and egress controls.
5. Review the before/after procedure, candidate history, validation/test scores, model identity, dataset hash and each case's output/feedback. Trajectory retains model requests, results and errors beside the originating chat.
6. **Promote procedure** requires validation improvement and no test regression. The procedure becomes advisory agent context in this engagement and survives restart. **Disable procedure** removes it from future requests. Promotion, revocation and context use do not grant target access or change approval policy.

`trials` in the model-facing `pentest_learn` tool means search evaluation budget for GEPA (2–300), and Optuna trial count for ranking. GEPA requires at least `2 × validation rows + 4` search evaluations. Search can stop early to keep a complete comparison within budget. Baseline/final evaluation and reflection also consume calls: a hard parent-enforced cap is `search budget + 4 × total rows + 12`, with a 15-minute deadline, 32 KiB response limit and cancellation. The Studies list shows the latest ten runs, with bounded output previews; complete reports remain in private study files and the learning/result trajectory. Reports include actual call and character counts; character counts are not token usage or dollar costs.

The recording runs the real pinned GEPA optimizer and real evaluator through the production model bridge. Its task/reflection model is a disclosed deterministic local fixture, which derives answers from the recorded HTTP observations and proposes a fixed generalized correction after receiving real failure feedback. The resulting synthetic improvement demonstrates the plumbing, not real model learning quality, live exploit detection or generalization. Production runs use your configured model and may find no improvement. Optuna's ranking score and this procedure score measure different tasks and should not be compared as a backend benchmark.

For real experiments, use independently labelled, sanitized observations from authorized resettable applications, including clean cases, misleading statuses and insufficient evidence. Separate applications across splits, match model/call budgets, and verify any claimed improvement on an untouched audit set and separate authorized live tests. Keep scope, credentials, permissions and the evaluator outside the search space.
