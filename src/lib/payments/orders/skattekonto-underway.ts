/**
 * What the company's bank payments to the skattekonto (payment_orders with
 * purpose 'skattekonto') already cover and the synced saldo cannot show yet.
 * Dependency-free on purpose: Hem's Betala row and the payment dialog read it
 * on the server (lib/worklist/categories.ts), the Skattekonto page's own
 * shortfall line in the browser, and the two must never disagree.
 */
import { roundOre, sumOre } from '@/lib/money'
import { SIGNING_FINISHED_BATCH_STATUSES, UNANSWERED_SIGNING_MINUTES } from './status'

/** A skattekonto payment through the bank that a person approved and the bank has not finished: from approved to accepted. */
export const SKATTEKONTO_PAYMENT_UNDERWAY_STATUSES = ['approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted'] as const

/** The statuses to read: the ones on their way, and executed (counted only after the saldo was fetched). */
export const SKATTEKONTO_PAYMENT_COVER_STATUSES = [...SKATTEKONTO_PAYMENT_UNDERWAY_STATUSES, 'executed'] as const

const UNDERWAY: ReadonlySet<string> = new Set(SKATTEKONTO_PAYMENT_UNDERWAY_STATUSES)

/**
 * The signing an order is in (payment_order_batches through batch_id), as the
 * cover reads it. Every read selects it with the order:
 * `signing:payment_order_batches!fk_payment_orders_batch(status, signing_started_at)`.
 */
export interface SkattekontoPaymentSigning {
  status: string
  signing_started_at: string | null
}

export interface SkattekontoPaymentOrderCover {
  amount: number | string
  status: string
  executed_at: string | null
  /**
   * The order's signing; null for an order in none. PostgREST returns this
   * many-to-one embed as one object, but the generated client types it as an
   * array, so both shapes are accepted and read the same.
   */
  signing: SkattekontoPaymentSigning | SkattekontoPaymentSigning[] | null
}

/**
 * Whether an order is on its way to the bank, so it covers its amount. A
 * payment waiting for its BankID (awaiting_signature) is on its way only while
 * that signing can still finish: for UNANSWERED_SIGNING_MINUTES after it
 * started, where the status sync stops waiting for the BankID too. Past it, a
 * payment nobody signed would hide a real shortfall on the skattekonto for as
 * long as the bank cannot be read (crm#1721). The window runs from the
 * signing's start, so a failed status read never extends it, and nothing is
 * cancelled here: the order stays as it is, and Hem and the Skattekonto page
 * ask for the money again. A signing whose BankID finished (the bank is still
 * confirming it) counts at any age, as does every status a read moves the
 * order on to.
 */
export function isSkattekontoPaymentUnderway(order: Pick<SkattekontoPaymentOrderCover, 'status' | 'signing'>, nowMs: number): boolean {
  if (!UNDERWAY.has(order.status)) return false
  if (order.status !== 'awaiting_signature') return true
  const signing = Array.isArray(order.signing) ? (order.signing[0] ?? null) : order.signing
  if (!signing) return false
  if (SIGNING_FINISHED_BATCH_STATUSES.has(signing.status)) return true
  const startedAt = signing.signing_started_at ? Date.parse(signing.signing_started_at) : Number.NaN
  return Number.isFinite(startedAt) && nowMs - startedAt < UNANSWERED_SIGNING_MINUTES * 60_000
}

/**
 * Every order on its way to the bank (approved up to accepted, a signing
 * nobody finished only while it can, isSkattekontoPaymentUnderway) covers its
 * amount, and so does every one the bank executed after the saldo was
 * fetched. A draft nobody approved pays nothing. Without a snapshot
 * (fetchedAtMs null) only the orders on their way count, since nothing tells
 * whether an executed one already reached the charge the company reads.
 */
export function skattekontoPaymentsCovering(
  orders: readonly SkattekontoPaymentOrderCover[],
  fetchedAtMs: number | null,
  nowMs: number = Date.now(),
): number {
  const covering = orders.filter(
    (order) =>
      isSkattekontoPaymentUnderway(order, nowMs) ||
      (order.status === 'executed' && fetchedAtMs !== null && order.executed_at !== null && Date.parse(order.executed_at) > fetchedAtMs),
  )
  return sumOre(covering.map((order) => Number(order.amount)))
}

/** A skattekonto bank payment as declarationBankPayment reads it. */
export interface SkattekontoDeclarationPaymentOrder extends Pick<SkattekontoPaymentOrderCover, 'amount' | 'status' | 'executed_at' | 'signing'> {
  requested_execution_date: string
  created_at: string
}

/**
 * The bank payment that pays a declaration in to the skattekonto, so the page
 * stops offering Betala via banken and the payment file for it: they would pay
 * it twice. Orders carry no link to a declaration, so this is the payment the
 * declaration's own Betala via banken makes: made after the declaration was
 * generated, for at least its amount (alone, or with the other declarations
 * due the same day), paid on or before its due date, and on its way to the
 * bank (isSkattekontoPaymentUnderway) or executed. A smaller payment leaves
 * the rest to pay and is not it. The newest such order, or null; null also
 * when the due date is unknown.
 */
export function declarationBankPayment<T extends SkattekontoDeclarationPaymentOrder>(
  orders: readonly T[],
  declaration: { declared: number; created_at: string; due_date: string | null },
  nowMs: number = Date.now(),
): T | null {
  if (!declaration.due_date) return null
  const dueDate = declaration.due_date
  const generatedAt = Date.parse(declaration.created_at)
  if (!Number.isFinite(generatedAt)) return null
  const paying = orders.filter(
    (order) =>
      (order.status === 'executed' || isSkattekontoPaymentUnderway(order, nowMs)) &&
      Date.parse(order.created_at) >= generatedAt &&
      order.requested_execution_date <= dueDate &&
      roundOre(Number(order.amount)) >= declaration.declared,
  )
  return paying.reduce<T | null>((newest, order) => (!newest || Date.parse(order.created_at) > Date.parse(newest.created_at) ? order : newest), null)
}
