import { describe, it, expect, beforeEach } from 'vitest'
import { installMockApi } from '../../test/renderer/mockWindowApi'
import { libraryService, collectionService, tagService } from './library'

let api: any

beforeEach(() => {
  api = installMockApi()
})

// The service layer is a thin pass-through to window.api. These tests lock the
// wiring for every method: right namespace, right method, right argument order.
// Cheap insurance against a rename/typo silently breaking an IPC call.
describe('libraryService delegation', () => {
  it('getAll → api.library.getAll', () => {
    libraryService.getAll()
    expect(api.library.getAll).toHaveBeenCalledTimes(1)
  })
  it('getById forwards the id', () => {
    libraryService.getById('id1')
    expect(api.library.getById).toHaveBeenCalledWith('id1')
  })
  it('softDelete forwards the id', () => {
    libraryService.softDelete('id1')
    expect(api.library.softDelete).toHaveBeenCalledWith('id1')
  })
  it('restore forwards the id', () => {
    libraryService.restore('id1')
    expect(api.library.restore).toHaveBeenCalledWith('id1')
  })
  it('getTrashed → api.library.getTrashed', () => {
    libraryService.getTrashed()
    expect(api.library.getTrashed).toHaveBeenCalledTimes(1)
  })
  it('permanentlyDelete forwards the id', () => {
    libraryService.permanentlyDelete('id1')
    expect(api.library.permanentlyDelete).toHaveBeenCalledWith('id1')
  })
  it('emptyTrash → api.library.emptyTrash', () => {
    libraryService.emptyTrash()
    expect(api.library.emptyTrash).toHaveBeenCalledTimes(1)
  })
  it('updateProgress forwards id + position', () => {
    libraryService.updateProgress('id1', 0.42)
    expect(api.library.updateProgress).toHaveBeenCalledWith('id1', 0.42)
  })
  it('saveScrollPos forwards id + chapter + scrollY', () => {
    libraryService.saveScrollPos('id1', 2, 300)
    expect(api.library.saveScrollPos).toHaveBeenCalledWith('id1', 2, 300)
  })
  it('search forwards the query', () => {
    libraryService.search('dragons')
    expect(api.library.search).toHaveBeenCalledWith('dragons')
  })
  it('getAllItemTags → api.library.getAllItemTags', () => {
    libraryService.getAllItemTags()
    expect(api.library.getAllItemTags).toHaveBeenCalledTimes(1)
  })
  it('setCover forwards id + data + ext', () => {
    const buf = new ArrayBuffer(8)
    libraryService.setCover('id1', buf, 'png')
    expect(api.library.setCover).toHaveBeenCalledWith('id1', buf, 'png')
  })
  it('pickCover forwards the id', () => {
    libraryService.pickCover('id1')
    expect(api.library.pickCover).toHaveBeenCalledWith('id1')
  })
  it('setAuthor forwards id + author', () => {
    libraryService.setAuthor('id1', 'Ann')
    expect(api.library.setAuthor).toHaveBeenCalledWith('id1', 'Ann')
  })
  it('setTitle forwards id + title', () => {
    libraryService.setTitle('id1', 'New')
    expect(api.library.setTitle).toHaveBeenCalledWith('id1', 'New')
  })
  it('setStatus forwards id + status', () => {
    libraryService.setStatus('id1', 'finished')
    expect(api.library.setStatus).toHaveBeenCalledWith('id1', 'finished')
  })
  it('setRating forwards id + rating', () => {
    libraryService.setRating('id1', 4.5)
    expect(api.library.setRating).toHaveBeenCalledWith('id1', 4.5)
  })
  it('setReview forwards id + review', () => {
    libraryService.setReview('id1', 'good')
    expect(api.library.setReview).toHaveBeenCalledWith('id1', 'good')
  })
  it('refresh forwards the id', () => {
    libraryService.refresh('id1')
    expect(api.library.refresh).toHaveBeenCalledWith('id1')
  })
  it('findBySourceUrl forwards the url', () => {
    libraryService.findBySourceUrl('https://x')
    expect(api.library.findBySourceUrl).toHaveBeenCalledWith('https://x')
  })
  it('returns the underlying api result', () => {
    api.library.getById.mockReturnValue({ id: 'x', title: 'T' })
    expect(libraryService.getById('x')).toEqual({ id: 'x', title: 'T' })
  })
})

