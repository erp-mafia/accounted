/**
 * Canonical registry of structured error codes used by both REST routes and
 * the MCP server.
 *
 * Each entry defines:
 *   - httpStatus: status returned by errorResponse() for this code
 *   - message_sv: Swedish user-facing message (consumed by toast)
 *   - message_en: English message for agents and developer logs
 *   - remediation: optional pointer to a fix (tool/resource/description)
 *
 * Adding a new code = add a row here. The error-code-matrix in
 * `.claude/plans/for-all-of-those-mutable-sunset.md` lists the codes per
 * operation; keep that document and this file in sync.
 *
 * Codes follow `<DOMAIN>_<OPERATION>_<CAUSE>` naming. Stable forever once
 * shipped: agents pattern-match on them.
 */

export interface StructuredErrorRemediation {
  description: string
  tool?: string
  args?: Record<string, unknown>
  resource?: string
}

export interface StructuredErrorEntry {
  httpStatus: number
  message_sv: string
  message_en: string
  remediation?: StructuredErrorRemediation
  /**
   * When true, agents and clients may retry the same request after a short
   * backoff. Set only on truly transient failures (DB blip, external API
   * timeout, rate limit). Permanent failures (validation, not found, period
   * locked) MUST stay false: retrying won't change the outcome.
   */
  retryable?: boolean
}

// ─────────────────────────────────────────────────────────────────
// Generic / cross-cutting codes
// ─────────────────────────────────────────────────────────────────

const GENERIC: Record<string, StructuredErrorEntry> = {
  UNKNOWN_ERROR: {
    httpStatus: 500,
    message_sv: 'Något gick fel. Försök igen.',
    message_en: 'An unexpected error occurred.',
  },
  // Unclassified-but-transient failures (DB deadlock/timeout, connection
  // drop, upstream 5xx/429) inferred by isTransientFailure() when no
  // specific code applies. Stable code so agents can dispatch on it.
  TRANSIENT_ERROR: {
    httpStatus: 503,
    message_sv: 'Tillfälligt fel: försök igen om en stund.',
    message_en: 'Transient failure: retry the same request after a short backoff.',
    retryable: true,
  },
  INTERNAL_ERROR: {
    httpStatus: 500,
    message_sv: 'Ett oväntat serverfel uppstod. Försök igen senare.',
    message_en: 'Internal server error.',
  },
  VALIDATION_ERROR: {
    httpStatus: 400,
    message_sv: 'Förfrågan innehåller ogiltiga uppgifter.',
    message_en: 'Validation error.',
  },
  UNAUTHORIZED: {
    httpStatus: 401,
    message_sv: 'Din session har gått ut. Logga in igen.',
    message_en: 'Authentication required.',
  },
  MFA_REQUIRED: {
    httpStatus: 403,
    message_sv: 'Tvåstegsverifiering krävs för att utföra åtgärden.',
    message_en: 'MFA verification required.',
  },
  FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Du har inte behörighet att utföra denna åtgärd.',
    message_en: 'Insufficient permissions.',
  },
  NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Resursen kunde inte hittas.',
    message_en: 'Resource not found.',
  },
  CONFLICT: {
    httpStatus: 409,
    message_sv: 'En konflikt uppstod. Ladda om sidan och försök igen.',
    message_en: 'Conflict.',
  },
  RATE_LIMITED: {
    httpStatus: 429,
    message_sv: 'För många förfrågningar. Vänta en stund och försök igen.',
    message_en: 'Rate limit exceeded.',
    retryable: true,
  },
  NOT_IMPLEMENTED: {
    httpStatus: 501,
    message_sv: 'Funktionen är inte implementerad ännu.',
    message_en: 'This feature is accepted by the schema but not yet implemented.',
  },
  COMPANY_CONTEXT_MISSING: {
    httpStatus: 400,
    message_sv: 'Ingen aktiv företagskontext. Välj ett företag och försök igen.',
    message_en: 'No active company context resolved for the request.',
  },
  IDEMPOTENCY_KEY_REUSE: {
    httpStatus: 409,
    message_sv: 'Idempotensnyckeln har redan använts med en annan begäran.',
    message_en: 'Idempotency key was previously used with a different request body.',
    remediation: {
      description:
        'Use a fresh UUID for a new operation, or send the original request body to replay.',
    },
  },
  INSUFFICIENT_SCOPE: {
    httpStatus: 403,
    message_sv: 'API-nyckeln saknar behörighet för denna åtgärd.',
    message_en: 'The current API key does not have the required scope.',
    remediation: {
      description:
        'Mint a new key with the missing scope or grant it through the API key settings.',
      resource: 'Accounted://capabilities',
    },
  },
  TEST_KEY_WRITE_BLOCKED: {
    httpStatus: 403,
    message_sv:
      'Den här åtgärden kan inte simuleras och är därför inte tillgänglig med en testnyckel. Använd en live-nyckel.',
    message_en:
      'This endpoint cannot be simulated, so it is not available with a test key. Test keys force dry-run on every write; use a live key for endpoints that do not support dry-run.',
    remediation: {
      description: 'Use a live key for this endpoint, or pick an endpoint that supports dry-run.',
    },
  },
}

// ─────────────────────────────────────────────────────────────────
// Bookkeeping engine codes (already used by lib/bookkeeping/errors.ts)
// ─────────────────────────────────────────────────────────────────

const BOOKKEEPING: Record<string, StructuredErrorEntry> = {
  ACCOUNTS_NOT_IN_CHART: {
    httpStatus: 400,
    message_sv: 'Konton saknas i kontoplanen.',
    message_en: 'One or more BAS accounts are not active in the chart of accounts.',
    remediation: {
      description:
        'Activate the missing accounts via bookkeeping settings, or use a different category.',
      resource: 'Accounted://chart-of-accounts',
    },
  },
  JOURNAL_ENTRY_NOT_BALANCED: {
    httpStatus: 400,
    message_sv: 'Verifikationen balanserar inte.',
    message_en: 'Debits and credits do not match.',
    remediation: {
      description: 'Recalculate the lines so totals are equal before retrying.',
    },
  },
  FISCAL_PERIOD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsperioden kunde inte hittas.',
    message_en: 'No fiscal period covers the entry date.',
    remediation: {
      description: 'Create or extend the relevant fiscal period before retrying.',
      resource: 'Accounted://period/active',
    },
  },
  ENTRY_DATE_OUTSIDE_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv: 'Datumet ligger utanför det valda räkenskapsåret.',
    message_en: 'Entry date is outside the active fiscal period.',
    remediation: {
      description: 'Use a date inside an open period or create one that covers it.',
      resource: 'Accounted://period/active',
    },
  },
  JOURNAL_ENTRY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikationen kunde inte hittas.',
    message_en: 'Journal entry not found.',
  },
  CANNOT_REVERSE_NON_POSTED: {
    httpStatus: 400,
    message_sv: 'Endast bokförda verifikationer kan stornas.',
    message_en: 'Only posted entries can be reversed.',
  },
  CANNOT_REVERSE_STORNO: {
    httpStatus: 400,
    message_sv: 'En stornering eller rättelse kan inte stornas.',
    message_en: 'A storno or correction entry cannot be reversed.',
  },
  CANNOT_CORRECT_NON_POSTED: {
    httpStatus: 400,
    message_sv: 'Endast bokförda verifikationer kan rättas.',
    message_en: 'Only posted entries can be corrected.',
  },
  ENTRY_ALREADY_REVERSED: {
    httpStatus: 409,
    message_sv:
      'Verifikationen har redan stornats av en annan användare. Ladda om sidan och försök igen.',
    message_en: 'Entry was already reversed by a concurrent operation.',
  },
  CURRENCY_REVALUATION_ALREADY_EXISTS: {
    httpStatus: 409,
    message_sv: 'En valutaomvärdering finns redan för denna period.',
    message_en: 'Currency revaluation already exists for this period.',
  },
  INVALID_MAPPING_RESULT: {
    httpStatus: 400,
    message_sv: 'Kontering saknas för transaktionen. Kontrollera bokföringsreglerna.',
    message_en: 'Mapping rules produced an invalid debit/credit account pair.',
  },
  DIMENSION_VALIDATION_FAILED: {
    httpStatus: 400,
    message_sv:
      'Ett angivet kostnadsställe/projekt finns inte i dimensionsregistret eller är arkiverat. Skapa värdet i registret först.',
    message_en:
      'One or more dimension codes on the entry lines are missing from the dimension registry or archived. details.issues lists each offending sie_dim_no/code.',
    remediation: {
      description:
        'Create the missing dimension value in the register (or re-activate the archived value), then retry. Only companies with dimensions enabled are validated; each issue in details.issues carries sie_dim_no, code and reason (unknown_dimension | unknown_value | archived_value).',
    },
  },
  BOOKKEEPING_DATABASE_ERROR: {
    httpStatus: 500,
    message_sv: 'Verifikationen kunde inte sparas. Försök igen.',
    message_en: 'Bookkeeping database operation failed.',
    retryable: true,
  },
  MEANINGLESS_CORRECTION: {
    httpStatus: 400,
    message_sv: 'Rättelsen motsvarar ingen ekonomisk händelse: det finns inget att rätta.',
    message_en: 'The correction represents no economic event: nothing to correct.',
  },
  NO_OPEN_PERIOD_FOR_DATE: {
    httpStatus: 400,
    message_sv:
      'Det finns ingen räkenskapsperiod som täcker det valda datumet. Skapa eller öppna räkenskapsåret först.',
    message_en: 'No fiscal period covers the selected date.',
    remediation: {
      description: 'Create or open the fiscal year that covers the date before retrying.',
      resource: 'Accounted://period/active',
    },
  },
  TARGET_PERIOD_CLOSED: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsåret som täcker datumet är stängt (bokslut) och kan inte öppnas. Bokför i en öppen period i stället.',
    message_en: 'The fiscal year covering the date is closed and cannot be reopened.',
  },
  TARGET_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv: 'Räkenskapsperioden som täcker datumet är låst.',
    message_en: 'The fiscal period covering the date is locked.',
    remediation: {
      description:
        'Unlock the period (if status is "locked", not "closed") or use a date inside an open period.',
      tool: 'gnubok_unlock_period',
    },
  },
  PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv: 'Bokföringen är låst för denna period.',
    message_en: 'Period is locked or closed; entries cannot be added.',
    remediation: {
      description:
        'Either unlock the period via gnubok_unlock_period (if status is "locked", not "closed") or change the entry date to fall inside an open period.',
      tool: 'gnubok_unlock_period',
    },
  },
  PERIOD_NOT_LOCKED: {
    httpStatus: 400,
    message_sv: 'Perioden måste först låsas innan den kan stängas.',
    message_en: 'Period must be locked before it can be closed.',
    remediation: {
      description: 'Call gnubok_lock_period before closing.',
      tool: 'gnubok_lock_period',
    },
  },
  PERIOD_HAS_UNBOOKED_TRANSACTIONS: {
    httpStatus: 400,
    message_sv:
      'Perioden innehåller okategoriserade affärstransaktioner. Bokför eller markera dem som privata innan låsning.',
    message_en: 'The period contains uncategorized business transactions.',
    remediation: {
      description: 'Categorize or mark uncategorized transactions before locking.',
      tool: 'gnubok_list_uncategorized_transactions',
    },
  },
  YEAR_END_NOT_RUN: {
    httpStatus: 400,
    message_sv: 'Bokslutsåtgärder måste utföras innan perioden kan stängas.',
    message_en: 'Year-end closing must be executed before the period can be closed.',
  },
  TRANSACTION_ALREADY_CATEGORIZED: {
    httpStatus: 409,
    message_sv:
      'Transaktionen är redan bokförd. Ångra kategoriseringen om du vill ändra den.',
    message_en: 'The transaction already has a journal entry.',
    remediation: {
      description:
        'Use gnubok_uncategorize_transaction first if you need to recategorize.',
      tool: 'gnubok_uncategorize_transaction',
    },
  },
  INVOICE_ALREADY_SENT: {
    httpStatus: 409,
    message_sv: 'Fakturan har redan skickats eller betalats.',
    message_en: 'The invoice is already sent or paid.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Wave 1: invoicing & transactions
// ─────────────────────────────────────────────────────────────────

const TRANSACTIONS: Record<string, StructuredErrorEntry> = {
  TRANSACTION_BOOK_POSSIBLE_DUPLICATE: {
    httpStatus: 409,
    message_sv:
      'Den här affärshändelsen ser redan ut att vara bokförd: antingen en annan transaktion på samma datum och belopp, eller en verifikation som redan bokar samma belopp på bankkontot (t.ex. en betald faktura eller en lönekörning). Bokför inte samma affärshändelse två gånger. Granska den befintliga verifikationen och länka transaktionen till den, eller bokför ändå om de inte hör ihop.',
    message_en:
      'This business event already appears to be booked: either another transaction with the same date and amount, or a voucher that already books the same amount on the bank account (e.g. a paid invoice or a salary run). Do not book the same business event twice. Review the existing voucher and link this transaction to it, or pass force=true to book it anyway if they are genuinely unrelated.',
  },
  TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Den möjliga dubbletten som visades matchar inte längre. Ladda om och försök igen så att rätt kandidat visas.',
    message_en:
      'The duplicate candidate echoed in expected_duplicate_transaction_id / expected_duplicate_journal_entry_id no longer matches the one detected at request time. Re-run the booking pre-flight to obtain the current candidate, then retry.',
  },
  TX_CATEGORIZE_TX_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Transaktionen kunde inte hittas.',
    message_en: 'Transaction not found.',
  },
  TRANSACTION_TITLE_LOCKED: {
    httpStatus: 409,
    message_sv:
      'Det går inte att ändra titeln på en bokförd eller matchad transaktion. Bokförda verifikat rättas med storno.',
    message_en:
      'Cannot edit the title of a booked or matched transaction. Posted vouchers are corrected with storno.',
  },
  TX_CATEGORIZE_INVALID_ACCOUNT: {
    httpStatus: 400,
    message_sv: 'Det valda kontot finns inte i kontoplanen.',
    message_en: 'The supplied account does not exist in the chart of accounts.',
    remediation: {
      description: 'Activate the account in the chart of accounts or pick a different one.',
      resource: 'Accounted://chart-of-accounts',
    },
  },
  TX_CATEGORIZE_INVALID_TEMPLATE: {
    httpStatus: 400,
    message_sv: 'Bokföringsmallen är ogiltig eller passar inte din bolagsform.',
    message_en: 'The supplied booking template is invalid or does not match the entity type.',
  },
  TX_CATEGORIZE_INVALID_MAPPING: {
    httpStatus: 400,
    message_sv: 'Konteringen saknar debet- eller kreditkonto.',
    message_en: 'Mapping result is missing a debit or credit account.',
  },
  TX_CATEGORIZE_RACE: {
    httpStatus: 409,
    message_sv: 'Transaktionen kategoriserades av en annan förfrågan. Ladda om och försök igen.',
    message_en: 'Transaction was already categorized by another request.',
  },
  TX_CATEGORIZE_SUGGEST_SI_MATCH: {
    httpStatus: 409,
    message_sv:
      'Det finns en öppen leverantörsfaktura från samma leverantör med samma belopp. Matcha mot fakturan istället för att bokföra direkt på leverantörsskuldskontot: annars skapas en dubblerad verifikation som måste stornas (BFL 5 kap 5 §).',
    message_en:
      'An open supplier invoice from the same supplier matches this amount. Suggest matching to the invoice instead of a plain 244x categorization to avoid producing a duplicate verifikation (BFL 5 kap 5 §).',
    remediation: {
      description:
        'Match the transaction via POST /api/transactions/{id}/match-supplier-invoice, or resend with confirm_no_match: true to keep the plain 244x categorization.',
    },
  },
  TX_CATEGORIZE_SUGGEST_CI_MATCH: {
    httpStatus: 409,
    message_sv:
      'Det finns en obetald kundfaktura från samma kund med samma belopp. Matcha mot fakturan istället för att bokföra direkt mot kundfordringskontot: annars skapas en dubblerad verifikation som måste stornas (BFL 5 kap 5 §).',
    message_en:
      'An unpaid customer invoice from the same customer matches this amount. Suggest matching to the invoice instead of a plain 151x categorization to avoid producing a duplicate verifikation (BFL 5 kap 5 §).',
    remediation: {
      description:
        'Match the transaction via POST /api/transactions/{id}/match-invoice, or resend with confirm_no_match: true to keep the plain 151x categorization.',
    },
  },
  TX_UNCATEGORIZE_NO_LINKED_ENTRY: {
    httpStatus: 400,
    message_sv: 'Transaktionen har ingen kopplad verifikation att stornera.',
    message_en: 'Transaction has no linked journal entry to reverse.',
  },
  TX_EXCHANGE_RATE_UNAVAILABLE: {
    httpStatus: 502,
    message_sv:
      'Kunde inte hämta växelkursen från Riksbanken. Försök igen om en stund: verifikationen måste bokföras i SEK.',
    message_en:
      'Could not fetch the exchange rate from Riksbanken. The verifikation must be posted in SEK.',
    retryable: true,
  },
}

