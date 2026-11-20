/**
 * The submit hook, walked through what a person does, one handler at a time:
 * which requests leave the editor when a registration is confirmed.
 *
 * The hook keeps its state with useState and useReducer only, so a slot
 * store stands in for React: render() runs the hook the way a render does,
 * the handlers it hands out write the slots, and the next render() sees
 * them. No DOM and no renderer. fetch is the only way out, and it is
 * recorded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PayerChoice } from '@/lib/expenses/payer'
import type { SupplierInvoiceFormData } from '@/lib/supplier-invoices/form-payload'

const store = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  /** The slot of the hook call at this position in the render, created on the first render. */
  const slot = (initial: () => unknown): number => {
    const index = store.cursor++
    if (!(index in store.slots)) store.slots[index] = initial()
    return index
  }
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = slot(() => (typeof initial === 'function' ? (initial as () => unknown)() : initial))
      const set = (next: unknown) => {
        store.slots[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(store.slots[index]) : next
      }
      return [store.slots[index], set]
    },
    useReducer: (reducer: (state: unknown, action: unknown) => unknown, initial: unknown) => {
      const index = slot(() => initial)
      const dispatch = (action: unknown) => {
        store.slots[index] = reducer(store.slots[index], action)
      }
      return [store.slots[index], dispatch]
    },
  }
})

// Under a plain name: it runs on the slot store above, not inside a React render.
import { useSupplierInvoiceSubmit as supplierInvoiceSubmit } from '../use-supplier-invoice-submit'

type HookParams = Parameters<typeof supplierInvoiceSubmit>[0]

const fetchMock = vi.fn()
const finishCreate = vi.fn()

/** One render of the hook: the state as it is now, and handlers that see it. */
function render(overrides: Partial<HookParams> = {}) {
  store.cursor = 0
  return supplierInvoiceSubmit({
    t: ((key: string) => key) as never,
    ta: ((key: string) => key) as never,
    toast: vi.fn() as never,
    isEF: false,
    inboxItemId: null,
    originalExtracted: null,
    buildPayload: (data) => data,
    reset: vi.fn(),
    finishCreate,
    documentUploadInProgress: false,
    documentUploadFailed: false,
    showNoPeriodWarning: false,
    canUseAccrual: false,
    invoiceNumberInputRef: { current: null },
    euSupplier: false,
    // The payment reference is on one other invoice of the supplier: every
    // registration passes the review dialog, an enskild firma's too.
    acknowledgesInReview: async () => true,
    ...overrides,
  })
}

const form = (payer: PayerChoice): SupplierInvoiceFormData => ({
  supplier_id: 'supplier-1',
  supplier_invoice_number: 'F-2002',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  delivery_date: '',
  currency: 'SEK',
  exchange_rate: '',
  reverse_charge: false,
  reverse_charge_kind: '',
  payment_reference: '5550001',
  notes: '',
  payer,
  claimant_name: '',
  employee_id: '',
  items: [{ description: 'Lokalhyra', amount: 1000, account_number: '5010', vat_rate: 0.25 }],
})

/** Every request the editor sent, in order: "POST /api/...". */
const requests = (): string[] => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url)}`)

const CREATE = 'POST /api/supplier-invoices'
const APPROVE = 'POST /api/supplier-invoices/si-1/approve'
const matchTo = (transactionId: string) => `POST /api/transactions/${transactionId}/match-supplier-invoice`

beforeEach(() => {
  vi.clearAllMocks()
  store.slots.length = 0
  store.cursor = 0
  fetchMock.mockImplementation(async (url: string) => {
    const body = /register-and-settle$/.test(url)
      ? { data: { supplier_invoice_id: 'si-1', arrival_number: 7, settled: true, settlement_error: null } }
      : { data: { id: 'si-1', arrival_number: 7 } }
    return { ok: true, status: 200, json: async () => body }
  })
  vi.stubGlobal('fetch', fetchMock)
})

describe('useSupplierInvoiceSubmit: a bank row belongs to the submit it was picked for', () => {
  const companies: Array<[string, boolean, string[]]> = [
    // An enskild firma's registration is attested at once; an aktiebolag's is not.
    ['an enskild firma', true, [CREATE, APPROVE]],
    ['an aktiebolag', false, [CREATE]],
  ]

  it.each(companies)(
    '%s: Obetald after a pick the person stepped back from is registered unpaid, matched to no bank row',
    async (_name, isEF, registersUnpaid) => {
      const hook = () => render({ isEF })
      // Vem betalade: Företaget. The picker opens, and row X is picked.
      await hook().onSubmit(form('company'))
      expect(hook().showBankPicker).toBe(true)
      await hook().handlePickTransaction('tx-X')
      expect(hook().showReview).toBe(true)
      // Tillbaka. Vem betalade: Ingen ännu. Registrera: the review opens again.
      hook().setShowReview(false)
      await hook().onSubmit(form('unpaid'))
      expect(hook().showReview).toBe(true)
      expect(requests()).toEqual([])
      // "Registrera ändå".
      await hook().handleConfirm()

      expect(requests()).toEqual(registersUnpaid)
      expect(requests()).not.toContain(matchTo('tx-X'))
      expect(finishCreate).toHaveBeenCalledTimes(1)
    },
  )

  it.each(companies)('%s: the row picked for a submit is matched when that submit is confirmed', async (_name, isEF, registersUnpaid) => {
    const hook = () => render({ isEF })
    await hook().onSubmit(form('company'))
    await hook().handlePickTransaction('tx-X')
    await hook().handleConfirm()

    expect(requests()).toEqual([...registersUnpaid, matchTo('tx-X')])
  })

  it('a second pick replaces the first: the registration is matched to the row picked for it', async () => {
    const hook = () => render({ isEF: true })
    await hook().onSubmit(form('company'))
    await hook().handlePickTransaction('tx-X')
    hook().setShowReview(false)
    await hook().onSubmit(form('company'))
    await hook().handlePickTransaction('tx-Y')
    await hook().handleConfirm()

    expect(requests()).toEqual([CREATE, APPROVE, matchTo('tx-Y')])
  })

  describe('with the bank row the Inkorg already knows', () => {
    const inbox = { isEF: true, inboxItemId: 'item-1', settleTransactionId: 'tx-S' }
    const CONVERT = 'POST /api/extensions/ext/invoice-inbox/items/item-1/convert'

    it('registers and settles against it when the company paid', async () => {
      const hook = () => render(inbox)
      await hook().onSubmit(form('company'))
      expect(hook().showReview).toBe(true)
      await hook().handleConfirm()

      expect(requests()).toEqual(['POST /api/inkorg/items/item-1/register-and-settle'])
    })

    it('leaves it alone once the person says nobody has paid yet', async () => {
      const hook = () => render(inbox)
      await hook().onSubmit(form('company'))
      hook().setShowReview(false)
      await hook().onSubmit(form('unpaid'))
      await hook().handleConfirm()

      expect(requests()).toEqual([CONVERT, APPROVE])
      expect(requests()).not.toContain(matchTo('tx-S'))
    })
  })
})
