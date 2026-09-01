import type { BackupExportResult, BackupImportResult } from '../types'

export const backupService = {
  export: (): Promise<BackupExportResult | null> => window.api.backup.export(),
  import: (): Promise<BackupImportResult> => window.api.backup.import(),
}
