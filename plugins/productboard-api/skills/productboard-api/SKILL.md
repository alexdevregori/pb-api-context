---
name: productboard-api
description: Write Apps Script, Python, JavaScript, or any other code that calls the Productboard API. Use this skill whenever the user mentions Productboard, the Productboard API, features, notes, components, releases, objectives, or asks to build an automation, integration, sync, export, report, or script that touches Productboard data — even if they don't explicitly say "Productboard API." Also use this skill when the user asks to debug, fix, update, or modify any existing Productboard-related code. This skill ensures generated code uses the current, live API specification rather than outdated assumptions.
---

# Productboard API Code Helper

This skill helps you write code that calls the Productboard API correctly, using the live, up-to-date OpenAPI specification rather than guessing from training data.

## The most important rule

**Never write Productboard API code from memory.** The Productboard API evolves — endpoints move, parameters become required, schemas change. Always fetch the current spec before writing or modifying code that calls it.

## How to fetch the current spec

The current spec lives in this skill's `reference/` directory, kept in sync with `https://developer.productboard.com/openapi` by an automated watcher. Each domain has its own OpenAPI file:

| Domain | File | Covers |
|---|---|---|
| Notes | `reference/notes.yaml` | Customer feedback notes, conversation notes, opportunity notes, note relationships |
| Entities | `reference/entities.yaml` | Features, components, products, releases, objectives, custom fields, ownership |
| Members | `reference/members.yaml` | Workspace members, teams, roles |
| Teams | `reference/teams.yaml` | Team management |
| Webhooks | `reference/webhooks.yaml` | Subscriptions, event delivery |
| Analytics | `reference/analytics.yaml` | Reporting endpoints |
| Jira integration | `reference/jira-integrations.yaml` | Jira-linked entities |
| Plugin integrations | `reference/plugin-integrations.yaml` | Plugin-based integrations |

**Read only the file(s) relevant to the task.** Loading all 8 wastes context. If the user asks about notes, read `notes.yaml`. If they ask about features, read `entities.yaml`. If unsure which one applies, read the file `reference/INDEX.md` first — it lists the high-level paths in each spec so you can pick.

## Read DATA_MODEL.md when the task touches multiple endpoints

The OpenAPI specs describe individual endpoints in isolation. But Productboard's API is configuration-driven and relationship-heavy — entities connect through `relationships[]` arrays, not foreign keys, and custom fields are UUIDs that vary by workspace. If the task involves any of the following, **read `reference/DATA_MODEL.md` first**:

- Walking relationships ("find features mentioned in notes", "list customers who care about feature X")
- Creating entities with parent/child relationships
- Looking up entities by human-readable name or email instead of UUID
- Working with custom fields (anything not in the standard built-in field list)
- Combining data from notes + entities, or entities + members
- Anything involving the words "customer", "feedback", or "linked"

`DATA_MODEL.md` explains how the three subsystems (PM entities, Notes, Members) connect, which workflows require which sequence of calls, and the configuration-driven quirks that aren't obvious from the spec.

## Determine the runtime before writing code

Productboard automations get written in many runtimes — Google Apps Script (for Sheets/Docs integrations), Python (CLI scripts, Airflow DAGs, data pipelines), Node.js (backend services, AWS Lambda), curl/bash (one-off ops), and others. Each has different idioms for HTTP requests, error handling, secret storage, and pagination.

**Before writing any code, determine the target runtime:**

1. **If the user named one explicitly** ("write a Python script", "Apps Script function", "Node module"), use that.
2. **If context strongly implies one** (the user pasted Apps Script and asked to extend it, or mentioned "in our Cloud Function", or showed a `requirements.txt`), use the implied runtime and note your assumption.
3. **If neither**, ask — one short question, with the most likely options based on the task:

> *Quick check before I write — should this be Apps Script (for Google Sheets integration), Python, Node.js, or something else?*

Don't write the same code in three languages "just in case." Pick one.

## Workflow