describe('collectionService delegation', () => {
  it('getAll → api.collections.getAll', () => {
    collectionService.getAll()
    expect(api.collections.getAll).toHaveBeenCalledTimes(1)
  })
  it('create forwards the name', () => {
    collectionService.create('Favorites')
    expect(api.collections.create).toHaveBeenCalledWith('Favorites')
  })
  it('delete forwards the id', () => {
    collectionService.delete('c1')
    expect(api.collections.delete).toHaveBeenCalledWith('c1')
  })
  it('rename forwards id + name', () => {
    collectionService.rename('c1', 'Renamed')
    expect(api.collections.rename).toHaveBeenCalledWith('c1', 'Renamed')
  })
  it('getAllItemCollections → api.collections.getAllItemCollections', () => {
    collectionService.getAllItemCollections()
    expect(api.collections.getAllItemCollections).toHaveBeenCalledTimes(1)
  })
  it('setForItem forwards itemId + ids', () => {
    collectionService.setForItem('item', ['c1', 'c2'])
    expect(api.collections.setForItem).toHaveBeenCalledWith('item', ['c1', 'c2'])
  })
  it('getItems forwards the id', () => {
    collectionService.getItems('c1')
    expect(api.collections.getItems).toHaveBeenCalledWith('c1')
  })
  it('reorderItems forwards id + ordered ids', () => {
    collectionService.reorderItems('col', ['a', 'b'])
    expect(api.collections.reorderItems).toHaveBeenCalledWith('col', ['a', 'b'])
  })
  it('addItem forwards id + itemId', () => {
    collectionService.addItem('c1', 'i1')
    expect(api.collections.addItem).toHaveBeenCalledWith('c1', 'i1')
  })
  it('removeItem forwards id + itemId', () => {
    collectionService.removeItem('c1', 'i1')
    expect(api.collections.removeItem).toHaveBeenCalledWith('c1', 'i1')
  })
})

describe('tagService delegation', () => {
  it('getAll → api.tags.getAll', () => {
    tagService.getAll()
    expect(api.tags.getAll).toHaveBeenCalledTimes(1)
  })
  it('getForItem forwards the itemId', () => {
    tagService.getForItem('i1')
    expect(api.tags.getForItem).toHaveBeenCalledWith('i1')
  })
  it('setForItem forwards itemId + tagIds', () => {
    tagService.setForItem('i1', ['t1', 't2'])
    expect(api.tags.setForItem).toHaveBeenCalledWith('i1', ['t1', 't2'])
  })
  it('create forwards name + color', () => {
    tagService.create('sci-fi', '#ff0000')
    expect(api.tags.create).toHaveBeenCalledWith('sci-fi', '#ff0000')
  })
  it('delete forwards the id', () => {
    tagService.delete('t1')
    expect(api.tags.delete).toHaveBeenCalledWith('t1')
  })
  it('rename forwards id + name', () => {
    tagService.rename('t1', 'fantasy')
    expect(api.tags.rename).toHaveBeenCalledWith('t1', 'fantasy')
  })
  it('setColor forwards id + color', () => {
    tagService.setColor('t1', '#00ff00')
    expect(api.tags.setColor).toHaveBeenCalledWith('t1', '#00ff00')
  })
  it('getItemCounts → api.tags.getItemCounts', () => {
    tagService.getItemCounts()
    expect(api.tags.getItemCounts).toHaveBeenCalledTimes(1)
  })
})
