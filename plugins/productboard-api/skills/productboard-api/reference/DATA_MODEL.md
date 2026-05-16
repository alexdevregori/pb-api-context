# Productboard Data Model

How Productboard's entities are structured and connected. Claude should read this when a task involves more than a single endpoint call — anything that walks relationships, joins notes to entities, or traverses any of the three hierarchies.

This doc is hand-maintained, unlike the OpenAPI specs. If something here contradicts the spec, the spec wins — but the spec doesn't tell you which sequence of calls to make, or which relationship type connects which pair of entity types. That's what this is for.

Last verified against real API responses: 2026-05.

## The three data systems

Productboard's API is three loosely connected systems. Understanding the boundary is the most important thing for writing correct code.

### 1. PM entities (`/v2/entities/...`)

11 entity types, organized into **three separate trees** plus customer entities:

**The product tree** (containment via `parent`/`child`):
```
product
└── component         ← can nest inside another component
    └── feature
        └── subfeature
```
- `component` can be a child of `product` OR another `component` (self-nesting, like folders)
- `subfeature`'s parent **must** be a `feature` (mandatory, cardinality single)

**The OKR tree** (containment via `parent`/`child`):
```
objective              ← can nest inside another objective
└── objective
    └── keyResult
```
- `objective` can be a child of another `objective` (self-nesting, like nested OKRs / bets / themes)
- `keyResult` lives under an `objective`

**The release tree** (containment via `parent`/`child`):
```
releaseGroup
└── release
```

**Customer entities** (not in any tree):
- `user` — individual customer
- `company` — customer organization

**Initiatives** are a flat type — they don't nest into other initiatives.

### 2. Notes (`/v2/notes/...`)

Customer feedback, a completely separate API. **3 note types:**

- `textNote` — plain text feedback
- `conversationNote` — structured back-and-forth (e.g., from Intercom, Zendesk)
- `opportunityNote` — sales/deal context (read-only via API)

Notes connect to customers via a `customer` relationship, and to product entities via `link` relationships, both stored on the note itself.

### 3. Members (`/v2/members/...`)

Workspace **employees**, not customers. Used for `owner`, `creator`, and team assignments. **Don't confuse `member` (employee) with `user` (customer)** — both are valid concepts in Productboard, completely different APIs.

## Relationship types

| Type | Meaning | Used for |
|---|---|---|
| `parent` | The target is the source's container | Walking up any of the three trees |
| `child` | The target is contained by the source | Walking down any of the three trees |
| `link` | Cross-tree association | Connecting a feature to a strategy entity, or a customer to a product entity |
| `isBlockedBy` | Source depends on target | Feature-to-feature dependencies |
| `isBlocking` | Source prevents target | Feature-to-feature dependencies (the inverse view) |

**Important: a feature cannot regular-`link` to another feature.** Feature-to-feature connections are *only* via `isBlockedBy` / `isBlocking`. If you need to associate two features, you're either modeling a dependency (use blocked/blocking) or you need a different shape — usually both features `link` to a shared parent like an initiative or release.

Note relationships use a simpler vocabulary: `customer` (to user/company) and `link` (to product entities).

## How relationships behave on entity reads

**When you GET an entity, the API returns ALL its relationships in one response** — `parent`, `child`, `link`, blocked/blocking, everything in one `relationships.data` array. You read them all at once and filter client-side.

**The `/v2/entities/{id}/relationships` endpoint** is for filtered queries — pass `?type=parent` or `?type=link` to get only that subset. Useful when an entity has many relationships and you only need one direction.

Example: an objective ("Bet 1") returned this in one read:

```json
"relationships": {
  "data": [
    { "type": "parent", "target": { "id": "...", "type": "objective" } },
    { "type": "child",  "target": { "id": "...", "type": "keyResult" } },
    { "type": "link",   "target": { "id": "...", "type": "feature" } }
  ]
}
```