const MATCH_INVOICE: Record<string, StructuredErrorEntry> = {
  MATCH_INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Fakturan kunde inte hittas.',
    message_en: 'Invoice not found.',
  },
  MATCH_INVOICE_NOT_INCOME: {
    httpStatus: 400,
    message_sv: 'Endast intäktstransaktioner kan matchas mot kundfakturor.',
    message_en: 'Only income transactions can be matched to customer invoices.',
  },
  MATCH_INVOICE_TX_ALREADY_LINKED: {
    httpStatus: 400,
    message_sv: 'Transaktionen är redan kopplad till en faktura.',
    message_en: 'Transaction is already linked to an invoice.',
  },
  MATCH_INVOICE_NOT_OPEN: {
    httpStatus: 400,
    message_sv: 'Fakturan är inte i ett obetalt läge och kan inte matchas.',
    message_en: 'Invoice is not in an unpaid state.',
  },
  MATCH_INVOICE_NOT_INVOICE_TYPE: {
    httpStatus: 400,
    message_sv: 'Endast fakturor kan matchas mot en transaktion. Proforma och följesedel saknar momsskyldighet.',
    message_en: 'Only invoices may be matched to a transaction; proforma and delivery notes have no VAT obligation.',
  },
  MATCH_INVOICE_FX_RATE_UNAVAILABLE: {
    httpStatus: 400,
    message_sv:
      'Kunde inte hämta valutakurs från Riksbanken för betalningsdatumet. Ange kursen manuellt från ditt bankutdrag (fältet manual_exchange_rate).',
    message_en:
      'Could not retrieve an exchange rate from Riksbanken for the payment date. Provide the rate manually from your bank statement (manual_exchange_rate field).',
  },
  MATCH_INVOICE_ALREADY_PAID: {
    httpStatus: 409,
    message_sv: 'Fakturan har redan slutbetalats av en annan förfrågan.',
    message_en: 'Invoice has already been fully paid or is no longer matchable.',
  },
  MATCH_INVOICE_DUPLICATE_PAYMENT: {
    httpStatus: 409,
    message_sv: 'Den här transaktionen är redan matchad mot fakturan.',
    message_en: 'This transaction is already matched to this invoice.',
  },
  MATCH_INVOICE_RECORD_PAYMENT_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte registrera fakturabetalningen.',
    message_en: 'Failed to record invoice payment.',
    retryable: true,
  },
  MATCH_INVOICE_LINK_TX_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte koppla transaktionen till fakturan.',
    message_en: 'Failed to link transaction to invoice.',
    retryable: true,
  },
  MATCH_INVOICE_PARTIAL: {
    httpStatus: 200,
    message_sv: 'Matchningen registrerades men verifikationen kunde inte skapas.',
    message_en: 'Match recorded but the journal entry could not be created.',
  },
  MATCH_INVOICE_ALREADY_HAS_PAYMENT_VOUCHER: {
    httpStatus: 409,
    message_sv:
      'Fakturan har redan en betalningsverifikation. Koppla istället bankhändelsen till befintlig verifikation, eller rätta tidigare bokföring först.',
    message_en:
      'Invoice already has a payment journal entry. Link the bank transaction to the existing voucher instead, or correct the prior bookkeeping first.',
  },
  MATCH_INVOICE_POSSIBLE_DUPLICATE: {
    httpStatus: 409,
    message_sv:
      'Det finns redan en bokförd verifikation på samma belopp och datum. Har du redan bokfört denna betalning? Koppla bankhändelsen till befintlig verifikation, eller skapa ny verifikation ändå om de inte hör ihop.',
    message_en:
      'A posted journal entry already books the same amount on a nearby date. The user may have already booked this payment manually: link to the existing voucher or pass force=true to create a new one anyway.',
  },
  MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Verifikationen som dubblettkontrollen visade matchar inte längre. Stäng dialogen och försök igen så att rätt verifikation visas.',
    message_en:
      'The candidate journal entry echoed in expected_journal_entry_id does not match the one detected at request time. Re-run the duplicate-payment pre-flight to obtain the current candidate, then retry.',
  },
  MATCH_AMOUNT_EXCEEDS_REMAINING: {
    httpStatus: 400,
    message_sv:
      'Transaktionsbeloppet är större än fakturans återstående belopp. Dela betalningen och fördela överskottet på en eller flera andra fakturor.',
    message_en:
      'Transaction amount exceeds the invoice remaining amount. Use the split-payment flow to allocate the excess across one or more other invoices.',
  },
}

const LINK_TX_JE: Record<string, StructuredErrorEntry> = {
  LINK_TX_JE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikationen kunde inte hittas.',
    message_en: 'Journal entry not found.',
  },
  LINK_TX_JE_NOT_POSTED: {
    httpStatus: 400,
    message_sv: 'Endast bokförda verifikationer kan kopplas till en banktransaktion.',
    message_en: 'Only posted journal entries can be linked to a transaction.',
  },
  LINK_TX_TX_ALREADY_LINKED: {
    httpStatus: 400,
    message_sv: 'Transaktionen är redan kopplad till en verifikation.',
    message_en: 'Transaction is already linked to a journal entry.',
  },
  LINK_TX_INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Fakturan kunde inte hittas.',
    message_en: 'Invoice not found.',
  },
  LINK_TX_INVOICE_NOT_OPEN: {
    httpStatus: 400,
    message_sv: 'Fakturan är inte i ett obetalt läge och kan inte kopplas.',
    message_en: 'Invoice is not in an unpaid state.',
  },
  LINK_TX_INVOICE_RACE: {
    httpStatus: 409,
    message_sv: 'Fakturan ändrades samtidigt. Försök igen.',
    message_en: 'Invoice status changed concurrently. Retry the request.',
  },
  LINK_TX_INVOICE_CURRENCY_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Transaktionens och fakturans valuta måste vara samma för att länka till en befintlig verifikation. Använd matchningsdialogen för valutaomräkning.',
    message_en:
      'Transaction and invoice currency must match to link to an existing voucher. Use the match-invoice flow for cross-currency settlement.',
  },
}

const MATCH_SI: Record<string, StructuredErrorEntry> = {
  MATCH_SI_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Leverantörsfakturan kunde inte hittas.',
    message_en: 'Supplier invoice not found.',
  },
  MATCH_SI_NOT_EXPENSE: {
    httpStatus: 400,
    message_sv: 'Endast utgiftstransaktioner kan matchas mot leverantörsfakturor.',
    message_en: 'Only expense transactions can be matched to supplier invoices.',
  },
  MATCH_SI_TX_ALREADY_LINKED: {
    httpStatus: 400,
    message_sv: 'Transaktionen är redan kopplad till en leverantörsfaktura.',
    message_en: 'Transaction is already linked to a supplier invoice.',
  },
  MATCH_SI_ALREADY_PAID: {
    httpStatus: 400,
    message_sv: 'Leverantörsfakturan är redan betald eller krediterad.',
    message_en: 'Supplier invoice is already paid or credited.',
  },
  MATCH_SI_NOT_OPEN: {
    httpStatus: 409,
    message_sv: 'Leverantörsfakturan har redan slutbetalats av en annan förfrågan.',
    message_en: 'Supplier invoice has already been fully paid or is no longer matchable.',
  },
  MATCH_SI_DUPLICATE_PAYMENT: {
    httpStatus: 409,
    message_sv: 'Den här transaktionen är redan matchad mot leverantörsfakturan.',
    message_en: 'This transaction is already matched to this supplier invoice.',
  },
  MATCH_SI_JE_FAILED: {
    httpStatus: 500,
    message_sv:
      'Betalningsverifikationen kunde inte skapas. Matchningen avbröts: inga ändringar har sparats.',
    message_en:
      'Failed to create the payment voucher. The match was aborted: no changes were saved.',
    retryable: true,
  },
  MATCH_SI_RECORD_PAYMENT_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte registrera leverantörsfakturabetalningen.',
    message_en: 'Failed to record supplier invoice payment.',
    retryable: true,
  },
  MATCH_SI_LINK_TX_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte koppla transaktionen till leverantörsfakturan.',
    message_en: 'Failed to link transaction to supplier invoice.',
    retryable: true,
  },
  MATCH_SI_CASH_FX_UNSUPPORTED: {
    httpStatus: 400,
    message_sv:
      'Kontantmetoden kan inte dela upp en delbetalning i utländsk valuta. Betala hela fakturan på en gång, byt till löpande bokföring eller bokför betalningen manuellt.',
    message_en:
      'The cash method cannot handle a partial foreign-currency payment. Pay the invoice in full, switch to accrual, or book the payment manually.',
  },
  MATCH_SI_AMOUNT_EXCEEDS_REMAINING: {
    httpStatus: 400,
    message_sv:
      'Transaktionsbeloppet är större än leverantörsfakturans återstående belopp. Dela betalningen och fördela överskottet på en eller flera andra leverantörsfakturor.',
    message_en:
      'Transaction amount exceeds the supplier invoice remaining amount. Use the split-payment flow to allocate the excess across one or more other supplier invoices.',
  },
  TX_UNCATEGORIZE_NOT_BOOKED: {
    httpStatus: 400,
    message_sv: 'Transaktionen är inte bokförd. Det finns inget att av-kategorisera.',
    message_en: 'Transaction has no journal entry: nothing to uncategorize.',
  },
  TX_UNCATEGORIZE_JE_NOT_POSTED: {
    httpStatus: 400,
    message_sv: 'Verifikationen är inte bokförd. Reversal kan inte utföras.',
    message_en: 'Journal entry is not in posted status; reversal is not possible.',
  },
  TX_INGEST_INSERT_FAILED: {
    httpStatus: 500,
    message_sv: 'Transaktionerna kunde inte importeras.',
    message_en: 'Transaction ingest failed.',
    retryable: true,
  },
  TX_BATCH_CATEGORIZE_EMPTY: {
    httpStatus: 400,
    message_sv: 'Batchen är tom.',
    message_en: 'Batch is empty: pass at least one item.',
  },
}

