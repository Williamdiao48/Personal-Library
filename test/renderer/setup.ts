// Renderer (jsdom) test setup — loaded by the `renderer` vitest project.
// Adds jest-dom matchers and auto-cleans the DOM + mocks between tests.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom has no ResizeObserver, but components that size themselves to their
// container (e.g. CollectionView's grid, RecommendationCard's clamp measurement)
// construct one in a layout effect. This stub is a no-op by default — it only
// fires when a test explicitly calls `fireResize(el)`. Because ResizeObserver is
// used all over the app, `fireResize` targets a specific observed element and
// fires only the observers watching it — so concurrently-running suites (which
// share this global stub) can't cross-fire each other's observers.
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = []
  callback: ResizeObserverCallback
  elements = new Set<Element>()
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb
    ResizeObserverStub.instances.push(this)
  }
  observe(el: Element): void {
    this.elements.add(el)
  }
  unobserve(el: Element): void {
    this.elements.delete(el)
  }
  disconnect(): void {
    this.elements.clear()
  }
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub

/** Fire every ResizeObserver currently observing `el` (usually exactly one). */
export function fireResize(el: Element): void {
  for (const inst of ResizeObserverStub.instances) {
    if (inst.elements.has(el)) inst.callback([], inst as unknown as ResizeObserver)
  }
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
  ResizeObserverStub.instances = []
})
