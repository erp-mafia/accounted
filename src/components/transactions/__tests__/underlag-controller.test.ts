import { describe, it, expect, vi } from 'vitest'
import { createUnderlagController } from '../underlag-controller'
import type { UnderlagWrite } from '../review-underlag'

/**
 * crm#1101: the first document attached in a booking dialog is pinned to
 * the bank transaction at once, so closing the dialog keeps it. These are
 * the orderings that decide what the row holds and what the booking links:
 * every pin and take-off is a request the person can act around while it is
 * on its way, so each test holds the requests open and settles them by hand.
 */

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const OK: UnderlagWrite = { ok: true }
const REFUSED: UnderlagWrite = {
  ok: false,
  status: 409,
  body: { error: { code: 'DOC_ATTACH_OTHER_VERIFIKAT', message: 'Underlaget är redan kopplat till en annan verifikation.' } },
}

function setup(initial: { transactionId: string | null; documentId: string | null } = { transactionId: 'tx-1', documentId: null }) {
  // What the dialog read about the row (the underlag route, else the list's pin).
  const row = { ...initial }
  const pins: Array<{ documentId: string; answer: (write: UnderlagWrite) => void }> = []
  const unpins: Array<(write: UnderlagWrite) => void> = []
  const deps = {
    read: () => ({ ...row }),
    pin: vi.fn((_transactionId: string, documentId: string) => {
      const d = deferred<UnderlagWrite>()
      pins.push({ documentId, answer: d.resolve })
      return d.promise
    }),
    unpin: vi.fn((_transactionId: string) => {
      const d = deferred<UnderlagWrite>()
      unpins.push(d.resolve)
      return d.promise
    }),
    onState: vi.fn(),
    onPinned: vi.fn(),
    onUnpinned: vi.fn(),
    onPinFailed: vi.fn(),
    onUnpinFailed: vi.fn(),
  }
  return { row, pins, unpins, deps, controller: createUnderlagController(deps) }
}

// The queue hands each write on through a few promise hops.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('claim', () => {
  it('pins the first document attached to a row without underlag', async () => {
    const { controller, pins, deps } = setup()

    const claimed = controller.claim('doc-a', 'kvitto.pdf')
    await flush()
    expect(deps.pin).toHaveBeenCalledWith('tx-1', 'doc-a')
    expect(controller.state().busy).toBe(true)
    expect(controller.tracks('doc-a')).toBe(true)

    pins[0].answer(OK)
    await expect(claimed).resolves.toBe(true)
    expect(controller.documentId()).toBe('doc-a')
    expect(deps.onPinned).toHaveBeenCalledWith('tx-1', 'doc-a', 'kvitto.pdf')
    expect(controller.state()).toEqual({
      session: { transactionId: 'tx-1', documentId: 'doc-a', fileName: 'kvitto.pdf' },
      busy: false,
    })
    expect(deps.onState).toHaveBeenLastCalledWith(controller.state())
  })

  it('holds a second document attached while the first pin is on its way, never pinning over it', async () => {
    const { controller, pins, deps } = setup()

    const first = controller.claim('doc-a', null)
    const second = controller.claim('doc-b', null)
    await flush()
    expect(deps.pin).toHaveBeenCalledTimes(1)

    pins[0].answer(OK)
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(false)
    expect(deps.pin).toHaveBeenCalledTimes(1)
    expect(controller.documentId()).toBe('doc-a')
  })

  it('leaves a row that already has its underlag (pinned before, or matched in the inkorg) alone', async () => {
    const { controller, deps } = setup({ transactionId: 'tx-1', documentId: 'doc-before' })

    await expect(controller.claim('doc-a', null)).resolves.toBe(false)
    expect(deps.pin).not.toHaveBeenCalled()
    expect(controller.documentId()).toBe('doc-before')
  })

  it('keeps a refused document attached in the dialog, where the booking links it, and says why', async () => {
    const { controller, pins, deps } = setup()

    const claimed = controller.claim('doc-a', null)
    await flush()
    pins[0].answer(REFUSED)

    await expect(claimed).resolves.toBe(false)
    expect(deps.onPinFailed).toHaveBeenCalledWith(REFUSED)
    expect(controller.documentId()).toBeNull()
    expect(controller.tracks('doc-a')).toBe(false)
    expect(controller.isLetGo('doc-a')).toBe(false)
  })

  it('pins nothing without a transaction', async () => {
    const { controller, deps } = setup({ transactionId: null, documentId: null })
    await expect(controller.claim('doc-a', null)).resolves.toBe(false)
    expect(deps.pin).not.toHaveBeenCalled()
  })
})

