import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import {
  errorResponse,
  errorResponseFromCode,
  extractBookkeepingDetails,
} from '@/lib/errors/get-structured-error'
import {
  BookkeepingDatabaseError,
  CannotCorrectNonPostedError,
  EntryAlreadyReversedError,
  isBookkeepingError,
} from '@/lib/bookkeeping/errors'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'
import { postedLineAsInput } from '@/lib/core/bookkeeping/posted-line-input'
import { fetchDynamicVatAccounts, type DynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import {
  RC_BASIS_TOLERANCE,
  isRcBasisGap,
  missingRcBasis,
  rcBasisReading,
  readVerifikatRcBasis,
  type RcBasisAtRate,
} from '@/lib/reports/rc-basis-gaps'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput, JournalEntryLine } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/reports/vat-declaration/rc-basis-gaps/fix
 *
 * Adds the basis a posted journal entry with reverse-charge output VAT
 * (2614/2624/2634) lacks: one basbelopp pair (44xx/45xx debit + 4598 credit)
 * per momssats that falls short. Uses correctEntry() so the original voucher
 * is preserved in compliance with BFL (storno + corrected entry).
 *
 * What is missing is read again here, at correction time, with the gap
 * scan's own rule (readVerifikatRcBasis over the declaration's account
 * resolution) and only that is added: the worklist row is a snapshot, and a
 * basis the verifikat already reports, on a static basis account or on a
 * cost line whose momskod reports ruta 20-24, would otherwise count the
 * purchase twice (crm#1096). Each momssats is classified on its own (EU goods
 * at 12 % and an EU service at 25 % land in different rutor). Refused, with
 * nothing written, when nothing is missing (an already corrected verifikat
 * included), when the verifikat reports its basis at another momssats than
 * its fiktiv moms, when it books on an account the declaration counts in
 * ruta 20-24 at no momssats (a momskod for omvänd skattskyldighet without
 * Standard moms 25, 12 or 6 %), or when the kontoplan reads the basis
 * account the pair would go on at another sats: only the kontoplan can fix
 * the last two.
 */

const SUPPLIER_TYPE = z.enum(['eu_business', 'non_eu_business', 'swedish_business'])
const SERVICE_OR_GOODS = z.enum(['service', 'goods'])

type RcOutputAccount = RcBasisAtRate['rcOutputAccount']

const FixGapSchema = z.object({
  entryId: z.string().uuid(),
  supplierType: SUPPLIER_TYPE,
  supplyType: SERVICE_OR_GOODS,
  /**
   * The classification of one momssats, by its fiktiv moms account, where it
   * differs from the one above: a verifikat with EU goods at 12 % and an EU
   * service at 25 % reports them in ruta 20 and ruta 21.
   */
  perOutputAccount: z
    .array(
      z.object({
        rcOutputAccount: z.enum(['2614', '2624', '2634']),
        supplierType: SUPPLIER_TYPE,
        supplyType: SERVICE_OR_GOODS,
      }),
    )
    .max(3)
    .optional(),
})

const RATE_INDEX: Record<RcOutputAccount, number> = { '2614': 0, '2624': 1, '2634': 2 }

/**
 * The BAS basis account for a sats and classification: EU services
 * 4535/4536/4537, EU goods 4515/4516/4517, non-EU services 4531/4532/4533,
 * domestic services 4425/4426/4427, domestic goods 4415/4416/4417. Null for
 * goods from outside the EU: that is import VAT (ruta 50/60-62 via
 * 4545-4547), not reverse charge, and does not belong on this path.
 */
function pickBasisAccount(
  outputAccount: RcOutputAccount,
  supplierType: z.infer<typeof SUPPLIER_TYPE>,
  supplyType: z.infer<typeof SERVICE_OR_GOODS>,
): string | null {
  const rateIdx = RATE_INDEX[outputAccount]
  if (supplierType === 'eu_business') {
    return (supplyType === 'service' ? ['4535', '4536', '4537'] : ['4515', '4516', '4517'])[rateIdx]
  }
  if (supplierType === 'non_eu_business') {
    return supplyType === 'service' ? ['4531', '4532', '4533'][rateIdx] : null
  }
  return (supplyType === 'service' ? ['4425', '4426', '4427'] : ['4415', '4416', '4417'])[rateIdx]
}

