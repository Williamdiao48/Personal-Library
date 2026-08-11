import { getSupabase } from '../auth/client'

export type BlobOp = 'put' | 'get' | 'delete'
export type BlobKind = 'content' | 'cover'
// A presign can also target the transient Phase-4 extraction-source prefix. Scratch is
// NOT a `BlobKind`: it is never laddered into `blob_sync` (it's a throwaway parse input,
// not a synced backup), so the ledger/reaper types stay narrow (`BlobKind`) and only the
// presign call surface widens to include it.
export type BlobScope = BlobKind | 'scratch'

// Client for the blob-url Edge Function (Phase 2 Decision 7). Asks for a
// short-lived presigned R2 URL scoped to the caller's own prefix; the session JWT
// is attached automatically by supabase-js, and the R2 secret never leaves the
// server. Bytes then flow directly to the returned URL (see uploader).
//
// For a PUT, pass `size` — the exact byte count of the body about to be uploaded.
// The server bakes it into the signature as a cap, so R2 rejects a larger body;
// it must equal the Content-Length the upload fetch sends (the body's length).
export async function presignBlobUrl(
  op: BlobOp,
  kind: BlobScope,
  hash: string,
  size?: number,
): Promise<string> {
  const supabase = getSupabase()
  if (!supabase) throw new Error('cloud not configured')

  const { data, error } = await supabase.functions.invoke('blob-url', {
    body: { op, kind, hash, ...(size !== undefined ? { size } : {}) },
  })
  if (error) throw new Error(`presign failed: ${error.message ?? String(error)}`)
  const url = (data as { url?: string } | null)?.url
  if (!url) throw new Error('presign returned no url')
  return url
}
