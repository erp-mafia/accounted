import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'
import type { CreateJournalEntryLineInput, JournalEntryLine } from '@/types'

/**
 * POST /api/reports/vat-declaration/rc-basis-gaps/fix
 *
 * Adds the missing basbelopp pair (44xx/45xx debit + 4598 credit) to a
 * posted journal entry that has reverse-charge output VAT (2614/2624/2634)
 * but no corresponding basis lines. Uses correctEntry() so the original
 * voucher is preserved in compliance with BFL (storno + corrected entry).
 */

const SUPPLIER_TYPE = z.enum(['eu_business', 'non_eu_business', 'swedish_business'])
const SERVICE_OR_GOODS = z.enum(['service', 'goods'])

const FixGapSchema = z.object({
  entryId: z.string().uuid(),
  supplierType: SUPPLIER_TYPE,
  supplyType: SERVICE_OR_GOODS,
})

const RC_OUTPUT_ACCOUNTS = new Set(['2614', '2624', '2634'])
const RATE_BY_OUTPUT: Record<string, number> = {
  '2614': 0.25,
  '2624': 0.12,
  '2634': 0.06,
}

function pickBasisAccount(
  outputAccount: string,
  supplierType: 'eu_business' | 'non_eu_business' | 'swedish_business',
  supplyType: 'service' | 'goods',
): { account: string; error?: undefined } | { account?: undefined; error: string } {
  const rateIdx = outputAccount === '2614' ? 0 : outputAccount === '2624' ? 1 : outputAccount === '2634' ? 2 : -1
  if (rateIdx < 0) return { error: 'Okänt RC-utgående konto.' }

  // EU services 4535/4536/4537, EU goods 4515/4516/4517,
  // non-EU services 4531/4532/4533, domestic services 4425/4426/4427,
  // domestic goods 4415/4416/4417.
  // Non-EU goods is NOT reverse charge: it's import VAT (ruta 50/60-62 via
  // 4545-4547), a separate flow that doesn't belong on this correction path.
  if (supplierType === 'eu_business' && supplyType === 'service') return { account: ['4535', '4536', '4537'][rateIdx] }
  if (supplierType === 'eu_business' && supplyType === 'goods') return { account: ['4515', '4516', '4517'][rateIdx] }
  if (supplierType === 'non_eu_business' && supplyType === 'service') return { account: ['4531', '4532', '4533'][rateIdx] }
  if (supplierType === 'non_eu_business' && supplyType === 'goods') {
    return {
      error:
        'Varor från leverantörer utanför EU hanteras som import (ruta 50/60-62), inte omvänd skattskyldighet. ' +
        'Korrigera verifikationen manuellt med importmoms på 2615/4545.',
    }
  }
  if (supplierType === 'swedish_business' && supplyType === 'service') return { account: ['4425', '4426', '4427'][rateIdx] }
  if (supplierType === 'swedish_business' && supplyType === 'goods') return { account: ['4415', '4416', '4417'][rateIdx] }
  return { error: 'Kunde inte välja basbeloppskonto för angiven leverantörstyp.' }
}

export const POST = withRouteContext(
  'report.vat_declaration.rc_basis_gaps.fix',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, FixGapSchema)
    if (!result.success) return result.response
    const { entryId, supplierType, supplyType } = result.data

    // Fetch the entry + its lines (RLS + explicit company filter)
    const { data: entry, error: fetchErr } = await supabase
      .from('journal_entries')
      .select('id, status, lines:journal_entry_lines(*)')
      .eq('id', entryId)
      .eq('company_id', companyId)
      .single()

    if (fetchErr || !entry) {
      return errorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', log, { requestId, details: { entryId } })
    }

    if (entry.status !== 'posted') {
      return errorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', log, {
        requestId,
        details: { entryId, reason: `entry is ${entry.status}, expected posted` },
      })
    }

    const originalLines = (entry.lines as JournalEntryLine[]) || []

    // Identify the RC output account and amount (sum across multiple lines if any)
    let outputAccount: string | null = null
    let outputAmount = 0
    for (const line of originalLines) {
      if (RC_OUTPUT_ACCOUNTS.has(line.account_number)) {
        const net = (Number(line.credit_amount) || 0) - (Number(line.debit_amount) || 0)
        if (net > 0) {
          if (outputAccount && outputAccount !== line.account_number) {
            return errorResponseFromCode('VAT_REPORT_GENERATION_FAILED', log, {
              requestId,
              details: {
                reason: 'Verifikationen har RC-moms på flera räntesatser. Korrigera manuellt.',
              },
            })
          }
          outputAccount = line.account_number
          outputAmount += net
        }
      }
    }

    if (!outputAccount || outputAmount <= 0) {
      return errorResponseFromCode('VAT_REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: 'Ingen RC-utgående moms hittades i verifikationen.' },
      })
    }

    const rate = RATE_BY_OUTPUT[outputAccount]
    const pick = pickBasisAccount(outputAccount, supplierType, supplyType)
    if (!pick.account) {
      return errorResponseFromCode('VAT_REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: pick.error ?? 'Kunde inte välja basbeloppskonto.' },
      })
    }
    const basisAccount: string = pick.account

    const basisAmount = Math.round((outputAmount / rate) * 100) / 100
    const rateLabel = `${Math.round(rate * 100)}%`

    // Build corrected lines = original lines + basis pair (44xx debit + 4598 credit)
    const correctedLines: CreateJournalEntryLineInput[] = [
      ...originalLines.map((l) => {
        const line: CreateJournalEntryLineInput = {
          account_number: l.account_number,
          debit_amount: Number(l.debit_amount) || 0,
          credit_amount: Number(l.credit_amount) || 0,
        }
        if (l.currency) line.currency = l.currency
        if (l.amount_in_currency != null) line.amount_in_currency = Number(l.amount_in_currency)
        if (l.exchange_rate != null) line.exchange_rate = Number(l.exchange_rate)
        if (l.line_description) line.line_description = l.line_description
        if (l.tax_code) line.tax_code = l.tax_code
        if (l.cost_center) line.cost_center = l.cost_center
        if (l.project) line.project = l.project
        return line
      }),
      {
        account_number: basisAccount,
        debit_amount: basisAmount,
        credit_amount: 0,
        line_description: `Basbelopp omvänd skattskyldighet ${rateLabel}`,
      },
      {
        account_number: '4598',
        debit_amount: 0,
        credit_amount: basisAmount,
        line_description: `Motkonto beräknad omvänd moms ${rateLabel}`,
      },
    ]

    try {
      const correction = await correctEntry(supabase, companyId, user.id, entryId, correctedLines)
      return NextResponse.json({
        data: {
          reversalId: correction.reversal.id,
          correctedId: correction.corrected.id,
          basisAccount,
          basisAmount,
        },
      })
    } catch (err) {
      log.error('rc-basis-gap fix failed', err as Error, { entryId })
      return errorResponseFromCode('VAT_REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
