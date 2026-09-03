import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  DEADLINE_SETTINGS_SELECT,
  hasTaxRelevantFields,
  regenerateTaxDeadlinesForUser,
  shouldRegenerateTaxDeadlines,
  toDeadlineSettings,
} from '@/lib/tax/deadline-generator'
import { validateBody } from '@/lib/api/validate'
import { UpdateSettingsSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { propagateLegacyPayeeWrite } from '@/lib/cash-accounts/invoice-payee'

export const GET = withRouteContext(
  'settings.get',
  async (_request, { supabase, companyId }) => {
    const { data, error } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', companyId)
      .single()

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    // Fall back to companies.entity_type if company_settings.entity_type is null
    let responseData = data
    if (data && !data.entity_type) {
      const { data: company } = await supabase
        .from('companies')
        .select('entity_type')
        .eq('id', companyId)
        .single()
      if (company?.entity_type) {
        responseData = { ...data, entity_type: company.entity_type }
      }
    }

    return NextResponse.json({ data: responseData })
  },
)

export const PUT = withRouteContext(
  'settings.update',
  async (request, { supabase, companyId, log, requestId, user }) => {
    // Fetch current settings to check for tax-relevant changes
    const { data: oldSettings } = await supabase
      .from('company_settings')
      .select(`${DEADLINE_SETTINGS_SELECT}, vat_number, onboarding_complete, salary_vacation_year_basis, reminder_days_level_1, reminder_days_level_2, reminder_days_level_3, aktiekapital, antal_aktier`)
      .eq('company_id', companyId)
      .single()

    const validation = await validateBody(request, UpdateSettingsSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const changesInvoiceEmailRecipients =
      body.invoice_email_cc_addresses !== undefined
      || body.invoice_email_bcc_addresses !== undefined
    const changesInvoicePaymentInstructions =
      body.invoice_payment_accounts !== undefined
      || body.bank_name !== undefined
      || body.clearing_number !== undefined
      || body.account_number !== undefined
      || body.bankgiro !== undefined
      || body.plusgiro !== undefined
      || body.swish !== undefined
      || body.iban !== undefined
      || body.bic !== undefined
    if (changesInvoiceEmailRecipients || changesInvoicePaymentInstructions) {
      const { data: membership, error: membershipError } = await supabase
        .from('company_members')
        .select('role')
        .eq('company_id', companyId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (membershipError) {
        log.error('failed to authorize restricted invoice settings', membershipError)
        return errorResponseFromCode('INTERNAL_ERROR', log, { requestId })
      }
      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        return errorResponseFromCode('FORBIDDEN', log, {
          requestId,
          details: { required_roles: ['owner', 'admin'] },
        })
      }
    }

    const reminderDays = [
      body.reminder_days_level_1 ?? oldSettings?.reminder_days_level_1 ?? 15,
      body.reminder_days_level_2 ?? oldSettings?.reminder_days_level_2 ?? 30,
      body.reminder_days_level_3 ?? oldSettings?.reminder_days_level_3 ?? 45,
    ]
    if (!(reminderDays[0] < reminderDays[1] && reminderDays[1] < reminderDays[2])) {
      return NextResponse.json(
        { error: 'Påminnelsedagarna måste ligga i stigande ordning.' },
        { status: 400 },
      )
    }

    // Lock org_number after onboarding is complete (legal identifier: changing it
    // would orphan vouchers, SIE history, and tax filings). company_name remains
    // editable so users can update their display/brand name (e.g. särskilt företagsnamn).
    if (oldSettings && (oldSettings as Record<string, unknown>).onboarding_complete === true) {
      delete (body as Record<string, unknown>).org_number
    }

    // Validate: enskild firma must use calendar year (BFL 3 kap.)
    const effectiveEntityType = body.entity_type || oldSettings?.entity_type
    const effectiveFYStartMonth = body.fiscal_year_start_month ?? oldSettings?.fiscal_year_start_month
    if (effectiveEntityType === 'enskild_firma' && effectiveFYStartMonth && effectiveFYStartMonth !== 1) {
      return NextResponse.json(
        { error: 'Enskild firma måste använda kalenderår (BFL 3 kap.)' },
        { status: 400 }
      )
    }

    // Share capital is all-or-nothing: the antal aktier/kvotvärde note (ÅRL 5 kap 34 §)
    // needs both the registered amount and the share count, and the DB pair
    // constraint enforces it. Validate against the effective (body-or-stored)
    // values so the user gets a clear message instead of a raw constraint 500.
    if (body.aktiekapital !== undefined || body.antal_aktier !== undefined) {
      const old = oldSettings as { aktiekapital?: number | null; antal_aktier?: number | null } | null
      const effectiveAktiekapital = body.aktiekapital !== undefined ? body.aktiekapital : old?.aktiekapital ?? null
      const effectiveAntalAktier = body.antal_aktier !== undefined ? body.antal_aktier : old?.antal_aktier ?? null
      if ((effectiveAktiekapital === null) !== (effectiveAntalAktier === null)) {
        return NextResponse.json(
          { error: 'Aktiekapital och antal aktier måste anges tillsammans. Fyll i båda fälten eller lämna båda tomma.' },
          { status: 400 },
        )
      }
    }

    // Vacation year basis (payroll gap-closure 3.1): changing the boundary
    // while OPEN vacation-ledger rows exist would orphan them (rows are keyed
    // by vacation_year_start). Close the current year first.
    if (
      body.salary_vacation_year_basis !== undefined &&
      body.salary_vacation_year_basis !==
        (oldSettings as Record<string, unknown> | null)?.salary_vacation_year_basis
    ) {
      const { count: openRows, error: openRowsError } = await supabase
        .from('employee_vacation_balances')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('status', 'open')
      // Fail closed: a failed check must not let the basis change through
      // and orphan open vacation-ledger rows.
      if (openRowsError) {
        return NextResponse.json({ error: getUserErrorMessage(openRowsError) }, { status: 500 })
      }
      if ((openRows ?? 0) > 0) {
        return NextResponse.json(
          {
            error:
              'Semesterårets basis kan inte ändras medan öppna semestersaldon finns. Stäng semesteråret först.',
          },
          { status: 400 },
        )
      }
    }

    // Turning VAT registration off retires the VAT-dependent flags, and
    // dropping EU trade retires the EU sales list: stale true values would
    // otherwise block the save below or silently resurrect wrong deadlines
    // when registration is re-enabled later. Same coherence rule as the
    // 20260717070000 migration and the tax settings form.
    if (body.vat_registered === false) {
      body.vat_taxable_base_over_40m = false
      body.vat_has_eu_trade = false
      body.periodisk_sammanstallning_enabled = false
    }
    if (body.vat_has_eu_trade === false) {
      body.periodisk_sammanstallning_enabled = false
    }
    // Seasonal registration is a mode of being a registered employer; an
    // unregistered company cannot be sasongsregistrerad.
    if (body.employer_registered === false) {
      body.employer_seasonal = false
    }

    // Validate: VAT-registered must have VAT number (ML 17 kap. 24 §, the
    // invoice needs it) and moms period (SFL 26 kap.).
    // Each cross-field check runs only when the request touches a field in its
    // group: a partial save of unrelated settings (e.g. the invoice bank-details
    // dialog) must not be rejected for a pre-existing inconsistency it cannot
    // fix from that surface. Explicit null counts as touched, it clears a value,
    // so it must not fall back to the stored one during validation.
    // PS/EU-trade edits are in the completeness group: enabling the EU sales
    // list on an incomplete VAT registration must keep failing like it did
    // when the check ran on every save.
    const effectiveVatRegistered = body.vat_registered ?? oldSettings?.vat_registered
    const effectiveMomsPeriod =
      body.moms_period !== undefined ? body.moms_period : oldSettings?.moms_period
    const touchesVatCompleteness =
      body.vat_registered !== undefined ||
      body.vat_number !== undefined ||
      body.moms_period !== undefined ||
      body.vat_has_eu_trade !== undefined ||
      body.periodisk_sammanstallning_enabled !== undefined
    if (touchesVatCompleteness && effectiveVatRegistered === true) {
      const effectiveVatNumber =
        body.vat_number !== undefined ? body.vat_number : oldSettings?.vat_number
      if (!effectiveVatNumber) {
        return NextResponse.json(
          { error: 'Momsregistreringsnummer krävs när företaget är momsregistrerat (ML 17 kap. 24 §)' },
          { status: 400 }
        )
      }
      if (!effectiveMomsPeriod) {
        return NextResponse.json(
          { error: 'Momsperiod krävs när företaget är momsregistrerat (SFL 26 kap.)' },
          { status: 400 }
        )
      }
    }

    const touchesVat40m =
      body.vat_registered !== undefined ||
      body.vat_taxable_base_over_40m !== undefined ||
      body.moms_period !== undefined
    const effectiveVatTaxableBaseOver40m =
      body.vat_taxable_base_over_40m ?? oldSettings?.vat_taxable_base_over_40m ?? false
    if (
      touchesVat40m &&
      effectiveVatRegistered &&
      effectiveVatTaxableBaseOver40m &&
      effectiveMomsPeriod !== 'monthly'
    ) {
      return NextResponse.json(
        { error: 'Företag med beskattningsunderlag över 40 miljoner kronor måste redovisa moms varje månad.' },
        { status: 400 },
      )
    }

    const touchesPs =
      body.periodisk_sammanstallning_enabled !== undefined ||
      body.vat_registered !== undefined ||
      body.vat_has_eu_trade !== undefined
    const effectivePsEnabled =
      body.periodisk_sammanstallning_enabled ??
      oldSettings?.periodisk_sammanstallning_enabled ??
      false
    const effectiveEuTrade = body.vat_has_eu_trade ?? oldSettings?.vat_has_eu_trade ?? false
    if (touchesPs && effectivePsEnabled && (!effectiveVatRegistered || !effectiveEuTrade)) {
      return NextResponse.json(
        { error: 'Periodisk sammanställning kräver momsregistrering och EU-handel.' },
        { status: 400 },
      )
    }

    const updateResult = await supabase
      .from('company_settings')
      .update(body)
      .eq('company_id', companyId)
      .select()
      .single()
    const error = updateResult.error
    let data = updateResult.data

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Inställningarna hittades inte.' }, { status: 404 })
      }
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    // Payment instructions live on cash_accounts since migration
    // 20260903150000; the columns just written are a mirror of the default
    // payee account per currency. Write the change through to those accounts
    // so the mirror does not undo it on the next payee edit, then return the
    // row as the mirror trigger left it.
    if (changesInvoicePaymentInstructions) {
      try {
        const written = await propagateLegacyPayeeWrite(supabase, companyId, body)
        if (written.length > 0) {
          const reread = await supabase
            .from('company_settings')
            .select()
            .eq('company_id', companyId)
            .single()
          if (!reread.error && reread.data) data = reread.data
        }
      } catch (err) {
        log.error('failed to write payment instructions through to cash accounts', err as Error)
      }
    }

    // Regenerate when the save touches tax-relevant fields: the statutory
    // dates are derived from them, and re-running also repairs rows created
    // by older schedule logic or lost to an earlier generation failure. The
    // generator preserves completed rows, so filing progress survives.
    // Additionally self-heal when the company has no system deadlines at all:
    // tax settings are filled at onboarding, so an unrelated later save may be
    // the first chance to backfill an empty set.
    const taxFieldsInBody = hasTaxRelevantFields(body)
    let existingSystemDeadlineCount = 0
    if (!taxFieldsInBody) {
      const { count, error: countError } = await supabase
        .from('deadlines')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('source', 'system')
        .eq('deadline_type', 'tax')
      // Fail safe: on a count error, assume deadlines already exist so we do
      // NOT delete+regenerate on a transient failure (regeneration would reset
      // the status of pending rows). A non-zero placeholder keeps the
      // self-heal off.
      existingSystemDeadlineCount = countError ? 1 : (count ?? 0)
    }

    if (shouldRegenerateTaxDeadlines(taxFieldsInBody, existingSystemDeadlineCount)) {
      try {
        await regenerateTaxDeadlinesForUser(supabase, companyId, toDeadlineSettings(data))
        log.info('tax deadlines regenerated after settings change')
      } catch (err) {
        log.error('failed to regenerate tax deadlines', err as Error)
        // Don't fail the settings update if deadline generation fails
      }
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
