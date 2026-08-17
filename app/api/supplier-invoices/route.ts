import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import {
  createSupplierInvoiceRegistrationEntry,
  createSupplierInvoicePrivatelyPaidEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { createSchedulesForSupplierInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { suggestBalanceAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import { isSlpPensionAccount } from '@/lib/bookkeeping/slp-lines'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  resolveSupplierInvoiceExchangeRate,
  supplierInvoiceSekAmounts,
} from '@/lib/currency/supplier-invoice-rate'
import { roundOre } from '@/lib/money'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

export const GET = withRouteContext(
  'supplier_invoice.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const supplierId = searchParams.get('supplier_id')

    let query = supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(id, name)')
      .eq('company_id', companyId)

    // Optional narrowing to one supplier — the supplier detail page only
    // needs that supplier's invoices, not the whole company ledger.
    if (supplierId) {
      query = query.eq('supplier_id', supplierId)
    }

    if (status && status !== 'all') {
      if (status === 'to_pay') {
        query = query.in('status', ['approved', 'overdue'])
      } else {
        query = query.eq('status', status)
      }
    }

    const { data, error } = await query.order('due_date', { ascending: true })

    if (error) {
      log.error('supplier_invoice list failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data })
  },
)

export const POST = withRouteContext(
  'supplier_invoice.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CreateSupplierInvoiceSchema, {
      log,
      operation: 'supplier_invoice.create',
    })
    if (!validation.success) return validation.response
    const body = validation.data
    const paidPrivately = body.paid_with_private_funds === true

    if (body.document_id) {
      const { data: document, error: documentError } = await supabase
        .from('document_attachments')
        .select('id, journal_entry_id')
        .eq('id', body.document_id)
        .eq('company_id', companyId)
        .maybeSingle()

      if (documentError || !document || document.journal_entry_id) {
        return errorResponseFromCode('SI_CREATE_INVALID_INPUT', log, {
          requestId,
          details: { reason: 'document_id is missing, belongs to another company, or is already linked' },
        })
      }

      const { data: existingDocumentUse, error: existingDocumentUseError } = await supabase
        .from('supplier_invoices')
        .select('id')
        .eq('company_id', companyId)
        .eq('document_id', body.document_id)
        .limit(1)
        .maybeSingle()

      if (existingDocumentUseError) {
        log.error('supplier invoice document usage lookup failed', existingDocumentUseError)
        return errorResponse(existingDocumentUseError, log, { requestId })
      }

      if (existingDocumentUse) {
        return errorResponseFromCode('SI_CREATE_INVALID_INPUT', log, {
          requestId,
          details: { reason: 'document_id is already used by a supplier invoice' },
        })
      }
    }

    if (paidPrivately && body.reverse_charge) {
      // RC invoices come from registered businesses with formal invoices and
      // go through normal AP. "Privately paid" only makes sense for
      // out-of-pocket kvitton: combining the two is a UI bug. 400, not 500.
      return errorResponseFromCode('SI_CREATE_INVALID_INPUT', log, {
        requestId,
        details: { reason: 'paid_with_private_funds is not supported with reverse_charge' },
      })
    }

    // Särskild löneskatt (SLP): the 7533/2514 pair is only lawful on pension
    // premiums, so the flag is rejected on any non-741x account, and rejected
    // together with periodisering on the same row (the pair is computed on
    // the full line amount at registration and cannot be deferred).
    if (body.items.some((item) => item.apply_slp && !isSlpPensionAccount(item.account_number))) {
      return errorResponseFromCode('SI_CREATE_SLP_INVALID_ACCOUNT', log, { requestId })
    }
    if (
      body.items.some(
        (item) =>
          item.apply_slp &&
          (item.accrual_period_start || item.accrual_period_end || item.accrual_balance_account),
      )
    ) {
      return errorResponseFromCode('SI_CREATE_SLP_ACCRUAL', log, { requestId })
    }

    const hasAccrualItems = body.items.some(
      (item) => item.accrual_period_start && item.accrual_period_end,
    )
    if (hasAccrualItems && body.reverse_charge) {
      // Omvänd skattskyldighet: the expense line IS the VAT base for rutor
      // 20-32: deferring the net to a 17xx interim account would corrupt the
      // momsdeklaration. Mirrors the customer-side reverse-charge guard.
      return errorResponseFromCode('SI_CREATE_ACCRUAL_REVERSE_CHARGE', log, { requestId })
    }
    if (hasAccrualItems && paidPrivately) {
      // Eget utlägg books the expense in one verifikat at registration:
      // there is no interim-account flow to defer. UI hides the combination.
      return errorResponseFromCode('SI_CREATE_INVALID_INPUT', log, {
        requestId,
        details: { reason: 'periodisering is not supported with paid_with_private_funds' },
      })
    }
    if (hasAccrualItems) {
      // Kontantmetoden recognises the cost at payment; periodisering only
      // exists under faktureringsmetoden. Reject loudly instead of silently
      // dropping the periods.
      const { data: methodSettings } = await supabase
        .from('company_settings')
        .select('accounting_method')
        .eq('company_id', companyId)
        .single()
      if ((methodSettings?.accounting_method || 'accrual') !== 'accrual') {
        return errorResponseFromCode('SI_CREATE_INVALID_INPUT', log, {
          requestId,
          details: { reason: 'periodisering requires faktureringsmetoden (accrual)' },
        })
      }
    }

    // Icke momsregistrerad verksamhet has no deduction right for input VAT
    // (avdragsrätt, 13 kap. ML 2023:200): a line carrying moms would book
    // 2641 the company can never reclaim. The form hides the moms controls;
    // this guard covers THIS route only. The v1 REST route, the inbox convert
    // route and the MCP staged executor still default 25 % and need the same
    // treatment in a follow-up sweep. Reverse charge stays allowed:
    // self-assessment is a separate obligation from deduction.
    const { data: vatSettings } = await supabase
      .from('company_settings')
      .select('vat_registered')
      .eq('company_id', companyId)
      .single()
    const vatRegistered = vatSettings?.vat_registered !== false
    if (
      !vatRegistered &&
      !body.reverse_charge &&
      body.items.some((item) => (item.vat_rate ?? 0) > 0 || (item.vat_amount ?? 0) > 0)
    ) {
      return errorResponseFromCode('SI_CREATE_INVALID_INPUT', log, {
        requestId,
        details: { reason: 'company is not VAT-registered; supplier invoice lines cannot carry moms' },
      })
    }

    const { data: supplier, error: supplierError } = await supabase
      .from('suppliers')
      .select('*')
      .eq('id', body.supplier_id)
      .eq('company_id', companyId)
      .single()

    if (supplierError || !supplier) {
      return errorResponseFromCode('SUPPLIER_NOT_FOUND', log, { requestId })
    }

    // Entity type drives the credit account for privately-paid invoices:
    // AB → 2893 (skuld till aktieägare), EF → 2018 (egen insättning). Loaded
    // up front so we can fail early if the company row is missing.
    let entityType: 'aktiebolag' | 'enskild_firma' | null = null
    if (paidPrivately) {
      const { data: company } = await supabase
        .from('companies')
        .select('entity_type')
        .eq('id', companyId)
        .single()
      if (!company?.entity_type) {
        return errorResponseFromCode('SI_CREATE_FAILED', log, {
          requestId,
          details: { reason: 'company entity_type missing, cannot pick owner account' },
        })
      }
      entityType = company.entity_type as 'aktiebolag' | 'enskild_firma'
    }

    // Resolve the exchange rate BEFORE the arrival-number sequence is touched:
    // a foreign invoice we cannot translate must not burn an ankomstnummer.
    // Shared with the v1 REST route and the inbox convert route so all three
    // write paths apply the same currency policy (lib/currency/supplier-invoice-rate.ts).
    const fx = await resolveSupplierInvoiceExchangeRate(supabase, {
      currency: body.currency,
      invoiceDate: body.invoice_date,
      suppliedRate: body.exchange_rate,
    })
    if (!fx.ok) {
      // Storing exchange_rate = NULL here is what created the permanently
      // unconverted rows: the booking path refuses them (SI_FX_RATE_MISSING)
      // and the user is by then far away from the invoice. Refuse at creation
      // instead, where the kurs can still be typed into the form.
      return errorResponseFromCode('SI_FX_RATE_MISSING', log, {
        requestId,
        details: { currency: fx.currency, invoice_date: fx.invoiceDate },
      })
    }

    const { data: arrivalNum, error: arrivalError } = await supabase
      .rpc('get_next_arrival_number', { p_company_id: companyId })

    if (arrivalError) {
      log.error('arrival number generation failed', arrivalError)
      return errorResponseFromCode('SI_CREATE_FAILED', log, {
        requestId,
        details: { reason: getUserErrorMessage(arrivalError), step: 'arrival_number' },
      })
    }

    const items = body.items.map((item, index) => {
      // An omitted rate defaults to 25 % only for VAT-registered companies;
      // icke momsregistrerade book the gross amount with no moms line.
      const vatRate = item.vat_rate ?? (vatRegistered ? 0.25 : 0)
      const lineTotal = item.amount != null
        ? Math.round(item.amount * 100) / 100
        : Math.round((item.quantity ?? 1) * (item.unit_price ?? 0) * 100) / 100
      // Honor a manual VAT override (partial-deduction cases, foreign-currency
      // rounding, supplier-side POS rounding). Falls back to line_total × rate
      // when the caller didn't supply one.
      const vatAmount = item.vat_amount != null
        ? Math.round(item.vat_amount * 100) / 100
        : Math.round(lineTotal * vatRate * 100) / 100
      const hasAccrual = Boolean(item.accrual_period_start && item.accrual_period_end)
      return {
        sort_order: index,
        description: item.description,
        quantity: item.amount != null ? 1 : (item.quantity ?? 1),
        unit: item.amount != null ? 'st' : (item.unit || 'st'),
        unit_price: item.amount != null ? lineTotal : (item.unit_price ?? 0),
        line_total: lineTotal,
        account_number: item.account_number,
        vat_code: item.vat_code || null,
        vat_rate: vatRate,
        vat_amount: vatAmount,
        // Self-assessed RC rate (0.06/0.12/0.25) or null. For reverse charge the
        // supplier charges no VAT (vat_rate stays 0); the engine self-assesses
        // at this rate, defaulting to 25% huvudregeln when null.
        reverse_charge_rate: body.reverse_charge ? (item.reverse_charge_rate ?? null) : null,
        // Periodisering: frozen onto the line at create time. The balance
        // account defaults from the cost account's BAS convention when the
        // client leaves it blank.
        accrual_period_start: hasAccrual ? item.accrual_period_start : null,
        accrual_period_end: hasAccrual ? item.accrual_period_end : null,
        accrual_balance_account: hasAccrual
          ? (item.accrual_balance_account ??
            suggestBalanceAccount('expense', item.account_number))
          : null,
        // Dimensions PR7: per-item bag, merged over default_dimensions on the
        // expense line at booking (supplier-invoice-entries.ts).
        dimensions: item.dimensions ?? {},
        // Särskild löneskatt (SLP): booking injects the self-balancing
        // 7533/2514 pair for this line. Guarded above (741x only, no accrual).
        apply_slp: item.apply_slp === true,
      }
    })

    const subtotal = items.reduce((sum, i) => sum + i.line_total, 0)
    const vatAmount = items.reduce((sum, i) => sum + i.vat_amount, 0)
    // Reverse charge: supplier never invoices VAT, so the payable total equals
    // the net. VAT is still tracked separately (vat_amount) for declarations
    // and books fiktiv 2614/2645 in the engine, but neither side moves cash.
    const payableVat = body.reverse_charge ? 0 : vatAmount
    // roundOre, not the naive form: `total` and `total_sek` must round
    // identically or a SEK invoice ends up with total_sek one öre off `total`.
    const total = roundOre(subtotal + payableVat)

    // Representation (BAS 6070-6079): ingående moms is only deductible up to
    // 300 SEK base/person per ML 8 kap. 1 §, and the income-tax deduction was
    // abolished in 2017 (IL 16 kap. 2 §). The engine debits 2641 for the full
    // VAT; we surface a non-blocking warning so the user can adjust manually.
    // Only emit on the new private-funds path for now: other AP paths share
    // the flaw and are tracked separately.
    const warnings: Array<{ code: string; message: string }> = []
    if (paidPrivately) {
      const repItems = items.filter(i => /^607\d$/.test(i.account_number))
      if (repItems.length > 0) {
        warnings.push({
          code: 'REPRESENTATION_VAT_CAP',
          message:
            'Representation (konto 6070-6079): ingående moms är endast avdragsgill ' +
            'upp till 300 kr/person (ML 8 kap. 1 §) och kostnaden är inte ' +
            'inkomstskattemässigt avdragsgill (IL 16 kap. 2 §). Justera bokföringen ' +
            'manuellt om beloppet överstiger gränsen.',
        })
      }
    }

    // SEK invoices resolve to rate 1, so total_sek === total. The old
    // `exchangeRate ? … : null` guard left every ordinary Swedish supplier
    // invoice with total_sek = NULL, which is why SEK-reporting readers saw
    // nothing.
    const {
      subtotal_sek: subtotalSek,
      vat_amount_sek: vatAmountSek,
      total_sek: totalSek,
    } = supplierInvoiceSekAmounts(fx.rate, { subtotal, vatAmount, total })

    const totalRounded = roundOre(total)
    const { data: invoice, error: invoiceError } = await supabase
      .from('supplier_invoices')
      .insert({
        user_id: user.id,
        company_id: companyId,
        supplier_id: body.supplier_id,
        document_id: body.document_id || null,
        arrival_number: arrivalNum,
        supplier_invoice_number: body.supplier_invoice_number,
        invoice_date: body.invoice_date,
        due_date: body.due_date,
        delivery_date: body.delivery_date || null,
        status: paidPrivately ? 'paid' : 'registered',
        currency: fx.rate.currency,
        exchange_rate: fx.rate.exchangeRate,
        // Which day's kurs the SEK amounts were translated at: the audit trail
        // that makes them verifiable (BFL 5 kap).
        exchange_rate_date: fx.rate.exchangeRateDate,
        vat_treatment: body.vat_treatment || 'standard_25',
        reverse_charge: body.reverse_charge || false,
        payment_reference: body.payment_reference || null,
        paid_with_private_funds: paidPrivately,
        subtotal: roundOre(subtotal),
        subtotal_sek: subtotalSek,
        vat_amount: roundOre(vatAmount),
        vat_amount_sek: vatAmountSek,
        total: totalRounded,
        total_sek: totalSek,
        paid_amount: paidPrivately ? totalRounded : 0,
        remaining_amount: paidPrivately ? 0 : totalRounded,
        paid_at: paidPrivately ? new Date().toISOString() : null,
        notes: body.notes || null,
        // Display-only öresavrundning override; null = off (no retroactive rounding).
        ore_rounding: body.ore_rounding ?? null,
        // Dimensions PR7: invoice-level bag; generators apply it to every line.
        default_dimensions: body.default_dimensions ?? {},
      })
      .select()
      .single()

    if (invoiceError || !invoice) {
      // Special-case the unique-index violation on (company_id, supplier_id,
      // supplier_invoice_number). The UI uses the embedded `existing` object
      // to offer "undo crediting": preserve that shape inside `details`.
      const pgErr = invoiceError as { code?: string; message?: string } | null
      const isDuplicateNumber =
        pgErr?.code === '23505' &&
        (pgErr.message || '').includes('idx_supplier_invoices_company_supplier_number')

      if (isDuplicateNumber) {
        const { data: existing } = await supabase
          .from('supplier_invoices')
          .select('id, supplier_invoice_number, status')
          .eq('company_id', companyId)
          .eq('supplier_id', body.supplier_id)
          .eq('supplier_invoice_number', body.supplier_invoice_number)
          .maybeSingle()

        let creditNoteId: string | null = null
        if (existing?.status === 'credited') {
          const { data: creditNote } = await supabase
            .from('supplier_invoices')
            .select('id')
            .eq('company_id', companyId)
            .eq('credited_invoice_id', existing.id)
            .eq('is_credit_note', true)
            .maybeSingle()
          creditNoteId = creditNote?.id ?? null
        }

        return errorResponseFromCode('SI_CREATE_DUPLICATE_INVOICE_NUMBER', log, {
          requestId,
          details: {
            supplierId: body.supplier_id,
            supplierInvoiceNumber: body.supplier_invoice_number,
            existing: existing
              ? {
                  id: existing.id,
                  supplier_invoice_number: existing.supplier_invoice_number,
                  status: existing.status,
                  credit_note_id: creditNoteId,
                }
              : null,
          },
        })
      }

      log.error('supplier invoice insert failed', invoiceError)
      return errorResponseFromCode('SI_CREATE_FAILED', log, {
        requestId,
        details: { reason: getUserErrorMessage(invoiceError) || 'unknown' },
      })
    }

    const itemInserts = items.map((item) => ({
      supplier_invoice_id: invoice.id,
      ...item,
    }))

    const { data: insertedItems, error: itemsError } = await supabase
      .from('supplier_invoice_items')
      .insert(itemInserts)
      .select('id, sort_order')

    if (itemsError) {
      // Roll back the parent on items failure to avoid orphan rows.
      await supabase.from('supplier_invoices').delete().eq('id', invoice.id)
      log.error('supplier invoice items insert failed; rolled back', itemsError, {
        invoiceId: invoice.id,
      })
      return errorResponseFromCode('SI_CREATE_FAILED', log, {
        requestId,
        details: { reason: getUserErrorMessage(itemsError), step: 'items_insert' },
      })
    }

    // Accrual method: create the registration journal entry. JE failure here
    // is fatal: an orphan supplier_invoices row without a registration JE
    // silently understates leverantörsskuld (2440) and ingående moms (2641)
    // for the momsdeklaration. Roll back instead.
    //
    // Privately-paid path bypasses both accrual and cash flows: a single
    // verifikat books the expense + VAT against 2893 (AB) or 2018 (EF) at
    // registration time, regardless of accounting_method. mark-paid is never
    // invoked for these (status='paid' from the start).
    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, defer_invoice_booking')
      .eq('company_id', companyId)
      .single()

    // #967: deferred companies register WITHOUT booking; ekonomi books later
    // via POST /api/supplier-invoices/[id]/book. The invoice then legitimately
    // sits at registration_journal_entry_id = NULL, like the cash method.
    const booksOnRegistration = booksInvoicesOnIssue(settings)
    let registrationJournalEntryId: string | null = null
    let paymentJournalEntryId: string | null = null

    if (paidPrivately && entityType) {
      try {
        const journalEntry = await createSupplierInvoicePrivatelyPaidEntry(
          supabase,
          companyId!,
          user.id,
          invoice as SupplierInvoice,
          items as SupplierInvoiceItem[],
          entityType,
          supplier.name,
        )
        if (journalEntry) {
          paymentJournalEntryId = journalEntry.id
          await supabase
            .from('supplier_invoices')
            .update({ payment_journal_entry_id: journalEntry.id })
            .eq('id', invoice.id)
          // Mirror the payment in supplier_invoice_payments so AR/AP and
          // payment-history queries stay consistent with the mark-paid path.
          await supabase.from('supplier_invoice_payments').insert({
            user_id: user.id,
            company_id: companyId,
            supplier_invoice_id: invoice.id,
            // For an eget utlägg the actual out-of-pocket date may differ from
            // the invoice/receipt date: accept an explicit payment_date and
            // fall back to invoice_date for the common kvitto case.
            payment_date: body.payment_date ?? invoice.invoice_date,
            amount: totalRounded,
            currency: invoice.currency,
            exchange_rate_difference: 0,
            journal_entry_id: journalEntry.id,
            notes: 'Eget utlägg, betalat privat',
          })
        } else {
          // createSupplierInvoicePrivatelyPaidEntry returns null ONLY when no
          // fiscal period covers invoice_date (every other failure throws and
          // lands in the catch below). Without this branch the invoice would be
          // saved as status='paid' with no verifikat: a silent orphan. Roll
          // back and surface an actionable error, per the fatal-orphan note above.
          await supabase.from('supplier_invoices').delete().eq('id', invoice.id).eq('company_id', companyId)
          return errorResponseFromCode('SI_CREATE_NO_FISCAL_PERIOD', log, {
            requestId,
            details: { invoiceDate: invoice.invoice_date },
          })
        }
      } catch (err) {
        await supabase.from('supplier_invoices').delete().eq('id', invoice.id).eq('company_id', companyId)
        if (isBookkeepingError(err)) {
          return errorResponse(err, log, { requestId })
        }
        log.error('failed to create privately-paid journal entry', err as Error, {
          invoiceId: invoice.id,
        })
        return errorResponseFromCode('SI_CREATE_FAILED', log, {
          requestId,
          details: {
            reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown',
            step: 'privately_paid_journal_entry',
          },
        })
      }
    } else if (booksOnRegistration) {
      try {
        const journalEntry = await createSupplierInvoiceRegistrationEntry(
          supabase,
          companyId!,
          user.id,
          invoice as SupplierInvoice,
          items as SupplierInvoiceItem[],
          supplier.supplier_type,
          supplier.name,
        )
        if (journalEntry) {
          registrationJournalEntryId = journalEntry.id
          await supabase
            .from('supplier_invoices')
            .update({ registration_journal_entry_id: journalEntry.id })
            .eq('id', invoice.id)

          if (hasAccrualItems) {
            // The registration entry is committed (immutable): a schedule
            // failure must not roll the invoice back. Surface a warning and
            // let the user retry from the periodiseringar page instead.
            const idBySortOrder = new Map(
              ((insertedItems ?? []) as Array<{ id: string; sort_order: number }>).map(
                (row) => [row.sort_order, row.id],
              ),
            )
            const itemsWithIds = items.map((item) => ({
              ...item,
              id: idBySortOrder.get(item.sort_order) ?? null,
            }))
            const scheduleResult = await createSchedulesForSupplierInvoice(
              supabase,
              companyId!,
              user.id,
              invoice as SupplierInvoice,
              itemsWithIds as unknown as SupplierInvoiceItem[],
              journalEntry.id,
            )
            if (scheduleResult.failed > 0) {
              warnings.push({
                code: 'ACCRUAL_SCHEDULE_FAILED',
                message:
                  'Fakturan bokfördes, men en eller flera periodiseringar kunde inte ' +
                  'skapas. Kontrollera under Bokföring → Periodiseringar.',
              })
            }
          }
        } else {
          // createSupplierInvoiceRegistrationEntry returns null ONLY when no
          // fiscal period covers invoice_date (every other failure throws and
          // lands in the catch below). An orphan supplier_invoices row without a
          // registration JE silently understates leverantörsskuld (2440) and
          // ingående moms (2641) for the momsdeklaration: exactly the fatal
          // case the note above warns about. Roll back and surface an
          // actionable error instead of returning 200.
          await supabase.from('supplier_invoices').delete().eq('id', invoice.id).eq('company_id', companyId)
          return errorResponseFromCode('SI_CREATE_NO_FISCAL_PERIOD', log, {
            requestId,
            details: { invoiceDate: invoice.invoice_date },
          })
        }
      } catch (err) {
        await supabase.from('supplier_invoices').delete().eq('id', invoice.id).eq('company_id', companyId)
        if (isBookkeepingError(err)) {
          return errorResponse(err, log, { requestId })
        }
        log.error('failed to create registration journal entry', err as Error, {
          invoiceId: invoice.id,
        })
        return errorResponseFromCode('SI_CREATE_FAILED', log, {
          requestId,
          details: {
            reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown',
            step: 'registration_journal_entry',
          },
        })
      }
    }

    const primaryJournalEntryId = paymentJournalEntryId || registrationJournalEntryId
    if (body.document_id && primaryJournalEntryId) {
      try {
        await linkToJournalEntry(
          supabase,
          companyId,
          body.document_id,
          primaryJournalEntryId,
        )
      } catch (err) {
        log.warn('supplier invoice document could not be linked to journal entry', {
          documentId: body.document_id,
          journalEntryId: primaryJournalEntryId,
          error: err instanceof Error ? err.message : String(err),
        })
        warnings.push({
          code: 'DOCUMENT_LINK_FAILED',
          message: 'Fakturan registrerades, men underlaget kunde inte kopplas till verifikationen.',
        })
      }
    }

    try {
      await eventBus.emit({
        type: 'supplier_invoice.registered',
        payload: { supplierInvoice: invoice as SupplierInvoice, companyId: companyId!, userId: user.id },
      })
      if (paidPrivately) {
        await eventBus.emit({
          type: 'supplier_invoice.paid',
          payload: {
            supplierInvoice: invoice as SupplierInvoice,
            paymentAmount: totalRounded,
            companyId: companyId!,
            userId: user.id,
          },
        })
      }
    } catch (err) {
      log.warn('supplier_invoice.registered event emission failed', err as Error)
    }

    return NextResponse.json({
      data: {
        ...invoice,
        items: itemInserts,
        registration_journal_entry_id: registrationJournalEntryId,
        payment_journal_entry_id: paymentJournalEntryId,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    })
  },
  { requireWrite: true },
)
