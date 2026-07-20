# Productboard API Spec Changelog

## 2026-07-20

### New spec files
- `customer-scores.yaml`

## 2026-07-10

### `notes.yaml`
- Endpoints added: `/notes/{id}/comments`

## 2026-07-02

### `notes.yaml`
- Schemas added: NoteSearchSearch
- Schema `NoteSearchData`: properties added: search

## 2026-06-18

### `entities.yaml`
- Schema `EntitySearchCustomFieldFilterValue`: properties added: isSet

## 2026-06-16

### `entities.yaml`
- `GET /entities`: params added: query:teams[id], query:teams[name]
- Schemas added: EntityUpdateMetadata, ApiSourceUpdate
- Schema `EntitySearchFieldFilters`: properties added: teams

## 2026-06-10

### `notes.yaml`
- `GET /notes`: params added: query:type[]

## 2026-06-04

### `entities.yaml`
- `GET /entities`: params added: query:metadata[source][system], query:metadata[source][recordId]

Automated changes detected by the watcher. New entries appear at the top.

