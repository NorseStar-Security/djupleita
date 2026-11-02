# Synthetic shop: prioritize ownership checks

This is the public fixture for the Optuna crawl-ranking backend. The updated learning video demonstrates the companion GEPA procedure task; both backends remain available in Studies. The cyber task is to choose promising endpoints for a subsequent paired-account authorization / IDOR test when only two candidate visits are available. The dataset contains no customer observations, credentials, or confirmed vulnerabilities.

The example bounty includes `example.test` and `*.example.test`, excludes `mail.example.test`, and uses the shop's `/shop` paths. Every URL uses a reserved name. Dataset URLs identify offline replay candidates; running the study never requests them.

## Labels and provenance

[shop-authz-ranking.json](shop-authz-ranking.json) contains 18 hand-authored candidates: six train, six validation, and six test. Routes and synthetic evidence identifiers are disjoint between splits. `synthetic:shop:<split>:<number>` identifies a fixture label, not a production evidence archive.

For this exercise, an object route such as `/shop/orders/1001` represents a record containing an object ID and owner field. Its reward is 1 because it merits a later ownership comparison with two authorized accounts. Login, preferences, search, and static pages receive reward 0 for this particular task. This does not mean those surfaces have no security value in other tasks. It does not assert that access controls are broken.

Each candidate costs 1; `requestBudget: 2` selects the first two candidates in each split. The objective is the sum of selected rewards divided by selected request cost. Features match the crawler's initial-frontier heuristics:

| Feature | Meaning in this fixture |
| --- | --- |
| `auth` | Path matches the crawler's auth/API keyword heuristic |
| `object` | Path contains a numeric object ID |
| `query` | URL has a query string |
| `novelty` | Previously unseen endpoint template; 1 for every fixture row |

The fixed baseline is `auth: 4, object: 3, query: 2, novelty: 1`. The crawler's additional constant offset does not change the ordering. The recording uses the actual offline optimizer, 12 trials and seed 42. Only training labels drive trial selection; validation and test labels assess the chosen parameters afterwards.

## Practical outcome

| Split | Baseline's two visits | Learned ranking's two visits | Useful candidates / request |
| --- | --- | --- | --- |
| Train | `/shop/account/settings`, `/shop/login` | `/shop/invoices/9001`, `/shop/orders/1001` | 0 → 1 |
| Validation | `/shop/admin/help`, `/shop/auth/reset` | `/shop/receipts/3001`, `/shop/shipments/2001` | 0 → 1 |
| Test | `/shop/account/preferences`, `/shop/user/profile` | `/shop/reservations/5001`, `/shop/returns/4001` | 0 → 1 |

The same two visits now select two useful ownership-test candidates rather than zero. This is deliberately simple synthetic data, not a benchmark of production improvement or a count of vulnerabilities. The next security task is an authorized paired-account comparison on those object routes.

## Configure and run

After building the app, run `pnpm setup:tools --only learning`. In **Plugins → Djupleita · Optuna learning → Plugins**, select **Load local setup** and check these actual configuration fields:

```json
{
  "learning": {
    "python": "<project>/.pentest/toolchains/optuna/bin/python",
    "script": "<project>/packages/learning/python/optimize.py",
    "datasets": "<project>/configs/datasets"
  }
}
```

The example paths are placeholders; the setup action fills the real installed paths. Apply the plugin configuration. In **Studies**, select **Shop bounty: prioritize ownership checks (SYNTHETIC)** and 12 trials, then **Run offline study**. Review the parameters, train/validation/test scores, dataset hash, and limitation. **Promote ranking** changes future crawl priority, while the operator's scope and effect policy remain unchanged.

For useful real studies, replace these labels with reviewed, recorded candidates from an authorized engagement, keep related evidence separated between splits, and evaluate live request efficiency separately. Never include credentials or private engagement data in a published dataset.
