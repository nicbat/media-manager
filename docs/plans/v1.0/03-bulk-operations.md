# Item 3 — Selected-record JSON export

**Reviewed 2026-10-08: discussion, optional.** See [Item 3](../../FUTURE_CHANGES.md#3--bulk-operations--bulk-export-remainder) and the [reassessed release plan](README.md).

Bulk Set field and Delete already ship, including propagation through linked relationships. Exporting a selection as JSON remains unimplemented. The CLI `export` command copies a whole portable workspace; it does not provide selected-record export.

The old brief recommended adding this merely to close the item. That is not a useful release criterion. Build it when a concrete consumer needs it.

Two product decisions remain:

1. Raw stored fields or a documented export DTO? List rows are projections and must not be assumed to contain full records.
2. Record-only payload or schema/linked-data package? Do not claim round-trip import until a corresponding importer exists.

If selected, keep the initial scope Records-only. Resolve the decisions, then specify selection semantics, filename, error handling, and a test comparing downloaded data with the intended records. Do not infer readiness from the small implementation size.
