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

// jsdom has no IntersectionObserver, but DiscoverView's infinite-scroll sentinel
// constructs one on mount. This controllable stub records each instance's callback
// so a test can drive the intersection: `fireIntersection()` fires the latest
// (active) observer. observe/disconnect are no-ops.
class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []
  callback: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb
    IntersectionObserverStub.instances.push(this)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}
;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
  IntersectionObserverStub

/** Fire the most recently constructed IntersectionObserver (the active sentinel). */
export function fireIntersection(isIntersecting = true): void {
  const inst = IntersectionObserverStub.instances.at(-1)
  inst?.callback(
    [{ isIntersecting } as IntersectionObserverEntry],
    inst as unknown as IntersectionObserver,
  )
}

afterEach(() => {
  cleanup()
  IntersectionObserverStub.instances = []
})
