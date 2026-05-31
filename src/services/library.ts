// IPC abstraction layer.
// React components never call window.api directly — they go through here.
// This makes the pivot surface minimal if we ever change the underlying transport.

export const collectionService = {
  getAll:               ()                               => window.api.collections.getAll(),
  create:               (name: string)                  => window.api.collections.create(name),
  delete:               (id: string)                    => window.api.collections.delete(id),
  rename:               (id: string, name: string)      => window.api.collections.rename(id, name),
  getAllItemCollections: ()                              => window.api.collections.getAllItemCollections(),
  setForItem:           (itemId: string, ids: string[]) => window.api.collections.setForItem(itemId, ids),
  getItems:             (id: string)                    => window.api.collections.getItems(id),
  reorderItems:         (id: string, ids: string[])     => window.api.collections.reorderItems(id, ids),
  addItem:              (id: string, itemId: string)    => window.api.collections.addItem(id, itemId),
}

export const libraryService = {
  getAll:         ()                                            => window.api.library.getAll(),
  getById:        (id: string)                                 => window.api.library.getById(id),
  softDelete:        (id: string)  => window.api.library.softDelete(id),
  restore:           (id: string)  => window.api.library.restore(id),
  getTrashed:        ()            => window.api.library.getTrashed(),
  permanentlyDelete: (id: string)  => window.api.library.permanentlyDelete(id),
  emptyTrash:        ()            => window.api.library.emptyTrash(),
  updateProgress: (id: string, pos: number)                    => window.api.library.updateProgress(id, pos),
  saveScrollPos:  (id: string, chapter: number, scrollY: number) => window.api.library.saveScrollPos(id, chapter, scrollY),
  search:         (query: string)                              => window.api.library.search(query),
  getAllItemTags:  ()                                           => window.api.library.getAllItemTags(),
  setCover:       (id: string, data: ArrayBuffer, ext: string) => window.api.library.setCover(id, data, ext),
  pickCover:      (id: string)                                 => window.api.library.pickCover(id),
  setAuthor:        (id: string, author: string | null)         => window.api.library.setAuthor(id, author),
  setTitle:         (id: string, title: string)                => window.api.library.setTitle(id, title),
  setStatus:        (id: string, status: import('../types').ReadingStatus | null) => window.api.library.setStatus(id, status),
  setRating:        (id: string, rating: number | null)        => window.api.library.setRating(id, rating),
  setReview:        (id: string, review: string | null)        => window.api.library.setReview(id, review),
  refresh:          (id: string)                               => window.api.library.refresh(id),
  findBySourceUrl:  (url: string)                              => window.api.library.findBySourceUrl(url),
}

export const tagService = {
  getAll:        ()                                  => window.api.tags.getAll(),
  getForItem:    (itemId: string)                   => window.api.tags.getForItem(itemId),
  setForItem:    (itemId: string, tagIds: string[]) => window.api.tags.setForItem(itemId, tagIds),
  create:        (name: string, color: string)      => window.api.tags.create(name, color),
  delete:        (id: string)                       => window.api.tags.delete(id),
  rename:        (id: string, name: string)         => window.api.tags.rename(id, name),
  setColor:      (id: string, color: string)        => window.api.tags.setColor(id, color),
  getItemCounts: ()                                 => window.api.tags.getItemCounts(),
}
