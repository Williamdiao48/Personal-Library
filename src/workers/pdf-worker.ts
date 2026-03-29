// Import polyfills first — they must run before pdf.worker.mjs is evaluated.
import '../polyfills/pdfjs-compat'
import 'pdfjs-dist/build/pdf.worker.mjs'