That single entity has a parent objective above it (it's nested), a key result below it, AND a linked feature contributing to it. Code that walks the OKR tree needs to handle parent AND child in the same response.

**Never take `relationships.data[0]` and assume it's the parent.** Always filter by `type`.

## Cross-tree links

Features and subfeatures `link` to entities in other trees:

| From | To | Purpose |
|---|---|---|
| `feature` / `subfeature` | `objective` | Contributes to OKR |
| `feature` / `subfeature` | `keyResult` | Contributes to measurable outcome |
| `feature` / `subfeature` | `initiative` | Part of a theme |
| `feature` / `subfeature` | `release` | Scheduled for release |
| `user` / `company` | `product` / `component` / `feature` / `subfeature` | Customer interest |

A single feature can `link` to many strategy entities at once. Example: one feature linked to two releases AND an objective:

```json
"relationships": {
  "data": [
    { "type": "parent", "target": { "type": "component", ... } },
    { "type": "link",   "target": { "type": "objective",  ... } },
    { "type": "link",   "target": { "type": "release",    ... } },
    { "type": "link",   "target": { "type": "release",    ... } }
  ]
}
```

The release tree contains release groups → releases, but features sit in the *product tree* and `link` to the release. A release does not `parent` features — that would be a category error.

> **TODO: verify customer link relationship type.** In real-world data, when a `user` or `company` is attached to a feature, does the relationship `type` show as `link` or as `customer`? Both are plausible. Note: notes always use `customer` for their user/company attachment, but PM entities may differ. Will lock this down when an example payload is available.

## Configuration-driven API

Productboard's API is explicitly "configuration-driven": available fields, types, and capabilities are determined by your workspace configuration, permissions, and business logic.

What this means for code:

1. **Custom fields appear as UUIDs**, not names. In a real entity payload, you'll see lines like `"a549ae34-cfa7-4cbd-b400-c3f7f9e909ee": 132` mixed in with the named built-in fields. Whatever your custom field is called in the UI (e.g. "Effort Score"), it shows up as its UUID in the API response.

2. **Field availability varies by entity type.** A field defined for `feature` may not exist for `initiative`. Always check via `GET /v2/entities/configurations/{type}` if you're unsure.

3. **Field paths for patch operations use `/fields/<id>`.** `/fields/name` for built-ins, `/fields/<uuid>` for custom fields.

4. **The configuration response also lists available filters.** Look at the `filters` array — it tells you which query parameters are valid for `GET /v2/entities?type=...`. Not all filters work for all entity types.

### How to handle custom fields in code

**Convention: always discover at runtime via `/configurations`. Never hardcode UUIDs.**

The configuration endpoint returns every field for an entity type — built-in and custom — with its display name, ID (UUID for custom fields, short string like `name` or `owner` for built-ins), data type, and validation rules. Use it to build a name → UUID lookup at the start of any script that touches custom fields.

**Pattern** (translate to the runtime you're working in — see SKILL.md "Runtime-specific notes"):

```
function getFieldIdsByName(entityType, token):
    response = HTTP GET https://api.productboard.com/v2/entities/configurations/{entityType}
                with Authorization: Bearer <token>
    config = response.data
    lookup = {}
    for fieldId, fieldMeta in config.fields:
        lookup[fieldMeta.name] = fieldId   # human name → UUID (or built-in short name)
    return lookup

# usage:
fields = getFieldIdsByName('feature', token)
effortFieldId = fields['Effort Score']     # resolves to "a549ae34-cfa7-4cbd-..."
effortValue = feature.fields[effortFieldId]
```

**Why this beats hardcoding:**
- A renamed field in the UI doesn't break the script — the name still resolves correctly because the UUID is stable
- A new workspace (sandbox, demo, second org) doesn't need code changes
- The same script works for someone else's workspace if you ever distribute it

**Don't fetch the configuration inside a loop.** Hit `/configurations/{type}` once per entity type per script run, cache the lookup, then use it. Configurations don't change mid-script.

**When you do need to write a UUID literally** (e.g., a CSV export that always uses a specific field), include a comment naming the field:

```
QUARTERLY_REVENUE_FIELD = "a549ae34-cfa7-4cbd-b400-c3f7f9e909ee"  // "Quarterly revenue impact"
```

That way the next person reading the code knows what they're looking at without opening Productboard.

## Common workflow patterns

### "All features in release X"

A release doesn't contain features (it's not a parent — features `link` to it). So search from the feature side:

```
POST /v2/entities/search
body: {
  filter: {
    type: ["feature"],
    relationships: { link: [{ id: "<release-id>" }] }
  }
}
```

Same pattern for "all features under objective Y," "all features in initiative Z," etc. — the feature is always the source of the link.

### "All key results under objective X"

This IS a containment relationship (parent/child), so use the relationship endpoint with a filter:

```
GET /v2/entities/{objective-id}/relationships?type=child
```

Then filter the response to where `target.type === "keyResult"`. Or, equivalently, search from the KR side filtered by parent.

### "Walk up from a feature to its product"

Containment up the product tree means following `parent` repeatedly:

```
feature → parent (component or product)
  if component:
    → parent (component or product)
      ... recurse until product
```

**Termination check matters here.** Because components self-nest, you can't assume two parent-hops get you to the product. Walk until `parent.target.type === "product"` or until no `parent` is returned (some entities like initiatives are tree roots in their own right).

### "All features mentioned in customer feedback since last quarter"

Two hops, starting from notes:

```
1. POST /v2/notes/search
   body: { filter: { createdAt: { from: "2026-01-01T00:00:00Z" } } }
   → paginated list of notes

2. For each note, read note.relationships[] for entries where type === "link"
   → collect target.id values where target.type === "feature"

3. (Optional) POST /v2/entities/search
   body: { filter: { type: ["feature"], id: [<collected ids>] }
   → hydrate the feature objects in one batch
```

Don't loop `GET /v2/entities/{id}` per feature — batch via `/entities/search` with the `id` filter.

### "Every customer who mentioned feature X"

Search notes filtered by the feature link, then read each note's customer relationship:

```
1. POST /v2/notes/search
   body: { filter: { relationships: { link: [{ id: "<feature-id>" }] } } }
   → notes linked to that feature

2. For each note, read note.relationships[] for entries where type === "customer"
   → that's the user OR company that originated the feedback
```

**Note quirk: a note's customer can be a user, a company, or sometimes both.** When a note is created from a user who's associated with a company, both relationships may exist. When a note is created with only a user reference, the company may not be auto-attached. So when aggregating "which companies care about feature X," you can't just count company relationships — you also need to walk from users to their companies via the user entity. (TODO: confirm the exact rules with a sample of real notes.)

### "Create a feature linked to a release and an objective atomically"

`POST /v2/entities` accepts inline relationships at creation, so you don't need three separate calls:

```json
{
  "data": {
    "type": "feature",
    "fields": { "name": "New feature", "owner": { "email": "..." } },
    "relationships": [
      { "type": "parent", "target": { "id": "<component-id>" } },
      { "type": "link",   "target": { "id": "<release-id>" } },
      { "type": "link",   "target": { "id": "<objective-id>" } }
    ]
  }
}
```

For notes, the equivalent pattern attaches a customer + product link at creation:

```json
{
  "data": {
    "type": "textNote",
    "fields": { "name": "Feedback from acme", "content": "..." },
    "relationships": [
      { "type": "customer", "target": { "email": "alice@acme.com", "type": "user" } },
      { "type": "link",     "target": { "id": "<feature-id>", "type": "link" } }
    ]
  }
}
```

Useful detail: **customers can be referenced by email** — the API resolves it server-side. Saves a search round-trip when you have an email and want to attach a note.

## Identifying by name vs identifying by ID

A pattern that runs through the whole API:

- **By ID** (UUID) is precise, idempotent, and preferred for automation
- **By name/email** is convenient when you have human-readable inputs

Most assignment payloads accept either:

```json
"owner": { "email": "alice@acme.com" }   // resolved server-side
"owner": { "id": "uuid-here" }           // exact match
"status": { "name": "In Progress" }      // case-sensitive
"status": { "id": "uuid-here" }
```

For automation, **prefer IDs**. Names break when someone renames a status in the UI. Pattern: resolve names to IDs once at the start of a script, cache them, use IDs everywhere else.

## API version

All endpoints are at `https://api.productboard.com/v2/...`. The OpenAPI files in this skill cover v2 exclusively. If you find old code calling `/features` or `/products` directly without `/v2/`, that's the legacy v1 API — rewrite it to use v2 rather than maintaining the v1 call. The skill won't help with v1 because the data shapes and configuration model are fundamentally different.

## When to read which spec file

| Task involves… | Read `reference/...` |
|---|---|
| Customer feedback, conversations | `notes.yaml` |
| Features, products, components, initiatives, OKRs, releases | `entities.yaml` |
| Custom fields, status values, tags | `entities.yaml` (all one spec) |
| Workspace users (employees), teams | `members.yaml`, `teams.yaml` |
| Webhooks, event subscriptions | `webhooks.yaml` |
| Member activity history | `analytics.yaml` |
| Jira-linked entities | `jira-integrations.yaml` |
| Plugin-managed entities | `plugin-integrations.yaml` |

Cross-domain tasks (e.g. "every customer who mentioned X feature") need both `notes.yaml` and `entities.yaml` — this doc tells you how they connect.

## Things this document deliberately doesn't cover

- **Rate limits and quotas** — these change; check current API docs. Generally: exponential backoff on HTTP 429.
- **Webhook event payloads** — see `reference/webhooks.yaml`. Payload shapes mirror the v2 entity shapes.

## Maintaining this document

This file is hand-maintained. The watcher leaves it alone — it only touches `.yaml` files and the auto-generated INDEX.md / CHANGELOG.md.

Update when:
- A new entity type ships (rare)
- A new relationship type is added
- The team learns a non-obvious rule through hard experience ("turns out you have to do X before Y or you get a 422")
- One of the TODOs in this doc gets answered with a real payload

The pattern: when someone hits a non-obvious gotcha and Claude helps them debug it, add a one-liner here. The next person who hits the same wall will have Claude already knowing the answer. This is the asset that compounds.
