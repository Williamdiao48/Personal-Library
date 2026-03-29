import sanitizeHtml from 'sanitize-html'

export function sanitize(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'hr',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins',
      'sup', 'sub', 'mark',
      'blockquote', 'pre', 'code',
      'a', 'img',
      'figure', 'figcaption',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
      'div', 'span', 'section', 'article', 'aside',
    ],
    allowedAttributes: {
      'a':   ['href', 'title'],
      'img': ['src', 'alt', 'title', 'loading'],
      'td':  ['colspan', 'rowspan'],
      'th':  ['colspan', 'rowspan'],
      '*':   ['class', 'id'],
    },
    allowedSchemes: ['http', 'https'],
    transformTags: {
      'img': (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, loading: 'lazy' },
      }),
    },
  })
}
