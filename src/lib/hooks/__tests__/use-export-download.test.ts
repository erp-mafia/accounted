import { describe, expect, it, vi } from 'vitest'
import { saveExport } from '../use-export-download'
import { RENDERED_DOWNLOAD_TIMEOUT_MS, type DownloadFileResult } from '@/lib/browser/download-file'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const copy = { timeout: 'timed out', network: 'no connection' }

function answering(result: DownloadFileResult) {
  return vi.fn().mockResolvedValue(result)
}

describe('saveExport', () => {
  it('saves under the server name and says nothing when the file arrived', async () => {
    const download = answering({ ok: true, filename: 'balansrapport.xlsx' })

    expect(await saveExport('/api/reports/x', 'export.xlsx', { locale: 'sv', copy, download })).toBeNull()
    expect(download).toHaveBeenCalledWith({
      url: '/api/reports/x',
      filename: 'export.xlsx',
      preferServerFilename: true,
      locale: 'sv',
      timeoutMs: RENDERED_DOWNLOAD_TIMEOUT_MS,
    })
  })

  it("keeps the route's own message for a refusal", async () => {
    const download = answering({ ok: false, reason: 'server', status: 403, message: 'Du saknar behörighet.', body: null })

    expect(await saveExport('/api/x', 'x.csv', { locale: 'sv', copy, download })).toBe('Du saknar behörighet.')
  })

  it('says a timeout and a lost connection apart', async () => {
    expect(await saveExport('/api/x', 'x.csv', { locale: 'sv', copy, download: answering({ ok: false, reason: 'timeout' }) }))
      .toBe('timed out')
    expect(await saveExport('/api/x', 'x.csv', { locale: 'sv', copy, download: answering({ ok: false, reason: 'network', message: 'x' }) }))
      .toBe('no connection')
  })

  it('reports a save the browser threw on instead of rejecting', async () => {
    const download = vi.fn().mockRejectedValue(new Error('NotAllowedError'))

    const failure = await saveExport('/api/x', 'x.csv', { locale: 'en', copy, download })
    expect(failure).toBe(getErrorMessage(new Error('NotAllowedError'), { locale: 'en' }))
    expect(failure).not.toBe('NotAllowedError')
  })
})
