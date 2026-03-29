import type { CaptureResult } from '../types'

export const captureService = {
  // Fire-and-forget: starts a background capture and returns a jobId.
  // Subscribe to window.api.onCaptureProgress/Complete/Error for updates.
  start:    (url: string, start?: number, end?: number): Promise<string>              => window.api.capture.start(url, start, end),
  fromFile: ():                                           Promise<CaptureResult | null> => window.api.capture.fromFile(),
  append:   (itemId: string, end: number):               Promise<string>              => window.api.capture.append(itemId, end),
}