const INVOICE: Record<string, StructuredErrorEntry> = {
  INVOICE_CUSTOMER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kunden kunde inte hittas.',
    message_en: 'Customer not found.',
  },
  INVOICE_CREATE_VAT_RULE_VIOLATION: {
    httpStatus: 400,
    message_sv: 'Momssatsen är inte tillåten för denna kundtyp.',
    message_en: 'The VAT rate is not allowed for this customer type.',
  },
  INVOICE_CREATE_REVENUE_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Ett angivet försäljningskonto finns inte eller är inte ett aktivt intäktskonto (klass 3).',
    message_en: 'A supplied revenue account does not exist or is not an active class-3 income account.',
  },
  INVOICE_CREATE_ROT_RUT_VALIDATION: {
    httpStatus: 400,
    message_sv: 'ROT/RUT-avdraget kunde inte valideras. Kontrollera personnummer och fastighetsbeteckning.',
    message_en: 'ROT/RUT deduction failed validation. Check personnummer and housing designation.',
  },
  INVOICE_CREATE_ACCRUAL_INVALID: {
    httpStatus: 400,
    message_sv: 'Periodisering kan inte användas här. Den kräver faktureringsmetoden och stöds inte för omvänd skattskyldighet, export eller proforma.',
    message_en: 'Periodisering cannot be used here. It requires the accrual method and is not supported for reverse charge, export, or proforma documents.',
  },
  ACCRUAL_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Periodiseringen kunde inte hittas.',
    message_en: 'Accrual schedule not found.',
  },
  ACCRUAL_DISSOLVE_FAILED: {
    httpStatus: 400,
    message_sv: 'Periodiseringen kunde inte lösas upp.',
    message_en: 'The accrual schedule could not be dissolved.',
  },
  ACCRUAL_NOT_ACTIVE: {
    httpStatus: 400,
    message_sv: 'Periodiseringen är inte aktiv.',
    message_en: 'The accrual schedule is not active.',
  },
  ACCRUAL_NOTHING_TO_DISSOLVE: {
    httpStatus: 400,
    message_sv: 'Det finns inget kvar att lösa upp.',
    message_en: 'There is nothing left to dissolve on this accrual schedule.',
  },
  INVOICE_CREATE_ROT_RUT_PERSONNUMMER_INVALID: {
    httpStatus: 400,
    message_sv: 'Personnumret för ROT/RUT-avdraget är ogiltigt.',
    message_en: 'The personnummer provided for the ROT/RUT deduction is invalid.',
  },
  // Rot/rut begäran om utbetalning (Skatteverkets husavdragstjänst)
  ROT_RUT_REQUEST_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Begäran om utbetalning hittades inte.',
    message_en: 'Payout request not found.',
  },
  ROT_RUT_NO_ELIGIBLE_INVOICES: {
    httpStatus: 400,
    message_sv: 'Ingen av de valda fakturorna kan ingå i filen. Se blockeringarna per faktura.',
    message_en: 'None of the selected invoices can be included in the file. See the per-invoice blockers.',
  },
  ROT_RUT_INVOICES_BLOCKED: {
    httpStatus: 400,
    message_sv: 'En eller flera valda fakturor kan inte ingå i filen. Åtgärda blockeringarna eller välj bort fakturorna.',
    message_en: 'One or more selected invoices cannot be included in the file. Fix the blockers or deselect the invoices.',
  },
  ROT_RUT_INVOICE_CONFLICT: {
    httpStatus: 409,
    message_sv: 'Minst en faktura ingår redan i en aktiv begäran om utbetalning.',
    message_en: 'At least one invoice is already part of an active payout request.',
  },
  ROT_RUT_INVALID_STATUS_TRANSITION: {
    httpStatus: 400,
    message_sv: 'Statusändringen är inte tillåten för begäran i dess nuvarande läge.',
    message_en: 'The status transition is not allowed from the request current state.',
  },
  ROT_RUT_SETTLE_INVALID_STATE: {
    httpStatus: 400,
    message_sv: 'Utbetalningen kan bara bokföras för en inskickad begäran som inte redan är bokförd.',
    message_en: 'The payout can only be booked for a submitted request that is not already settled.',
  },
  ROT_RUT_FILE_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Filen kunde inte skapas.',
    message_en: 'The payout file could not be created.',
  },
  ROT_RUT_BESLUT_WRONG_COMPANY: {
    httpStatus: 400,
    message_sv:
      'Beslutsfilens utförare matchar inte företagets organisationsnummer. Kontrollera att filen laddades ner för rätt företag.',
    message_en:
      "The decision file's utförare does not match the company's organisation number. Check that the file was downloaded for the right company.",
  },
  INVOICE_CREATE_INSERT_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturan kunde inte sparas.',
    message_en: 'Invoice insert failed.',
  },
  INVOICE_CREATE_ITEMS_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturaraderna kunde inte sparas.',
    message_en: 'Invoice items insert failed.',
  },
  INVOICE_CREATE_NUMBER_ASSIGN_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte tilldela fakturanummer vid skapande.',
    message_en: 'Failed to assign invoice number on create.',
  },
  INVOICE_CREDIT_ORIGINAL_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Ursprungsfakturan kunde inte hittas.',
    message_en: 'Original invoice not found.',
  },
  INVOICE_CREDIT_NOT_INVOICE: {
    httpStatus: 400,
    message_sv: 'Kreditfakturor kan endast skapas från riktiga fakturor.',
    message_en: 'Credit notes can only be created from standard invoices.',
  },
  INVOICE_CREDIT_ALREADY_CREDITED: {
    httpStatus: 400,
    message_sv: 'Fakturan har redan krediterats.',
    message_en: 'Invoice has already been credited.',
  },
  INVOICE_CREDIT_NOT_SENT: {
    httpStatus: 400,
    message_sv: 'Endast skickade, betalda eller förfallna fakturor kan krediteras.',
    message_en: 'Only sent, paid, or overdue invoices can be credited.',
  },
  INVOICE_SEND_EMAIL_NOT_CONFIGURED: {
    httpStatus: 503,
    message_sv:
      'E-posttjänsten är inte konfigurerad. Kontrollera att RESEND_API_KEY och RESEND_FROM_EMAIL är satta.',
    message_en: 'Email service is not configured.',
    remediation: {
      description: 'Set RESEND_API_KEY and RESEND_FROM_EMAIL in the deployment environment.',
    },
  },
  INVOICE_SEND_NO_CUSTOMER_EMAIL: {
    httpStatus: 400,
    message_sv: 'Kunden saknar e-postadress. Uppdatera kunduppgifterna först.',
    message_en: 'Customer has no email address.',
    remediation: { description: 'Add an email address on the customer record before sending.' },
  },
  INVOICE_SEND_COMPANY_SETTINGS_MISSING: {
    httpStatus: 404,
    message_sv: 'Företagsinställningar saknas.',
    message_en: 'Company settings are missing.',
  },
  INVOICE_SEND_NUMBER_ASSIGN_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte tilldela fakturanummer.',
    message_en: 'Failed to assign invoice number on send.',
  },
  INVOICE_SEND_PROVIDER_FAILED: {
    httpStatus: 502,
    message_sv: 'E-postleverantören kunde inte skicka meddelandet.',
    message_en: 'The email provider could not deliver the message.',
  },
  INVOICE_SEND_PDF_RENDER_FAILED: {
    httpStatus: 500,
    message_sv:
      'Fakturans PDF kunde inte skapas. Kontrollera fakturarader och kunduppgifter och försök igen.',
    message_en: 'Failed to render invoice PDF before send; no invoice number was consumed.',
  },
  INVOICE_PDF_RENDER_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturans PDF kunde inte skapas.',
    message_en: 'Invoice PDF rendering failed.',
  },
  INVOICE_SEND_PARTIAL: {
    httpStatus: 200,
    message_sv:
      'Fakturan skickades men en efterföljande åtgärd misslyckades (verifikation eller PDF-bilaga).',
    message_en: 'Invoice was sent but a follow-up step (journal entry or PDF) failed.',
  },
  INVOICE_SEND_CANCELLED: {
    httpStatus: 400,
    message_sv: 'Makulerade fakturor kan inte skickas. Skapa en ny faktura istället.',
    message_en: 'Cancelled invoices cannot be sent; create a new invoice instead.',
  },
  INVOICE_PAID_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Fakturan kunde inte hittas.',
    message_en: 'Invoice not found.',
  },
  INVOICE_PAID_NOT_PAYABLE: {
    httpStatus: 400,
    message_sv: 'Fakturan kan inte markeras som betald i nuvarande status.',
    message_en: 'Invoice is not in a payable status.',
  },
  INVOICE_PAID_LINES_UNBALANCED: {
    httpStatus: 400,
    message_sv: 'Verifikationsraderna är inte balanserade (debet ≠ kredit).',
    message_en: 'Custom journal lines do not balance.',
  },
  INVOICE_PAID_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv: 'Ingen öppen räkenskapsperiod för betalningsdatumet.',
    message_en: 'No open fiscal period covers the payment date.',
  },
  INVOICE_PAID_RACE: {
    httpStatus: 409,
    message_sv: 'Fakturan har redan betalats av en annan förfrågan.',
    message_en: 'Invoice was already paid by another request.',
  },
  INVOICE_PAID_BOOK_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte bokföra betalningen.',
    message_en: 'Failed to create payment journal entry.',
  },
  INVOICE_PAID_LIKELY_DUPLICATE: {
    httpStatus: 409,
    message_sv:
      'Det finns redan en obokförd inkommande banktransaktion som kan vara denna betalning. Länka den istället, eller markera som betald ändå om du är säker.',
    message_en:
      'A likely-matching unlinked inbound bank transaction was found for this customer. Suggest linking it instead of creating a new payment entry.',
    remediation: {
      description:
        'Match the candidate transaction via POST /api/transactions/{id}/match-invoice, or resend mark-paid with force: true to create the payment entry anyway. When using the v1 endpoint, the force retry requires a fresh Idempotency-Key (the original key is bound to the body hash).',
    },
  },
  INVOICE_DELETE_NOT_DRAFT: {
    httpStatus: 400,
    message_sv: 'Endast utkast kan tas bort. Bokförda fakturor måste krediteras istället.',
    message_en: 'Only draft invoices can be deleted; non-drafts must be credited.',
    remediation: {
      description: 'Issue a credit note instead of deleting a posted invoice.',
    },
  },
  INVOICE_UPDATE_NOT_DRAFT: {
    httpStatus: 409,
    message_sv: 'Endast utkast kan ändras. Bokförda fakturor är oföränderliga: utfärda en kreditfaktura istället.',
    message_en: 'Only draft invoices can be updated. Issued invoices are immutable: issue a credit note instead.',
    remediation: {
      description: 'Issue a credit note via POST /invoices/{id}:credit and create a fresh invoice with the corrected details.',
    },
  },
  INVOICE_CANCEL_RACE: {
    httpStatus: 409,
    message_sv: 'Fakturan ändrades samtidigt och kunde inte makuleras. Ladda om och försök igen.',
    message_en: 'Invoice was modified concurrently and could not be cancelled. Reload and retry.',
  },
  INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Fakturan kunde inte hittas.',
    message_en: 'Invoice not found.',
  },
  INVOICE_FINALIZE_NOT_DRAFT: {
    httpStatus: 409,
    message_sv: 'Endast onumrerade utkast kan skapas. Fakturan har redan ett nummer eller är inte ett utkast.',
    message_en: 'Only unnumbered drafts can be finalized; this invoice already has a number or is not a draft.',
  },
  INVOICE_FINALIZE_INCOMPLETE: {
    httpStatus: 500,
    message_sv: 'Fakturanumret tilldelades men fakturan kunde inte läsas tillbaka. Ladda om sidan och kontrollera fakturan.',
    message_en: 'The invoice number was assigned but the invoice could not be re-read. Reload the page and verify the invoice.',
  },
  // Quotes / Offerter
  QUOTE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Offerten kunde inte hittas.',
    message_en: 'Quote not found.',
  },
  QUOTE_INVALID_STATE: {
    httpStatus: 400,
    message_sv: 'Offerten är inte i en status som tillåter denna åtgärd.',
    message_en: 'Quote is not in a state that allows this action.',
  },
  QUOTE_TOKEN_INVALID: {
    httpStatus: 404,
    message_sv: 'Länken är ogiltig eller har gått ut.',
    message_en: 'The link is invalid or has expired.',
  },
  QUOTE_NUMBER_ASSIGN_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte tilldela offertnummer.',
    message_en: 'Failed to assign quote number.',
  },
  QUOTE_CONVERSION_FAILED: {
    httpStatus: 500,
    message_sv: 'Offerten kunde inte konverteras till faktura.',
    message_en: 'Failed to convert quote to invoice.',
  },
  QUOTE_NOT_QUOTE: {
    httpStatus: 400,
    message_sv: 'Detta dokument är inte en offert.',
    message_en: 'This document is not a quote.',
  },
}

const SUPPLIER_INVOICE: Record<string, StructuredErrorEntry> = {
  SI_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Leverantörsfakturan kunde inte hittas.',
    message_en: 'Supplier invoice not found.',
  },
  SI_APPROVE_NOT_REGISTERED: {
    httpStatus: 400,
    message_sv: 'Endast registrerade fakturor kan godkännas.',
    message_en: 'Only invoices in registered status can be approved.',
  },
  SI_APPROVE_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte godkänna leverantörsfakturan.',
    message_en: 'Failed to update supplier invoice status to approved.',
  },
  PO_THREE_WAY_MATCH_FAILED: {
    httpStatus: 422,
    message_sv:
      'Trevägs-matchning misslyckades: leverantörsfakturan stämmer inte med inköpsordern eller godsmottagningen.',
    message_en:
      'Three-way match failed: the supplier invoice does not reconcile with the purchase order / goods receipt.',
  },
  PO_LINK_REQUIRED: {
    httpStatus: 422,
    message_sv:
      'Inställningarna kräver att varje leverantörsfaktura kopplas till en inköpsorder.',
    message_en:
      'Company settings require every supplier invoice to be linked to a purchase order.',
  },
  PO_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Inköpsordern kunde inte hittas.',
    message_en: 'Purchase order not found.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Wave 2: periods, year-end, reports
// ─────────────────────────────────────────────────────────────────

