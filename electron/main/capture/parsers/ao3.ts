import type { JSDOM } from 'jsdom'

export function parseAo3Metadata(dom: JSDOM): { title?: string; author?: string } {
  const doc = dom.window.document

  const title = doc.querySelector('.title.heading')?.textContent?.trim()
  const author = doc.querySelector('.byline.heading a[rel="author"]')?.textContent?.trim()

  return { title, author }
}
