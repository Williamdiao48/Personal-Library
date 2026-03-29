import type { ConvertPayload, ConvertResult } from '../types'

export const convertService = {
  pdfToEpub: (payload: ConvertPayload): Promise<ConvertResult> =>
    window.api.convert.pdfToEpub(payload),
}
