import { describe, it, expect, beforeEach } from 'vitest'
import { installMockApi } from '../../test/renderer/mockWindowApi'
import { libraryService, collectionService, tagService } from './library'

let api: any

beforeEach(() => {
  api = installMockApi()
})

// The service layer is a thin pass-through to window.api. These tests lock the
// wiring: right namespace, right method, right argument order. Cheap insurance
// against a rename/typo silently breaking an IPC call.
describe('libraryService delegation', () => {
  it('getAll → api.library.getAll', () => {
    libraryService.getAll()
    expect(api.library.getAll).toHaveBeenCalledTimes(1)
  })

  it('setStatus forwards id and status', () => {
    libraryService.setStatus('id1', 'finished')
    expect(api.library.setStatus).toHaveBeenCalledWith('id1', 'finished')
  })

  it('setRating forwards id and rating', () => {
    libraryService.setRating('id1', 4.5)
    expect(api.library.setRating).toHaveBeenCalledWith('id1', 4.5)
  })

  it('search forwards the query', () => {
    libraryService.search('dragons')
    expect(api.library.search).toHaveBeenCalledWith('dragons')
  })

  it('returns the underlying api result', () => {
    api.library.getById.mockReturnValue({ id: 'x', title: 'T' })
    expect(libraryService.getById('x')).toEqual({ id: 'x', title: 'T' })
  })
})

describe('collectionService delegation', () => {
  it('setForItem forwards itemId and collection ids', () => {
    collectionService.setForItem('item', ['c1', 'c2'])
    expect(api.collections.setForItem).toHaveBeenCalledWith('item', ['c1', 'c2'])
  })

  it('reorderItems forwards collection id and ordered ids', () => {
    collectionService.reorderItems('col', ['a', 'b'])
    expect(api.collections.reorderItems).toHaveBeenCalledWith('col', ['a', 'b'])
  })
})

describe('tagService delegation', () => {
  it('create forwards name and color', () => {
    tagService.create('sci-fi', '#ff0000')
    expect(api.tags.create).toHaveBeenCalledWith('sci-fi', '#ff0000')
  })
})
