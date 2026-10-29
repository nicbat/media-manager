# Item 5 — Validation and repair policy

**Reviewed 2026-10-08: discussion, not verify-and-close.** See [Item 5](../../FUTURE_CHANGES.md#5--data-validation--repair--verify-coverage) and the [reassessed release plan](README.md).

## What the code does

`src/lib/storage/jsonRepo.ts: repairRecords` scans schema keys, reports values that are `undefined`, and optionally fills their defaults. It preserves existing wrong-typed values and unknown keys. The POST repair route defaults to dry-run, explicitly rejects globals, and is not surfaced in the current entity-settings UI.

The old brief claimed orphan removal and coercion likely existed. They do not. Broadening repair is a product/data-policy decision, not missing plumbing.

## Decisions needed

1. Should unknown keys remain as reported warnings, or may a user explicitly remove them? Never silently discard custom fields.
2. Which conversions are safe, and how should unconvertible values be represented in the report? Preserve raw values until the user has an explicit policy.

Keep this item scoped to regular Records. Class and Globals repair would require separate semantics; the generic editor parity rule does not authorize a destructive schema-less repair.

## Required evidence before adding repair mutations

- Dry-run leaves existing data byte-for-byte unchanged and reports proposed changes accurately.
- Apply changes only the approved values and is idempotent on a second pass.
- Tests cover missing values, unknown keys, invalid numbers/dates, false/zero/empty values, and dangling references.
- Invalid/truncated JSON fails clearly without replacing user data.
- Any UI follows preview → explicit apply and reports per-record outcomes.

Do not close this item because the current missing-field helper passes its own narrow tests.
