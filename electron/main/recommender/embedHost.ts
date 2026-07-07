import type { EmbedItemInput } from './embeddingText'

// C2.4/C2.5 — the seam between "which items need embedding" (backfill, main
// process, owns the DB) and "run the model" (worker or in-process). The backfill
// runner depends only on this interface, so it's testable with a stub and the
// real impl (a utilityProcess worker, D-C2-2) can be swapped in at C2.5 without
// touching the orchestration.

export interface EmbedHost {
  /**
   * The model these vectors come from. Stored as `model_version` on each row and
   * fed to the staleness gate, so a model swap re-embeds everything (D-C2-3).
   */
  readonly modelVersion: string

  /** Embed one item into its final D8 vector (Tier-A metadata blended with Tier-B content). */
  embed(item: EmbedItemInput, tags: string[]): Promise<Float32Array>
}
