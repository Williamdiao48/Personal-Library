import { describe, it, expect, beforeEach } from 'vitest'
import { installMockApi } from '../../test/renderer/mockWindowApi'
import { captureService } from './capture'
import { readerService } from './reader'
import { statsService } from './stats'
import { goalsService } from './goals'
import { convertService } from './convert'
import { backupService } from './backup'
import { annotationsService } from './annotationsService'

// The service layer is a thin pass-through to window.api. These tests lock the
// wiring for every non-library service — right namespace, right method, right
// argument order — cheap insurance against a rename/typo silently breaking an
// IPC call. (libraryService/collectionService/tagService are covered in
// library.test.ts.)

let api: any

beforeEach(() => {
  api = installMockApi()
})

describe('captureService delegation', () => {
  it('start forwards url + optional range', () => {
    captureService.start('https://x', 1, 3)
    expect(api.capture.start).toHaveBeenCalledWith('https://x', 1, 3)
  })
  it('fromFile → api.capture.fromFile', () => {
    captureService.fromFile()
    expect(api.capture.fromFile).toHaveBeenCalledTimes(1)
  })
  it('append forwards itemId + end', () => {
    captureService.append('i1', 5)
    expect(api.capture.append).toHaveBeenCalledWith('i1', 5)
  })
})

describe('readerService delegation', () => {
  it('loadContent forwards the path', () => {
    readerService.loadContent('a.html')
    expect(api.reader.loadContent).toHaveBeenCalledWith('a.html')
  })
  it('loadBinaryContent forwards the path', () => {
    readerService.loadBinaryContent('a.pdf')
    expect(api.reader.loadBinaryContent).toHaveBeenCalledWith('a.pdf')
  })
  it('loadEpub forwards the path', () => {
    readerService.loadEpub('a.epub')
    expect(api.reader.loadEpub).toHaveBeenCalledWith('a.epub')
  })
  it('getChapterCount forwards the path', () => {
    readerService.getChapterCount('a.epub')
    expect(api.reader.getChapterCount).toHaveBeenCalledWith('a.epub')
  })
  it('loadChapter forwards path + index', () => {
    readerService.loadChapter('a.epub', 2)
    expect(api.reader.loadChapter).toHaveBeenCalledWith('a.epub', 2)
  })
})

describe('statsService delegation', () => {
  it('recordSession forwards item + timestamps', () => {
    statsService.recordSession('i1', 10, 20)
    expect(api.stats.recordSession).toHaveBeenCalledWith('i1', 10, 20)
  })
  it('getSummary → api.stats.getSummary', () => {
    statsService.getSummary()
    expect(api.stats.getSummary).toHaveBeenCalledTimes(1)
  })
  it('getTimeline forwards the day span', () => {
    statsService.getTimeline(30)
    expect(api.stats.getTimeline).toHaveBeenCalledWith(30)
  })
  it('getByItem → api.stats.getByItem', () => {
    statsService.getByItem()
    expect(api.stats.getByItem).toHaveBeenCalledTimes(1)
  })
  it('getStreaks → api.stats.getStreaks', () => {
    statsService.getStreaks()
    expect(api.stats.getStreaks).toHaveBeenCalledTimes(1)
  })
  it('getDashboard forwards the day span', () => {
    statsService.getDashboard(366)
    expect(api.stats.getDashboard).toHaveBeenCalledWith(366)
  })
})

describe('goalsService delegation', () => {
  it('getAll → api.goals.getAll', () => {
    goalsService.getAll()
    expect(api.goals.getAll).toHaveBeenCalledTimes(1)
  })
  it('create forwards the payload', () => {
    const payload = { type: 'time' as const, title: 'Read daily' }
    goalsService.create(payload)
    expect(api.goals.create).toHaveBeenCalledWith(payload)
  })
  it('update forwards id + patch', () => {
    goalsService.update('g1', { title: 'New' })
    expect(api.goals.update).toHaveBeenCalledWith('g1', { title: 'New' })
  })
  it('delete forwards the id', () => {
    goalsService.delete('g1')
    expect(api.goals.delete).toHaveBeenCalledWith('g1')
  })
  it('addItem forwards goalId + itemId', () => {
    goalsService.addItem('g1', 'i1')
    expect(api.goals.addItem).toHaveBeenCalledWith('g1', 'i1')
  })
  it('removeItem forwards goalId + itemId', () => {
    goalsService.removeItem('g1', 'i1')
    expect(api.goals.removeItem).toHaveBeenCalledWith('g1', 'i1')
  })
  it('upsertPeriodGoal forwards type + period + target', () => {
    goalsService.upsertPeriodGoal('time', 'weekly', 120)
    expect(api.goals.upsertPeriodGoal).toHaveBeenCalledWith('time', 'weekly', 120)
  })
})

describe('convertService delegation', () => {
  it('pdfToEpub forwards the payload', () => {
    const payload = { itemId: 'i1', chapters: [] }
    convertService.pdfToEpub(payload as any)
    expect(api.convert.pdfToEpub).toHaveBeenCalledWith(payload)
  })
})

describe('backupService delegation', () => {
  it('export → api.backup.export', () => {
    backupService.export()
    expect(api.backup.export).toHaveBeenCalledTimes(1)
  })
  it('import → api.backup.import', () => {
    backupService.import()
    expect(api.backup.import).toHaveBeenCalledTimes(1)
  })
})

describe('annotationsService delegation', () => {
  it('getForItem forwards the itemId', () => {
    annotationsService.getForItem('i1')
    expect(api.annotations.getForItem).toHaveBeenCalledWith('i1')
  })
  it('create forwards the payload', () => {
    const payload = { itemId: 'i1', quote: 'q' }
    annotationsService.create(payload as any)
    expect(api.annotations.create).toHaveBeenCalledWith(payload)
  })
  it('updateNote forwards id + note', () => {
    annotationsService.updateNote('a1', 'hi')
    expect(api.annotations.updateNote).toHaveBeenCalledWith('a1', 'hi')
  })
  it('delete forwards the id', () => {
    annotationsService.delete('a1')
    expect(api.annotations.delete).toHaveBeenCalledWith('a1')
  })
  it('swapSortOrder forwards both ids', () => {
    annotationsService.swapSortOrder('a1', 'a2')
    expect(api.annotations.swapSortOrder).toHaveBeenCalledWith('a1', 'a2')
  })
})
