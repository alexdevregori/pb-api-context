# Productboard API Context

A Claude Code plugin that teaches Claude to write Productboard API code against the live, up-to-date OpenAPI spec — not whatever was in its training data.

The plugin bundles:
- A **skill** with instructions for how to approach Productboard API tasks
- The **current OpenAPI specs** for all 8 v2 domains, kept in sync by a daily GitHub Action
- A **data model document** capturing the team knowledge that the specs don't (entity hierarchies, relationship types, common workflow patterns)

## Install

Once, per engineer:

```bash
# In Claude Code
/plugin marketplace add alexdegregori/pb-api-context
/plugin install productboard-api@your-org-tools
```

Replace `alexdegregori/pb-api-context` with the actual GitHub path. After install, the skill activates automatically whenever you mention Productboard in a conversation with Claude. Updates land automatically when the daily watcher commits to `main` — engineers run `/plugin update` to pull them.

## Use

Open Claude Code in any directory. Ask things like:

> Write me an Apps Script that pulls all notes tagged `q1-feedback` and dumps them into a Google Sheet.

> Build a script that creates a Productboard feature for every row in this CSV that has status approved.

> The script I wrote last month stopped working — can you fix it? [paste code]

Claude will read the relevant spec files, consult the data model doc when the task spans multiple endpoints, and generate code using the current API.

## Repository layout

```
.claude-plugin/marketplace.json      ← marketplace manifest for /plugin install
plugins/productboard-api/
   ├── .claude-plugin/plugin.json    ← plugin manifest
   └── skills/productboard-api/
       ├── SKILL.md                  ← skill instructions Claude reads
       └── reference/
           ├── INDEX.md              ← endpoint map across files (auto-generated)
           ├── DATA_MODEL.md         ← entity relationships, workflow patterns (hand-maintained)
           ├── analytics.yaml        ← live OpenAPI specs (auto-updated daily)
           ├── entities.yaml
           ├── notes.yaml
           └── ...
watcher/                              ← Node script that runs daily in CI
smoke-test/                           ← static skill validation (Node, weekly)
integration-test/                     ← runs generated code against real sandbox (Python, weekly)
.github/workflows/check-spec.yml      ← daily spec watcher schedule
.github/workflows/weekly-tests.yml    ← weekly skill test schedule
CHANGELOG.md                          ← auto-generated spec change log
```

Everything the plugin ships with lives under `plugins/productboard-api/`. There is no separate "source" copy elsewhere in the repo.

## Contributing to the skill

The data model document and the skill instructions are the highest-leverage parts of this repo. Anything you learn through hard experience — a 422 you didn't expect, a relationship traversal that wasn't obvious — belongs in `DATA_MODEL.md` so the next teammate's Claude session starts with that knowledge.

**The workflow is just regular Claude Code:**

```bash
git clone git@github.com:alexdegregori/pb-api-context.git
cd pb-api-context
claude
```

Then describe the change to Claude:

> I learned today that note conversations imported from Intercom always have the customer attached to the company entity, never the user. Update `plugins/productboard-api/skills/productboard-api/reference/DATA_MODEL.md` to capture this.

> Add a workflow pattern for "find features blocked by features in release X" — it needs to combine isBlockedBy traversal with a link search.

When you paste a real API payload into the prompt, Claude will work from that rather than guessing from the spec. Real payloads beat plausible inference every time.

After Claude edits, commit and push:

```bash
git add -A
git commit -m "DATA_MODEL: note customer attachment from Intercom imports"
git push
```

The next time anyone uses the skill (or runs `/plugin update`), they get the update.

## How the auto-update works

1. `.github/workflows/check-spec.yml` runs daily at 14:00 UTC.
2. The workflow runs `watcher/watch.mjs`, which:
   - Scrapes `https://developer.productboard.com/openapi` to find the current list of spec files
   - Downloads each one and SHA-256 hashes it
   - If unchanged: exits silently
   - If changed: overwrites the cached files, regenerates `INDEX.md`, appends to `CHANGELOG.md`
3. If anything changed, the workflow commits and pushes to `main`.
4. If a changelog entry mentions a **breaking** change (endpoint removed, schema property deleted), the workflow opens a GitHub issue labeled `breaking-change`.

The watcher only touches `.yaml` files plus `INDEX.md` and `CHANGELOG.md`. It never modifies `SKILL.md` or `DATA_MODEL.md` — those are hand-curated.

## Weekly skill tests

`.github/workflows/weekly-tests.yml` runs every Sunday at 08:00 UTC and exercises the skill two different ways:

### 1. Static smoke test (Node)

