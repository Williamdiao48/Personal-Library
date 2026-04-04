import { contextBridge, ipcRenderer } from 'electron'

// This is the only surface the renderer can touch.
// Every capability must be explicitly listed here.
contextBridge.exposeInMainWorld('api', {

  // Library
  library: {
    getAll:         ()                                              => ipcRenderer.invoke('library:getAll'),
    getById:        (id: string)                                   => ipcRenderer.invoke('library:getById', id),
    delete:         (id: string)                                   => ipcRenderer.invoke('library:delete', id),
    updateProgress: (id: string, pos: number)                      => ipcRenderer.invoke('library:updateProgress', id, pos),
    saveScrollPos:  (id: string, chapter: number, scrollY: number) => ipcRenderer.invoke('library:saveScrollPos', id, chapter, scrollY),
    search:         (query: string)                                => ipcRenderer.invoke('library:search', query),
    getAllItemTags:  ()                                             => ipcRenderer.invoke('library:getAllItemTags'),
    setCover:       (id: string, data: ArrayBuffer, ext: string)   => ipcRenderer.invoke('library:setCover', id, data, ext),
    pickCover:      (id: string)                                   => ipcRenderer.invoke('library:pickCover', id),
    setAuthor:      (id: string, author: string | null)            => ipcRenderer.invoke('library:setAuthor', id, author),
    setStatus:      (id: string, status: string | null)           => ipcRenderer.invoke('library:setStatus', id, status),
    refresh:        (id: string)                                   => ipcRenderer.invoke('library:refresh', id),
  },

  // Tags
  tags: {
    getAll:     ()                                  => ipcRenderer.invoke('tags:getAll'),
    getForItem: (itemId: string)                   => ipcRenderer.invoke('tags:getForItem', itemId),
    setForItem: (itemId: string, tagIds: string[]) => ipcRenderer.invoke('tags:setForItem', itemId, tagIds),
    create:     (name: string, color: string)      => ipcRenderer.invoke('tags:create', name, color),
    delete:     (id: string)                       => ipcRenderer.invoke('tags:delete', id),
  },

  // Capture
  capture: {
    // Fire-and-forget: returns a jobId immediately. Progress/completion/errors
    // are delivered asynchronously via onCaptureProgress/Complete/Error.
    start:    (url: string, start?: number, end?: number) => ipcRenderer.invoke('capture:start', url, start, end),
    fromFile: ()                                           => ipcRenderer.invoke('capture:fromFile'),
    append:   (itemId: string, end: number)               => ipcRenderer.invoke('capture:append', itemId, end),
  },

  // Reader
  reader: {
    loadContent:       (relativePath: string)                => ipcRenderer.invoke('reader:loadContent', relativePath),
    loadBinaryContent: (relativePath: string)                => ipcRenderer.invoke('reader:loadBinaryContent', relativePath),
    loadEpub:          (relativePath: string)                => ipcRenderer.invoke('reader:loadEpub', relativePath),
    getChapterCount:   (relativePath: string)                => ipcRenderer.invoke('reader:getChapterCount', relativePath),
    loadChapter:       (relativePath: string, index: number) => ipcRenderer.invoke('reader:loadChapter', relativePath, index),
  },

  // Collections
  collections: {
    getAll:               ()                               => ipcRenderer.invoke('collections:getAll'),
    create:               (name: string)                  => ipcRenderer.invoke('collections:create', name),
    delete:               (id: string)                    => ipcRenderer.invoke('collections:delete', id),
    rename:               (id: string, name: string)      => ipcRenderer.invoke('collections:rename', id, name),
    getAllItemCollections: ()                              => ipcRenderer.invoke('collections:getAllItemCollections'),
    setForItem:           (itemId: string, ids: string[]) => ipcRenderer.invoke('collections:setForItem', itemId, ids),
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
    getSummary:    ()             => ipcRenderer.invoke('stats:getSummary'),
    getTimeline:   (days: number) => ipcRenderer.invoke('stats:getTimeline', days),
    getByItem:     ()             => ipcRenderer.invoke('stats:getByItem'),
    getStreaks:    ()             => ipcRenderer.invoke('stats:getStreaks'),
  },

  // Goals
  goals: {
    getAll:     ()                                    => ipcRenderer.invoke('goals:getAll'),
    create:     (payload: object)                     => ipcRenderer.invoke('goals:create', payload),
    update:     (id: string, patch: object)           => ipcRenderer.invoke('goals:update', id, patch),
    delete:     (id: string)                          => ipcRenderer.invoke('goals:delete', id),
    addItem:    (goalId: string, itemId: string)      => ipcRenderer.invoke('goals:addItem', goalId, itemId),
    removeItem:        (goalId: string, itemId: string)               => ipcRenderer.invoke('goals:removeItem', goalId, itemId),
    upsertPeriodGoal:  (type: string, period: string, target: number | null) => ipcRenderer.invoke('goals:upsertPeriodGoal', type, period, target),
  },

  // Annotations
  annotations: {
    getForItem: (itemId: string) =>
      ipcRenderer.invoke('annotations:getForItem', itemId),
    create: (payload: object) =>
      ipcRenderer.invoke('annotations:create', payload),
    updateNote: (id: string, noteText: string | null) =>
      ipcRenderer.invoke('annotations:updateNote', id, noteText),
    delete: (id: string) =>
      ipcRenderer.invoke('annotations:delete', id),
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

  onCaptureComplete: (callback: (payload: { jobId: string; result: { id: string; title: string; author: string | null; wordCount: number | null } }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: typeof callback extends (p: infer P) => void ? P : never) =>
      callback(payload)
    ipcRenderer.on('capture:complete', handler)
    return () => ipcRenderer.removeListener('capture:complete', handler)
  },

  onCaptureError: (callback: (payload: { jobId: string; error: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { jobId: string; error: string }) =>
      callback(payload)
    ipcRenderer.on('capture:error', handler)
    return () => ipcRenderer.removeListener('capture:error', handler)
  },

})
