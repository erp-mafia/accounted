/**
 * The momsredovisning verifikat over the machine doors: read the settlement
 * proposal (lib/reports/vat-settlement.ts, issue #980) and book exactly the
 * lines it gives. Behind the v1 operations reports.vat-settlement-proposal
 * and vat.book-settlement and their MCP tools (lib/operations/vat-settlement.ts).
 *
 * The dashboard books the same proposal through the journal entry form
 * (POST /api/bookkeeping/journal-entries, source_type 'vat_settlement') after
 * the user may have edited the lines. The API has no edit step: an integrator
 * who needs different lines books them as an ordinary verifikat. So this
 * booking takes no lines from the caller at all, only the period, and posts
 * the proposal the server computes, through the engine.
 *
 * Rules, in order:
 *   - a fiscal_period_id (helårsmoms) must be the company's;
 *   - a posted settlement in the period, tagged or recognised by shape,
 *     refuses (the proposal re-clears the FULL period: booking twice would
 *     corrupt the 26xx balances), the same gate as the dashboard's button;
 *   - an empty period (no VAT to clear) refuses;
 *   - when the caller pins the fingerprint of the proposal they reviewed
 *     (the MCP stage always does), a proposal that changed since refuses;
 *   - the entry date (the period's last day) must not be in a locked or
 *     closed period nor on or before the company lock date, and an open
 *     fiscal year must cover it.
 * A dry run reads, checks and previews the verifikat and writes nothing.
 */
import { createHash } from 'node:crypto'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { toEntryPreview } from '@/lib/bookkeeping/entry-preview'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import {
  buildVatSettlementProposal,
  findDraftVatSettlement,
  findPostedVatSettlement,
  vatSettlementBookingStatus,
  type VatSettlementProposal,
} from '@/lib/reports/vat-settlement'
import { loadReportPeriod, type VatPeriodInput } from '@/lib/reports/filing-report-service'
import type { CreateJournalEntryInput } from '@/types'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

export interface VatSettlementProposalView extends VatSettlementProposal {
  /** 'booked' when a posted settlement exists, 'draft' when only a draft does. */
  booking_status: 'booked' | 'draft' | 'none'
  /**
   * SHA-256 over the period and the proposed lines. Pass it back as
   * expected_fingerprint when booking to refuse a proposal that changed
   * after it was reviewed.
   */
  fingerprint: string
}

