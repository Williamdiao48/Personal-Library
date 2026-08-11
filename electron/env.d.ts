// Ambient typing for the main-process build's `import.meta.env`. electron-vite
// injects `MAIN_VITE_*` vars (from a gitignored .env) at build time; this gives
// the main TypeScript project (tsconfig.node.json) type-safety for the ones we
// read. Both are optional — an unconfigured build simply has them undefined and
// the auth layer no-ops (the Phase 1 local-only invariant).
interface ImportMetaEnv {
  readonly MAIN_VITE_SUPABASE_URL?: string
  readonly MAIN_VITE_SUPABASE_ANON_KEY?: string
  // Dev/testing only: override the R2 reaper's mark-and-sweep grace window (ms) so a
  // two-profile rig can see a reap in seconds instead of the 10-min default. A plain
  // tuning knob (not a secret); a release built with no override uses the default.
  readonly MAIN_VITE_REAP_GRACE_MS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