Reads the skill into a system prompt and asks Claude to write code for 5 different scenarios. For each response, validates:
- **Skill activation:** Claude emitted a `consulted_files:` YAML block listing which spec files it read
- **Endpoint validity:** Every `/v2/...` path in generated code exists in the YAML specs
- **Language match:** Generated code is in the expected language

Catches: skill stops loading, broken frontmatter, hallucinated/stale endpoints in DATA_MODEL.md examples.
Doesn't catch: code that uses a real endpoint with a wrong request shape.

### 2. Integration test (Python, real sandbox)

Asks Claude to write Python functions, then **executes them against your Productboard sandbox** with a real token. For each test case:
1. Generates Python code from the skill
2. `exec`s the function in an isolated namespace
3. Calls it against `https://api.productboard.com/v2/...` with the sandbox token
4. Validates the response shape (expected keys, expected types)
5. Cleans up any entities the test created (notes with the `[smoke-test-<runid>]` prefix)

Catches: generated code that 4xx's against the real API, wrong request body shape, missing headers, pagination handling that breaks, response shape changes that nobody noticed.

The test distinguishes **skill bugs** (the generated code is wrong) from **infra failures** (the sandbox returned 5xx, network timeouts). Only skill bugs open GitHub issues — infra failures show as workflow warnings to avoid noise on flaky days.

### Setup

Two GitHub repository secrets are required:

| Secret | What | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Used by both tests to call Claude | console.anthropic.com → API Keys |
| `PB_SANDBOX_TOKEN` | Used by the integration test only | Productboard sandbox workspace → Integrations → Public APIs → Add token |

**The sandbox token must be on a non-production workspace.** The integration test creates and deletes notes; running it against prod would leave clutter and risks deletion bugs. The token only needs the scopes the test cases actually exercise (currently `notes:write`).

### Cost

~$0.05–0.15 per weekly run combined (one Claude call per test case, 8 cases total).

### Editing the tests

- **Static prompts:** `smoke-test/prompts.json` — language and expected spec files per prompt
- **Integration cases:** `integration-test/test_cases.json` — each case has a prompt, an `execution` block (function name and arg template), and validation rules (`expect_dict_with_keys`, `expect_string_uuid`)

When you add a new case that creates entities, set `creates_entities: true` and provide a `cleanup` block with the HTTP method and path. The harness will run cleanup automatically. If a test fails partway through (creates a note but doesn't get to cleanup), the next run's "orphan sweep" catches notes with the `[smoke-test-` prefix and deletes them.

### Running locally

Static smoke test:
```bash
cd smoke-test
npm install
export ANTHROPIC_API_KEY=sk-ant-...
node test.mjs                 # all prompts
node test.mjs --prompt name   # single prompt
node self-test.mjs            # validation unit tests, no API needed
```

Integration test:
```bash
cd integration-test
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
export PB_SANDBOX_TOKEN=...
python test.py                # all cases
python test.py --case name    # single case
python test.py --skip-cleanup # leave entities behind (debugging)
```

## Local testing

```bash
cd watcher
npm install
node watch.mjs            # check + update files in place
node watch.mjs --force    # regenerate everything, useful after schema tweaks
node watch.mjs --check-only   # exit 1 if drift detected, write nothing
```

## When the spec breaks your existing scripts

The watcher updates the skill's API context, but it doesn't touch your downstream scripts. If your Apps Scripts call an endpoint that got removed or a parameter that's now required, those scripts will keep breaking until you fix them.

Two ways to handle this:

1. **Manual:** Watch for the auto-created GitHub issue. It lists exactly what changed. Update your scripts and push.
2. **Semi-automated:** Run Claude Code in your scripts repo with this plugin installed, and ask: *"Read the latest entry in `CHANGELOG.md` from the pb-api-context plugin, then update any Apps Script files in this repo that are affected."* Claude will read the changelog, search your code for affected endpoints, and patch them with minimal edits, flagging anything ambiguous with `// TODO` comments.

## Honest limitations

- **The watcher's schema diff is shallow** (top-level properties only). It catches endpoint adds/removes, param changes, and required-flag flips — the things that actually break code. Schemas using deep `allOf`/`oneOf` composition aren't fully diffed.
- **Skill triggering relies on keywords.** If you ask something very oblique that doesn't mention Productboard, the skill might not fire. The description is written to trigger on tangential phrasing (`features`, `notes`, `automation`), which helps.
- **DATA_MODEL.md has one explicit TODO.** Customer link relationship type from PM entity side is documented as unverified at the time of writing. When you have a payload showing a feature with a customer attached, update the doc.

## A note about the Productboard MCP connector

If you're using Claude (the chat app) with the Productboard MCP connector, you may not need Apps Script at all for many tasks. This plugin is specifically for when you do need Apps Script — running on a schedule inside Google Workspace, integrating with Sheets, etc. — and you want the script itself to stay in sync with the API.
