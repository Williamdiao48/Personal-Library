// ─────────────────────────────────────────────────────────────────────────────
// Name-tombstone separator.
//
// tags / collections / annotation_themes carry a UNIQUE(name). A soft-delete keeps
// the row (as a propagating tombstone), so we must FREE its name slot — otherwise
// re-creating a same-named row would collide with the tombstone. We do that by
// suffixing the freed name with a separator + the row id, which is unique and
// reversible.
//
// The separator MUST be a byte that BOTH SQLite and Postgres `text` accept, because
// the tombstone name syncs to the cloud mirror (Phase 3). NUL (x'00') is legal in
// SQLite but Postgres rejects it (22P05: "unsupported Unicode escape / invalid byte
// sequence"), so a nul-suffixed name can never push — plain tag/collection/theme
// deletions (and the C4 natural-key merge) would silently fail to sync. We use the
// ASCII Unit Separator (0x1F): legal in both engines, and a control byte that never
// appears in a real user-entered name, so a freed name can't collide with a live one.
//
// Both the SQL literal and the JS string must be the SAME byte so the two sides of a
// C4 merge (local-loser path in SQL, incoming-loser path in JS) produce IDENTICAL
// tombstone names and converge under LWW.
export const NAME_TOMB_SEP = '\x1f'

/** SQL literal for {@link NAME_TOMB_SEP}, for inline `name || <sep> || id` updates. */
export const NAME_TOMB_SEP_SQL = "x'1f'"