1. **Identify the domain.** What's the user actually doing? Pulling notes? Updating a feature? Listing components? Map it to the right spec file.
2. **Read the relevant spec file(s).** Find the exact endpoint, method, parameters, request body, and response shape. Pay attention to:
   - Which parameters are `required: true`
   - Which fields the response actually returns (don't assume nested structures)
   - Whether the operation is marked `deprecated: true`
   - Authentication: `BearerAuth` (developer token) vs `OAuth2` (with scopes)
3. **Write the code.** Use the exact endpoint paths, parameter names, and field names from the spec. Don't paraphrase or "clean up" field names — Productboard uses things like `metadata[source][system]` as query params, which are easy to mangle.
4. **Add a comment at the top** of the generated code noting which spec file you consulted, e.g. `// Generated against reference/notes.yaml on YYYY-MM-DD`. This makes drift detectable later.

## Authentication

All endpoints use one of two auth mechanisms — check the `security` field on each operation:

- **BearerAuth** — workspace admins generate a developer token from Integrations → Public APIs. Pass as `Authorization: Bearer <token>`.
- **OAuth2** — for apps acting on behalf of users. Each operation declares which scopes it needs (e.g. `notes:read`, `notes:write`).

Never put tokens in source code. Store them in whatever secret-management mechanism the chosen runtime provides — see "Runtime-specific notes" below.

## Runtime-specific notes

Once you know the runtime, apply these idioms. The principles (check status codes, surface real error messages, follow `links.next` for pagination) are the same everywhere — only the syntax differs.

### Google Apps Script

- Use `UrlFetchApp.fetch(url, options)`, not `fetch()`.
- Set `muteHttpExceptions: true` and check `response.getResponseCode()` so the user sees real Productboard error messages, not Apps Script execution errors.
- Store tokens with `PropertiesService.getScriptProperties().getProperty('PB_TOKEN')` — never hardcode.
- For backoff on 429s, use `Utilities.sleep(ms)`.

### Python

- Use `requests` or `httpx`. Both handle JSON natively.
- Store tokens in environment variables (`os.environ['PB_TOKEN']`) or a `.env` file loaded by `python-dotenv` — never hardcode.
- Check `response.status_code` and surface `response.json()['errors'][0]['detail']` when non-2xx.
- For backoff on 429s, use `time.sleep()` with exponential growth or `tenacity` for declarative retry.

### Node.js / TypeScript

- Use native `fetch` (Node 18+) or `undici`. Both stream and handle JSON natively.
- Store tokens in environment variables (`process.env.PB_TOKEN`).
- Check `response.status` and surface the structured error body when non-2xx.
- For backoff on 429s, use `setTimeout` with a `Promise` wrapper, or a library like `p-retry`.

### Common rules for all runtimes

- **Productboard returns structured errors** (see the `ErrorResponse` schema in the relevant spec). Always parse and surface `errors[0].detail` to the user — never just dump the raw response.
- **For pagination, follow the `links.next` URL exactly as returned.** Don't reconstruct it. The cursor format is opaque and may change.
- **Rate limits return HTTP 429** with a body following `TooManyRequestsResponse`. Implement exponential backoff (start at ~1s, double up to ~30s, then fail).
- **Use the `X-Version` header** if the spec lists one for the endpoint you're calling — without it, you may get an older response shape.

## Common patterns

The patterns below show the structure. Translate to the chosen runtime using the idioms above.

**Pagination loop:**

```
token = get from secrets
url = 'https://api.productboard.com/v2/<endpoint>'
results = []
while url is not null:
    response = HTTP GET url with Authorization: Bearer <token>
    if response status != 200:
        raise error with response body
    body = parse JSON
    append body.data to results
    url = body.links.next   # null when there are no more pages
return results
```

**Always check the spec for the specific endpoint** — the path, required headers, query parameters, and pagination shape can vary between domains (notes vs. entities vs. members).

## What to do when the spec doesn't have what you need

If the user asks for something the spec doesn't cover (e.g. "bulk delete all features in a release"), say so plainly. Suggest:

1. Whether the operation might exist on a different domain spec file you haven't read yet.
2. Whether it can be composed from existing endpoints (list, then loop with individual deletes).
3. That the user may want to file a request with Productboard rather than work around it.

Don't invent endpoints that aren't in the spec. The watcher will tell us when new ones land.

## Updating existing code

If the user has existing Productboard code and asks you to fix or update it:

1. Read the relevant spec file first.
2. Compare what the existing code expects vs. what the spec currently defines.
3. Look for: removed endpoints, renamed fields, newly required parameters, changed response shapes, newly deprecated operations.
4. Make minimal, surgical edits — don't refactor unrelated code.
5. Flag anything ambiguous with a `// TODO:` comment rather than guessing.

## Related skill files

- `reference/INDEX.md` — high-level map of which paths live in which file (read this when you're not sure which spec to load)
- `reference/DATA_MODEL.md` — how Productboard's entities, notes, and members connect; common workflow patterns (read this for any task spanning multiple endpoints)
- `reference/CHANGELOG.md` — recent spec changes detected by the watcher (read this if the user mentions something working/breaking recently)
- `reference/*.yaml` — the live OpenAPI specs (read whichever one is relevant)
