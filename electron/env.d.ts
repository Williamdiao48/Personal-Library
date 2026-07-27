// Ambient typing for the main-process build's `import.meta.env`. electron-vite
// injects `MAIN_VITE_*` vars (from a gitignored .env) at build time; this gives
// the main TypeScript project (tsconfig.node.json) type-safety for the ones we
// read. Both are optional — an unconfigured build simply has them undefined and
// the auth layer no-ops (the Phase 1 local-only invariant).
interface ImportMetaEnv {
  readonly MAIN_VITE_SUPABASE_URL?: string
  readonly MAIN_VITE_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