/**
 * The database's refusals of a write behind a lock, in the triggers' own
 * words: a locked or closed period (enforce_period_lock) and the company's
 * lock date (enforce_company_lock_date). The user's state, not a server fault.
 */
const LOCK_REFUSAL = /locked\/closed fiscal period|Bokföringen är låst/i

/** "25 %", or "25 % och 12 %" for a verifikat with fiktiv moms at two sats. */
function satsLabel(rates: RcBasisAtRate[]): string {
  return rates.map((r) => `${Math.round(r.rate * 100)} %`).join(' och ')
}

/** Basis reported at a momssats beyond what the fiktiv moms at that sats implies. */
function surplusRcBasis(rate: RcBasisAtRate): number {
  return roundOre(rate.reportedBasisAmount - Math.max(rate.expectedBasisAmount, 0))
}

export const POST = withRouteContext(
  'report.vat_declaration.rc_basis_gaps.fix',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, FixGapSchema)
    if (!result.success) return result.response
    const { entryId, supplierType, supplyType, perOutputAccount } = result.data

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

    // A stale row whose verifikat was already corrected (in another tab, by a
    // colleague, by an earlier click): the storno left it reversed, and its
    // correction is a verifikat of its own that the list shows after a reload.
    const alreadyReversed = () =>
      errorResponseFromCode('VAT_RC_BASIS_NOTHING_MISSING', log, {
        requestId,
        messageSv:
          'Verifikationen har redan rättats med storno, så det finns inget kvar att korrigera på den. ' +
          'Ladda om sidan så uppdateras listan.',
        messageEn:
          'The voucher has already been reversed, so there is nothing to correct on it. ' +
          'Reload the page to refresh the list.',
        details: { entryId, reason: 'reversed' },
      })
    if (entry.status === 'reversed') return alreadyReversed()

    if (entry.status !== 'posted') {
      return errorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', log, {
        requestId,
        details: { entryId, reason: `entry is ${entry.status}, expected posted` },
      })
    }

    const originalLines = (entry.lines as JournalEntryLine[]) || []

    // The kontoplan as the declaration and the gap scan read it.
    let accounts: DynamicVatAccounts
    try {
      accounts = await fetchDynamicVatAccounts(supabase, companyId)
    } catch (err) {
      log.error('rc-basis-gap fix: momskod lookup failed', err as Error, { entryId })
      return errorResponseFromCode('VAT_REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: 'Kontoplanens momskoder kunde inte läsas.' },
      })
    }
    const { rates, unratedAccounts } = readVerifikatRcBasis(originalLines, accounts)

    // The declaration counts these accounts in ruta 20-24 but at no momssats,
    // so no basis can be judged missing or complete until the kontoplan says
    // which sats they report at; a pair beside them would count the purchase
    // twice, and removing it again would bring the gap back.
    if (unratedAccounts.length > 0) {
      const one = unratedAccounts.length === 1
      const accountList = unratedAccounts.join(', ')
      return errorResponseFromCode('VAT_RC_BASIS_ACCOUNT_WITHOUT_RATE', log, {
        requestId,
        messageSv:
          `${one ? 'Konto' : 'Kontona'} ${accountList} har en momskod för omvänd skattskyldighet men ingen ` +
          'Standard moms på 25, 12 eller 6 % i kontoplanen. Deklarationen tar ändå med ' +
          `${one ? 'kontot' : 'kontona'} i ruta 20-24 men kan inte knyta basbeloppet till den fiktiva momsen, ` +
          'så ett basbelopp till skulle räkna inköpet två gånger. Välj samma sats som den fiktiva momsen under ' +
          `Standard moms på ${one ? 'kontot' : 'kontona'} i kontoplanen, eller ta bort momskoden om ` +
          `${one ? 'kontot' : 'kontona'} inte ska redovisas i ruta 20-24, och ladda sedan om sidan.`,
        messageEn:
          `${one ? 'Account' : 'Accounts'} ${accountList} ${one ? 'has' : 'have'} a reverse-charge VAT code but no ` +
          '"Standard moms" (default VAT rate) of 25, 12 or 6 % in the chart of accounts. The declaration still counts ' +
          `${one ? 'it' : 'them'} in boxes 20-24 but cannot pair the basis with the reverse-charge VAT, so another ` +
          'basis would count the purchase twice. Set "Standard moms" to the rate of the reverse-charge VAT in the ' +
          `chart of accounts, or remove the VAT code if ${one ? 'it' : 'they'} should not report in boxes 20-24, ` +
          'and reload the page.',
        details: { entryId, accounts: unratedAccounts },
      })
    }

    const gaps = rates.filter(isRcBasisGap)
    if (gaps.length === 0) {
      const hasFiktivMoms = rates.some((r) => r.rcOutputAmount > RC_BASIS_TOLERANCE)
      return errorResponseFromCode('VAT_RC_BASIS_NOTHING_MISSING', log, {
        requestId,
        ...(hasFiktivMoms
          ? {}
          : {
              messageSv:
                'Verifikationen har ingen fiktiv moms på 2614, 2624 eller 2634 som kräver basbelopp, ' +
                'så det finns inget att korrigera.',
              messageEn:
                'The voucher has no reverse-charge VAT on 2614, 2624 or 2634 that needs a basis, ' +
                'so there is nothing to correct.',
            }),
        details: { entryId, rates },
      })
    }

    // A basis at a sats without the fiktiv moms to match it is a sats error,
    // not a missing basis: a pair at the sats of the fiktiv moms would count
    // the purchase twice in ruta 20-24.
    const misplaced = rates.filter((r) => !isRcBasisGap(r) && surplusRcBasis(r) > RC_BASIS_TOLERANCE)
    if (misplaced.length > 0) {
      return errorResponseFromCode('VAT_RC_BASIS_RATE_MISMATCH', log, {
        requestId,
        messageSv:
          `Verifikationen redovisar redan basbelopp i ruta 20-24, men med en annan momssats (${satsLabel(misplaced)}) ` +
          `än den fiktiva momsen (${satsLabel(gaps)}). Ett basbelopp till skulle räkna inköpet två gånger. ` +
          'Rätta momssatsen med rättelse eller storno av verifikationen, eller kontrollera kontots Standard moms i kontoplanen.',
        messageEn:
          `The voucher already reports a basis in boxes 20-24, but at another VAT rate (${satsLabel(misplaced)}) ` +
          `than its reverse-charge VAT (${satsLabel(gaps)}). Another basis would count the purchase twice. ` +
          'Correct the rate by correcting or reversing the voucher, or check the account\'s "Standard moms" in the chart of accounts.',
        details: { entryId, rates },
      })
    }

    // One pair per momssats that falls short, with only what it lacks. The
    // original lines are copied whole, dimensions bag included, so the
    // corrected entry keeps every tag the storno reverses.
    const basisLines: CreateJournalEntryLineInput[] = []
    const basis: Array<{ rate: number; account: string; amount: number }> = []
    for (const gap of gaps) {
      const sel = perOutputAccount?.find((c) => c.rcOutputAccount === gap.rcOutputAccount) ?? { supplierType, supplyType }
      const account = pickBasisAccount(gap.rcOutputAccount, sel.supplierType, sel.supplyType)
      if (account === null) {
        return errorResponseFromCode('VALIDATION_ERROR', log, {
          requestId,
          messageSv:
            'Varor från leverantörer utanför EU hanteras som import (ruta 50/60-62), inte omvänd skattskyldighet. ' +
            'Korrigera verifikationen manuellt med importmoms på 2615/4545.',
          messageEn:
            'Goods from suppliers outside the EU are imports (boxes 50/60-62), not reverse charge. ' +
            'Correct the voucher by hand with import VAT on 2615/4545.',
          details: { entryId, rcOutputAccount: gap.rcOutputAccount, ...sel },
        })
      }
      // The declaration must read the pair at the sats of the fiktiv moms it
      // answers, or it closes nothing: a kontoplan that holds 4536 at 25 %
      // would move the basis to the 25 % bucket and leave 12 % as short.
      if (rcBasisReading(account, accounts) !== gap.rate) {
        const pct = Math.round(gap.rate * 100)
        return errorResponseFromCode('VAT_RC_BASIS_ACCOUNT_RATE_CONFLICT', log, {
          requestId,
          messageSv:
            `Konto ${account}, där basbeloppet för ${pct} % ska bokföras, redovisas inte i ruta 20-24 med ` +
            `${pct} % enligt kontoplanen, så det skulle inte täcka den fiktiva momsen på ${gap.rcOutputAccount}. ` +
            `Kontrollera momskoden och välj ${pct} % under Standard moms på konto ${account} i kontoplanen, ` +
            'och ladda sedan om sidan.',
          messageEn:
            `Account ${account}, where the ${pct} % basis goes, does not report in boxes 20-24 at ${pct} % ` +
            `according to the chart of accounts, so it would not cover the reverse-charge VAT on ${gap.rcOutputAccount}. ` +
            `Check its VAT code and set "Standard moms" to ${pct} % on account ${account} in the chart of accounts, ` +
            'and reload the page.',
          details: { entryId, account, rate: gap.rate, rcOutputAccount: gap.rcOutputAccount },
        })
      }
      const amount = missingRcBasis(gap)
      const rateLabel = `${Math.round(gap.rate * 100)}%`
      basisLines.push(
        {
          account_number: account,
          debit_amount: amount,
          credit_amount: 0,
          line_description: `Basbelopp omvänd skattskyldighet ${rateLabel}`,
        },
        {
          account_number: '4598',
          debit_amount: 0,
          credit_amount: amount,
          line_description: `Motkonto beräknad omvänd moms ${rateLabel}`,
        },
      )
      basis.push({ rate: gap.rate, account, amount })
    }
    const correctedLines: CreateJournalEntryLineInput[] = [
      ...originalLines.map(postedLineAsInput),
      ...basisLines,
    ]

    try {
      const correction = await correctEntry(supabase, companyId, user.id, entryId, correctedLines)
      return NextResponse.json({
        data: {
          reversalId: correction.reversal.id,
          correctedId: correction.corrected.id,
          basis,
        },
      })
    } catch (err) {
      // The loser of a concurrent click: the verifikat was posted when this
      // request read it and reversed by the time the storno ran. The same
      // state as a stale row, so the same answer.
      if (
        err instanceof EntryAlreadyReversedError ||
        (err instanceof CannotCorrectNonPostedError && err.currentStatus === 'reversed')
      ) {
        return alreadyReversed()
      }
      // A lock refuses the storno in the database, so it arrives as a
      // database error: answer it as the lock it is, with its own sentence.
      // The English stays the registry's for PERIOD_LOCKED: the error's own
      // English is the database failure's, not the lock's.
      if (err instanceof Error && LOCK_REFUSAL.test(err.message)) {
        return errorResponseFromCode('PERIOD_LOCKED', log, {
          requestId,
          messageSv: getUserErrorMessage(err),
          details: { entryId },
        })
      }
      // Any other refusal of the storno service keeps its registry code,
      // status and details, and says what to fix in the message, which is all
      // the worklist row shows: the accounts to activate, the account that
      // needs a dimension, the depth and root of the correction chain.
      if (isBookkeepingError(err) && !(err instanceof BookkeepingDatabaseError)) {
        const { code, details } = extractBookkeepingDetails(err)
        return errorResponseFromCode(code, log, {
          requestId,
          reason: (err as Error).message,
          messageSv: getUserErrorMessage(err),
          messageEn: getUserErrorMessage(err, { locale: 'en' }),
          details: details ?? { entryId },
        })
      }
      // The rest is a server failure.
      return errorResponse(err, log, { requestId, details: { entryId } })
    }
  },
  { requireWrite: true },
)
