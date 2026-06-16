# Productboard API Spec Index

High-level map of endpoints across all spec files. Use this to decide which spec file to load before generating code.

_Last generated: 2026-06-16_

## `analytics.yaml` — Analytics

Productboard API v2 for listing analytics and member activity data. Use these endpoints to list member activities with optional date filtering and pagination.

**Endpoints (1):**

- `GET` /analytics/member-activities

## `entities.yaml` — Entities

Productboard API v2 for managing the following Entities: 

**Endpoints (10):**

- `POST, GET` /entities
- `GET` /entities/configurations
- `GET` /entities/configurations/{type}
- `GET, POST` /entities/fields/{id}/values
- `PATCH, DELETE` /entities/fields/{id}/values/{valueId}
- `POST` /entities/search
- `GET, PATCH, DELETE` /entities/{id}
- `GET, POST` /entities/{id}/relationships
- `PUT` /entities/{id}/relationships/parent
- `DELETE` /entities/{id}/relationships/{type}/{targetId}

## `jira-integrations.yaml` — Jira Integrations

Productboard API v2 for managing Jira integrations and their connections to Productboard entities. Use these endpoints to list and get Jira integrations, check their status, and browse entity-to-issue connections.

**Endpoints (4):**

- `GET` /jira-integrations
- `GET` /jira-integrations/{integrationId}
- `GET` /jira-integrations/{integrationId}/connections
- `GET` /jira-integrations/{integrationId}/connections/{entityId}

## `members.yaml` — Members

Productboard API v2 for managing workspace members and their team memberships. Use these endpoints to list and get members, filter by role, and browse their team assignments.

**Endpoints (3):**

- `GET` /members
- `POST` /members/search
- `GET` /members/{id}

## `notes.yaml` — Notes

Productboard API v2 for managing notes and their relationships to other entities. Use these endpoints to create, list, update, and delete notes, and to link them to entities, companies, and other resources.

**Endpoints (8):**

- `POST, GET` /notes
- `GET` /notes/configurations
- `GET` /notes/configurations/{type}
- `POST` /notes/search
- `GET, PATCH, DELETE` /notes/{id}
- `GET, POST` /notes/{id}/relationships
- `PUT` /notes/{id}/relationships/customer
- `DELETE` /notes/{id}/relationships/{targetType}/{targetId}

## `plugin-integrations.yaml` — Plugin Integrations

Manages plugin integrations and their connections.

**Endpoints (5):**

- `POST, GET` /plugin-integrations
- `GET, PATCH, DELETE` /plugin-integrations/{integrationId}
- `GET` /plugin-integrations/{integrationId}/connections
- `POST` /plugin-integrations/{integrationId}/connections/search
- `GET, PUT, DELETE` /plugin-integrations/{integrationId}/connections/{entityId}

## `teams.yaml` — Teams

Productboard API v2 for managing teams and their member assignments. Use these endpoints to create, list, update, and delete teams, and to manage which members belong to each team.

**Endpoints (4):**

- `GET, POST` /teams
- `POST` /teams/search
- `GET, PATCH, DELETE` /teams/{id}
- `GET` /teams/{id}/members

## `webhooks.yaml` — Webhooks

Manages webhook subscriptions. Subscribe to entity change events and receive

**Endpoints (2):**

- `POST, GET` /webhooks
- `GET, DELETE` /webhooks/{webhookId}

