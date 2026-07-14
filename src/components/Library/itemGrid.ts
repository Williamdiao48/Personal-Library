import type { Tag, Collection } from '../../types'

// Pure builders that turn the flat (item_id → tag/collection) IPC rows into the
// per-item lookup maps the Library grid renders from. Extracted from LibraryView
// (audit RED-3) so they can be reused by other grid views without copy-paste.

/** Group flat item↔tag rows into a `{ itemId: Tag[] }` map. */
export function buildTagsMap(
  rows: { item_id: string; tag_id: string; name: string; color: string }[],
): Record<string, Tag[]> {
  const map: Record<string, Tag[]> = {}
  for (const { item_id, tag_id, name, color } of rows) {
    if (!map[item_id]) map[item_id] = []
    map[item_id].push({ id: tag_id, name, color })
  }
  return map
}

/** Group flat item↔collection rows into a `{ itemId: Collection[] }` map. */
export function buildCollectionsMap(
  cols: Collection[],
  rows: { item_id: string; collection_id: string; name: string }[],
): Record<string, Collection[]> {
  const colById: Record<string, Collection> = {}
  for (const c of cols) colById[c.id] = c

  const map: Record<string, Collection[]> = {}
  for (const { item_id, collection_id } of rows) {
    if (!map[item_id]) map[item_id] = []
    if (colById[collection_id]) map[item_id].push(colById[collection_id])
  }
  return map
}
