/**
 * Saves of a preference stored whole: one at a time, in order, the newest
 * value last, and a refusal reported only when nothing newer is on its way.
 */
import { describe, expect, it, vi } from 'vitest'
import { createOrderedSave, type RefusedSave } from '../ordered-save'

const ok = { ok: true } as Response
const refusal = { ok: false, status: 400 } as Response

/** A send whose answers the test gives one by one, in the order the saves went out. */
function manualSend() {
  const sent: string[][] = []
  const answers: Array<{ resolve: (response: Response) => void; reject: (error: unknown) => void }> = []
  const send = (value: string[]) => {
    sent.push(value)
    return new Promise<Response>((resolve, reject) => answers.push({ resolve, reject }))
  }
  return { send, sent, answers }
}

/** Lets the queue's pending steps run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('createOrderedSave', () => {
  it('sends a value and reports nothing when the server takes it', async () => {
    const { send, sent, answers } = manualSend()
    const onRefused = vi.fn()
    const save = createOrderedSave(send)

    const done = save(['/accounts'], onRefused)
    await settle()
    answers[0].resolve(ok)
    await done

    expect(sent).toEqual([['/accounts']])
    expect(onRefused).not.toHaveBeenCalled()
  })

  it('holds the next value until the one before it is answered', async () => {
    const { send, sent, answers } = manualSend()
    const save = createOrderedSave(send)

    void save(['/accounts'], vi.fn())
    await settle()
    const second = save(['/accounts', '/invoices'], vi.fn())
    await settle()
    expect(sent).toEqual([['/accounts']])

    answers[0].resolve(ok)
    await settle()
    expect(sent).toEqual([['/accounts'], ['/accounts', '/invoices']])

    answers[1].resolve(ok)
    await second
  })

  it('never sends a value that was replaced while it waited', async () => {
    const { send, sent, answers } = manualSend()
    const save = createOrderedSave(send)

    void save(['/a'], vi.fn())
    await settle()
    void save(['/a', '/b'], vi.fn())
    const last = save(['/a', '/b', '/c'], vi.fn())
    await settle()
    expect(sent).toEqual([['/a']])

    answers[0].resolve(ok)
    await settle()
    expect(sent).toEqual([['/a'], ['/a', '/b', '/c']])

    answers[1].resolve(ok)
    await last
  })

  it('sends only the newest of the values made before any went out', async () => {
    const { send, sent, answers } = manualSend()
    const save = createOrderedSave(send)

    void save(['/a'], vi.fn())
    const last = save(['/a', '/b'], vi.fn())
    await settle()
    answers[0].resolve(ok)
    await last

    expect(sent).toEqual([['/a', '/b']])
  })

  it('reports a refused save with nothing to put back when the server took none', async () => {
    const { send, answers } = manualSend()
    const refusals: RefusedSave<string[]>[] = []
    const save = createOrderedSave(send)

    const done = save(['/accounts'], (refused) => refusals.push(refused))
    await settle()
    answers[0].resolve(refusal)
    await done

    expect(refusals).toEqual([{ lastSaved: undefined, response: refusal }])
  })

  it('reports a refused save with the last value the server took', async () => {
    const { send, answers } = manualSend()
    const refusals: RefusedSave<string[]>[] = []
    const save = createOrderedSave(send)

    const first = save(['/accounts'], (refused) => refusals.push(refused))
    await settle()
    answers[0].resolve(ok)
    await first

    const second = save(['/accounts', '/invoices'], (refused) => refusals.push(refused))
    await settle()
    answers[1].resolve(refusal)
    await second

    expect(refusals).toEqual([{ lastSaved: ['/accounts'], response: refusal }])
  })

  it('reports a request that never got an answer', async () => {
    const { send, answers } = manualSend()
    const refusals: RefusedSave<string[]>[] = []
    const offline = new Error('offline')
    const save = createOrderedSave(send)

    const done = save(['/accounts'], (refused) => refusals.push(refused))
    await settle()
    answers[0].reject(offline)
    await done

    expect(refusals).toEqual([{ lastSaved: undefined, error: offline }])
  })

  it('stays quiet about a refused save while a newer value is on its way, and sends that one', async () => {
    const { send, sent, answers } = manualSend()
    const firstRefused = vi.fn()
    const secondRefused = vi.fn()
    const save = createOrderedSave(send)

    void save(['/accounts'], firstRefused)
    await settle()
    const second = save(['/accounts', '/invoices'], secondRefused)
    answers[0].resolve(refusal)
    await settle()

    expect(firstRefused).not.toHaveBeenCalled()
    expect(sent).toEqual([['/accounts'], ['/accounts', '/invoices']])

    answers[1].resolve(ok)
    await second
    expect(secondRefused).not.toHaveBeenCalled()
  })

  it('reports once when the newest value is refused too', async () => {
    const { send, answers } = manualSend()
    const firstRefused = vi.fn()
    const refusals: RefusedSave<string[]>[] = []
    const save = createOrderedSave(send)

    void save(['/accounts'], firstRefused)
    await settle()
    const second = save(['/accounts', '/invoices'], (refused) => refusals.push(refused))
    answers[0].resolve(refusal)
    await settle()
    answers[1].resolve(refusal)
    await second

    expect(firstRefused).not.toHaveBeenCalled()
    expect(refusals).toEqual([{ lastSaved: undefined, response: refusal }])
  })

  it('keeps saving after a refusal, and after a report that threw', async () => {
    const { send, sent, answers } = manualSend()
    const save = createOrderedSave(send)

    const first = save(['/accounts'], () => {
      throw new Error('the report failed')
    })
    await settle()
    answers[0].resolve(refusal)
    await expect(first).rejects.toThrow('the report failed')

    const onRefused = vi.fn()
    const second = save(['/invoices'], onRefused)
    await settle()
    answers[1].resolve(ok)
    await second

    expect(sent).toEqual([['/accounts'], ['/invoices']])
    expect(onRefused).not.toHaveBeenCalled()
  })
})