const PERIOD: Record<string, StructuredErrorEntry> = {
  PERIOD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsperioden kunde inte hittas.',
    message_en: 'Fiscal period not found.',
  },
  PERIOD_LOCK_FAILED: {
    httpStatus: 400,
    message_sv: 'Perioden kunde inte låsas.',
    message_en: 'Failed to lock period.',
  },
  PERIOD_LOCK_HAS_DRAFTS: {
    httpStatus: 400,
    message_sv: 'Perioden innehåller verifikationsutkast som måste bokföras eller raderas innan låsning.',
    message_en: 'Period contains draft journal entries.',
  },
  PERIOD_LOCK_ALREADY_LOCKED: {
    httpStatus: 409,
    message_sv: 'Perioden är redan låst.',
    message_en: 'Period is already locked.',
  },
  PERIOD_UNLOCK_NOT_LOCKED: {
    httpStatus: 409,
    message_sv: 'Perioden är inte låst.',
    message_en: 'Period is not locked.',
  },
  PERIOD_UNLOCK_CLOSED: {
    httpStatus: 409,
    message_sv: 'Ett stängt räkenskapsår kan inte låsas upp.',
    message_en: 'A closed fiscal year cannot be unlocked.',
  },
  // Forward-chaining a new räkenskapsår is blocked while a prior period is
  // still fully open (not locked, not closed, not covered by the company-wide
  // lock-through date). BFL 6 kap allows löpande bokföring of the new year in
  // parallel with bokslut, but the prior year must at least be locked so
  // nothing is back-posted into a year you've moved on from. The blocking
  // periods (id + name + dates) are attached to the response `details` so the
  // UI can offer to lock them inline. See app/api/bookkeeping/fiscal-periods.
  PERIOD_CREATE_BLOCKED_BY_OPEN_PERIODS: {
    httpStatus: 409,
    message_sv:
      'Du måste låsa föregående räkenskapsår innan du kan skapa ett nytt.',
    message_en:
      'Cannot create a new fiscal year while a prior period is still open; lock it first.',
  },
}

const YEAR_END: Record<string, StructuredErrorEntry> = {
  YEAR_END_PREVIEW_FAILED: {
    httpStatus: 400,
    message_sv: 'Bokslutsförhandsgranskningen misslyckades.',
    message_en: 'Failed to preview year-end closing.',
  },
  YEAR_END_FAILED: {
    httpStatus: 400,
    message_sv: 'Bokslutet kunde inte verkställas.',
    message_en: 'Failed to execute year-end closing.',
  },
  YEAR_END_PRIOR_PERIOD_OPEN: {
    httpStatus: 400,
    message_sv: 'En tidigare period är fortfarande öppen. Stäng den först.',
    message_en: 'A prior fiscal period is still open.',
  },
  YEAR_END_UNBALANCED_TRIAL: {
    httpStatus: 400,
    message_sv: 'Resultaträkningens debet och kredit balanserar inte. Granska verifikationerna innan bokslut.',
    message_en: 'Trial balance does not balance.',
  },
  YEAR_END_NEXT_PERIOD_HAS_IB: {
    httpStatus: 400,
    message_sv: 'Nästa räkenskapsperiod har redan ingående balanser bokförda. Storno dem innan du kör om bokslutet.',
    message_en: 'Next fiscal period already has opening balances posted; reverse them before re-running year-end.',
  },
}

const OPENING_BAL: Record<string, StructuredErrorEntry> = {
  OPENING_BAL_PERIOD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsperioden kunde inte hittas.',
    message_en: 'Fiscal period not found.',
  },
}

const FX: Record<string, StructuredErrorEntry> = {
  FX_PERIOD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsperioden kunde inte hittas.',
    message_en: 'Fiscal period not found.',
  },
  FX_PERIOD_CLOSED: {
    httpStatus: 400,
    message_sv: 'Perioden är redan stängd. Valutaomvärdering kan inte köras.',
    message_en: 'Period is already closed; currency revaluation cannot be run.',
  },
  FX_FAILED: {
    httpStatus: 400,
    message_sv: 'Valutaomvärderingen misslyckades.',
    message_en: 'Currency revaluation failed.',
  },
}

const REPORT: Record<string, StructuredErrorEntry> = {
  REPORT_PERIOD_REQUIRED: {
    httpStatus: 400,
    message_sv: 'period_id krävs.',
    message_en: 'period_id query parameter is required.',
  },
  REPORT_GENERATION_FAILED: {
    httpStatus: 500,
    message_sv: 'Rapporten kunde inte genereras.',
    message_en: 'Failed to generate the report.',
  },
}

const VAT_REPORT: Record<string, StructuredErrorEntry> = {
  VAT_REPORT_MISSING_PARAMS: {
    httpStatus: 400,
    message_sv: 'periodType, year och period krävs.',
    message_en: 'periodType, year and period query parameters are required.',
  },
  VAT_REPORT_INVALID_PERIOD_TYPE: {
    httpStatus: 400,
    message_sv: 'periodType måste vara monthly, quarterly eller yearly.',
    message_en: 'periodType must be one of monthly, quarterly, yearly.',
  },
  VAT_REPORT_INVALID_YEAR: {
    httpStatus: 400,
    message_sv: 'year måste vara ett giltigt årtal mellan 2000 och 2100.',
    message_en: 'year must be a number between 2000 and 2100.',
  },
  VAT_REPORT_INVALID_PERIOD: {
    httpStatus: 400,
    message_sv: 'period är ogiltig för vald periodtyp.',
    message_en: 'period is invalid for the chosen period type.',
  },
  VAT_REPORT_GENERATION_FAILED: {
    httpStatus: 500,
    message_sv: 'Momsdeklarationen kunde inte beräknas.',
    message_en: 'Failed to calculate VAT declaration.',
  },
}

const PS_REPORT: Record<string, StructuredErrorEntry> = {
  PS_REPORT_MISSING_PARAMS: {
    httpStatus: 400,
    message_sv: 'periodType, year och period krävs.',
    message_en: 'periodType, year and period query parameters are required.',
  },
  PS_REPORT_INVALID_PERIOD_TYPE: {
    httpStatus: 400,
    message_sv: 'periodType måste vara monthly eller quarterly.',
    message_en: 'periodType must be monthly or quarterly.',
  },
  PS_REPORT_INVALID_YEAR: {
    httpStatus: 400,
    message_sv: 'year måste vara ett giltigt årtal mellan 2000 och 2100.',
    message_en: 'year must be a number between 2000 and 2100.',
  },
  PS_REPORT_INVALID_PERIOD: {
    httpStatus: 400,
    message_sv: 'period är ogiltig för vald periodtyp.',
    message_en: 'period is invalid for the chosen period type.',
  },
  PS_REPORT_GENERATION_FAILED: {
    httpStatus: 500,
    message_sv: 'Periodisk sammanställning kunde inte beräknas.',
    message_en: 'Failed to generate periodisk sammanställning.',
  },
  PS_REPORT_CSV_BLOCKED_BY_ERRORS: {
    httpStatus: 400,
    message_sv: 'CSV kan inte laddas ner. Åtgärda blockerande fel först.',
    message_en: 'CSV download blocked by validation errors. Fix them first.',
  },
  PS_REPORT_MISSING_FILER_INFO: {
    httpStatus: 400,
    message_sv: 'Kontaktuppgifter saknas. Fyll i namn, telefon och e-post under Inställningar.',
    message_en: 'Tax contact information is missing on company_settings.',
  },
}

const SIE_EXPORT: Record<string, StructuredErrorEntry> = {
  SIE_EXPORT_COMPANY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Företagsinställningar saknas: SIE-exporten kan inte skapas.',
    message_en: 'Company settings missing; SIE export cannot be generated.',
  },
  SIE_EXPORT_FAILED: {
    httpStatus: 500,
    message_sv: 'SIE-exporten misslyckades.',
    message_en: 'Failed to generate SIE export.',
  },
}

const TAX_DECL: Record<string, StructuredErrorEntry> = {
  TAX_DECL_GENERATION_FAILED: {
    httpStatus: 500,
    message_sv: 'Skattedeklarationen kunde inte genereras.',
    message_en: 'Failed to generate tax declaration.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Wave 3: imports (SIE, bank-file, opening-balance)
// ─────────────────────────────────────────────────────────────────

const SIE_IMPORT: Record<string, StructuredErrorEntry> = {
  SIE_PARSE_NO_FILE: {
    httpStatus: 400,
    message_sv: 'Ingen fil bifogad i förfrågan.',
    message_en: 'No file attached to the request.',
  },
  SIE_PARSE_INVALID_TYPE: {
    httpStatus: 400,
    message_sv: 'Filtypen stöds inte. Ladda upp en fil med ändelsen .sie eller .se.',
    message_en: 'Unsupported file type; upload a .sie or .se file.',
  },
  SIE_PARSE_FILE_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Filen är för stor. Maxstorlek är 50 MB.',
    message_en: 'File exceeds the 50 MB size limit.',
  },
  SIE_PARSE_EMPTY: {
    httpStatus: 400,
    message_sv: 'Filen är tom (0 bytes). Kontrollera exporten från bokföringsprogrammet.',
    message_en: 'File is empty.',
  },
  SIE_PARSE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte tolka SIE-filen. Filen kan vara skadad eller i ett format som inte stöds.',
    message_en: 'Failed to parse the SIE file.',
  },
  SIE_PARSE_VALIDATION_FAILED: {
    httpStatus: 400,
    message_sv: 'SIE-filen innehåller valideringsfel som måste åtgärdas innan import.',
    message_en: 'SIE file failed validation.',
  },
  SIE_DUPLICATE_FILE: {
    httpStatus: 409,
    message_sv: 'Den här filen har redan importerats.',
    message_en: 'File has already been imported.',
  },
  SIE_DUPLICATE_PERIOD: {
    httpStatus: 409,
    message_sv: 'En SIE-import för ett överlappande räkenskapsår finns redan.',
    message_en: 'An SIE import for an overlapping fiscal period already exists.',
  },
  SIE_IMPORT_UNMAPPED_ACCOUNTS: {
    httpStatus: 400,
    message_sv: 'Vissa konton saknar mappning. Gå tillbaka till kontomappningssteget och koppla alla konton.',
    message_en: 'One or more accounts have no mapping target.',
    remediation: { description: 'Map every source account to a BAS account before importing.' },
  },
  SIE_IMPORT_ACCOUNT_ACTIVATION_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte aktivera konton i kontoplanen. Kontrollera att kontona inte redan finns med andra inställningar.',
    message_en: 'Failed to activate mapped accounts in the chart of accounts.',
  },
  SIE_IMPORT_FAILED: {
    httpStatus: 400,
    message_sv: 'Importen slutfördes med fel. Se detaljerna nedan.',
    message_en: 'SIE import completed with errors.',
  },
  SIE_IMPORT_UNEXPECTED: {
    httpStatus: 500,
    message_sv: 'Importen avbröts oväntat. Ingen data har sparats.',
    message_en: 'Unexpected error during SIE import; no data was committed.',
  },
  SIE_REPLACE_FAILED: {
    httpStatus: 400,
    message_sv: 'SIE-importen kunde inte ersättas.',
    message_en: 'Failed to replace SIE import.',
  },
  SIE_UNDO_FAILED: {
    httpStatus: 400,
    message_sv: 'SIE-importen kunde inte ångras.',
    message_en: 'Failed to undo SIE import.',
  },
}

const BANK_FILE: Record<string, StructuredErrorEntry> = {
  BANK_FILE_NO_FILE: {
    httpStatus: 400,
    message_sv: 'Ingen fil bifogad i förfrågan.',
    message_en: 'No file attached to the request.',
  },
  BANK_FILE_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Filen är för stor. Maxstorlek är 10 MB.',
    message_en: 'File exceeds the 10 MB size limit.',
  },
  BANK_FILE_DUPLICATE: {
    httpStatus: 409,
    message_sv: 'Den här filen har redan importerats.',
    message_en: 'Bank file has already been imported.',
  },
  BANK_FILE_PARSE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte tolka bankfilen.',
    message_en: 'Failed to parse the bank file.',
  },
  BANK_FILE_NO_TRANSACTIONS: {
    httpStatus: 400,
    message_sv: 'Bankfilen innehåller inga transaktioner att importera.',
    message_en: 'No transactions to import.',
  },
  BANK_FILE_IMPORT_RECORD_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte skapa importpost.',
    message_en: 'Failed to create the bank file import record.',
  },
  BANK_FILE_EXECUTE_FAILED: {
    httpStatus: 500,
    message_sv: 'Bankfilsimporten misslyckades.',
    message_en: 'Bank file import failed.',
  },
}

