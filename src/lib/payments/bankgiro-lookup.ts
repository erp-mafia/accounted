/**
 * Bankgiro Lookup: fraud and typo protection around bankgiro and plusgiro
 * payments, through Accounted Connect's payments family (contract 2026-10-16,
 * lookupCreditor and lookupGiroNumbers), served by the provider's premium
 * Bankgiro Lookup product.
 *
 *   lookupCreditorName      the name Bankgirot has registered for a giro
 *                           number and, with an OCR, whether the creditor
 *                           accepts it: shown before a person signs a payment
 *                           to a new or changed account, and when a supplier
 *                           card is saved.
 *   lookupCompanyGiroNumbers the giro numbers registered to the company's own
 *                           organisationsnummer: offered when the invoice
 *                           payee is set up.
 *
 * Every provider call may cost the premium fee, so the whole feature sits
 * behind OPENPAYMENTS_BANKGIRO_LOOKUP=true (bankgiroLookupEnabled): with the
 * flag off, or without a connector key, every answer is `{ enabled: false }`
 * and Connect is never called. Answers are cached in the process for ten
 * minutes per company and question (a dialog re-render never pays twice);
 * a provider refusal is not cached, so a later attempt may still succeed.
 *
 * A lookup is advice, never a gate: nothing here throws for a provider
 * failure. The answer says `available: false` with a reason and the caller
 * shows nothing or a quiet note; the person may still proceed.
 */

import { PAYMENTS_OPERATIONS, type PaymentsLookupUnavailableReason } from '@accounted/connect-contract'
import { signerPersonalNumberOnFile } from '@/lib/auth/bankid-signer'
import { validateBankgiroNumber, validatePlusgiroNumber } from '@/lib/bankgiro/luhn'
import { companyOrgNumber } from '@/lib/company/org-number'
import { callConnectorOperation } from '@/lib/connect/instance/connector-fetch'
import { paymentsConnectorMode } from '@/lib/connect/instance/upstreams'
import type { OperationContext } from '@/lib/operations/types'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { giroMessage } from '@/lib/payments/supplier-payee'

/** The environment flag that switches the premium lookups on: exactly 'true'. */
export const BANKGIRO_LOOKUP_FLAG = 'OPENPAYMENTS_BANKGIRO_LOOKUP'

/** Ten minutes: long enough for a dialog's re-renders and a second look, short enough that a corrected registration shows the same day. */
export const BANKGIRO_LOOKUP_CACHE_TTL_MS = 10 * 60 * 1000

/** Connect's own client timeout is 20 s; wait long enough to hear its answer. */
const LOOKUP_TIMEOUT_MS = 30_000

type Env = Readonly<Record<string, string | undefined>>

/** Whether the premium lookups are switched on for this installation; read on every call, so a redeploy with a new value needs nothing else. */
export function bankgiroLookupEnabled(env: Env = process.env): boolean {
  return env[BANKGIRO_LOOKUP_FLAG]?.trim() === 'true'
}

export type GiroType = 'bankgiro' | 'plusgiro'

/**
 * Why a switched-on lookup has no answer: the contract's reasons, plus two
 * decided here before any call: `invalid_number` (the giro fails its check
 * digit, so Bankgirot cannot know it) and `org_number_missing` (the company
 * has no organisationsnummer to ask as).
 */
export type LookupUnavailableReason = PaymentsLookupUnavailableReason | 'invalid_number' | 'org_number_missing'

export const LOOKUP_UNAVAILABLE_REASONS = ['premium_not_enabled', 'provider_refused', 'not_found', 'invalid_number', 'org_number_missing'] as const

export interface LookupWarning {
  code: string
  text: string | null
}

export type CreditorNameLookup =
  | { enabled: false }
  | { enabled: true; available: false; reason: LookupUnavailableReason }
  | { enabled: true; available: true; creditorName: string; ocrValid: boolean | null; warnings: LookupWarning[] }

