import {
  DELIVERY_OPERATIONS,
  type DeliveryMethod,
  type DeliveryOperation,
  type DeliveryStatus,
} from '@accounted/connect-contract'
import { CONNECTOR_REQUEST_INVALID_CODE } from '@/lib/connect/instance/connector-fetch'
import { encodeFakeCaseRef, fakeCaseAt } from '@/lib/collections/adapters/fake'
import { COLLECTIONS_NOT_FOUND, CollectionsError } from '@/lib/collections/errors'
import type { DeliveryAdapter } from '../port'

/**
 * The deterministic fake delivery provider: tests, local development and
 * sandbox companies (route 'fake'). Nothing is ever sent.
 *
 * - methods: a debtor whose identifier ends in 0 is unreachable
 *   (reasonCode 'not_registered'); every other one is reachable.
 * - send: answers a delivery handle that carries the method and the time;
 *   with followUp it also answers the watching case (stage invoice_sent),
 *   which the collections fake then reads like any other case.
 * - status: scheduled, then sent after one timeline minute, then delivered
 *   after three.
 * A replayed send (same idempotency key) answers the same handle within a
 * process.
 */

export interface FakeDeliveryOptions {
  now?: () => Date
  minuteMs?: number
  /** idempotency key -> delivery handle, for replays. */
  sent?: Map<string, string>
}

const METHOD_CODES: Record<DeliveryMethod, string> = { post: 'p', kivra: 'k', einvoice_bank: 'e' }
const processSent = new Map<string, string>()

function validate(operation: DeliveryOperation, body: unknown): void {
  const parsed = DELIVERY_OPERATIONS[operation].request.safeParse(body)
  if (parsed.success) return
  throw new CollectionsError(`Fake delivery ${operation}: the request does not match the contract`, {
    code: CONNECTOR_REQUEST_INVALID_CODE,
    retryable: false,
    detail: parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; '),
  })
}

export function encodeFakeDeliveryRef(method: DeliveryMethod, sentAt: number, serial: number): string {
  return ['fake', METHOD_CODES[method], Math.floor(sentAt / 1000).toString(36), serial.toString(36)].join('.')
}

export function decodeFakeDeliveryRef(ref: string): { method: DeliveryMethod; sentAt: number } | null {
  const [prefix, code, sentSec] = ref.split('.')
  const method = (Object.keys(METHOD_CODES) as DeliveryMethod[]).find((m) => METHOD_CODES[m] === code)
  const seconds = parseInt(sentSec ?? '', 36)
  if (prefix !== 'fake' || !method || !Number.isFinite(seconds)) return null
  return { method, sentAt: seconds * 1000 }
}

export function createFakeDeliveryAdapter(options: FakeDeliveryOptions = {}): DeliveryAdapter {
  const now = () => (options.now ? options.now() : new Date()).getTime()
  const minuteMs = options.minuteMs ?? 60_000
  const sent = options.sent ?? processSent

  return {
    route: 'fake',

    async methods(_ctx, input) {
      validate('methods', input)
      const identifier = input.debtor.kind === 'business' ? input.debtor.orgNumber : input.debtor.personalNumber
      const reachable = !identifier?.endsWith('0')
      return {
        method: input.method,
        reachable,
        reasonCode: reachable ? null : 'not_registered',
        checkedAt: new Date(now()).toISOString(),
      }
    },

    async send(_ctx, input) {
      validate('send', input)
      const at = now()
      let deliveryRef = sent.get(input.idempotencyKey)
      if (!deliveryRef) {
        deliveryRef = encodeFakeDeliveryRef(input.method, at, sent.size + 1)
        sent.set(input.idempotencyKey, deliveryRef)
      }
      const sentAt = decodeFakeDeliveryRef(deliveryRef)!.sentAt
      let watchingCase = null
      if (input.followUp) {
        const caseRef = encodeFakeCaseRef({
          step: 'invoice',
          openedAt: sentAt,
          claimAmount: input.invoice.claimAmount,
          claimRemaining: input.invoice.claimRemaining,
          invoiceRef: input.invoice.ref,
        })
        watchingCase = fakeCaseAt(
          caseRef,
          { step: 'invoice', openedAt: sentAt, claimAmount: input.invoice.claimAmount, claimRemaining: input.invoice.claimRemaining, invoiceRef: input.invoice.ref },
          [],
          at,
          minuteMs,
        )
      }
      return { deliveryRef, acceptedAt: new Date(sentAt).toISOString(), scheduledFor: null, case: watchingCase }
    },

    async status(_ctx, input) {
      validate('status', input)
      const decoded = decodeFakeDeliveryRef(input.deliveryRef)
      if (!decoded) {
        throw new CollectionsError('Fake delivery: no such delivery', { code: COLLECTIONS_NOT_FOUND, retryable: false })
      }
      const timeline: Array<[DeliveryStatus['state'], number]> = [
        ['scheduled', decoded.sentAt],
        ['sent', decoded.sentAt + minuteMs],
        ['delivered', decoded.sentAt + 3 * minuteMs],
      ]
      return timeline
        .filter(([, at]) => at <= now())
        .map(([state, at]) => ({ state, method: decoded.method, occurredAt: new Date(at).toISOString(), detail: null }))
    },
  }
}