const OPENING_BALANCE_IMPORT: Record<string, StructuredErrorEntry> = {
  OB_NO_FILE: {
    httpStatus: 400,
    message_sv: 'Ingen fil bifogad.',
    message_en: 'No file attached.',
  },
  OB_FILE_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Filen är för stor. Maxstorlek är 10 MB.',
    message_en: 'File exceeds the 10 MB size limit.',
  },
  OB_INVALID_FORMAT: {
    httpStatus: 400,
    message_sv: 'Filformatet stöds inte. Tillåtna format: .xlsx, .xls, .csv, .ods.',
    message_en: 'Unsupported file format.',
  },
  OB_INVALID_COLUMN_OVERRIDES: {
    httpStatus: 400,
    message_sv: 'Ogiltig kolumnmappning.',
    message_en: 'Invalid column overrides JSON.',
  },
  OB_PARSE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte tolka filen.',
    message_en: 'Failed to parse the opening balance file.',
  },
  OB_PERIOD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsperioden hittades inte.',
    message_en: 'Fiscal period not found.',
  },
  OB_PERIOD_CLOSED: {
    httpStatus: 400,
    message_sv: 'Räkenskapsperioden är stängd.',
    message_en: 'Fiscal period is closed.',
  },
  OB_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv: 'Räkenskapsperioden är låst.',
    message_en: 'Fiscal period is locked.',
  },
  OB_COMPANY_LOCK_DATE: {
    httpStatus: 409,
    message_sv:
      'Bokföringen är låst t.o.m. ett låsdatum som täcker periodens start — ingående balanser kan inte korrigeras. Ta bort eller flytta låsdatumet under Inställningar → Bokföring och försök igen.',
    message_en:
      'The company-wide bookkeeping lock date covers the period start — opening balances cannot be corrected. Remove or move the lock date under Settings → Bookkeeping and try again.',
    remediation: {
      description:
        'Clear or move the bookkeeping lock date (company_settings.bookkeeping_locked_through) to a date before the period start, then retry the correction.',
    },
  },
  OB_PERIOD_ALREADY_HAS_BALANCES: {
    httpStatus: 409,
    message_sv: 'Räkenskapsperioden har redan ingående balanser.',
    message_en: 'Fiscal period already has opening balances set.',
  },
  OB_TOO_FEW_LINES: {
    httpStatus: 400,
    message_sv: 'Minst två rader med belopp krävs.',
    message_en: 'At least two lines with amounts are required.',
  },
  OB_PNL_ACCOUNT: {
    httpStatus: 400,
    message_sv: 'Resultatkonton (klass 3-8) kan inte användas i ingående balanser.',
    message_en: 'Profit & loss accounts (class 3-8) are not allowed in opening balances.',
  },
  OB_UNBALANCED: {
    httpStatus: 400,
    message_sv: 'Debet och kredit balanserar inte.',
    message_en: 'Opening balance debits and credits do not match.',
  },
  OB_ACCOUNT_ACTIVATION_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte aktivera konton i kontoplanen.',
    message_en: 'Failed to activate accounts in the chart of accounts.',
  },
  OB_EXECUTE_FAILED: {
    httpStatus: 500,
    message_sv: 'Importen misslyckades.',
    message_en: 'Opening balance import failed.',
  },
  OB_CORRECT_NO_EXISTING: {
    httpStatus: 409,
    message_sv: 'Perioden har inga ingående balanser att korrigera. Bokför dem först.',
    message_en: 'The period has no opening balances to correct. Book them first.',
  },
  OB_CORRECT_YEAR_END_EXISTS: {
    httpStatus: 409,
    message_sv:
      'Perioden har ett bokslut. Återför bokslutet och öppna perioden innan ingående balanser kan korrigeras.',
    message_en:
      'The period has a year-end close. Reverse the close and reopen the period before opening balances can be corrected.',
  },
  OB_CORRECT_FAILED: {
    httpStatus: 500,
    message_sv: 'Korrigeringen av ingående balanser misslyckades.',
    message_en: 'Opening balance correction failed.',
  },
}

const REGISTER_IMPORT: Record<string, StructuredErrorEntry> = {
  REG_IMPORT_NO_FILE: {
    httpStatus: 400,
    message_sv: 'Ingen fil bifogad.',
    message_en: 'No file attached.',
  },
  REG_IMPORT_FILE_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Filen är för stor. Maxstorlek är 10 MB.',
    message_en: 'File exceeds the 10 MB size limit.',
  },
  REG_IMPORT_INVALID_FORMAT: {
    httpStatus: 400,
    message_sv: 'Filformatet stöds inte. Tillåtna format: .xlsx, .xls, .csv, .ods.',
    message_en: 'Unsupported file format.',
  },
  REG_IMPORT_INVALID_COLUMN_OVERRIDES: {
    httpStatus: 400,
    message_sv: 'Ogiltig kolumnmappning.',
    message_en: 'Invalid column overrides JSON.',
  },
  REG_IMPORT_PARSE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte tolka filen.',
    message_en: 'Failed to parse the register file.',
  },
  REG_IMPORT_NO_ROWS: {
    httpStatus: 400,
    message_sv: 'Inga giltiga rader hittades i filen.',
    message_en: 'No valid rows found in the file.',
  },
  REG_IMPORT_EXECUTE_FAILED: {
    httpStatus: 500,
    message_sv: 'Importen misslyckades.',
    message_en: 'Register import failed.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Wave 3 tail: provider migration extension codes
// ─────────────────────────────────────────────────────────────────

const PROVIDER_MIGRATION: Record<string, StructuredErrorEntry> = {
  PROVIDER_INVALID: {
    httpStatus: 400,
    message_sv: 'Okänd leverantör.',
    message_en: 'Unknown provider.',
  },
  PROVIDER_CONSENT_NOT_READY: {
    httpStatus: 400,
    message_sv: 'Anslutningen är inte klar. Slutför inloggningen först.',
    message_en: 'Provider consent is not ready; finish authentication first.',
  },
  PROVIDER_CONSENT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Anslutningen kunde inte hittas.',
    message_en: 'Provider consent not found.',
  },
  PROVIDER_CONNECT_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte starta anslutningen till leverantören.',
    message_en: 'Failed to start provider connection flow.',
  },
  PROVIDER_TOKEN_REQUIRED: {
    httpStatus: 400,
    message_sv: 'API-token krävs för den här leverantören.',
    message_en: 'apiToken is required for this provider.',
  },
  PROVIDER_COMPANY_ID_REQUIRED: {
    httpStatus: 400,
    message_sv: 'companyId krävs för den här leverantören.',
    message_en: 'companyId is required for this provider.',
  },
  PROVIDER_TOKEN_SUBMIT_FAILED: {
    httpStatus: 500,
    message_sv: 'Tokensubmissionen misslyckades.',
    message_en: 'Failed to submit provider token.',
  },
  PROVIDER_TOKEN_INVALID: {
    // 422 (not 401): the UPSTREAM provider rejected the pasted credentials.
    // The caller's own session is fine: a 401 here can trip client-side auth
    // interceptors into logging the user out. Clients must dispatch on the
    // error code, never on the HTTP status.
    httpStatus: 422,
    message_sv:
      'Leverantören avvisade uppgifterna. Kontrollera att konto-ID och applikationstoken stämmer och försök igen.',
    message_en:
      'The provider rejected the credentials. Check that the account ID and application token are correct and try again.',
  },
  PROVIDER_PREVIEW_FAILED: {
    httpStatus: 500,
    message_sv: 'Förhandsgranskningen från leverantören misslyckades.',
    message_en: 'Provider preview failed.',
  },
  PROVIDER_SIE_FETCH_FAILED: {
    httpStatus: 502,
    message_sv: 'Kunde inte hämta SIE-data från leverantören.',
    message_en: 'Failed to fetch SIE data from the provider.',
  },
  PROVIDER_SIE_NO_YEARS: {
    // The supported window is rolling (current year and the two before it):
    // the route interpolates the actual range via the messageSv/messageEn
    // overrides on errorResponseFromCode(); this entry is the static fallback.
    httpStatus: 404,
    message_sv: 'Inga räkenskapsår inom det stödda intervallet hittades hos leverantören.',
    message_en: 'No fiscal years available within the supported range.',
  },
  PROVIDER_SIE_NOT_SUPPORTED: {
    httpStatus: 400,
    message_sv:
      'Den här leverantören stöder inte SIE-hämtning via API. Ladda upp en SIE-fil manuellt istället.',
    message_en:
      'This provider does not support fetching SIE via API. Upload a SIE file manually instead.',
  },
  PROVIDER_SIE_IMPORT_REQUIRED: {
    httpStatus: 409,
    message_sv:
      'Bokföringsdata (SIE) måste importeras först. Ladda upp en SIE-fil med kontoplan, ingående balanser och verifikationer innan du hämtar kunder, leverantörer och fakturor från den här leverantören.',
    message_en:
      'A completed SIE import is required first. Import the SIE file (chart of accounts, opening balances and verifications) before importing customers, suppliers and invoices from this provider.',
  },
  PROVIDER_MIGRATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Migrationen från leverantören misslyckades.',
    message_en: 'Provider migration failed.',
  },
  PROVIDER_IMPORT_DOCUMENTS_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte importera underlag från leverantören.',
    message_en: 'Failed to import documents from provider.',
  },
  PROVIDER_DISCONNECT_FAILED: {
    httpStatus: 500,
    message_sv: 'Frånkoppling från leverantören misslyckades.',
    message_en: 'Provider disconnect failed.',
  },
  PROVIDER_ACCEPT_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte slutföra anslutningen.',
    message_en: 'Failed to accept consent.',
  },
  PROVIDER_STATUS_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte hämta status från leverantören.',
    message_en: 'Failed to fetch provider status.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Wave 4: documents, masters, salary, company, API keys
// ─────────────────────────────────────────────────────────────────

const DOCUMENT: Record<string, StructuredErrorEntry> = {
  DOC_UPLOAD_NO_FILE: {
    httpStatus: 400,
    message_sv: 'Ingen fil bifogad.',
    message_en: 'No file attached.',
  },
  DOC_UPLOAD_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Filen är för stor.',
    message_en: 'Uploaded file exceeds the size limit.',
  },
  DOC_UPLOAD_UNSUPPORTED_TYPE: {
    httpStatus: 400,
    message_sv: 'Filtypen stöds inte.',
    message_en: 'Unsupported file type.',
  },
  DOC_UPLOAD_INVALID_CONTENT: {
    httpStatus: 400,
    message_sv: 'Filen kunde inte läsas som en giltig PDF eller bild. Kontrollera att filen inte är skadad.',
    message_en: 'The file could not be read as a valid PDF or image. Check that the file is not corrupted.',
  },
  DOC_UPLOAD_STORAGE_FAILED: {
    httpStatus: 500,
    message_sv: 'Filen kunde inte sparas.',
    message_en: 'Document storage failed.',
  },
  DOC_UPLOAD_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv: 'Det går inte att bifoga underlag till verifikationer i en låst eller stängd period.',
    message_en: 'Cannot attach documents to entries in a locked or closed fiscal period.',
  },
  DOC_DOWNLOAD_FAILED: {
    httpStatus: 500,
    message_sv: 'Det gick inte att skapa nedladdningslänken.',
    message_en: 'Failed to create signed download URL.',
  },
  DOC_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Dokumentet kunde inte hittas.',
    message_en: 'Document not found.',
  },
  DOC_LINK_ENTRY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikationen kunde inte hittas.',
    message_en: 'Journal entry not found.',
  },
  DOC_LINK_ALREADY_LINKED: {
    httpStatus: 409,
    message_sv: 'Dokumentet är redan kopplat till en verifikation.',
    message_en: 'Document is already linked to a journal entry.',
  },
  DOC_LINK_FAILED: {
    httpStatus: 500,
    message_sv: 'Kopplingen misslyckades.',
    message_en: 'Failed to link document to journal entry.',
  },
}

const CUSTOMER: Record<string, StructuredErrorEntry> = {
  CUSTOMER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kunden kunde inte hittas.',
    message_en: 'Customer not found.',
  },
  CUSTOMER_DUPLICATE_ORG_NUMBER: {
    httpStatus: 409,
    message_sv: 'En kund med samma organisationsnummer finns redan.',
    message_en: 'A customer with that organisation number already exists.',
  },
  CUSTOMER_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunden kunde inte skapas.',
    message_en: 'Failed to create customer.',
  },
  CUSTOMER_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunden kunde inte uppdateras.',
    message_en: 'Failed to update customer.',
  },
  CUSTOMER_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunden kunde inte tas bort.',
    message_en: 'Failed to delete customer.',
  },
  CUSTOMER_HAS_INVOICES: {
    httpStatus: 409,
    message_sv: 'Kunden har fakturor och kan inte tas bort.',
    message_en: 'Customer cannot be deleted while invoices reference it.',
  },
}

const ARTICLE: Record<string, StructuredErrorEntry> = {
  ARTICLE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Artikeln kunde inte hittas.',
    message_en: 'Article not found.',
  },
  ARTICLE_DUPLICATE_NUMBER: {
    httpStatus: 409,
    message_sv: 'En artikel med samma artikelnummer finns redan.',
    message_en: 'An article with that article number already exists.',
  },
  ARTICLE_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Artikeln kunde inte skapas.',
    message_en: 'Failed to create article.',
  },
  ARTICLE_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Artikeln kunde inte uppdateras.',
    message_en: 'Failed to update article.',
  },
  ARTICLE_REVENUE_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Försäljningskontot finns inte eller är inte ett aktivt intäktskonto (klass 3).',
    message_en: 'The revenue account does not exist or is not an active class-3 income account.',
  },
}

const SUPPLIER: Record<string, StructuredErrorEntry> = {
  SUPPLIER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Leverantören kunde inte hittas.',
    message_en: 'Supplier not found.',
  },
  SUPPLIER_DUPLICATE_ORG_NUMBER: {
    httpStatus: 409,
    message_sv: 'En leverantör med samma organisationsnummer finns redan.',
    message_en: 'A supplier with that organisation number already exists.',
  },
  SUPPLIER_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Leverantören kunde inte skapas.',
    message_en: 'Failed to create supplier.',
  },
  SUPPLIER_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Leverantören kunde inte uppdateras.',
    message_en: 'Failed to update supplier.',
  },
  SUPPLIER_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Leverantören kunde inte tas bort.',
    message_en: 'Failed to delete supplier.',
  },
  // v1 archive refusal: leverantörsfakturor pointing at this supplier still
  // need its name/address for BFL 7 kap audit. Issue credit notes first.
  SUPPLIER_HAS_INVOICES: {
    httpStatus: 409,
    message_sv:
      'Leverantören kan inte arkiveras eftersom det finns öppna leverantörsfakturor som refererar till den.',
    message_en:
      'Supplier cannot be archived while open supplier invoices reference it.',
    remediation: {
      description:
        'Close (credit / mark paid) every open supplier invoice before archiving the supplier. The dashboard exposes the same blocker.',
    },
  },
  // v1 strict-mode: update / delete only allowed on `registered` SIs (the
  // SI analogue of `draft`). Mirrors the dashboard internal route.
  SI_NOT_DRAFT: {
    httpStatus: 400,
    message_sv:
      'Leverantörsfakturan är inte längre i status "registrerad" och kan därför inte uppdateras eller tas bort.',
    message_en:
      'Supplier invoice is not in `registered` status and cannot be updated or deleted.',
  },
}

