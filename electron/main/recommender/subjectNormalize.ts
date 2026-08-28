// Subject-variant normalization (shared, pure, ABI-agnostic). OpenLibrary lists the
// SAME topic under several surface forms — "Bears", "Bears, Fiction", "Bears --
// Juvenile fiction", "Bears in literature" — and each owned Seekers book carries two
// or three of them. Left untouched they (a) double the topic token in a candidate's
// embed text, (b) split into two `subject:` seeds, and (c) defeat any per-topic
// diversity cap that keys on the raw string. Collapsing the variants to one canonical
// key fixes all three. This is deliberately NARROW: it only strips a *trailing
// qualifier that follows a separator* (comma / dash / parens / " in "), so genuine
// compound genres with no separator before the qualifier — "Science Fiction",
// "Fantasy Fiction", "Historical Fiction" — are left ALONE (their "fiction" is part
// of the genre name, not a qualifier on a topic).

// Trailing "…, Fiction" / "… -- Juvenile fiction" / "…: Literature" — a format/class
// qualifier hung off a real topic after a comma, dash, or colon. Looped so stacked
// qualifiers ("Bears, Juvenile fiction, Fiction") all peel. `literature`/`fiction`/
// `nonfiction` only; NOT a blanket last-word strip.
const TRAILING_QUALIFIER_RE =
  /\s*(?:,|--|—|–|:)\s*(?:juvenile\s+|young\s+adult\s+)?(?:fiction|nonfiction|non-fiction|literature)\.?$/i

// "Bears in fiction" / "Wizards in literature" / "Dragons in art" — the " in <medium>"
// construction OL uses for the same topical split.
const IN_QUALIFIER_RE = /\s+in\s+(?:fiction|literature|art|mass media)\.?$/i

// "Paddington (Fictitious character)" — parenthetical fictional-character marker.
const PAREN_QUALIFIER_RE = /\s*\((?:fictitious|fictional)\s+characters?\)\.?$/i

/**
 * The identity a subject collapses to for dedup / seed aggregation / diversity keying:
 * lowercased, whitespace-collapsed, with trailing fiction/literature qualifiers peeled
 * (see the regexes). "Bears", "Bears, Fiction", "Bears -- Juvenile fiction", and "Bears
 * in literature" all map to `bears`; "Science Fiction" maps to `science fiction`
 * (unchanged — no separator before the qualifier). Pure.
 */
export function canonicalSubjectKey(subject: string): string {
  let k = subject.trim().toLowerCase().replace(/\s+/g, ' ')
  k = k.replace(PAREN_QUALIFIER_RE, '').replace(IN_QUALIFIER_RE, '').trim()
  let prev: string
  do {
    prev = k
    k = k.replace(TRAILING_QUALIFIER_RE, '').trim()
  } while (k !== prev)
  return k
}

/**
 * Collapse subject-variant duplicates: one entry per `canonicalSubjectKey`, keeping the
 * SHORTEST surface form (so the bare topic "Bears" wins over "Bears, Fiction"; ties keep
 * the first seen), in first-seen key order. Blank/whitespace subjects drop. Pure — used
 * both on a candidate's fetched subjects (before the embed text) and, via the seed
 * aggregator, on the owned-book subjects that become `subject:` queries.
 */
export function dedupeSubjects(subjects: string[]): string[] {
  const best = new Map<string, string>()
  const order: string[] = []
  for (const raw of subjects) {
    const surface = raw.trim().replace(/\s+/g, ' ')
    if (!surface) continue
    const key = canonicalSubjectKey(surface)
    if (!key) continue
    const cur = best.get(key)
    if (cur === undefined) {
      best.set(key, surface)
      order.push(key)
    } else if (surface.length < cur.length) {
      best.set(key, surface)
    }
  }
  return order.map((k) => best.get(k)!)
}
