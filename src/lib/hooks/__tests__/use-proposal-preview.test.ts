import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchProposalPreview, ProposalPreviewError } from '../use-proposal-preview'

function respond(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({ ok: status < 400, status, json: () => Promise.resolve(body) })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchProposalPreview', () => {
  it('posts the proposal and answers the server’s lines', async () => {
    const lines = [
      { side: 'debet', account: '6540', amount: 100 },
      { side: 'kredit', account: '1930', amount: 100, settlement: true },
    ]
    const fetchMock = respond(200, { data: { lines } })
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchProposalPreview({ amount: 100, template_id: 'it_saas_eu' })).toEqual(lines)
    expect(fetchMock).toHaveBeenCalledWith('/api/bookkeeping/proposal-preview', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ amount: 100, template_id: 'it_saas_eu' }),
    }))
  })

  it('throws the refusal in Swedish', async () => {
    vi.stubGlobal('fetch', respond(400, {
      error: { code: 'TX_CATEGORIZE_INVALID_TEMPLATE', message: 'Bokföringsmallen är ogiltig eller passar inte din bolagsform.' },
    }))

    const failure = fetchProposalPreview({ amount: 100, template_id: 'ab_only' })
    await expect(failure).rejects.toBeInstanceOf(ProposalPreviewError)
    await expect(failure).rejects.toThrow('Bokföringsmallen är ogiltig')
  })
})
