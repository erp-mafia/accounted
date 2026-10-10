import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'
import { postedLineAsInput } from '@/lib/core/bookkeeping/posted-line-input'
import { fetchChartVatTreatments } from '@/lib/bookkeeping/chart-vat-treatments'
import { costAccountRcBasisRate } from '@/lib/bookkeeping/vat-entries'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput, JournalEntryLine } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

/**
 * POST /api/reports/vat-declaration/rc-basis-gaps/fix
 *
 * Adds the missing basbelopp pair (44xx/45xx debit + 4598 credit) to a
 * posted journal entry that has reverse-charge output VAT (2614/2624/2634)
 * but not the basis it implies. Uses correctEntry() so the original
 * voucher is preserved in compliance with BFL (storno + corrected entry).
 *
 * Only the shortfall is added, read off the verifikat itself as the gap scan
 * and the declaration read it (costAccountRcBasisRate with the company's
 * momskoder): a worklist can be stale, and a cost line whose momskod reports
 * ruta 20-24 already carries its share, so the whole basis on top of it would
 * count the purchase twice (crm#1096).
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

    const rateLabel = `${Math.round(rate * 100)}%`

    // The basis the verifikat already reports, by the sats the declaration
    // buckets it at: a static basis account, or a cost line whose momskod
    // reports ruta 20-24 itself.
    const chart = await fetchChartVatTreatments(supabase, companyId).catch((err: unknown) => {
      log.error('rc-basis-gap fix: momskod lookup failed', err as Error, { entryId })
      return null
    })
    if (!chart) {
      return errorResponseFromCode('VAT_REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: 'Kontoplanens momskoder kunde inte läsas.' },
      })
    }
    let reportedAtRate = 0
    let reportedAtOtherRates = 0
    for (const line of originalLines) {
      const lineRate = costAccountRcBasisRate(line.account_number, chart.get(line.account_number))
      if (lineRate === null) continue
      const net = (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)
      if (lineRate === rate) reportedAtRate = roundOre(reportedAtRate + net)
      else reportedAtOtherRates = roundOre(reportedAtOtherRates + net)
    }
    // A basis reported at another sats than the fiktiv moms is a sats error,
    // not a missing basis: a pair at the sats of the fiktiv moms would count
    // the purchase twice in ruta 20-24.
    if (reportedAtOtherRates > 0.5) {
      return errorResponseFromCode('VAT_REPORT_GENERATION_FAILED', log, {
        requestId,
        status: 409,
        messageSv:
          'Verifikationen redovisar redan sitt basbelopp i ruta 20-24, men till en annan momssats än ' +
          `den fiktiva momsen (${rateLabel}). Ett basbelopp till skulle räkna inköpet två gånger. ` +
          'Rätta momssatsen med rättelse eller storno av verifikationen, eller kontrollera kontots momssats i kontoplanen.',
        messageEn:
          'The voucher already reports its basis in boxes 20-24, but at another VAT rate than its ' +
          `reverse-charge VAT (${rateLabel}). Another basis would count the purchase twice. ` +
          'Correct the rate by correcting or reversing the voucher, or check the account\'s VAT rate in the chart of accounts.',
        details: { entryId, reportedAtOtherRates },
      })
    }
    // The scan's own tolerance: what it would not flag needs nothing.
    const basisAmount = roundOre(roundOre(outputAmount / rate) - reportedAtRate)
    if (basisAmount <= 0.5) {
      return errorResponseFromCode('VAT_REPORT_GENERATION_FAILED', log, {
        requestId,
        status: 409,
        messageSv:
          'Verifikationen redovisar redan basbeloppet för den fiktiva momsen i ruta 20-24, ' +
          'så inget saknas. Ladda om sidan för att uppdatera listan.',
        messageEn:
          'The voucher already reports the basis for its reverse-charge VAT in boxes 20-24, ' +
          'so nothing is missing. Reload the page to refresh the list.',
        details: { entryId, reportedAtRate },
      })
    }

    // Build corrected lines = original lines + basis pair (44xx debit + 4598
    // credit). The original lines are copied whole, dimensions bag included,
    // so the corrected entry keeps every tag the storno reverses.
    const correctedLines: CreateJournalEntryLineInput[] = [
      ...originalLines.map(postedLineAsInput),
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
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