export interface RegisteredGiro {
  number: string
  type: GiroType
  name: string | null
}

export type CompanyGiroNumbersLookup =
  | { enabled: false }
  | { enabled: true; available: false; reason: LookupUnavailableReason }
  | { enabled: true; available: true; giroNumbers: RegisteredGiro[] }

export interface CreditorLookupInput {
  /** The giro number as typed or stored: digits, spaces and dashes. */
  giro: string
  type: GiroType
  /** The payment's OCR reference, when it has one: the creditor's OCR check runs on it. */
  ocr?: string | null
  /** The payment's free reference (the invoice number) when it has no OCR. */
  invoiceRef?: string | null
}

export interface LookupDeps {
  env?: Env
  now?: () => number
  fetch?: typeof fetch
}

type Cached<T> = { expiresAt: number; value: T }

const creditorCache = new Map<string, Cached<CreditorNameLookup>>()
const giroNumbersCache = new Map<string, Cached<CompanyGiroNumbersLookup>>()

/** Tests only. */
export function resetBankgiroLookupCache(): void {
  creditorCache.clear()
  giroNumbersCache.clear()
}

function readCache<T>(cache: Map<string, Cached<T>>, key: string, now: number): T | null {
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.expiresAt <= now) {
    cache.delete(key)
    return null
  }
  return hit.value
}

/** Only answers worth repeating are kept: a provider failure is asked again next time. */
function cacheable(answer: { available: boolean; reason?: LookupUnavailableReason }): boolean {
  return answer.available || answer.reason === 'not_found' || answer.reason === 'premium_not_enabled'
}

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

/** The OCR as the contract takes it (2 to 25 digits), or null when the value is no OCR at all. */
function ocrForWire(ocr: string | null | undefined): string | null {
  const cleaned = (ocr ?? '').replace(/[\s-]/g, '')
  return /^\d{2,25}$/.test(cleaned) ? cleaned : null
}

/** The free reference as the contract takes it: the giro message (giroMessage), or null when empty. */
function invoiceRefForWire(ref: string | null | undefined): string | null {
  return giroMessage(ref ?? '') || null
}

async function lookupParty(ctx: OperationContext): Promise<{ orgNumber: string; signerPersonalNumber: string | null } | null> {
  const orgNumber = await companyOrgNumber(ctx.supabase, ctx.companyId)
  if (!orgNumber) return null
  // Never thrown: a person with no BankID login still gets the lookup.
  const signer = await signerPersonalNumberOnFile(ctx.userId).catch(() => null)
  return {
    orgNumber,
    signerPersonalNumber: signer ? digits(signer) : null,
  }
}

/**
 * Whether anything may be asked for this company: the flag, a connector key,
 * and not a sandbox company (a demo must never cost a premium fee or reach a
 * real registry). Asks nothing of the provider: the forms' probe.
 */
export async function bankgiroLookupOpen(ctx: Pick<OperationContext, 'supabase' | 'companyId'>, env: Env = process.env): Promise<boolean> {
  if (!bankgiroLookupEnabled(env)) return false
  if (!paymentsConnectorMode()) return false
  return !(await isSandboxCompany(ctx.supabase, ctx.companyId))
}

async function gate(ctx: OperationContext, env: Env): Promise<{ enabled: false } | null> {
  return (await bankgiroLookupOpen(ctx, env)) ? null : { enabled: false }
}

/**
 * The name Bankgirot has registered for a bankgiro or plusgiro number and,
 * when the payment carries an OCR, whether the creditor accepts it.
 */
