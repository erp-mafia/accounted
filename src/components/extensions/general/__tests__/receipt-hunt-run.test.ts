import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runReceiptHunt } from '@/components/extensions/general/receipt-hunt-run'

function pass(data: Record<string, number>, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } })
}

function passes(...responses: Response[]) {
  const queue = [...responses]
  return vi.fn(async () => {
    const next = queue.shift()
    if (!next) throw new Error('no more passes queued')
    return next
  })
}

const base = { purchasesWithoutReceipt: 30, searched: 25, proposed: 0, remaining: 5, searchFailures: 0 }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runReceiptHunt', () => {
  it('keeps going while passes fetch something and stops on the first that fetches nothing', async () => {
    const request = passes(
      pass({ ...base, fetched: 2, proposed: 1 }),
      pass({ ...base, fetched: 1, proposed: 1, remaining: 4 }),
      pass({ ...base, fetched: 0, remaining: 3 }),
    )
    const onPass = vi.fn()

    const outcome = await runReceiptHunt({ request, shouldStop: () => false, onPass })

    expect(request).toHaveBeenCalledTimes(3)
    // Totals across passes; what is left comes from the last pass.
    expect(outcome).toEqual({ kind: 'finished', fetched: 3, proposed: 2, remaining: 3 })
    expect(onPass.mock.calls.map(([progress]) => progress)).toEqual([
      { passes: 1, fetched: 2, proposed: 1 },
      { passes: 2, fetched: 3, proposed: 2 },
      { passes: 3, fetched: 3, proposed: 2 },
    ])
  })

  it('reports an unreadable mailbox, never "nothing found", when a pass could not search', async () => {
    // The regression this shape exists for: zero fetched from a mailbox that
    // refused the search would otherwise read as "no receipts there".
    const request = passes(
      pass({ ...base, fetched: 1 }),
      pass({ ...base, fetched: 0, searchFailures: 1, remaining: 5 }),
    )

    const outcome = await runReceiptHunt({ request, shouldStop: () => false })

    expect(outcome).toEqual({ kind: 'mailbox_unreadable', fetched: 1, proposed: 0, remaining: 5 })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('stops on a search failure even when that pass fetched something', async () => {
    const request = passes(pass({ ...base, fetched: 2, searchFailures: 1 }))

    const outcome = await runReceiptHunt({ request, shouldStop: () => false })

    expect(outcome.kind).toBe('mailbox_unreadable')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('tells a paywall refusal apart from a failure, so "try again" is not offered for it', async () => {
    const refusal = new Response(
      JSON.stringify({ error: 'Den här funktionen kräver en betald prenumeration.', capability_blocked: true, capability: 'ai' }),
      { status: 403 },
    )

    const outcome = await runReceiptHunt({ request: passes(refusal), shouldStop: () => false })

    expect(outcome).toEqual({ kind: 'blocked', fetched: 0, proposed: 0 })
  })

  it('tells "another pass is running" and "the day is spent" apart from a failure', async () => {
    const busy = new Response(JSON.stringify({ code: 'RECEIPT_HUNT_IN_PROGRESS' }), { status: 409 })
    const limited = new Response(JSON.stringify({ error: 'För många förfrågningar.' }), { status: 429 })

    expect(await runReceiptHunt({ request: passes(busy), shouldStop: () => false })).toEqual({
      kind: 'busy',
      fetched: 0,
      proposed: 0,
    })
    expect(
      await runReceiptHunt({ request: passes(pass({ ...base, fetched: 1 }), limited), shouldStop: () => false }),
    ).toEqual({ kind: 'limited', fetched: 1, proposed: 0 })
  })

  it('treats a 403 without the capability marker as a failure', async () => {
    const forbidden = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })

    const outcome = await runReceiptHunt({ request: passes(forbidden), shouldStop: () => false })

    expect(outcome.kind).toBe('failed')
  })

  it('keeps what earlier passes fetched when a later one fails', async () => {
    const request = passes(
      pass({ ...base, fetched: 2, proposed: 1 }),
      new Response('<html>502</html>', { status: 502 }),
    )

    const outcome = await runReceiptHunt({ request, shouldStop: () => false })

    expect(outcome).toEqual({ kind: 'failed', fetched: 2, proposed: 1 })
  })

  it('fails on a network error and on an answer that is not a pass', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect((await runReceiptHunt({ request: offline, shouldStop: () => false })).kind).toBe('failed')

    const notAPass = passes(new Response(JSON.stringify({ data: { searched: 3 } }), { status: 200 }))
    expect((await runReceiptHunt({ request: notAPass, shouldStop: () => false })).kind).toBe('failed')
  })

  it('stops after the pass in flight when asked to', async () => {
    let stop = false
    const request = vi.fn(async () => {
      // Pressed while the first pass is running.
      stop = true
      return pass({ ...base, fetched: 2 })
    })

    const outcome = await runReceiptHunt({ request, shouldStop: () => stop })

    expect(request).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ kind: 'finished', fetched: 2, proposed: 0, remaining: 5 })
  })

  it('never runs past the backstop, however much every pass reports', async () => {
    const request = vi.fn(async () => pass({ ...base, fetched: 1 }))

    const outcome = await runReceiptHunt({ request, shouldStop: () => false, maxPasses: 3 })

    expect(request).toHaveBeenCalledTimes(3)
    expect(outcome).toEqual({ kind: 'finished', fetched: 3, proposed: 0, remaining: 5 })
  })
})
