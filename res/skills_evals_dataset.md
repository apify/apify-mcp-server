# Seeding the `skills-evals` dataset

The harness supports Apify agent skills (`--skills`, `metadata.skills`; see
`evals/workflows/README.md` → Skill evals), but the Langfuse dataset the skill cases live in does
not exist yet. It has to be created with Langfuse credentials, which the branch that added the
harness support did not have.

**Delete this note once `skills-evals` is created and its first wave of cases is calibrated.**

## Create the dataset

Preamble and CLI usage: `.claude/skills/creating-workflow-evals/reference.md` → Langfuse CLI.

```bash
cd /tmp && export $(grep -E '^LANGFUSE' <repo>/.env | xargs) && export LANGFUSE_HOST="$LANGFUSE_BASE_URL"
npx -y langfuse-cli api datasets create --body-json '{
  "name": "skills-evals",
  "description": "Multi-turn cases run with an Apify agent skill preloaded (github.com/apify/agent-skills). Proper suite: zero tool errors."
}'
```

Error-provoking skill cases get `skills-evals-errors`, per the two-suite rule.

## First case

Apify's own documented example prompt for `apify-ultimate-scraper`, so the premise is upstream's,
not invented here. Uncalibrated — run it on `claude-opus-5` first; a failure there is a defect in
the case, not in the skill.

```json
{
  "datasetName": "skills-evals",
  "id": "skills-scraper-easy-1",
  "input": { "query": "Find 10 highly rated coffee shops in Seattle with name, address, rating, phone, and website." },
  "expectedOutput": "PASS only if the agent ran a Google Maps Actor on the Apify platform and the final answer lists 10 Seattle coffee shops, each with name, address and rating (phone and website may be missing for a given place if the agent says so). FAIL if the agent answers from its own knowledge without running an Actor, or reports fewer than 10 places without saying why.",
  "metadata": { "category": "apify-ultimate-scraper", "maxTurns": 14, "skills": ["apify-ultimate-scraper"] }
}
```

The rest of the suite gets authored with the `creating-workflow-evals` skill (waves, calibration
ladder, coverage matrix). Two things to settle while writing it:

- What the suite measures. Same query with and without the skill is the interesting comparison —
  the same case cannot do both, so a with/without pair needs two ids or two datasets.
- The `apify` CLI is a prerequisite of every skill case, so the suite cannot run in an environment
  without it (CI included).
