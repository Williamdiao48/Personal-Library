import type {
  Annotation,
  AnnotationTheme,
  AnnotationWithSource,
  CreateAnnotationPayload,
  ExportQuoteRow,
  HighlightColor,
} from '../types'

export const annotationsService = {
  getForItem: (itemId: string): Promise<Annotation[]> => window.api.annotations.getForItem(itemId),

  getAll: (): Promise<AnnotationWithSource[]> => window.api.annotations.getAll(),

  create: (payload: CreateAnnotationPayload): Promise<Annotation> =>
    window.api.annotations.create(payload),

  updateNote: (id: string, noteText: string | null): Promise<void> =>
    window.api.annotations.updateNote(id, noteText),

  setColor: (id: string, color: HighlightColor | null): Promise<void> =>
    window.api.annotations.setColor(id, color),

  setThemes: (annotationId: string, themeIds: string[]): Promise<void> =>
    window.api.annotations.setThemes(annotationId, themeIds),

  delete: (id: string): Promise<void> => window.api.annotations.delete(id),

  swapSortOrder: (id1: string, id2: string): Promise<void> =>
    window.api.annotations.swapSortOrder(id1, id2),

  exportQuotes: (rows: ExportQuoteRow[], format: 'md' | 'txt'): Promise<string | null> =>
    window.api.annotations.exportQuotes(rows, format),
}

export const annotationThemesService = {
  list: (): Promise<AnnotationTheme[]> => window.api.annotationThemes.list(),
  create: (name: string): Promise<AnnotationTheme> => window.api.annotationThemes.create(name),
  rename: (id: string, name: string): Promise<void> => window.api.annotationThemes.rename(id, name),
  delete: (id: string): Promise<void> => window.api.annotationThemes.delete(id),
}
