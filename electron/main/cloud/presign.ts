import { getSupabase } from '../auth/client'

export type BlobOp = 'put' | 'get'
export type BlobKind = 'content' | 'cover'

// Client for the blob-url Edge Function (Phase 2 Decision 7). Asks for a
// short-lived presigned R2 URL scoped to the caller's own prefix; the session JWT
// is attached automatically by supabase-js, and the R2 secret never leaves the
// server. Bytes then flow directly to the returned URL (see uploader).
export async function presignBlobUrl(op: BlobOp, kind: BlobKind, hash: string): Promise<string> {
  const supabase = getSupabase()
  if (!supabase) throw new Error('cloud not configured')

  const { data, error } = await supabase.functions.invoke('blob-url', {
    body: { op, kind, hash },
  })
  if (error) throw new Error(`presign failed: ${error.message ?? String(error)}`)
  const url = (data as { url?: string } | null)?.url
  if (!url) throw new Error('presign returned no url')
  return url
}
