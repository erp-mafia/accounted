import { describe, expect, it, vi } from 'vitest'
import { refreshCounterparts } from '../refresh'

describe('refreshCounterparts', () => {
  it('reports successful reads, including a genuinely empty refresh', async () => {
    const post = vi.fn().mockResolvedValueOnce({ created: 0, attached: 2, merged: 1 }).mockResolvedValueOnce({ written: 0 })
    expect(await refreshCounterparts(post)).toEqual({ status: 'success', count: 0 })
    expect(post.mock.calls).toEqual([['/api/parties/suggest'], ['/api/parties/resolver/run']])
  })

  it('does not report failed requests as an empty success', async () => {
    const post = vi.fn().mockRejectedValue(new Error('503'))
    expect(await refreshCounterparts(post)).toEqual({ status: 'failed', count: 0 })
  })

  it.each(['suggest', 'resolver'])('keeps the other result when %s fails', async (failed) => {
    const post = vi.fn()
    if (failed === 'suggest') post.mockRejectedValueOnce(new Error('57014')).mockResolvedValueOnce({ written: 4 })
    else post.mockResolvedValueOnce({ created: 3, attached: 0 }).mockRejectedValueOnce(new Error('57014'))
    expect(await refreshCounterparts(post)).toEqual({ status: 'partial', count: failed === 'suggest' ? 4 : 3 })
  })

  it('waits for the other request after a failure before allowing a reload or retry', async () => {
    let finish!: (value: { written: number }) => void
    const pending = new Promise<{ written: number }>((resolve) => { finish = resolve })
    const post = vi.fn().mockRejectedValueOnce(new Error('503')).mockReturnValueOnce(pending)
    const settled = vi.fn()
    const result = refreshCounterparts(post).then((value) => { settled(); return value })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).not.toHaveBeenCalled()
    finish({ written: 2 })
    expect(await result).toEqual({ status: 'partial', count: 2 })
  })
})
