import { vi } from 'vitest'

// Installs a fake `window.api` where every namespace method is an auto-created
// vi.fn(). Services are thin wrappers over window.api.<ns>.<method>(...args), so
// tests just assert the right method was called with the right args.
//
// A Proxy lazily materializes namespaces/methods and caches each vi.fn() so the
// same reference is returned across accesses (required for call assertions).

type Fn = ReturnType<typeof vi.fn>

function makeNamespace(): Record<string, Fn> {
  const fns = new Map<string, Fn>()
  return new Proxy({} as Record<string, Fn>, {
    get(_t, prop: string) {
      if (!fns.has(prop)) fns.set(prop, vi.fn())
      return fns.get(prop)
    },
  })
}

export function installMockApi(): any {
  const namespaces = new Map<string, Record<string, Fn>>()
  const api = new Proxy(
    {},
    {
      get(_t, ns: string) {
        if (!namespaces.has(ns)) namespaces.set(ns, makeNamespace())
        return namespaces.get(ns)
      },
    },
  )
  ;(globalThis as any).window = (globalThis as any).window ?? {}
  ;(globalThis as any).window.api = api
  return api
}
