/**
 * The paying account as the dashboard shows it beside a payment file: the
 * salary run's payment file panel, the tax payment panel and the "Konto för
 * löneutbetalningar" row under Inställningar → Löner (crm#1483). It is the
 * resolution the files themselves run (lib/payments/paying-account.ts), so
 * what the page names is what the file pays from.
 *
 * With a salary run, a booked run answers the account its salary verifikat
 * credits; any other run, and no run at all, answers the primary bank
 * account, which the booking will credit and which the supplier and tax
 * files pay from.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import type { Logger } from '@/lib/logger'
import {
  payingAccountSummary,
  resolvePayingAccount,
  type PayingAccountMissing,
  type PayingAccountSummary,
} from '@/lib/payments/paying-account'
import { isSwedbankBic } from '@/lib/payments/swedbank'
import { bookedNetPayAccount } from '@/lib/salary/posted-run-entries'
import { salaryInstructionBank, type SalaryInstructionBank } from './instruction-bank'

export interface PaymentFileAccountView {
  account: PayingAccountSummary
  /**
   * booked: the account a booked run's salary verifikat credits, fixed by the
   * verifikat; primary: the company's primary bank account, changed under
   * Inställningar → Bokföring.
   */
  basis: 'booked' | 'primary'
  /** What a pain.001 cannot be made without on the account, or null when it can pay. */
  missing: PayingAccountMissing | null
  /** The bank whose upload instructions open first (instruction-bank.ts). */
  instruction_bank: SalaryInstructionBank | null
  /** The account's bank is Swedbank (a savings bank included): its files need Swedbank's SignerID and Corporate Pay id. */
  swedbank: boolean
}

export type PaymentFileAccountViewResult =
  | { ok: true; view: PaymentFileAccountView }
  | { ok: false; code: 'SALARY_RUN_NOT_FOUND' }

export async function loadPaymentFileAccountView(
  supabase: SupabaseClient,
  companyId: string,
  log: Logger,
  salaryRunId?: string | null,
): Promise<PaymentFileAccountViewResult> {
  let bookedLedgerAccount: string | null = null
  if (salaryRunId) {
    const { data: run, error } = await supabase
      .from('salary_runs')
      .select('id, status, salary_entry_id')
      .eq('id', salaryRunId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw dbError(error)
    if (!run) return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
    bookedLedgerAccount = await bookedNetPayAccount(
      supabase,
      companyId,
      run as { id: string; status: string; salary_entry_id: string | null },
    )
  }

  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('iban, bic, salary_default_bank')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) throw dbError(settingsError)
  const stored = settings as { iban: string | null; bic: string | null; salary_default_bank: string | null } | null

  const paying = await resolvePayingAccount(supabase, companyId, log, { settings: stored, bookedLedgerAccount })
  return {
    ok: true,
    view: {
      account: payingAccountSummary(paying.account),
      basis: bookedLedgerAccount ? 'booked' : 'primary',
      missing: paying.ok ? null : paying.missing,
      instruction_bank: salaryInstructionBank(paying.ok ? paying.account.iban : null, stored?.salary_default_bank),
      swedbank: paying.ok && isSwedbankBic(paying.account.bic),
    },
  }
}