const SUPPLIER_INVOICE_WAVE4: Record<string, StructuredErrorEntry> = {
  SI_CREATE_DUPLICATE_INVOICE_NUMBER: {
    httpStatus: 409,
    message_sv: 'En leverantörsfaktura med samma nummer finns redan.',
    message_en: 'A supplier invoice with that number already exists.',
  },
  SI_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Leverantörsfakturan kunde inte skapas.',
    message_en: 'Failed to create supplier invoice.',
  },
  SI_CREATE_INVALID_INPUT: {
    httpStatus: 400,
    message_sv: 'Ogiltig kombination av fakturafält. Kontrollera formuläret och försök igen.',
    message_en: 'Invalid combination of supplier invoice fields.',
  },
  SI_CREATE_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv:
      'Det finns inget räkenskapsår som täcker fakturadatumet. Lägg upp räkenskapsåret först, eller ändra fakturadatumet.',
    message_en:
      'No fiscal year covers the invoice date. Create the fiscal year first, or change the invoice date.',
  },
  SI_CREATE_ACCRUAL_REVERSE_CHARGE: {
    httpStatus: 400,
    message_sv:
      'Periodisering kan inte kombineras med omvänd skattskyldighet. Kostnadsraden utgör momsunderlaget i momsdeklarationen (ruta 20-32), så nettobeloppet kan inte skjutas upp till ett interimskonto.',
    message_en:
      'Periodisering cannot be combined with reverse charge. The expense line carries the VAT base for the VAT declaration (boxes 20-32), so the net amount cannot be deferred to an interim account.',
  },
  SI_DELETE_HAS_BOOKING: {
    httpStatus: 400,
    message_sv:
      'Leverantörsfakturan är bokförd eller har en periodisering och kan inte tas bort. Skapa en kreditfaktura i stället för att återställa bokföringen.',
    message_en:
      'The supplier invoice has a posted journal entry or an accrual schedule and cannot be deleted. Create a credit note instead to reverse the bookkeeping.',
  },
  SI_PAID_ALREADY: {
    httpStatus: 409,
    message_sv: 'Leverantörsfakturan är redan betald eller krediterad.',
    message_en: 'Supplier invoice is already paid or credited.',
  },
  SI_PAID_NOT_PAYABLE: {
    httpStatus: 400,
    message_sv: 'Leverantörsfakturan kan inte markeras som betald i nuvarande status.',
    message_en: 'Supplier invoice is not in a payable state.',
  },
  SI_PAID_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv: 'Bokföringen är låst. Betalningen kan inte registreras.',
    message_en: 'Bookkeeping is locked; payment cannot be recorded.',
  },
  SI_PAID_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte registrera betalningen.',
    message_en: 'Failed to record supplier invoice payment.',
  },
  SI_PAID_LIKELY_DUPLICATE: {
    httpStatus: 409,
    message_sv:
      'Det finns redan en obokförd banktransaktion som kan vara denna betalning. Länka den istället, eller markera som betald ändå om du är säker.',
    message_en:
      'A likely-matching unlinked bank transaction was found for this supplier. Suggest linking it instead of creating a new payment entry.',
    remediation: {
      description:
        'Match the candidate transaction via POST /api/transactions/{id}/match-supplier-invoice, or resend mark-paid with force: true to create the payment entry anyway.',
    },
  },
  SI_CREDIT_ALREADY_CREDITED: {
    httpStatus: 409,
    message_sv: 'Leverantörsfakturan har redan krediterats.',
    message_en: 'Supplier invoice has already been credited.',
  },
  SI_CREDIT_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv: 'Bokföringen är låst. Krediteringen kan inte skapas.',
    message_en: 'Bookkeeping is locked; credit note cannot be created.',
  },
  SI_CREDIT_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte kreditera leverantörsfakturan.',
    message_en: 'Failed to credit supplier invoice.',
  },
}

const SALARY: Record<string, StructuredErrorEntry> = {
  SALARY_RUN_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Lönekörningen kunde inte hittas.',
    message_en: 'Salary run not found.',
  },
  SALARY_RUN_NO_EMPLOYEES: {
    httpStatus: 400,
    message_sv: 'Inga aktiva anställda finns i företaget.',
    message_en: 'No active employees in the company.',
  },
  SALARY_RUN_TAX_TABLE_MISSING: {
    httpStatus: 400,
    message_sv: 'Skattetabellen saknas för perioden. Importera skattetabellen först.',
    message_en: 'Tax table is missing for the period.',
  },
  SALARY_RUN_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv: 'Lönekörningen kan inte göras i en låst period.',
    message_en: 'Salary run cannot be processed in a locked period.',
  },
  SALARY_RUN_NOT_CALCULATED: {
    httpStatus: 400,
    message_sv: 'Lönekörningen måste beräknas innan bokföring.',
    message_en: 'Salary run must be calculated before booking.',
  },
  SALARY_RUN_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Lönekörningen kunde inte skapas.',
    message_en: 'Failed to create salary run.',
  },
  SALARY_RUN_CALCULATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Lönekörningen kunde inte beräknas.',
    message_en: 'Failed to calculate salary run.',
  },
  SALARY_RUN_BOOK_FAILED: {
    httpStatus: 500,
    message_sv: 'Lönekörningen kunde inte bokföras.',
    message_en: 'Failed to book salary run.',
  },
  AGI_NO_SALARY_RUN: {
    httpStatus: 400,
    message_sv: 'Det finns ingen lönekörning för perioden.',
    message_en: 'No salary run exists for the period.',
  },
  AGI_FSKATT_VERIFICATION_FAILED: {
    httpStatus: 400,
    message_sv: 'F-skattekontrollen misslyckades. Kontrollera leverantörens F-skatt.',
    message_en: 'F-skatt verification failed.',
  },
  AGI_GENERATION_FAILED: {
    httpStatus: 500,
    message_sv: 'AGI-deklarationen kunde inte genereras.',
    message_en: 'Failed to generate AGI declaration.',
  },
  // Phase 5 PR-1: v1 REST surface error codes.
  EMPLOYEE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Den anställda kunde inte hittas.',
    message_en: 'Employee not found.',
  },
  EMPLOYEE_DUPLICATE_PERSONNUMMER: {
    httpStatus: 409,
    message_sv: 'En anställd med samma personnummer finns redan.',
    message_en: 'An employee with that personnummer already exists.',
  },
  SALARY_RUN_DUPLICATE_PERIOD: {
    httpStatus: 409,
    message_sv: 'En lönekörning för perioden finns redan.',
    message_en: 'A salary run for that period already exists.',
  },
  SALARY_RUN_PATCH_NOT_DRAFT: {
    httpStatus: 400,
    message_sv: 'Endast utkast (draft) kan uppdateras.',
    message_en: 'Only draft salary runs can be patched.',
  },
  SALARY_RUN_DELETE_NOT_DRAFT: {
    httpStatus: 400,
    message_sv: 'Endast utkast (draft) kan raderas.',
    message_en: 'Only draft salary runs can be deleted.',
  },
  SALARY_RUN_CALCULATE_NOT_DRAFT: {
    httpStatus: 400,
    message_sv: 'Lönekörningen måste vara i status draft för beräkning.',
    message_en: 'Salary run must be in draft status to calculate.',
  },
  SALARY_RUN_APPROVE_NOT_REVIEW: {
    httpStatus: 400,
    message_sv: 'Lönekörningen måste vara i status review för godkännande.',
    message_en: 'Salary run must be in review status to approve.',
  },
  SALARY_RUN_APPROVE_VALIDATION_FAILED: {
    httpStatus: 400,
    message_sv: 'Valideringsfel: korrigera innan godkännande.',
    message_en: 'Validation failed: fix issues before approving.',
  },
  SALARY_RUN_MARK_PAID_NOT_APPROVED: {
    httpStatus: 400,
    message_sv: 'Lönekörningen måste vara godkänd för att markeras som betald.',
    message_en: 'Salary run must be approved before it can be marked paid.',
  },
  SALARY_RUN_BOOK_NOT_PAID: {
    httpStatus: 400,
    message_sv: 'Lönekörningen måste vara markerad som betald för bokföring.',
    message_en: 'Salary run must be marked paid before booking.',
  },
  SALARY_PAYSLIPS_SEND_INVALID_STATUS: {
    httpStatus: 400,
    message_sv: 'Lönespecifikationer kan bara skickas efter godkännande.',
    message_en: 'Payslips can only be sent after the salary run is approved.',
  },
  SALARY_PAYSLIPS_NO_EMPLOYEES: {
    httpStatus: 400,
    message_sv: 'Inga anställda i lönekörningen.',
    message_en: 'No employees in the salary run.',
  },
  AGI_GENERATE_NOT_BOOKABLE: {
    httpStatus: 400,
    message_sv: 'AGI kan endast genereras för lönekörningar i status review, approved, paid, booked eller corrected.',
    message_en: 'AGI can only be generated for salary runs in review, approved, paid, booked, or corrected status.',
  },
  AGI_INCOMPLETE_DATA: {
    httpStatus: 400,
    message_sv: 'AGI-data ofullständig: kontrollera att företaget har organisationsnummer, kontaktnamn, telefon och e-post.',
    message_en: 'AGI data is incomplete: verify the company has org number, contact name, phone, and email.',
  },
  COMPANY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Företaget kunde inte hittas.',
    message_en: 'Company not found.',
  },
  // Phase 5 PR-1 carry-over: distinct error code for the salary-run DELETE
  // FK-null guard so an operator seeing this in logs knows a journal entry
  // is at risk, not just a status race.
  SALARY_RUN_DELETE_HAS_JOURNAL_ENTRY: {
    httpStatus: 400,
    message_sv: 'Lönekörningen är kopplad till en verifikation och kan inte raderas (BFL 5 kap räkenskapsinformation).',
    message_en: 'Salary run is linked to a journal entry and cannot be deleted (BFL 5 kap räkenskapsinformation).',
  },
  // Phase 5 PR-3: additional import error codes.
  SIE_IMPORT_DUPLICATE: {
    httpStatus: 409,
    message_sv: 'Den här SIE-filen har redan importerats.',
    message_en: 'This SIE file has already been imported.',
  },
  BANK_IMPORT_FAILED: {
    httpStatus: 500,
    message_sv: 'Bankfilsimporten misslyckades.',
    message_en: 'Bank file import failed.',
  },
  BANK_FILE_FORMAT_UNKNOWN: {
    httpStatus: 400,
    message_sv: 'Bankfilens format kunde inte identifieras.',
    message_en: 'Bank file format could not be identified.',
  },
  BANK_IMPORT_DUPLICATE_OTHER_COMPANY: {
    httpStatus: 409,
    message_sv: 'Den här filen har redan importerats för ett annat företag av samma användare.',
    message_en: 'This file has already been imported into another company by this user.',
  },
}

const COMPANY: Record<string, StructuredErrorEntry> = {
  COMPANY_CREATE_DUPLICATE_ORG_NUMBER: {
    httpStatus: 409,
    message_sv: 'Ett företag med samma organisationsnummer finns redan.',
    message_en: 'A company with that organisation number already exists.',
  },
  COMPANY_CREATE_BAS_SEED_FAILED: {
    httpStatus: 500,
    message_sv: 'Kontoplanen kunde inte skapas. Försök igen.',
    message_en: 'Failed to seed the chart of accounts.',
  },
  COMPANY_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Företaget kunde inte skapas.',
    message_en: 'Failed to create company.',
  },
}

const API_KEY: Record<string, StructuredErrorEntry> = {
  API_KEY_SCOPE_INVALID: {
    httpStatus: 400,
    message_sv: 'En eller flera scopes är ogiltiga.',
    message_en: 'One or more requested scopes are invalid.',
  },
  API_KEY_QUOTA_EXCEEDED: {
    httpStatus: 429,
    message_sv: 'Du har nått maxgränsen för antal API-nycklar.',
    message_en: 'API key quota exceeded.',
  },
  API_KEY_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'API-nyckeln kunde inte skapas.',
    message_en: 'Failed to create API key.',
  },
  API_KEY_REVOKE_FAILED: {
    httpStatus: 500,
    message_sv: 'API-nyckeln kunde inte återkallas.',
    message_en: 'Failed to revoke API key.',
  },
  API_KEY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'API-nyckeln kunde inte hittas.',
    message_en: 'API key not found.',
  },
  API_KEY_SOD_CONFLICT: {
    httpStatus: 409,
    message_sv:
      'Nyckeln kombinerar ett skriv-scope som stagar bokföring med pending_operations:approve. Då kan en automatiserad agent både skapa och godkänna verifikationer utan mänsklig granskning (ansvarsfördelning, ISO 27001 A.5.3 / BFNAR 2013:2). Bekräfta att du förstår risken för att skapa nyckeln ändå.',
    message_en:
      'This key combines a staging write scope with pending_operations:approve, letting an automated agent both stage and approve postings with no human in the loop (segregation of duties, ISO 27001 A.5.3 / BFNAR 2013:2).',
    remediation: {
      description:
        'Inform the user of the segregation-of-duties risk, then re-POST the same scopes with acknowledge_sod: true to create the key anyway.',
    },
  },
}

// ─────────────────────────────────────────────────────────────────
// Provider connection / external HTTP codes
// ─────────────────────────────────────────────────────────────────