export async function lookupCreditorName(ctx: OperationContext, input: CreditorLookupInput, deps: LookupDeps = {}): Promise<CreditorNameLookup> {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const closed = await gate(ctx, env)
  if (closed) return closed

  const giro = digits(input.giro)
  const valid = input.type === 'bankgiro' ? validateBankgiroNumber(giro) : validatePlusgiroNumber(giro)
  if (!valid) return { enabled: true, available: false, reason: 'invalid_number' }
  // A valid plusgiro may be as short as two digits, but the provider takes five
  // at least: nothing to ask, and nothing to pay for.
  if (giro.length < 5) return { enabled: true, available: false, reason: 'provider_refused' }
  const ocrRef = ocrForWire(input.ocr)
  const invoiceRef = ocrRef ? null : invoiceRefForWire(input.invoiceRef)

  const key = [ctx.companyId, input.type, giro, ocrRef ?? '', invoiceRef ?? ''].join('|')
  const cached = readCache(creditorCache, key, now())
  if (cached) return cached

  const party = await lookupParty(ctx)
  if (!party) return { enabled: true, available: false, reason: 'org_number_missing' }
  const upstream = paymentsConnectorMode()
  if (!upstream) return { enabled: false }

  let answer: CreditorNameLookup
  try {
    const result = await callConnectorOperation({
      upstream,
      operation: 'payments.lookupCreditor',
      def: PAYMENTS_OPERATIONS.lookupCreditor,
      body: {
        party,
        giroNumber: giro,
        giroType: input.type === 'bankgiro' ? 'BANKGIRO' : 'PLUSGIRO',
        ...(ocrRef ? { ocrRef } : {}),
        ...(invoiceRef ? { invoiceRef } : {}),
      },
      companyId: ctx.companyId,
      timeoutMs: LOOKUP_TIMEOUT_MS,
      fetch: deps.fetch,
    })
    answer = result.available
      ? { enabled: true, available: true, creditorName: result.creditorName, ocrValid: result.ocrValid, warnings: result.warnings }
      : { enabled: true, available: false, reason: result.reason }
  } catch (error) {
    // Advice, never a gate: the person pays without the name rather than not at all.
    ctx.log.warn('bankgiro lookup: Connect did not answer', { type: input.type, err: error instanceof Error ? error.message : String(error) })
    answer = { enabled: true, available: false, reason: 'provider_refused' }
  }
  if (cacheable(answer)) creditorCache.set(key, { expiresAt: now() + BANKGIRO_LOOKUP_CACHE_TTL_MS, value: answer })
  return answer
}

/** The giro numbers registered to the company's own organisationsnummer. */
export async function lookupCompanyGiroNumbers(ctx: OperationContext, deps: LookupDeps = {}): Promise<CompanyGiroNumbersLookup> {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const closed = await gate(ctx, env)
  if (closed) return closed

  const cached = readCache(giroNumbersCache, ctx.companyId, now())
  if (cached) return cached

  const party = await lookupParty(ctx)
  if (!party) return { enabled: true, available: false, reason: 'org_number_missing' }
  const upstream = paymentsConnectorMode()
  if (!upstream) return { enabled: false }

  let answer: CompanyGiroNumbersLookup
  try {
    const result = await callConnectorOperation({
      upstream,
      operation: 'payments.lookupGiroNumbers',
      def: PAYMENTS_OPERATIONS.lookupGiroNumbers,
      body: { party },
      companyId: ctx.companyId,
      timeoutMs: LOOKUP_TIMEOUT_MS,
      fetch: deps.fetch,
    })
    answer = result.available
      ? { enabled: true, available: true, giroNumbers: result.giroNumbers.map((g) => ({ number: g.number, type: g.type, name: g.name })) }
      : { enabled: true, available: false, reason: result.reason }
  } catch (error) {
    ctx.log.warn('bankgiro lookup: Connect did not answer the giro numbers', { err: error instanceof Error ? error.message : String(error) })
    answer = { enabled: true, available: false, reason: 'provider_refused' }
  }
  if (cacheable(answer)) giroNumbersCache.set(ctx.companyId, { expiresAt: now() + BANKGIRO_LOOKUP_CACHE_TTL_MS, value: answer })
  return answer
}