describe('withdraw: a document the person removed never stays on the row', () => {
  it('takes a document removed while its pin was on its way off as soon as the pin lands', async () => {
    const { controller, pins, unpins, deps } = setup()

    const claimed = controller.claim('doc-a', null)
    await flush()
    // The x in the upload list, while the pin is still on its way.
    const withdrawn = controller.withdraw('doc-a')
    expect(controller.isLetGo('doc-a')).toBe(true)

    pins[0].answer(OK)
    await expect(claimed).resolves.toBe(true)
    await flush()
    expect(deps.unpin).toHaveBeenCalledWith('tx-1')

    unpins[0](OK)
    await expect(withdrawn).resolves.toBe(true)
    expect(controller.documentId()).toBeNull()
    expect(deps.onUnpinned).toHaveBeenCalledWith('tx-1', 'doc-a')
    await expect(controller.settled()).resolves.toBeNull()
  })

  it('never pins a document removed before its turn came', async () => {
    const { controller, pins, deps } = setup()

    const first = controller.claim('doc-a', null)
    const second = controller.claim('doc-b', null)
    const withdrawn = controller.withdraw('doc-b')
    await flush()
    // The first pin fails, so the row would have taken the second one.
    pins[0].answer(REFUSED)

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    await expect(withdrawn).resolves.toBe(true)
    expect(deps.pin).toHaveBeenCalledTimes(1)
    expect(deps.pin).not.toHaveBeenCalledWith('tx-1', 'doc-b')
    expect(deps.unpin).not.toHaveBeenCalled()
  })

  it('lets a document only the dialog holds go at once, with no write', async () => {
    const { controller, deps } = setup({ transactionId: 'tx-1', documentId: 'doc-before' })

    await expect(controller.withdraw('doc-held')).resolves.toBe(true)
    expect(deps.unpin).not.toHaveBeenCalled()
    expect(controller.isLetGo('doc-held')).toBe(true)
    expect(controller.state().busy).toBe(false)
  })

  it("keeps a document whose take-off the route refused: still the row's, so still attached", async () => {
    const { controller, pins, unpins, deps } = setup()

    const claimed = controller.claim('doc-a', null)
    await flush()
    pins[0].answer(OK)
    await claimed

    const withdrawn = controller.withdraw('doc-a')
    await flush()
    const refusal: UnderlagWrite = { ok: false, status: 409, body: { error: { code: 'DOC_DETACH_POSTED' } } }
    unpins[0](refusal)

    await expect(withdrawn).resolves.toBe(false)
    expect(deps.onUnpinFailed).toHaveBeenCalledWith(refusal)
    expect(controller.documentId()).toBe('doc-a')
    expect(controller.isLetGo('doc-a')).toBe(false)
  })

  it('offers a document attached again after it was let go to the row again', async () => {
    const { controller, pins } = setup()

    await controller.withdraw('doc-a')
    expect(controller.isLetGo('doc-a')).toBe(true)

    const claimed = controller.claim('doc-a', null)
    expect(controller.isLetGo('doc-a')).toBe(false)
    await flush()
    pins[0].answer(OK)
    await expect(claimed).resolves.toBe(true)
  })
})

describe('release', () => {
  it('takes the underlag the row had before the dialog off', async () => {
    const { controller, unpins, deps } = setup({ transactionId: 'tx-1', documentId: 'doc-before' })

    const released = controller.release()
    await flush()
    unpins[0](OK)

    await expect(released).resolves.toBe('doc-before')
    expect(controller.documentId()).toBeNull()
    expect(deps.onUnpinned).toHaveBeenCalledWith('tx-1', 'doc-before')
    expect(controller.isLetGo('doc-before')).toBe(true)
  })

  it('answers null and keeps the underlag when the take-off is refused, or there is none', async () => {
    const { controller, unpins } = setup({ transactionId: 'tx-1', documentId: 'doc-before' })

    const released = controller.release()
    await flush()
    unpins[0]({ ok: false, status: 0, body: null })
    await expect(released).resolves.toBeNull()
    expect(controller.documentId()).toBe('doc-before')

    const none = setup()
    await expect(none.controller.release()).resolves.toBeNull()
    expect(none.deps.unpin).not.toHaveBeenCalled()
  })
})

describe('settled: what a booking waits for', () => {
  it('answers once the pin on its way has landed, with the pinned document', async () => {
    const { controller, pins } = setup()

    const claimed = controller.claim('doc-a', null)
    let answer: string | null | undefined
    const settled = controller.settled().then((id) => {
      answer = id
    })
    await flush()
    expect(answer).toBeUndefined()

    pins[0].answer(OK)
    await settled
    expect(answer).toBe('doc-a')
    await claimed
  })

  it('also waits for a write asked for while it waited', async () => {
    const { controller, pins, unpins } = setup()

    const claimed = controller.claim('doc-a', null)
    const settled = controller.settled()
    await flush()
    const withdrawn = controller.withdraw('doc-a')
    pins[0].answer(OK)
    await claimed
    await flush()
    unpins[0](OK)

    await expect(settled).resolves.toBeNull()
    await withdrawn
  })

  it('answers at once when nothing is on its way', async () => {
    const { controller } = setup({ transactionId: 'tx-1', documentId: 'doc-before' })
    await expect(controller.settled()).resolves.toBe('doc-before')
  })
})

it("answers for its own row only: after a switch to another row, that row's read counts", async () => {
  const { controller, pins, row } = setup()

  const claimed = controller.claim('doc-a', null)
  await flush()
  pins[0].answer(OK)
  await claimed
  expect(controller.documentId()).toBe('doc-a')

  row.transactionId = 'tx-2'
  row.documentId = null
  expect(controller.documentId()).toBeNull()
})