const PROVIDER: Record<string, StructuredErrorEntry> = {
  PROVIDER_AUTH_EXPIRED: {
    httpStatus: 401,
    message_sv: 'Anslutningen till leverantören har gått ut. Återanslut för att fortsätta.',
    message_en: 'Provider authentication expired or refresh failed.',
  },
  PROVIDER_LICENSE_MISSING: {
    httpStatus: 403,
    message_sv:
      'Fortnox nekade anslutningen eftersom integrationslicensen inte är aktiv. Aktivera tilläggstjänsten "Fortnox Integration" i ditt Fortnox-konto (Inställningar → Tilläggstjänster) och återanslut sedan. Du kan även importera via SIE-fil under tiden.',
    message_en:
      'Fortnox refused the connection because the integration license is not active. Activate the "Fortnox Integration" add-on in your Fortnox account, then reconnect. You can also import via SIE file in the meantime.',
  },
  PROVIDER_RATE_LIMITED: {
    httpStatus: 429,
    message_sv:
      'Leverantören begränsar antalet anrop just nu. Vänta en stund och försök igen.',
    message_en: 'Provider rate limit exceeded.',
  },
  PROVIDER_UNREACHABLE: {
    httpStatus: 502,
    message_sv: 'Leverantörens tjänst är inte tillgänglig just nu. Försök igen om en stund.',
    message_en: 'Provider service is unreachable (network/DNS error).',
  },
  PROVIDER_UPSTREAM_ERROR: {
    httpStatus: 502,
    message_sv: 'Leverantören svarade med ett fel. Försök igen om en stund.',
    message_en: 'Provider returned an upstream 5xx error.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Link invoice to an existing posted verifikat (no new JE)
// ─────────────────────────────────────────────────────────────────

const LINK_INVOICE_VOUCHER: Record<string, StructuredErrorEntry> = {
  LINK_VOUCHER_INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Fakturan kunde inte hittas.',
    message_en: 'Invoice not found.',
  },
  LINK_VOUCHER_VOUCHER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikationen kunde inte hittas.',
    message_en: 'Journal entry not found.',
  },
  LINK_VOUCHER_NOT_POSTED: {
    httpStatus: 409,
    message_sv: 'Verifikationen är inte bokförd. Endast bokförda verifikationer kan länkas som betalning.',
    message_en: 'Journal entry is not posted. Only posted entries can be linked as a payment.',
  },
  LINK_VOUCHER_NO_AR_CREDIT: {
    httpStatus: 400,
    message_sv:
      'Verifikationen krediterar inte ett kundfordringskonto (151x). Bokföringen behöver först rättas med en stornoverifikation som krediterar 1510, t.ex. via gnubok_correct_entry.',
    message_en:
      'The journal entry does not credit an accounts-receivable account (151x). Correct the booking first via a storno+correction (gnubok_correct_entry) that credits 1510.',
    remediation: {
      description:
        'Use gnubok_correct_entry to storno the existing voucher and re-book the receipt as Dr 1930 / Cr 1510, then link the corrected voucher.',
      tool: 'gnubok_correct_entry',
    },
  },
  LINK_VOUCHER_ALREADY_LINKED: {
    httpStatus: 409,
    message_sv: 'Verifikationen är redan länkad till den här fakturan.',
    message_en: 'This journal entry is already linked to this invoice.',
  },
  LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING: {
    httpStatus: 400,
    message_sv:
      'Verifikationens kundfordringskreditering är större än fakturans återstående belopp. Verifikationen täcker fler fakturor: välj en annan verifikation eller rätta beloppet först.',
    message_en:
      'The voucher\'s AR credit exceeds the invoice\'s remaining balance. Split the voucher across multiple invoices via gnubok_correct_entry first, or pick a different voucher.',
  },
  LINK_VOUCHER_CURRENCY_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Verifikationens valuta matchar inte fakturans. Endast verifikationer i fakturans valuta kan länkas.',
    message_en: 'The voucher\'s currency does not match the invoice currency.',
  },
  LINK_VOUCHER_INVOICE_FULLY_PAID: {
    httpStatus: 409,
    message_sv: 'Fakturan har redan slutbetalats. Inget mer behöver länkas.',
    message_en: 'Invoice is already fully paid.',
  },
  LINK_VOUCHER_DB_ERROR: {
    httpStatus: 500,
    message_sv: 'Databasfel under länkning. Försök igen.',
    message_en: 'Database error while linking the voucher. Please retry.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Link SUPPLIER invoice to an existing posted verifikat (no new JE)
// ─────────────────────────────────────────────────────────────────

const LINK_SI_VOUCHER: Record<string, StructuredErrorEntry> = {
  LINK_SI_VOUCHER_INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Leverantörsfakturan kunde inte hittas.',
    message_en: 'Supplier invoice not found.',
  },
  LINK_SI_VOUCHER_VOUCHER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikationen kunde inte hittas.',
    message_en: 'Journal entry not found.',
  },
  LINK_SI_VOUCHER_NOT_POSTED: {
    httpStatus: 409,
    message_sv:
      'Verifikationen är inte bokförd. Endast bokförda verifikationer kan länkas som betalning.',
    message_en: 'Journal entry is not posted. Only posted entries can be linked as a payment.',
  },
  LINK_SI_VOUCHER_NO_AP_DEBIT: {
    httpStatus: 400,
    message_sv:
      'Verifikationen debiterar inget leverantörsskuldskonto (244x). Rätta bokföringen först med en stornoverifikation som debiterar t.ex. 2440 (SEK) eller 2441 (utländsk valuta), via gnubok_correct_entry.',
    message_en:
      'The journal entry does not debit any accounts-payable account in the 244x range (e.g. 2440 SEK, 2441 foreign currency). Correct the booking first via a storno+correction (gnubok_correct_entry).',
    remediation: {
      description:
        'Use gnubok_correct_entry to storno the existing voucher and re-book the payment as Dr 244x / Cr 1930, then link the corrected voucher.',
      tool: 'gnubok_correct_entry',
    },
  },
  LINK_SI_VOUCHER_ALREADY_LINKED: {
    httpStatus: 409,
    message_sv: 'Verifikationen är redan länkad till den här leverantörsfakturan.',
    message_en: 'This journal entry is already linked to this supplier invoice.',
  },
  LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING: {
    httpStatus: 400,
    message_sv:
      'Verifikationens leverantörsskuldsdebitering är större än leverantörsfakturans återstående belopp. Verifikationen täcker fler fakturor: välj en annan verifikation eller rätta beloppet först.',
    message_en:
      'The voucher\'s AP debit exceeds the supplier invoice\'s remaining balance. Split the voucher across multiple supplier invoices via gnubok_correct_entry first, or pick a different voucher.',
  },
  LINK_SI_VOUCHER_CURRENCY_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Verifikationens valuta matchar inte leverantörsfakturans. Endast verifikationer i fakturans valuta kan länkas.',
    message_en: 'The voucher\'s currency does not match the supplier invoice currency.',
  },
  LINK_SI_VOUCHER_INVOICE_FULLY_PAID: {
    httpStatus: 409,
    message_sv: 'Leverantörsfakturan har redan slutbetalats. Inget mer behöver länkas.',
    message_en: 'Supplier invoice is already fully paid.',
  },
  LINK_SI_VOUCHER_DB_ERROR: {
    httpStatus: 500,
    message_sv: 'Databasfel under länkning. Försök igen.',
    message_en: 'Database error while linking the voucher. Please retry.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Batch allocation (match_batch_allocate RPC)
// ─────────────────────────────────────────────────────────────────

const MATCH_BATCH: Record<string, StructuredErrorEntry> = {
  BATCH_TX_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Transaktionen kunde inte hittas.',
    message_en: 'Transaction not found.',
  },
  BATCH_UNAUTHORIZED: {
    httpStatus: 403,
    message_sv: 'Du har inte behörighet att fördela transaktioner för det här företaget.',
    message_en: 'You are not authorized to allocate transactions for this company.',
  },
  BATCH_TX_ALREADY_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Transaktionen är redan bokförd. Avbokföra först (storno) innan du fördelar den på flera fakturor.',
    message_en:
      'Transaction is already booked. Reverse the existing journal entry before re-allocating.',
  },
  BATCH_TX_ZERO_AMOUNT: {
    httpStatus: 400,
    message_sv: 'Transaktioner med beloppet 0 kan inte bokföras.',
    message_en: 'Zero-amount transactions cannot be allocated.',
  },
  BATCH_NO_ALLOCATIONS: {
    httpStatus: 400,
    message_sv: 'Minst en fördelning krävs.',
    message_en: 'At least one allocation is required.',
  },
  BATCH_INVALID_AMOUNT: {
    httpStatus: 400,
    message_sv: 'Fördelningens belopp måste vara positivt.',
    message_en: 'Allocation amount must be positive.',
  },
  BATCH_DUPLICATE_ALLOCATION: {
    httpStatus: 400,
    message_sv:
      'Samma faktura förekommer två gånger i fördelningen. Slå ihop beloppen eller ta bort dubbletten.',
    message_en:
      'The same invoice appears twice in the allocations. Merge the amounts or remove the duplicate.',
  },
  BATCH_INVALID_KIND: {
    httpStatus: 400,
    message_sv:
      'Okänd typ av fördelning. Endast customer_invoice och supplier_invoice stöds.',
    message_en:
      'Unknown allocation kind. Only customer_invoice and supplier_invoice are supported.',
  },
  BATCH_INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'En av fakturorna i fördelningen kunde inte hittas.',
    message_en: 'One of the invoices in the allocation could not be found.',
  },
  BATCH_INVOICE_NOT_OPEN: {
    httpStatus: 409,
    message_sv: 'En av fakturorna är inte i ett obetalt läge och kan inte ta emot betalning.',
    message_en: 'One of the invoices is not in an open state.',
  },
  BATCH_SUPPLIER_INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'En av leverantörsfakturorna i fördelningen kunde inte hittas.',
    message_en: 'One of the supplier invoices in the allocation could not be found.',
  },
  BATCH_SUPPLIER_INVOICE_NOT_OPEN: {
    httpStatus: 409,
    message_sv:
      'En av leverantörsfakturorna är inte i ett obetalt läge och kan inte ta emot betalning.',
    message_en: 'One of the supplier invoices is not in an open state.',
  },
  BATCH_OVERSHOOT: {
    httpStatus: 400,
    message_sv:
      'En av fördelningarna överskrider fakturans återstående belopp. Sänk beloppet eller fördela överskottet på fler fakturor.',
    message_en:
      'One allocation exceeds the invoice remaining amount. Lower it or split the excess across additional invoices.',
  },
  BATCH_AMOUNT_EXCEEDS_TX: {
    httpStatus: 400,
    message_sv:
      'Summan av fördelningarna är större än transaktionens belopp.',
    message_en: 'Sum of allocations exceeds the transaction amount.',
  },
  BATCH_AMOUNT_BELOW_TX: {
    httpStatus: 400,
    message_sv:
      'Hela transaktionen måste fördelas. Lägg till fler fakturor eller höj något belopp så att summan motsvarar bankhändelsen.',
    message_en:
      'The full transaction amount must be allocated. Add more invoices or raise an amount so the sum matches the bank movement.',
  },
  BATCH_MIXED_KINDS_UNSUPPORTED: {
    httpStatus: 400,
    message_sv:
      'En transaktion kan inte fördelas på både kund- och leverantörsfakturor i samma verifikat. Skapa två separata fördelningar.',
    message_en:
      'A single transaction cannot allocate to both customer and supplier invoices in one batch.',
  },
  BATCH_DIRECTION_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Transaktionens riktning matchar inte fördelningens typ. Kundfakturor kräver inkommande, leverantörsfakturor utgående.',
    message_en:
      'Transaction direction does not match allocation kind: customer invoices require income, supplier invoices require expense.',
  },
  BATCH_CURRENCY_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Fakturans valuta matchar inte transaktionens. Endast samma valuta stöds i V1.',
    message_en:
      'Invoice currency does not match the transaction currency. Same-currency only in v1.',
  },
  BATCH_FX_RATE_MISSING: {
    httpStatus: 400,
    message_sv:
      'Fakturan i annan valuta saknar växelkurs. Komplettera fakturans exchange_rate innan du fördelar.',
    message_en:
      'The foreign-currency invoice has no exchange rate on file. Complete invoice.exchange_rate before allocating.',
  },
  BATCH_FX_DEVIATION_TOO_LARGE: {
    httpStatus: 400,
    message_sv:
      'Beloppet du angav avviker mer än 10 % från fakturans bokförda värde. Kontrollera att du fyllt i bankbeloppet i transaktionens valuta.',
    message_en:
      'The amount you entered deviates more than 10% from the invoice\'s booked SEK value. Check that you entered the bank-side amount in the transaction\'s currency.',
  },
  BATCH_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv:
      'Det finns ingen öppen räkenskapsperiod för transaktionens datum. Skapa perioden först.',
    message_en:
      'No fiscal period exists for the transaction date. Create the period first.',
  },
  BATCH_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsperioden för transaktionens datum är stängd. Öppna perioden eller välj ett annat datum.',
    message_en:
      'Fiscal period for the transaction date is closed/locked. Open the period or pick a different date.',
  },
  BATCH_RPC_FAILED: {
    httpStatus: 500,
    message_sv: 'Databasfel under fördelning. Försök igen.',
    message_en: 'Database error during batch allocation. Please retry.',
    retryable: true,
  },
}

// ─────────────────────────────────────────────────────────────────
// Bulk-book (bulk_book_transactions RPC): N txs → 1 verifikat
// ─────────────────────────────────────────────────────────────────

