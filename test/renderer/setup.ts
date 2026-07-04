// Renderer (jsdom) test setup — loaded by the `renderer` vitest project.
// Adds jest-dom matchers and auto-cleans the DOM + mocks between tests.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom has no ResizeObserver, but components that size themselves to their
// container (e.g. CollectionView's grid) construct one in a layout effect. A
// no-op stub is enough for tests that don't assert on observed dimensions.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
}

afterEach(() => {
  cleanup()
})
