// Renderer (jsdom) test setup — loaded by the `renderer` vitest project.
// Adds jest-dom matchers and auto-cleans the DOM + mocks between tests.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})
