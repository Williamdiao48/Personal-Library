import type { BackupExportResult } from '../types'

export const backupService = {
  export: (): Promise<BackupExportResult | null> => window.api.backup.export(),
  import: (): Promise<void>                       => window.api.backup.import(),
}
