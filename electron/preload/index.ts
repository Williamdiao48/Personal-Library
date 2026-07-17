import { contextBridge, ipcRenderer } from 'electron'

// This is the only surface the renderer can touch.
// Every capability must be explicitly listed here.
contextBridge.exposeInMainWorld('api', {
  // Library
  library: {
    getAll: () => ipcRenderer.invoke('library:getAll'),
    getById: (id: string) => ipcRenderer.invoke('library:getById', id),
    softDelete: (id: string) => ipcRenderer.invoke('library:softDelete', id),
    restore: (id: string) => ipcRenderer.invoke('library:restore', id),
    getTrashed: () => ipcRenderer.invoke('library:getTrashed'),
    permanentlyDelete: (id: string) => ipcRenderer.invoke('library:permanentlyDelete', id),
    emptyTrash: () => ipcRenderer.invoke('library:emptyTrash'),
    updateProgress: (id: string, pos: number) =>
      ipcRenderer.invoke('library:updateProgress', id, pos),
    saveScrollPos: (id: string, chapter: number, scrollY: number) =>
      ipcRenderer.invoke('library:saveScrollPos', id, chapter, scrollY),
    search: (query: string) => ipcRenderer.invoke('library:search', query),
    getAllItemTags: () => ipcRenderer.invoke('library:getAllItemTags'),
    setCover: (id: string, data: ArrayBuffer, ext: string) =>
      ipcRenderer.invoke('library:setCover', id, data, ext),
    pickCover: (id: string) => ipcRenderer.invoke('library:pickCover', id),
    setAuthor: (id: string, author: string | null) =>
      ipcRenderer.invoke('library:setAuthor', id, author),
    setTitle: (id: string, title: string) => ipcRenderer.invoke('library:setTitle', id, title),
    setStatus: (id: string, status: string | null) =>
      ipcRenderer.invoke('library:setStatus', id, status),
    setRating: (id: string, rating: number | null) =>
      ipcRenderer.invoke('library:setRating', id, rating),
    setReview: (id: string, review: string | null) =>
      ipcRenderer.invoke('library:setReview', id, review),
    refresh: (id: string) => ipcRenderer.invoke('library:refresh', id),
    findBySourceUrl: (url: string) => ipcRenderer.invoke('library:findBySourceUrl', url),
  },

  // Tags
  tags: {
    getAll: () => ipcRenderer.invoke('tags:getAll'),
    getForItem: (itemId: string) => ipcRenderer.invoke('tags:getForItem', itemId),
    setForItem: (itemId: string, tagIds: string[]) =>
      ipcRenderer.invoke('tags:setForItem', itemId, tagIds),
    create: (name: string, color: string) => ipcRenderer.invoke('tags:create', name, color),
    delete: (id: string) => ipcRenderer.invoke('tags:delete', id),
    rename: (id: string, name: string) => ipcRenderer.invoke('tags:rename', id, name),
    setColor: (id: string, color: string) => ipcRenderer.invoke('tags:setColor', id, color),
    getItemCounts: () => ipcRenderer.invoke('tags:getItemCounts'),
  },

  // Capture
  capture: {
    // Fire-and-forget: returns a jobId immediately. Progress/completion/errors
    // are delivered asynchronously via onCaptureProgress/Complete/Error.
    start: (url: string, start?: number, end?: number) =>
      ipcRenderer.invoke('capture:start', url, start, end),
    fromFile: () => ipcRenderer.invoke('capture:fromFile'),
    append: (itemId: string, end: number) => ipcRenderer.invoke('capture:append', itemId, end),
  },

  // Reader
  reader: {
    loadContent: (relativePath: string) => ipcRenderer.invoke('reader:loadContent', relativePath),
    loadBinaryContent: (relativePath: string) =>
      ipcRenderer.invoke('reader:loadBinaryContent', relativePath),
    loadEpub: (relativePath: string) => ipcRenderer.invoke('reader:loadEpub', relativePath),
    getChapterCount: (relativePath: string) =>
      ipcRenderer.invoke('reader:getChapterCount', relativePath),
    loadChapter: (relativePath: string, index: number) =>
      ipcRenderer.invoke('reader:loadChapter', relativePath, index),
  },

  // Collections
  collections: {
    getAll: () => ipcRenderer.invoke('collections:getAll'),
    create: (name: string) => ipcRenderer.invoke('collections:create', name),
    delete: (id: string) => ipcRenderer.invoke('collections:delete', id),
    rename: (id: string, name: string) => ipcRenderer.invoke('collections:rename', id, name),
    getAllItemCollections: () => ipcRenderer.invoke('collections:getAllItemCollections'),
    setForItem: (itemId: string, ids: string[]) =>
      ipcRenderer.invoke('collections:setForItem', itemId, ids),
    getItems: (id: string) => ipcRenderer.invoke('collections:getItems', id),
    reorderItems: (id: string, itemIds: string[]) =>
      ipcRenderer.invoke('collections:reorderItems', id, itemIds),
    addItem: (id: string, itemId: string) => ipcRenderer.invoke('collections:addItem', id, itemId),
    removeItem: (id: string, itemId: string) =>
      ipcRenderer.invoke('collections:removeItem', id, itemId),
  },

  // PDF → EPUB conversion
  convert: {
    pdfToEpub: (payload: { itemId: string; chapters: { title: string; content: string }[] }) =>
      ipcRenderer.invoke('convert:pdfToEpub', payload),
  },

  // Reading stats
  stats: {
    recordSession: (itemId: string, startedAt: number, endedAt: number) =>
      ipcRenderer.invoke('stats:recordSession', itemId, startedAt, endedAt),
    getSummary: () => ipcRenderer.invoke('stats:getSummary'),
    getTimeline: (days: number) => ipcRenderer.invoke('stats:getTimeline', days),
    getByItem: () => ipcRenderer.invoke('stats:getByItem'),
    getStreaks: () => ipcRenderer.invoke('stats:getStreaks'),
    getDashboard: (days: number) => ipcRenderer.invoke('stats:getDashboard', days),
  },

  // Goals
  goals: {
    getAll: () => ipcRenderer.invoke('goals:getAll'),
    create: (payload: object) => ipcRenderer.invoke('goals:create', payload),
    update: (id: string, patch: object) => ipcRenderer.invoke('goals:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('goals:delete', id),
    addItem: (goalId: string, itemId: string) =>
      ipcRenderer.invoke('goals:addItem', goalId, itemId),
    removeItem: (goalId: string, itemId: string) =>
      ipcRenderer.invoke('goals:removeItem', goalId, itemId),
    upsertPeriodGoal: (type: string, period: string, target: number | null) =>
      ipcRenderer.invoke('goals:upsertPeriodGoal', type, period, target),
  },

  // Auto-updater
  updater: {
    checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
    downloadUpdate: () => ipcRenderer.invoke('updater:downloadUpdate'),
    quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall'),

    onUpdateAvailable: (callback: (info: { version: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, info: { version: string }) => callback(info)
      ipcRenderer.on('updater:update-available', handler)
      return () => ipcRenderer.removeListener('updater:update-available', handler)
    },
    onUpdateNotAvailable: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('updater:update-not-available', handler)
      return () => ipcRenderer.removeListener('updater:update-not-available', handler)
    },
    onDownloadProgress: (callback: (info: { percent: number }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, info: { percent: number }) => callback(info)
      ipcRenderer.on('updater:download-progress', handler)
      return () => ipcRenderer.removeListener('updater:download-progress', handler)
    },
    onUpdateDownloaded: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('updater:update-downloaded', handler)
      return () => ipcRenderer.removeListener('updater:update-downloaded', handler)
    },
    onError: (callback: (info: { message: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, info: { message: string }) => callback(info)
      ipcRenderer.on('updater:error', handler)
      return () => ipcRenderer.removeListener('updater:error', handler)
    },
  },

  // Annotations
  annotations: {
    getForItem: (itemId: string) => ipcRenderer.invoke('annotations:getForItem', itemId),
    getAll: () => ipcRenderer.invoke('annotations:getAll'),
    create: (payload: object) => ipcRenderer.invoke('annotations:create', payload),
    updateNote: (id: string, noteText: string | null) =>
      ipcRenderer.invoke('annotations:updateNote', id, noteText),
    setColor: (id: string, color: string | null) =>
      ipcRenderer.invoke('annotations:setColor', id, color),
    setThemes: (annotationId: string, themeIds: string[]) =>
      ipcRenderer.invoke('annotations:setThemes', annotationId, themeIds),
    delete: (id: string) => ipcRenderer.invoke('annotations:delete', id),
    swapSortOrder: (id1: string, id2: string) =>
      ipcRenderer.invoke('annotations:swapSortOrder', id1, id2),
    exportQuotes: (rows: object[], format: string) =>
      ipcRenderer.invoke('annotations:exportQuotes', rows, format),
  },
  annotationThemes: {
    list: () => ipcRenderer.invoke('annotationThemes:list'),
    create: (name: string) => ipcRenderer.invoke('annotationThemes:create', name),
    rename: (id: string, name: string) => ipcRenderer.invoke('annotationThemes:rename', id, name),
    delete: (id: string) => ipcRenderer.invoke('annotationThemes:delete', id),
  },

  // Backup
  backup: {
    export: () => ipcRenderer.invoke('backup:export'),
    import: () => ipcRenderer.invoke('backup:import'),
  },

  // Protocol-triggered capture (personallibrary://save?url=...)
  onRequestCapture: (callback: (url: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) => callback(url)
    ipcRenderer.on('request-capture', handler)
    return () => ipcRenderer.removeListener('request-capture', handler)
  },

  // Background capture event streams — all keyed by jobId
  onCaptureProgress: (callback: (payload: { jobId: string; msg: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { jobId: string; msg: string }) =>
      callback(payload)
    ipcRenderer.on('capture:progress', handler)
    return () => ipcRenderer.removeListener('capture:progress', handler)
  },

  onCaptureComplete: (
    callback: (payload: {
      jobId: string
      result: { id: string; title: string; author: string | null; wordCount: number | null }
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: typeof callback extends (p: infer P) => void ? P : never,
    ) => callback(payload)
    ipcRenderer.on('capture:complete', handler)
    return () => ipcRenderer.removeListener('capture:complete', handler)
  },

  onCaptureError: (callback: (payload: { jobId: string; error: string }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { jobId: string; error: string },
    ) => callback(payload)
    ipcRenderer.on('capture:error', handler)
    return () => ipcRenderer.removeListener('capture:error', handler)
  },

  // Crash logging
  log: {
    writeError: (message: string) => ipcRenderer.invoke('log:writeError', message),
  },

  // Discover (recommendations)
  discover: {
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('discover:setEnabled', enabled),
    get: () => ipcRenderer.invoke('discover:get'),
    refresh: (excludeSourceIds: string[]) =>
      ipcRenderer.invoke('discover:refresh', excludeSourceIds),
    more: (excludeSourceIds: string[], contentMode?: 'books' | 'fanfiction') =>
      ipcRenderer.invoke('discover:more', excludeSourceIds, contentMode),
    dismiss: (card: import('../../src/types').Recommendation) =>
      ipcRenderer.invoke('discover:dismiss', card),
    openExternal: (url: string) => ipcRenderer.invoke('discover:openExternal', url),
  },
})