export function proposalFingerprint(proposal: VatSettlementProposal): string {
  const canonical = JSON.stringify({
    start: proposal.period.start,
    end: proposal.period.end,
    entry_date: proposal.entry_date,
    lines: proposal.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount]),
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

async function loadProposal(
  ctx: OperationContext,
  input: VatPeriodInput,
): Promise<{ ok: true; proposal: VatSettlementProposal } | Failure> {
  if (input.fiscal_period_id) {
    const period = await loadReportPeriod(ctx, input.fiscal_period_id)
    if (!period.ok) return period
  }
  try {
    const proposal = await buildVatSettlementProposal(
      ctx.supabase, ctx.companyId, input.period_type, input.year, input.period,
      { fiscalPeriodId: input.fiscal_period_id },
    )
    return { ok: true, proposal }
  } catch (err) {
    ctx.log.error('vat settlement proposal failed', err as Error, { ...input })
    return {
      ok: false,
      code: 'VAT_REPORT_GENERATION_FAILED',
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    }
  }
}

/** The proposal as GET /api/reports/vat-declaration/settlement-proposal answers it, plus status and fingerprint. */
export async function getVatSettlementProposal(
  ctx: OperationContext,
  input: VatPeriodInput,
): Promise<OperationOutcome<VatSettlementProposalView>> {
  const loaded = await loadProposal(ctx, input)
  if (!loaded.ok) return loaded
  const proposal = loaded.proposal
  return {
    ok: true,
    data: {
      ...proposal,
      booking_status: vatSettlementBookingStatus(proposal.existing_entries),
      fingerprint: proposalFingerprint(proposal),
    },
  }
}

export interface BookVatSettlementInput extends VatPeriodInput {
  expected_fingerprint?: string
}

export interface BookVatSettlementResult {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  period_label: string
  filed_net: number
  rounding_amount: number
}

const DRAFT_EXISTS: OperationWarning = {
  code: 'VAT_SETTLEMENT_DRAFT_EXISTS',
  message_sv: 'Det fanns redan ett utkast för momsen i perioden. Utkastet påverkas inte; ta bort det om det inte behövs.',
  message_en: 'A draft settlement already existed for the period. It is left untouched; delete it if it is not needed.',
}

export async function bookVatSettlement(
  ctx: OperationContext,
  input: BookVatSettlementInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BookVatSettlementResult>> {
  const { supabase, companyId, userId, log } = ctx

  const loaded = await loadProposal(ctx, input)
  if (!loaded.ok) return loaded
  const proposal = loaded.proposal

  const posted = findPostedVatSettlement(proposal.existing_entries)
  if (posted) {
    return {
      ok: false,
      code: 'VAT_SETTLEMENT_ALREADY_BOOKED',
      details: {
        journal_entry_id: posted.id,
        voucher_series: posted.voucher_series,
        voucher_number: posted.voucher_number,
        entry_date: posted.entry_date,
      },
    }
  }
  if (proposal.is_empty) return { ok: false, code: 'VAT_SETTLEMENT_EMPTY' }

  const fingerprint = proposalFingerprint(proposal)
  if (input.expected_fingerprint && input.expected_fingerprint !== fingerprint) {
    return { ok: false, code: 'VAT_SETTLEMENT_PROPOSAL_CHANGED', details: { fingerprint } }
  }

  const verdict = await checkPeriodLock(supabase, companyId, proposal.entry_date)
  if (verdict.locked) {
    return {
      ok: false,
      code: 'PERIOD_LOCKED',
      details: {
        reason: verdict.reason,
        ...(verdict.fiscal_period_id ? { fiscal_period_id: verdict.fiscal_period_id } : {}),
        entry_date: proposal.entry_date,
      },
    }
  }
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, proposal.entry_date)
  if (!fiscalPeriodId) {
    return { ok: false, code: 'VAT_SETTLEMENT_NO_FISCAL_PERIOD', details: { entry_date: proposal.entry_date } }
  }

  const entryInput: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: proposal.entry_date,
    description: proposal.description,
    source_type: 'vat_settlement',
    lines: proposal.lines.map((line) => ({
      account_number: line.account_number,
      debit_amount: line.debit_amount,
      credit_amount: line.credit_amount,
      ...(line.line_description ? { line_description: line.line_description } : {}),
    })),
  }
  const draft = findDraftVatSettlement(proposal.existing_entries)

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        period: proposal.period,
        period_label: proposal.period_label,
        filed_net: proposal.filed_net,
        rounding_amount: proposal.rounding_amount,
        fingerprint,
        draft_settlement_journal_entry_id: draft?.id ?? null,
        journal_entry: toEntryPreview(entryInput),
      },
    }
  }

  let entry
  try {
    entry = await createJournalEntry(supabase, companyId, userId, entryInput)
  } catch (err) {
    if (isBookkeepingError(err)) return { ok: false, code: 'VAT_SETTLEMENT_FAILED', error: err }
    log.error('vat settlement booking failed', err as Error, { ...input })
    return { ok: false, code: 'VAT_SETTLEMENT_FAILED' }
  }

  return {
    ok: true,
    created: true,
    data: {
      journal_entry_id: entry.id,
      voucher_series: entry.voucher_series ?? null,
      voucher_number: entry.voucher_number ?? null,
      entry_date: entry.entry_date,
      period_label: proposal.period_label,
      filed_net: proposal.filed_net,
      rounding_amount: proposal.rounding_amount,
    },
    ...(draft ? { warnings: [DRAFT_EXISTS] } : {}),
  }
}
