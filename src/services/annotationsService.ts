import type { Annotation, CreateAnnotationPayload } from '../types'

export const annotationsService = {
  getForItem: (itemId: string): Promise<Annotation[]> =>
    window.api.annotations.getForItem(itemId),

  create: (payload: CreateAnnotationPayload): Promise<Annotation> =>
    window.api.annotations.create(payload),

  updateNote: (id: string, noteText: string | null): Promise<void> =>
    window.api.annotations.updateNote(id, noteText),

  delete: (id: string): Promise<void> =>
    window.api.annotations.delete(id),

  swapSortOrder: (id1: string, id2: string): Promise<void> =>
    window.api.annotations.swapSortOrder(id1, id2),
}