const BULK_BOOK: Record<string, StructuredErrorEntry> = {
  BULK_BOOK_UNAUTHORIZED: {
    httpStatus: 403,
    message_sv: 'Du har inte behörighet att bokföra transaktioner för det här företaget.',
    message_en: 'You are not authorized to bulk-book transactions for this company.',
  },
  BULK_BOOK_NO_TXS: {
    httpStatus: 400,
    message_sv: 'Inga transaktioner att bokföra.',
    message_en: 'No transactions to book.',
  },
  BULK_BOOK_TXS_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'En eller flera transaktioner kunde inte hittas i det aktuella företaget.',
    message_en: 'One or more transactions could not be found in this company.',
  },
  BULK_BOOK_TX_ALREADY_BOOKED: {
    httpStatus: 409,
    message_sv:
      'En av de valda transaktionerna är redan bokförd. Avbokföra (storno) den först eller välj bort den.',
    message_en:
      'One of the selected transactions is already booked. Reverse the existing journal entry first or deselect it.',
  },
  BULK_BOOK_TX_ZERO_AMOUNT: {
    httpStatus: 400,
    message_sv: 'Transaktioner med beloppet 0 kan inte ingå i en samlingsbokföring.',
    message_en: 'Zero-amount transactions cannot be part of a bulk booking.',
  },
  BULK_BOOK_DATE_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Alla transaktioner i en samlingsbokföring måste ha samma datum (BFL 5 kap 6§).',
    message_en:
      'All transactions in a bulk booking must share the same date (BFL 5 kap 6§).',
  },
  BULK_BOOK_DIRECTION_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Alla transaktioner måste vara samma riktning (alla intäkter eller alla utgifter).',
    message_en: 'All transactions must be the same direction (all income or all expense).',
  },
  BULK_BOOK_MIXED_CURRENCY: {
    httpStatus: 400,
    message_sv:
      'Samlingsbokföring stödjer endast transaktioner i samma valuta. Välj transaktioner i en valuta åt gången.',
    message_en:
      'Bulk booking supports only single-currency batches. Select transactions in one currency at a time.',
  },
  BULK_BOOK_INVALID_PAYLOAD: {
    httpStatus: 400,
    message_sv:
      'Ange antingen existing_journal_entry_id (länkning) eller template_id (skapa ny), inte båda, och inte ingen.',
    message_en:
      'Provide either existing_journal_entry_id (link) or template_id (create new), not both, and not neither.',
  },
  BULK_BOOK_TEMPLATE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Den valda bokföringsmallen kunde inte hittas.',
    message_en: 'The selected booking template could not be found.',
  },
  BULK_BOOK_VOUCHER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikationen kunde inte hittas.',
    message_en: 'The target journal entry could not be found.',
  },
  BULK_BOOK_VOUCHER_NOT_POSTED: {
    httpStatus: 409,
    message_sv: 'Endast bokförda verifikationer kan länkas mot banktransaktioner.',
    message_en: 'Only posted journal entries can be linked.',
  },
  BULK_BOOK_NO_BANK_LINE: {
    httpStatus: 400,
    message_sv:
      'Verifikationen har ingen rad på bankkonto (19xx). Den kan inte länkas mot banktransaktioner.',
    message_en:
      'The journal entry has no bank-account (19xx) line and cannot be linked to bank transactions.',
  },
  BULK_BOOK_AMOUNT_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Summan av transaktionerna stämmer inte med bankradens nettobelopp på verifikationen.',
    message_en:
      'The sum of the selected transactions does not match the bank-line net amount on the journal entry.',
  },
  BULK_BOOK_NO_LINES: {
    httpStatus: 400,
    message_sv: 'Verifikationen måste innehålla minst två rader (debit och kredit).',
    message_en: 'The journal entry must contain at least two lines (debit and credit).',
  },
  BULK_BOOK_UNBALANCED: {
    httpStatus: 400,
    message_sv: 'Verifikationen balanserar inte: summa debet måste lika summa kredit.',
    message_en: 'The journal entry does not balance: debits must equal credits.',
  },
  BULK_BOOK_NEGATIVE_LINE: {
    httpStatus: 400,
    message_sv: 'Verifikationsrader kan inte ha negativa belopp.',
    message_en: 'Journal entry lines cannot have negative amounts.',
  },
  BULK_BOOK_BOTH_SIDES_NONZERO: {
    httpStatus: 400,
    message_sv: 'En verifikationsrad kan inte ha både debet och kredit nollskilda.',
    message_en: 'A journal entry line cannot have both debit and credit non-zero.',
  },
  BULK_BOOK_MISSING_DESCRIPTION: {
    httpStatus: 400,
    message_sv: 'Beskrivning krävs för en ny samlingsverifikation.',
    message_en: 'Description is required when creating a new combined journal entry.',
  },
  BULK_BOOK_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv:
      'Det finns ingen öppen räkenskapsperiod för transaktionsdatumet. Skapa perioden först.',
    message_en:
      'No fiscal period exists for the transaction date. Create the period first.',
  },
  BULK_BOOK_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsperioden för transaktionsdatumet är stängd. Öppna perioden eller välj ett annat datum.',
    message_en:
      'The fiscal period for the transaction date is closed/locked.',
  },
  BULK_BOOK_RPC_FAILED: {
    httpStatus: 500,
    message_sv: 'Databasfel under samlingsbokföring. Försök igen.',
    message_en: 'Database error during bulk booking. Please retry.',
    retryable: true,
  },
  BULK_BOOK_INVALID_ACCOUNT: {
    httpStatus: 400,
    message_sv:
      'Ett eller flera konton finns inte i kontoplanen eller är inaktiva. Välj giltiga BAS-konton.',
    message_en:
      'One or more accounts are not in the chart of accounts or are inactive. Pick valid BAS accounts.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Skatteverket filing codes (PR5: MCP momsdeklaration + AGI tools)
// ─────────────────────────────────────────────────────────────────

const SKATTEVERKET: Record<string, StructuredErrorEntry> = {
  EXTENSION_DISABLED: {
    httpStatus: 503,
    message_sv: 'Skatteverket-integrationen är inte aktiverad i denna miljö.',
    message_en: 'The Skatteverket integration is not enabled in this environment.',
  },
  SKATTEVERKET_NOT_CONNECTED: {
    httpStatus: 401,
    message_sv:
      'Anslutningen till Skatteverket saknas eller har gått ut. Anslut med BankID under Inställningar → Skatteverket.',
    message_en: 'No valid Skatteverket connection. Reconnect with BankID before retrying.',
    remediation: {
      description:
        'Connect (or reconnect) to Skatteverket with BankID under Settings → Skatteverket, then retry.',
    },
  },
  SKATTEVERKET_ACCESS_DENIED: {
    httpStatus: 403,
    message_sv:
      'Behörighet saknas hos Skatteverket för det här företaget. Kontrollera att du är firmatecknare eller deklarationsombud.',
    message_en:
      'Skatteverket denied access for this company (missing authorisation or scope).',
    remediation: {
      description:
        'Verify the signed-in user is firmatecknare/deklarationsombud for this company at Skatteverket, then reconnect with BankID.',
    },
  },
  SKATTEVERKET_RATE_LIMITED: {
    httpStatus: 429,
    message_sv: 'För många förfrågningar mot Skatteverket. Vänta en stund och försök igen.',
    message_en: 'Skatteverket rate limit exceeded.',
    retryable: true,
  },
}

// ─────────────────────────────────────────────────────────────────
// Bolagsverket filing codes (digital inlämning av årsredovisning)
// ─────────────────────────────────────────────────────────────────

const BOLAGSVERKET: Record<string, StructuredErrorEntry> = {
  BOLAGSVERKET_API_ERROR: {
    httpStatus: 502,
    message_sv: 'Bolagsverkets tjänst svarade med ett fel. Se detaljerna och försök igen.',
    message_en: 'The Bolagsverket API returned an error. See details for the upstream message.',
  },
  BOLAGSVERKET_SUBMISSION_EXISTS: {
    httpStatus: 409,
    message_sv:
      'Det finns redan en aktiv inlämning av årsredovisningen för räkenskapsåret. Invänta Bolagsverkets besked innan du lämnar in på nytt.',
    message_en:
      'An active årsredovisning submission already exists for this fiscal period. Wait for Bolagsverket to resolve it before submitting again.',
  },
  BOLAGSVERKET_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Otillräcklig behörighet för att lämna in årsredovisning för det här företaget.',
    message_en:
      'Insufficient role to file an årsredovisning for this company (viewer members cannot submit).',
  },
  BOLAGSVERKET_INVALID_ENVIRONMENT: {
    httpStatus: 400,
    message_sv: "Ogiltig Bolagsverket-miljö. Tillåtna värden: 'test', 'accept', 'prod'.",
    message_en: "Invalid Bolagsverket environment. Allowed values: 'test', 'accept', 'prod'.",
  },
  BOLAGSVERKET_ENV_NOT_ALLOWED: {
    httpStatus: 403,
    message_sv:
      'Den valda Bolagsverket-miljön är inte tillåten i den här installationen. Plattformens BOLAGSVERKET_ENV sätter taket.',
    message_en:
      'The selected Bolagsverket environment exceeds the platform ceiling set by BOLAGSVERKET_ENV (order: test < accept < prod; unset means test).',
  },
  BOLAGSVERKET_CONFIG_MISSING: {
    httpStatus: 503,
    message_sv:
      'Serverkonfiguration saknas för Bolagsverket-integrationen. Kontakta administratören.',
    message_en:
      'Server configuration required by the Bolagsverket integration is missing (see details).',
  },
  BOLAGSVERKET_NO_SUBSCRIPTION: {
    httpStatus: 404,
    message_sv: 'Ingen händelseprenumeration finns för företaget ännu.',
    message_en:
      'No Bolagsverket event subscription exists for this company yet. One is created on the first submission.',
  },
}

const ASSETS: Record<string, StructuredErrorEntry> = {
  ASSET_CORRECTION_BLOCKED: {
    httpStatus: 409,
    message_sv:
      'Anskaffningsdatum, anskaffningsvärde och kategori kan inte ändras efter att tillgången avyttrats eller avskrivningar bokförts. Återför (storno) först, eller använd avyttringsflödet.',
    message_en:
      'Acquisition date, cost and category cannot be changed once the asset has been disposed or depreciation has been posted. Reverse (storno) first, or use the disposal flow.',
  },
}

// Dimensions registry (kostnadsställe/projekt): dev_docs/dimensions_implementation_plan.md §6
const DIMENSION: Record<string, StructuredErrorEntry> = {
  DIMENSION_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Dimensionen kunde inte hittas.',
    message_en: 'Dimension not found.',
  },
  DIMENSION_SYSTEM_RENAME: {
    httpStatus: 400,
    message_sv: 'Systemdimensioner kan inte döpas om.',
    message_en: 'System dimensions (kostnadsställe/projekt) cannot be renamed.',
  },
  DIMENSION_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Dimensionen kunde inte uppdateras.',
    message_en: 'Failed to update dimension.',
  },
  DIMENSION_VALUE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Dimensionsvärdet kunde inte hittas.',
    message_en: 'Dimension value not found.',
  },
  DIMENSION_VALUE_DUPLICATE_CODE: {
    httpStatus: 409,
    message_sv: 'Ett värde med samma kod finns redan i dimensionen.',
    message_en: 'A value with that code already exists in the dimension.',
  },
  DIMENSION_VALUE_DATES_NOT_ALLOWED: {
    httpStatus: 400,
    message_sv: 'Datum kan bara sättas på ackumulerande dimensioner (t.ex. projekt).',
    message_en:
      'Start/end dates can only be set on accumulating dimensions (e.g. projects): this dimension resets annually.',
  },
  DIMENSION_VALUE_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Dimensionsvärdet kunde inte skapas.',
    message_en: 'Failed to create dimension value.',
  },
  DIMENSION_VALUE_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Dimensionsvärdet kunde inte uppdateras.',
    message_en: 'Failed to update dimension value.',
  },
  // The DB retention trigger (enforce_dimension_value_retention) raises when a
  // code is referenced by posted/reversed lines. Routes surface the trigger's
  // own Swedish message via `messageSv` so the code + kod appear in the toast.
  DIMENSION_VALUE_REFERENCED: {
    httpStatus: 409,
    message_sv:
      'Värdet används på bokförda verifikat och kan inte tas bort: arkivera det istället.',
    message_en:
      'The value is referenced by posted vouchers and cannot be deleted: archive (inactivate) it instead.',
    remediation: {
      description:
        'Archive the value instead: PATCH the dimension value with { "is_active": false }. Codes referenced by posted lines are retained for the BFL 7-year period.',
    },
  },
  DIMENSION_VALUE_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Dimensionsvärdet kunde inte tas bort.',
    message_en: 'Failed to delete dimension value.',
  },
  DIMENSION_IMPORT_FAILED: {
    httpStatus: 500,
    message_sv: 'Import av befintliga dimensionskoder misslyckades.',
    message_en: 'Failed to import existing dimension codes from journal lines.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Combined registry
// ─────────────────────────────────────────────────────────────────

const REGISTRY: Record<string, StructuredErrorEntry> = {
  ...GENERIC,
  ...BOOKKEEPING,
  ...TRANSACTIONS,
  ...MATCH_INVOICE,
  ...LINK_TX_JE,
  ...LINK_INVOICE_VOUCHER,
  ...LINK_SI_VOUCHER,
  ...MATCH_BATCH,
  ...BULK_BOOK,
  ...MATCH_SI,
  ...INVOICE,
  ...SUPPLIER_INVOICE,
  ...PERIOD,
  ...YEAR_END,
  ...OPENING_BAL,
  ...FX,
  ...REPORT,
  ...VAT_REPORT,
  ...PS_REPORT,
  ...SIE_EXPORT,
  ...TAX_DECL,
  ...SIE_IMPORT,
  ...BANK_FILE,
  ...OPENING_BALANCE_IMPORT,
  ...REGISTER_IMPORT,
  ...PROVIDER_MIGRATION,
  ...DOCUMENT,
  ...CUSTOMER,
  ...ARTICLE,
  ...SUPPLIER,
  ...SUPPLIER_INVOICE_WAVE4,
  ...SALARY,
  ...COMPANY,
  ...API_KEY,
  ...PROVIDER,
  ...SKATTEVERKET,
  ...BOLAGSVERKET,
  ...ASSETS,
  ...DIMENSION,
}

export function getErrorEntry(code: string): StructuredErrorEntry | undefined {
  return REGISTRY[code]
}

export function hasErrorEntry(code: string): boolean {
  return code in REGISTRY
}

/**
 * Test-only: returns all registered codes. Used by the unit test that asserts
 * the matrix in the plan file stays in sync with this registry.
 */
export function listErrorCodes(): string[] {
  return Object.keys(REGISTRY)
}
