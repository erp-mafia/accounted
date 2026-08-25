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
  // A Postgres privilege/RLS denial (42501) on a write the application
  // expected to succeed: a server-side configuration bug (e.g. a SECURITY
  // INVOKER trigger writing to a policy-less RLS table), not a user-permission
  // problem. Kept distinct from FORBIDDEN (which blames the user) and from
  // INTERNAL_ERROR (which hides the failure mode from diagnostics).
  DB_PERMISSION_DENIED: {
    httpStatus: 500,
    message_sv: 'Ett behörighetsfel i databasen stoppade åtgärden. Kontakta supporten om felet kvarstår.',
    message_en: 'A database permission (RLS) denial blocked the write. This indicates a server-side misconfiguration.',
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
  // Distinct from a plain duplicate: the account number is taken by a row the
  // company deactivated. Creating it again can never succeed (the unique
  // constraint counts inactive rows), so the only way forward is reactivation.
  // Callers key on this code to offer that instead of a dead-end 409.
  ACCOUNT_EXISTS_INACTIVE: {
    httpStatus: 409,
    message_sv: 'Kontot finns redan i din kontoplan men är inaktiverat.',
    message_en:
      'The account number already exists in this company chart of accounts but is deactivated.',
    remediation: {
      description:
        'Reactivate the existing account instead of creating it: POST /api/bookkeeping/accounts/activate with { account_numbers: [number] }.',
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
    message_sv:
      'En stornering kan inte stornas. Om verifikationen makulerades av misstag, bokför den på nytt (kopiera originalet).',
    message_en:
      'A storno entry cannot be reversed. If the entry was cancelled by mistake, re-book it (copy the original).',
  },
  CANNOT_CORRECT_NON_POSTED: {
    httpStatus: 400,
    message_sv: 'Endast bokförda verifikationer kan rättas.',
    message_en: 'Only posted entries can be corrected.',
  },
  CANNOT_EDIT_NON_DRAFT: {
    httpStatus: 409,
    message_sv: 'Endast utkast kan redigeras. Bokförda verifikationer rättas med storno.',
    message_en: 'Only draft entries can be edited; posted entries are immutable and are corrected with storno.',
    remediation: {
      description: 'Use the correction (storno) flow to change a posted entry instead of editing it.',
    },
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
  MANDATORY_DIMENSION_MISSING: {
    httpStatus: 400,
    message_sv:
      'Ett eller flera konton kräver en dimension (t.ex. projekt eller kostnadsställe). Välj värden innan bokföring.',
    message_en:
      'One or more accounts require a dimension value. details.violations lists each account_number, sie_dim_no and dimension_name.',
    remediation: {
      description:
        'Tag every listed line with the required dimension value, then retry the commit.',
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
  CORRECTION_CHAIN_TOO_DEEP: {
    httpStatus: 409,
    message_sv:
      'Rättelsekedjan är redan flera nivåer djup. Räkna ut nettoeffekten av hela kedjan och gör EN rättelse istället, eller skicka allow_deep_chain=true för att rätta ändå.',
    message_en:
      'The correction chain is already several levels deep. Compute the net effect of the whole chain and book ONE correction instead, or pass allow_deep_chain=true to override.',
    remediation: {
      description:
        'Read the full chain with gnubok_query_journal (follow correction_of_id/reverses_id to the chain root), compute the net effect across all entries, and stage ONE correction on the live entry that expresses it. Only pass allow_deep_chain=true if stacking another correction is genuinely intended.',
      tool: 'gnubok_query_journal',
    },
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
  // Bokslutsdispositioner: the schablonintäkt on periodiseringsfonder
  // (IL 30 kap 6a §) needs the SLR for the closing year, kept in a table in
  // lib/bokslut/reserves/periodiseringsfond-service.ts that is extended each
  // December. Only raised when the company actually holds fonder at the start
  // of the year (no fonder: no rate needed). 500 on purpose: it is a
  // server-side configuration gap, not a user error, and it must show up in
  // runtime-error clustering so the annual update is not missed.
  SCHABLONINTAKT_RATE_NOT_CONFIGURED: {
    httpStatus: 500,
    message_sv:
      'Statslåneräntan för det här räkenskapsåret saknas i systemet, så schablonintäkten på periodiseringsfonderna kan inte beräknas ännu. Kontakta supporten så lägger vi in den.',
    message_en:
      'The statslåneränta (SLR) for this closing year is not configured, so the schablonintäkt on periodiseringsfonder cannot be calculated yet. Contact support to have it added.',
    remediation: {
      description:
        'Wait for the SLR table update, or pass schablonintaktRate explicitly on periodiseringsfond_avsattning / periodiseringsfond_ateforing items when posting dispositions.',
    },
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
  TRANSACTION_MOVE_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Transaktionen är bokförd eller kopplad till en verifikation och kan inte flyttas till ett annat konto. Koppla bort den under Rapporter → Bankavstämning, eller storna verifikationen först.',
    message_en:
      'The transaction is booked or linked to a voucher and cannot be moved to another account. Unlink it under Reports → Bank reconciliation, or reverse (storno) the voucher first.',
  },
  TRANSACTION_MOVE_UNKNOWN_ACCOUNT: {
    httpStatus: 404,
    message_sv: 'Kontot finns inte bland företagets registrerade bankkonton.',
    message_en: "The account is not one of the company's registered cash accounts.",
  },
  TRANSACTION_MOVE_CURRENCY_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Transaktionens valuta stämmer inte med kontots valuta. En transaktion kan bara flyttas till ett konto i samma valuta.',
    message_en:
      'The transaction currency does not match the target account currency. A transaction can only be moved to an account in the same currency.',
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
  TX_CATEGORIZE_IGNORED_CONFLICT: {
    httpStatus: 409,
    message_sv:
      'Transaktionen är fortfarande markerad som ignorerad och kan därför inte kopplas till en verifikation.',
    message_en:
      'The transaction is still marked as ignored and cannot be linked to a journal entry.',
    remediation: {
      description: 'Reload and retry categorization. Report the conflict if it persists.',
    },
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
  MATCH_INVOICE_CREDIT_NOTE: {
    httpStatus: 400,
    message_sv: 'Kreditfakturor kan inte registreras som betalda.',
    message_en: 'Credit notes cannot be recorded as paid.',
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
  MATCH_INVOICE_BOOKING_RATE_MISSING: {
    httpStatus: 400,
    message_sv:
      'Fakturan är utställd i utländsk valuta men saknar växelkurs. Utan kursen går det inte att räkna fram kursvinst eller kursförlust. Komplettera fakturans växelkurs (exchange_rate) och försök igen.',
    message_en:
      'The foreign-currency invoice has no usable booking exchange rate on file (invoice.exchange_rate is missing, zero, or out of range), so the FX gain/loss (BAS 3960/7960) on settlement cannot be computed. Same guard as BATCH_FX_RATE_MISSING in match_batch_allocate.',
    remediation: {
      description:
        'Set invoice.exchange_rate to the rate the receivable (1510) was booked at, then retry the match. On an invoice that is not yet booked, POST /api/invoices/{id}/refresh-exchange-rate fetches the taxable-event rate from Riksbanken and fills it in. On an already-booked invoice that endpoint refuses (INVOICE_FX_REFRESH_BOOKED): the SEK amounts are in a verifikat and only storno or inline rättelse may change them.',
    },
  },
  // The BANK ROW itself has no SEK value: transactions.currency is foreign and
  // both amount_sek and exchange_rate are empty (the shape a row gets when
  // Riksbanken was unreachable at ingest, see lib/transactions/ingest.ts).
  // Journal entry lines are always SEK, so the raw foreign number must never
  // stand in for one: a 500 USD receipt would be allocated as 500 SEK. Same
  // refusal as the match_batch_allocate RPC's BATCH_FX_RATE_MISSING.
  MATCH_INVOICE_TX_FX_RATE_MISSING: {
    httpStatus: 400,
    message_sv:
      'Banktransaktionen är i utländsk valuta men saknar både SEK-belopp och växelkurs. Komplettera transaktionens växelkurs innan du matchar: utan den kan beloppet inte räknas om till kronor.',
    message_en:
      'The bank transaction is in a foreign currency but has neither a SEK amount nor an exchange rate on file. Set the transaction exchange rate before matching; without it the amount cannot be translated to SEK.',
    remediation: {
      description:
        'Set amount_sek (or exchange_rate) on the transaction for its value date, then retry the match.',
    },
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
  LINK_TX_INVOICE_CREDIT_NOTE: {
    httpStatus: 400,
    message_sv: 'Kreditfakturor kan inte registreras som betalda.',
    message_en: 'Credit notes cannot be recorded as paid.',
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
  // Raw database failure on the transaction or invoice UPDATE. The service
  // puts the Postgres message in details.reason; callers append it so the
  // constraint or trigger that fired is visible to the agent instead of a
  // bare code (a customer hit this reproducibly on certain positive amounts
  // and could not tell us why).
  LINK_TX_DB_ERROR: {
    httpStatus: 500,
    message_sv: 'Kopplingen kunde inte sparas i databasen.',
    message_en: 'Linking the transaction to the journal entry failed at the database.',
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
  INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED: {
    httpStatus: 400,
    message_sv:
      'Kontantmetoden kan inte bokföra delbetalningar av en obokförd faktura automatiskt: hela fakturan bokförs vid betalning. Ta emot hela beloppet i en betalning, byt till faktureringsmetoden eller bokför betalningen manuellt som verifikation.',
    message_en:
      'The cash method cannot auto-book partial payments of an unbooked invoice: the generated entry always books the full invoice. Receive the full amount in one payment, switch to the accrual method, or book the payment manually as a journal entry.',
  },
  SI_CASH_PARTIAL_UNSUPPORTED: {
    httpStatus: 400,
    message_sv:
      'Kontantmetoden kan inte bokföra delbetalningar av en obokförd leverantörsfaktura automatiskt: hela fakturan bokförs vid betalning. Betala hela beloppet i en betalning eller bokför betalningen manuellt som verifikation.',
    message_en:
      'The cash method cannot auto-book partial payments of an unbooked supplier invoice: the generated entry always books the full invoice. Pay the full amount in one payment or book the payment manually as a journal entry.',
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
    message_sv: 'Ett angivet bokföringskonto finns inte eller är inte ett aktivt balans- eller intäktskonto (klass 1-3).',
    message_en: 'A supplied posting account does not exist or is not an active balance-sheet or revenue account (class 1-3).',
  },
  INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT: {
    httpStatus: 400,
    message_sv: 'Ett balanskonto (klass 1-2) kan bara användas på rader utan moms. Använd ett intäktskonto (3xxx) för momspliktiga rader.',
    message_en: 'A balance-sheet account (class 1-2) can only be used on zero-VAT lines. Use a revenue account (3xxx) for VAT-bearing lines.',
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
  INVOICE_CREDIT_NO_NUMBER: {
    httpStatus: 400,
    message_sv: 'Ursprungsfakturan saknar fakturanummer och kan inte krediteras.',
    message_en: 'The original invoice has no invoice number and cannot be credited.',
  },
  INVOICE_CREDIT_ISSUE_INCOMPLETE: {
    httpStatus: 500,
    message_sv:
      'Kreditfakturan kunde inte utfärdas färdigt. Ingen e-post skickades. Försök igen.',
    message_en:
      'The credit note could not be issued completely. No email was sent. Please try again.',
  },
  INVOICE_CREDIT_REPAIR_REQUIRED: {
    httpStatus: 500,
    message_sv: 'Kreditfakturans verifikat skapades, men utfärdandet måste slutföras. Försök igen eller kontakta support.',
    message_en: 'The credit-note voucher was created, but issuance must be completed. Retry or contact support.',
  },
  INVOICE_CREDIT_ALREADY_ISSUED: {
    httpStatus: 409,
    message_sv: 'Kreditfakturan har redan utfärdats.',
    message_en: 'The credit note has already been issued.',
  },
  INVOICE_MARK_SENT_INVALID_STATUS: {
    httpStatus: 400,
    message_sv: 'Fakturan kan inte markeras som skickad i nuvarande status.',
    message_en: 'The invoice cannot be marked as sent in its current status.',
  },
  INVOICE_MARK_SENT_STATUS_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturans status kunde inte uppdateras.',
    message_en: 'The invoice status could not be updated.',
  },
  INVOICE_MARK_SENT_RACE: {
    httpStatus: 409,
    message_sv: 'Fakturan ändrades av en annan begäran. Ladda om och försök igen.',
    message_en: 'The invoice was changed by another request. Reload and retry.',
  },
  INVOICE_MARK_SENT_LINES_UNBALANCED: {
    httpStatus: 400,
    message_sv: 'Verifikationsraderna är inte balanserade (debet ≠ kredit).',
    message_en: 'Custom journal lines do not balance.',
  },
  INVOICE_MARK_SENT_LINES_INVALID: {
    httpStatus: 400,
    message_sv: 'Verifikationsraderna kan inte användas: en rad har både debet och kredit, eller använder ett interimskonto (29xx). Använd periodisering på fakturaraden istället.',
    message_en: 'Custom journal lines are invalid: a row carries both debit and credit, or uses a 29xx interim account. Use line-level periodisering instead.',
  },
  INVOICE_MARK_SENT_BOOK_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturan kunde inte bokföras och ligger kvar som utkast.',
    message_en: 'The invoice could not be posted and remains a draft.',
  },
  INVOICE_MARK_SENT_REPAIR_REQUIRED: {
    httpStatus: 500,
    message_sv: 'Verifikatet skapades, men kopplingen till fakturan måste återställas. Kontakta support.',
    message_en: 'The voucher was created, but its invoice link must be repaired. Contact support.',
  },
  INVOICE_BOOK_ALREADY_BOOKED: {
    httpStatus: 400,
    message_sv: 'Fakturan är redan bokförd.',
    message_en: 'The invoice is already booked.',
  },
  INVOICE_BOOK_INVALID_STATUS: {
    httpStatus: 400,
    message_sv: 'Endast skickade eller förfallna fakturor kan bokföras i efterhand.',
    message_en: 'Only sent or overdue invoices can be booked afterwards.',
  },
  INVOICE_BOOK_NOT_BOOKABLE: {
    httpStatus: 400,
    message_sv: 'Kreditfakturor och andra dokumenttyper bokförs inte via detta steg.',
    message_en: 'Credit notes and other document types are not booked through this step.',
  },
  INVOICE_BOOK_CASH_METHOD: {
    httpStatus: 400,
    message_sv: 'Vid kontantmetoden bokförs fakturan när den betalas.',
    message_en: 'Under the cash method the invoice is booked when it is paid.',
  },
  // Bulk Bokför on a DRAFT when the company defers invoice booking (#967):
  // issuing the draft would consume an F-number and mark it sent without
  // booking anything, so the item is rejected before any side effect.
  INVOICE_BOOK_DEFERRED_DRAFT: {
    httpStatus: 400,
    message_sv:
      'Företaget bokför fakturor i ett separat steg. Skicka eller markera utkastet som skickat först, bokför sedan.',
    message_en:
      'This company books invoices in a separate step. Send or mark the draft as sent first, then book it.',
  },
  INVOICE_BOOK_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv: 'Inget öppet räkenskapsår täcker fakturadatumet. Skapa räkenskapsåret först.',
    message_en: 'No open fiscal period covers the invoice date. Create the fiscal year first.',
  },
  INVOICE_BOOK_CONFLICT: {
    httpStatus: 409,
    message_sv: 'Fakturan bokfördes samtidigt av en annan begäran. Ladda om sidan.',
    message_en: 'The invoice was booked concurrently by another request. Reload the page.',
  },
  INVOICE_BOOK_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturan kunde inte bokföras.',
    message_en: 'Failed to book the invoice.',
  },
  // Raised by lib/bookkeeping/invoice-entries.ts when a foreign-currency
  // customer invoice reaches a booking path with no exchange rate. Items carry
  // no per-item SEK column, so the rate is the only honest source; booking 1:1
  // would still balance (the 1510 debit is derived from the credits) while
  // understating ruta 05 and ruta 10 of the momsdeklaration. Sales-side twin of
  // SI_FX_RATE_MISSING.
  INVOICE_FX_RATE_MISSING: {
    httpStatus: 400,
    message_sv:
      'Fakturan är i utländsk valuta men saknar växelkurs. Ange fakturans växelkurs innan den bokförs: utan kurs kan beloppen inte räknas om till kronor och momsen blir fel.',
    message_en:
      'The invoice is in a foreign currency but has no exchange rate on file. Set the invoice exchange rate before booking; without it the amounts cannot be translated to SEK and the output VAT would be understated.',
    remediation: {
      description:
        'Set exchange_rate on the invoice (the rate at the taxable-event date) and retry. On an unbooked invoice, POST /api/invoices/{id}/refresh-exchange-rate fetches it from Riksbanken.',
    },
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
  INVOICE_SEND_TOO_MANY_RECIPIENTS: {
    httpStatus: 400,
    message_sv: 'Ett fakturautskick får ha högst 20 mottagare totalt.',
    message_en: 'An invoice email may have at most 20 recipients in total.',
    remediation: { description: 'Remove CC or BCC recipients before sending the invoice.' },
  },
  INVOICE_SEND_COMPANY_SETTINGS_MISSING: {
    httpStatus: 404,
    message_sv: 'Företagsinställningar saknas.',
    message_en: 'Company settings are missing.',
  },
  INVOICE_SEND_PAYMENT_ACCOUNT_MISSING: {
    httpStatus: 400,
    message_sv: 'Fakturan saknar ett betalningskonto för vald valuta. Lägg till kontot under Fakturering innan du skapar PDF-filen eller skickar fakturan.',
    message_en: 'The invoice has no payment account for its currency. Add the account under Invoicing before generating the PDF or sending the invoice.',
    remediation: {
      description: 'Lägg till ett betalningskonto med IBAN för fakturans valuta under Fakturering.',
    },
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
  INVOICE_SEND_SNAPSHOT_FAILED: {
    httpStatus: 500,
    message_sv: 'Utskicksinformationen kunde inte sparas. Ingen e-post skickades.',
    message_en: 'The delivery snapshot could not be saved. No email was sent.',
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
  INVOICE_PAYMENT_CONFIRMATION_NOT_PAID: {
    httpStatus: 409,
    message_sv:
      'En betalningsbekräftelse kan bara skapas för en faktura som är fullt betald.',
    message_en: 'A payment confirmation can only be produced for a fully paid invoice.',
    remediation: {
      description:
        'Register the payment first (POST /api/invoices/{id}/mark-paid) so the invoice reaches status paid; credit notes and proformas never qualify.',
    },
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
  // POST /api/invoices/{id}/refresh-exchange-rate: the repair path for a
  // foreign-currency invoice whose SEK conversion is missing or was stamped
  // from the wrong day's rate. It works on sent invoices (PATCH does not), but
  // stops at the verifikat.
  INVOICE_FX_REFRESH_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Fakturan är redan bokförd, så växelkursen kan inte räknas om här. Beloppen i kronor sitter i verifikatet och får bara ändras genom rättelse: makulera med storno och bokför om, eller rätta verifikatet inifrån (BFL 5 kap. 5 §).',
    message_en:
      'The invoice already has a verifikat, so its SEK conversion cannot be re-rated here. The SEK amounts are posted entries and may only be changed through one of the two sanctioned rättelse tracks (BFL 5 kap 5 §): storno + correcting entry, or the inline rättelse RPCs on an open unlocked period.',
    remediation: {
      description:
        'Reverse the invoice verifikat (gnubok_reverse_journal_entry) and rebook it with the correct rate, or correct it inline via gnubok_correct_entry while the period is still open and unlocked. Never update invoice.exchange_rate behind a posted entry.',
      tool: 'gnubok_reverse_journal_entry',
    },
  },
  INVOICE_FX_REFRESH_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsperioden för fakturadatumet är låst eller stängd, så växelkursen kan inte uppdateras. Öppna perioden eller rätta med storno i en öppen period.',
    message_en:
      'The fiscal period covering the invoice date is locked or closed, so the exchange rate cannot be updated. details.period_status carries the verdict; lookup_failed: true means the lock state could not be read and the request was refused fail-closed.',
    remediation: {
      description:
        'Unlock the period via gnubok_unlock_period (only if the status is "locked", not "closed"), then retry. Past a close, the correction belongs in an open period as a storno.',
      tool: 'gnubok_unlock_period',
    },
  },
  INVOICE_FX_REFRESH_RATE_UNAVAILABLE: {
    httpStatus: 502,
    message_sv:
      'Kunde inte hämta växelkursen från Riksbanken för leverans-/fakturadatumet. Fakturan är oförändrad: en gissad kurs får inte bokföras. Försök igen om en stund.',
    message_en:
      'No Riksbanken observation could be retrieved for the taxable-event date (delivery_date, falling back to invoice_date) and no cached rate was available either. The invoice was left unchanged rather than converted at an invented rate.',
    retryable: true,
    remediation: {
      description:
        'Retry once Riksbanken responds. The permitted rate sources are the Nasdaq OMX mid-rate published by Riksbanken or the latest ECB rate (ML 8 kap 21-23 §); never substitute an estimate.',
    },
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
  INVOICE_RECURRING_UPDATE_PARTIAL: {
    httpStatus: 500,
    message_sv:
      'Ändringen av det återkommande schemat kunde inte slutföras och schemat kan ha hamnat i ett halvsparat läge. Öppna schemat och kontrollera både fält och rader innan du sparar igen.',
    message_en:
      'The recurring schedule update failed and the compensating rollback did not fully apply: the schedule may be left in a partial state (header fields and items out of sync). Inspect the schedule fields and items before retrying.',
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
  // POST /api/invoices/{id}/peppol/send. The Access Point is an environment
  // decision (PEPPOL_TRANSPORT_PROVIDER + adapter credentials); the product
  // never pretends to send when no adapter is switched on.
  PEPPOL_TRANSPORT_UNAVAILABLE: {
    httpStatus: 503,
    message_sv: 'Peppol-utskick är inte aktiverat i den här miljön. En avtalad Peppol-operatör måste vara konfigurerad.',
    message_en: 'Peppol sending is not enabled in this environment. A contracted Peppol access point must be configured.',
  },
  PEPPOL_SEND_INVALID_STATUS: {
    httpStatus: 409,
    message_sv: 'Bara utkast och skickade fakturor kan skickas via Peppol. Makulerade, krediterade och proformafakturor kan inte skickas.',
    message_en: 'Only draft and sent invoices can be sent via Peppol. Cancelled, credited and proforma invoices cannot be sent.',
  },
  PEPPOL_RECIPIENT_NOT_REACHABLE: {
    httpStatus: 422,
    message_sv: 'Mottagaren är inte registrerad för att ta emot e-fakturor via Peppol. Kontrollera organisationsnumret eller skicka fakturan på annat sätt.',
    message_en: 'The recipient is not registered to receive e-invoices via Peppol. Check the organisation number or deliver the invoice another way.',
  },
  PEPPOL_SUBMISSION_REJECTED: {
    httpStatus: 422,
    message_sv: 'Peppol-operatören avvisade fakturan vid valideringen. Fakturan har inte skickats.',
    message_en: 'The Peppol access point rejected the invoice during validation. The invoice has not been sent.',
  },
  PEPPOL_SUBMISSION_FAILED: {
    httpStatus: 502,
    message_sv: 'Peppol-operatören kunde inte nås just nu. Fakturan har inte skickats; försök igen om en stund.',
    message_en: 'The Peppol access point could not be reached. The invoice has not been sent; try again shortly.',
  },
  // /api/settings/peppol: publishing a company's identifier for receiving.
  PEPPOL_RECEIVING_UNSUPPORTED: {
    httpStatus: 503,
    message_sv: 'Den konfigurerade Peppol-operatören stöder inte mottagning av e-fakturor.',
    message_en: 'The configured Peppol access point does not support receiving e-invoices.',
  },
  PEPPOL_SANDBOX_NOT_ALLOWED: {
    httpStatus: 403,
    message_sv: 'Peppol-registrering är inte tillgänglig i demobolaget. Skapa ett riktigt konto för att ta emot e-fakturor.',
    message_en: 'Peppol registration is not available in the demo company. Create a real account to receive e-invoices.',
  },
  PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED: {
    httpStatus: 422,
    message_sv: 'Bolaget behöver ett giltigt organisationsnummer i företagsinställningarna innan det kan ta emot e-fakturor via Peppol.',
    message_en: 'The company needs a valid organisation number in company settings before it can receive e-invoices via Peppol.',
  },
  PEPPOL_REGISTRATION_PERSONAL_NUMBER: {
    httpStatus: 422,
    message_sv: 'Enskild firma med personnummer kan ännu inte registreras för Peppol: det skulle publicera personuppgifter i Peppol-katalogen. Stöd för GLN-nummer kommer.',
    message_en: 'A sole trader identified by a personal identity number cannot be registered for Peppol yet: it would publish personal data in the Peppol directory. GLN support is coming.',
  },
  PEPPOL_REGISTRATION_COMPANY_NAME_REQUIRED: {
    httpStatus: 422,
    message_sv: 'Bolaget behöver ett företagsnamn i företagsinställningarna innan det kan registreras för Peppol.',
    message_en: 'The company needs a company name in company settings before it can be registered for Peppol.',
  },
  PEPPOL_REGISTRATION_FAILED: {
    httpStatus: 502,
    message_sv: 'Peppol-operatören kunde inte genomföra registreringen. Försök igen om en stund.',
    message_en: 'The Peppol access point could not complete the registration. Try again shortly.',
  },
  PEPPOL_REGISTRATION_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Bolaget är inte registrerat för Peppol-mottagning.',
    message_en: 'The company is not registered for Peppol receiving.',
  },
  // Peppol access is granted per company by the operators (#546): locked by
  // default, requested from settings, enabled with a sending cap.
  PEPPOL_ACCESS_REQUIRED: {
    httpStatus: 403,
    message_sv: 'Peppol är inte aktiverat för det här bolaget. Begär åtkomst under Inställningar > Fakturering > E-faktura via Peppol, så aktiverar vi det.',
    message_en: 'Peppol is not enabled for this company. Request access under Settings > Invoicing > E-invoicing via Peppol and we will enable it.',
  },
  PEPPOL_SEND_LIMIT_REACHED: {
    httpStatus: 409,
    message_sv: 'Bolaget har använt sina Peppol-sändningar. Hör av dig till support för fler.',
    message_en: 'The company has used its Peppol sends. Contact support for more.',
  },
  PEPPOL_RECEIVING_NOT_ENABLED: {
    httpStatus: 403,
    message_sv: 'Mottagning via Peppol är inte aktiverad för det här bolaget. Hör av dig till support så öppnar vi en plats.',
    message_en: 'Receiving via Peppol is not enabled for this company. Contact support and we will open a slot.',
  },
  PEPPOL_ACCESS_ALREADY_ENABLED: {
    httpStatus: 409,
    message_sv: 'Peppol är redan aktiverat för bolaget.',
    message_en: 'Peppol is already enabled for the company.',
  },
  PEPPOL_REGISTRATION_CAP_REACHED: {
    httpStatus: 409,
    message_sv: 'Alla platser för Peppol-mottagning är upptagna just nu. Hör av dig till support så öppnar vi fler. Att skicka e-fakturor fungerar ändå.',
    message_en: 'All Peppol receiving slots are taken right now. Contact support and we will open more. Sending e-invoices works regardless.',
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
    message_sv: 'Fakturan är redan godkänd eller kan inte godkännas i nuvarande status.',
    message_en: 'The invoice is already approved, or cannot be approved in its current status.',
  },
  SI_EDIT_CONFLICT: {
    httpStatus: 409,
    message_sv:
      'Leverantörsfakturan ändrades av någon annan (eller av den dagliga förfallokontrollen) medan du redigerade. Ladda om fakturan och försök igen.',
    message_en:
      'The supplier invoice changed elsewhere (or in the daily overdue check) while you were editing. Reload the invoice and try again.',
  },
  SI_EDIT_INVALID_STATUS: {
    httpStatus: 400,
    message_sv:
      'Bara obetalda leverantörsfakturor kan redigeras. Betalda, krediterade och återförda fakturor rättas genom kreditfaktura eller storno.',
    message_en:
      'Only unsettled supplier invoices can be edited. Paid, credited and reversed invoices are corrected with a credit note or a storno.',
  },
  SI_EDIT_VERIFIKAT_LOCKED: {
    httpStatus: 400,
    message_sv:
      'Fakturadatum och fakturanummer står på det bokförda verifikatet och kan inte ändras här. ' +
      'Rätta verifikatet (rättelse i öppen period, annars storno + ny bokföring) eller kreditera fakturan. ' +
      'Förfallodatum, betalningsreferens och anteckningar går fortfarande att ändra.',
    message_en:
      'Invoice date and invoice number are part of the posted verifikat and cannot be changed here. ' +
      'Correct the entry instead (inline rättelse in an open period, otherwise storno + re-book), or credit the invoice. ' +
      'due_date, payment_reference and notes remain editable.',
    remediation: {
      description:
        'Correct the registration verifikat through a sanctioned rättelse path, or credit the supplier invoice and register a corrected one.',
      tool: 'gnubok_correct_entry',
    },
  },
  SI_APPROVE_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte godkänna leverantörsfakturan.',
    message_en: 'Failed to update supplier invoice status to approved.',
  },
  SI_BOOK_ALREADY_BOOKED: {
    httpStatus: 400,
    message_sv: 'Leverantörsfakturan är redan bokförd.',
    message_en: 'The supplier invoice is already booked.',
  },
  SI_BOOK_INVALID_STATUS: {
    httpStatus: 400,
    message_sv: 'Endast registrerade, godkända eller förfallna fakturor kan bokföras i efterhand.',
    message_en: 'Only registered, approved or overdue invoices can be booked afterwards.',
  },
  SI_BOOK_NOT_BOOKABLE: {
    httpStatus: 400,
    message_sv: 'Kreditfakturor bokförs inte via detta steg.',
    message_en: 'Credit notes are not booked through this step.',
  },
  SI_BOOK_CASH_METHOD: {
    httpStatus: 400,
    message_sv: 'Vid kontantmetoden bokförs fakturan när den betalas.',
    message_en: 'Under the cash method the invoice is booked when it is paid.',
  },
  SI_BOOK_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv: 'Inget öppet räkenskapsår täcker fakturadatumet. Skapa räkenskapsåret först.',
    message_en: 'No open fiscal period covers the invoice date. Create the fiscal year first.',
  },
  SI_BOOK_CONFLICT: {
    httpStatus: 409,
    message_sv: 'Leverantörsfakturan bokfördes samtidigt av en annan begäran. Ladda om sidan.',
    message_en: 'The supplier invoice was booked concurrently by another request. Reload the page.',
  },
  SI_BOOK_FAILED: {
    httpStatus: 500,
    message_sv: 'Leverantörsfakturan kunde inte bokföras.',
    message_en: 'Failed to book the supplier invoice.',
  },
  // Raised by lib/bookkeeping/supplier-invoice-entries.ts when a
  // foreign-currency invoice reaches a booking path with no exchange rate.
  // Booking it 1:1 would balance but understate the fiktiv moms on 2614/2645
  // and therefore rutorna 20-24 + 30-32 of the momsdeklaration.
  SI_FX_RATE_MISSING: {
    httpStatus: 400,
    message_sv:
      'Leverantörsfakturan är i utländsk valuta men saknar växelkurs. Ange fakturans växelkurs innan den bokförs: utan kurs kan beloppen inte räknas om till kronor och momsen blir fel.',
    message_en:
      'The supplier invoice is in a foreign currency but has no exchange rate on file. Set the invoice exchange rate before booking; without it the amounts cannot be translated to SEK and the reverse-charge VAT would be understated.',
    remediation: {
      description:
        'Set exchange_rate on the supplier invoice (the rate at the invoice date) and retry the booking.',
    },
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
  FISCAL_YEAR_RESET_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsåret kunde inte hittas.',
    message_en: 'Fiscal year not found.',
  },
  FISCAL_YEAR_RESET_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Endast företagets ägare eller administratörer kan nollställa ett räkenskapsår.',
    message_en: 'Only company owners and admins can reset a fiscal year.',
  },
  FISCAL_YEAR_RESET_INELIGIBLE: {
    httpStatus: 409,
    message_sv: 'Räkenskapsåret kan inte nollställas i sitt nuvarande läge.',
    message_en: 'The fiscal year cannot be reset in its current state.',
  },
  FISCAL_YEAR_RESET_CONFIRMATION_MISMATCH: {
    httpStatus: 400,
    message_sv: 'Räkenskapsårets namn stämmer inte överens.',
    message_en: 'The fiscal year name does not match.',
  },
  FISCAL_YEAR_RESET_LINKED_ENTRIES: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsåret innehåller verifikat som är kopplade till andra poster (t.ex. anläggningstillgångar, periodiseringar eller lönekörningar). Ta bort eller ångra de kopplade flödena först. Inga ändringar har sparats.',
    message_en:
      'The fiscal year contains vouchers linked to other records (e.g. assets, accrual schedules or salary runs). Undo those flows first. No changes were saved.',
  },
  FISCAL_YEAR_RESET_FAILED: {
    httpStatus: 500,
    message_sv: 'Räkenskapsåret kunde inte nollställas. Inga ändringar har sparats.',
    message_en: 'Failed to reset the fiscal year. No changes were saved.',
  },
  // Retired 2026-07-26: PERIOD_CREATE_BLOCKED_BY_OPEN_PERIODS. Creating the
  // next räkenskapsår while a prior one is still fully open is no longer an
  // error at all: BFL 5 kap 2 § forces the new year's affärshändelser to be
  // booked within weeks (which needs a räkenskapsår covering them) while BFL
  // 6 kap gives the prior year six months to be finished, so running both in
  // parallel is the mandated state, not an edge case. The detection now rides
  // along as a non-blocking `warnings: [{ code: 'PRIOR_FISCAL_YEAR_STILL_OPEN',
  // message }]` on the 200 (app/api/bookkeeping/fiscal-periods), which needs no
  // registry entry: warnings are not thrown errors. Do not re-add this code.
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
  YEAR_END_NO_ACTIVITY: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsperioden saknar bokförd aktivitet och kan därför inte skapa en bokslutsverifikation. Bokför eller importera periodens affärshändelser innan du kör bokslutet.',
    message_en:
      'The fiscal period has no posted activity, so no year-end voucher can be created. Post or import the period activity before running year-end closing.',
    retryable: false,
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
  FX_CLOSING_RATE_UNAVAILABLE: {
    httpStatus: 502,
    message_sv:
      'Ingen valutakurs från Riksbanken finns för balansdagen. Valutaomvärderingen har inte bokförts: en uppskattad kurs får inte bokföras mot 3960/7960 (ÅRL 4 kap. 13 §). Försök igen när kursen är publicerad.',
    message_en:
      'No Riksbanken observation is available for the closing date. The revaluation was refused rather than posted from an estimated rate; details.missingRates lists each currency and date.',
    retryable: true,
    remediation: {
      description:
        'Retry once Riksbanken has published the closing-date rate, or run the revaluation for a closing date that has a published observation.',
    },
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
  REPORT_PDF_TOO_LARGE: {
    httpStatus: 413,
    message_sv: 'Rapporten är för stor för PDF. Ladda ner den som CSV eller Excel i stället.',
    message_en: 'The report is too large for PDF. Download it as CSV or Excel instead.',
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
  SIE_REPLACE_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Endast ägare eller administratörer kan ersätta en SIE-import.',
    message_en: 'Only company owners and admins can replace an SIE import.',
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
  BANK_FILE_SKATTEKONTO_DETECTED: {
    httpStatus: 400,
    message_sv:
      'Filen ser ut som ett skattekontoutdrag från Skatteverket. Använd Skattekonto-importen i stället.',
    message_en:
      'This file looks like a Skatteverket tax account statement. Use the skattekonto import instead.',
  },
  BANK_FILE_UNDO_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Bankfilsimporten kunde inte hittas.',
    message_en: 'Bank file import not found.',
  },
  BANK_FILE_UNDO_FAILED: {
    httpStatus: 400,
    message_sv: 'Bankfilsimporten kunde inte ångras.',
    message_en: 'Failed to undo bank file import.',
  },
  BANK_FILE_UNDO_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Endast ägare eller administratörer kan ångra en bankfilsimport.',
    message_en: 'Only company owners and admins can undo a bank file import.',
  },
  BANK_FILE_LIST_INVALID_QUERY: {
    httpStatus: 400,
    message_sv: 'Ogiltiga listparametrar: limit måste vara 1-100, offset ett icke-negativt heltal och status ett giltigt importstatus.',
    message_en: 'Invalid list parameters: limit must be 1-100, offset a nonnegative integer, and status a valid import status.',
  },
}

const SKATTEKONTO_FILE: Record<string, StructuredErrorEntry> = {
  SKATTEKONTO_FILE_NO_FILE: {
    httpStatus: 400,
    message_sv: 'Ingen fil bifogad i förfrågan.',
    message_en: 'No file attached to the request.',
  },
  SKATTEKONTO_FILE_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Filen är för stor. Maxstorlek är 10 MB.',
    message_en: 'File exceeds the 10 MB size limit.',
  },
  SKATTEKONTO_FILE_DUPLICATE: {
    httpStatus: 409,
    message_sv: 'Det här kontoutdraget har redan importerats.',
    message_en: 'This tax account statement has already been imported.',
  },
  SKATTEKONTO_FILE_PARSE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte tolka skattekontoutdraget.',
    message_en: 'Failed to parse the tax account statement.',
  },
  SKATTEKONTO_FILE_NOT_RECOGNIZED: {
    httpStatus: 400,
    message_sv:
      'Filen känns inte igen som ett skattekontoutdrag. Ladda ner kontohändelserna från Skatteverkets e-tjänst Skattekonto och försök igen.',
    message_en:
      'The file was not recognized as a tax account statement. Download the account events from Skatteverket and try again.',
  },
  SKATTEKONTO_FILE_NO_ROWS: {
    httpStatus: 400,
    message_sv: 'Kontoutdraget innehåller inga händelser att importera.',
    message_en: 'No account events to import.',
  },
  SKATTEKONTO_FILE_IMPORT_RECORD_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte skapa importpost.',
    message_en: 'Failed to create the import record.',
  },
  SKATTEKONTO_FILE_EXECUTE_FAILED: {
    httpStatus: 500,
    message_sv: 'Importen av skattekontoutdraget misslyckades.',
    message_en: 'Tax account statement import failed.',
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
    message_sv: 'Kunde inte kontrollera integrationsuppgifterna hos leverantören. Försök igen.',
    message_en: 'Could not verify the integration details with the provider. Try again.',
  },
  PROVIDER_TOKEN_INVALID: {
    // 422 (not 401): the UPSTREAM provider rejected the pasted credentials.
    // The caller's own session is fine: a 401 here can trip client-side auth
    // interceptors into logging the user out. Clients must dispatch on the
    // error code, never on the HTTP status.
    httpStatus: 422,
    message_sv:
      'Leverantören avvisade autentiseringen. Kontrollera integrationsuppgifterna och försök igen.',
    message_en:
      'The provider rejected the authentication. Check the integration details and try again.',
  },
  BOKIO_COMPANY_NOT_FOUND: {
    httpStatus: 422,
    message_sv:
      'Bokio hittade inte företaget. Kontrollera företags-ID:t och att integrationstoken skapades för samma företag.',
    message_en:
      'Bokio could not find the company. Check the company ID and that the integration token was created for the same company.',
  },
  PROVIDER_COMPANY_MISMATCH: {
    // 422, same reasoning as PROVIDER_TOKEN_INVALID: the credentials are valid,
    // but they open a DIFFERENT legal entity than the one being imported into.
    // Importing anyway mixes another company's ledger into this one, which is
    // both a bookkeeping and a data-protection problem: refuse at the boundary.
    httpStatus: 422,
    message_sv:
      'Uppgifterna gäller ett annat företag än det du importerar till. Kontrollera att du valt rätt företag hos leverantören och försök igen.',
    message_en:
      'These credentials belong to a different company than the one you are importing into. Check that you picked the right company at the provider and try again.',
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
  // Same-origin storage proxy (/api/storage): signed Storage URLs served
  // from the app's own host for agent sandboxes that only reach the MCP host.
  STORAGE_PROXY_UNSUPPORTED_PATH: {
    httpStatus: 404,
    message_sv: 'Sökvägen stöds inte av lagringsproxyn.',
    message_en: 'The storage proxy does not serve this path.',
  },
  STORAGE_PROXY_TOKEN_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Länken saknar sin signerade token.',
    message_en: 'The link is missing its signed token.',
  },
  STORAGE_PROXY_BODY_TOO_LARGE: {
    httpStatus: 413,
    message_sv: 'Filen är för stor för att laddas upp via länken.',
    message_en: 'The file is too large to upload through this link.',
  },
  STORAGE_PROXY_UNCONFIGURED: {
    httpStatus: 503,
    message_sv: 'Lagringen är inte konfigurerad på den här servern.',
    message_en: 'Storage is not configured on this server.',
  },
  STORAGE_PROXY_UPSTREAM_UNAVAILABLE: {
    httpStatus: 502,
    message_sv: 'Lagringen svarade inte.',
    message_en: 'Storage did not respond.',
  },
  PROVIDER_DOCUMENT_SCOPES_REQUIRED: {
    httpStatus: 403,
    message_sv:
      'Fortnox-anslutningen saknar behörighet till Arkiv och Koppla fil. Koppla om Fortnox och godkänn behörigheterna för att importera underlag.',
    message_en:
      'The Fortnox connection lacks Archive and Connect file access. Reconnect Fortnox and approve those permissions to import documents.',
  },
  PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE: {
    httpStatus: 403,
    message_sv:
      'Filimport från Fortnox är inte påslagen än: behörigheterna Arkiv och Koppla fil saknas för Accounted-integrationen hos Fortnox. Att koppla om hjälper inte, vi aktiverar det så snart behörigheten är på plats. Allt annat i migreringen är importerat.',
    message_en:
      'Fortnox file import is not enabled yet: the Archive and Connect file permissions are missing for the Accounted integration at Fortnox. Reconnecting will not help; we enable this as soon as the permission is in place. Everything else in the migration was imported.',
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
  UNDERLAG_REF_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Filnamnet pekar inte på den verifikation som valdes. Ladda om förhandsgranskningen och försök igen.',
    message_en:
      'The filename does not point at the selected verifikat. Reload the preview and try again.',
  },
  UNDERLAG_PERIOD_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Verifikationen tillhör ett annat räkenskapsår än det du valde för underlagen. Ladda om förhandsgranskningen och försök igen.',
    message_en:
      'The verifikat belongs to a different fiscal year than the one selected for these files. Reload the preview and try again.',
  },
  UNDERLAG_ENTRY_NOT_POSTED: {
    httpStatus: 409,
    message_sv: 'Verifikationen är inte bokförd, så underlag kan inte kopplas till den ännu.',
    message_en: 'The journal entry is not posted, so documents cannot be attached to it yet.',
  },
  UNDERLAG_ENTRY_NOT_MIGRATED: {
    httpStatus: 400,
    message_sv: 'Verifikationen kommer inte från en SIE-import och kan inte matchas mot filnamn.',
    message_en: 'The journal entry did not come from a SIE import and cannot be matched by filename.',
  },
}

// Invoice-inbox manual upload and attach-document (extension REST routes).
const INBOX_UPLOAD: Record<string, StructuredErrorEntry> = {
  INBOX_UPLOAD_NO_FILE: {
    httpStatus: 400,
    message_sv: 'Ingen fil bifogad.',
    message_en: 'No file attached.',
  },
  INBOX_UPLOAD_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Filen är för stor. Maxstorlek är 10 MB.',
    message_en: 'File exceeds the 10 MB size limit.',
  },
  INBOX_UPLOAD_UNSUPPORTED_TYPE: {
    httpStatus: 400,
    message_sv: 'Filtypen stöds inte. Tillåtna format: PDF, JPEG, PNG, HEIC och WebP.',
    message_en: 'Unsupported file type. Allowed: PDF, JPEG, PNG, HEIC, WebP.',
  },
  INBOX_UPLOAD_TX_NOT_IN_COMPANY: {
    httpStatus: 400,
    message_sv: 'Den angivna transaktionen (matched_transaction_id) tillhör ett annat företag.',
    message_en: 'matched_transaction_id refers to a transaction outside this company.',
  },
  INBOX_UPLOAD_FAILED: {
    httpStatus: 500,
    message_sv: 'Uppladdningen misslyckades. Försök igen.',
    message_en: 'Upload failed.',
  },
  INBOX_ATTACH_FAILED: {
    httpStatus: 500,
    message_sv: 'Bilagan kunde inte kopplas. Försök igen.',
    message_en: 'Failed to attach the document.',
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
  CUSTOMER_NO_PERSONAL_NUMBER: {
    httpStatus: 404,
    message_sv: 'Kunden har inget sparat personnummer.',
    message_en: 'No personal number is stored for this customer.',
  },
  // The stored ciphertext could not be decrypted (written under a different
  // PERSONNUMMER_ENCRYPTION_KEY, or corrupted). Deliberately not an
  // INTERNAL_ERROR: it is not transient, retrying never helps, and the user
  // can fix it in one step by typing the personnummer in again.
  CUSTOMER_PERSONAL_NUMBER_UNREADABLE: {
    httpStatus: 422,
    message_sv:
      'Det sparade personnumret kan inte läsas. Skriv in det igen för att ersätta det.',
    message_en:
      'The stored personal number cannot be read. Enter it again to replace it.',
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
  INVOICE_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturan kunde inte tas bort eller makuleras.',
    message_en: 'The invoice could not be deleted or cancelled.',
  },
  CUSTOMER_PERSONAL_NUMBER_NOT_ALLOWED: {
    httpStatus: 400,
    message_sv: 'Personnummer kan endast sparas för privatkunder.',
    message_en: 'Personal numbers can only be stored for individual customers.',
  },
  CUSTOMER_ORG_NUMBER_IS_PERSONAL: {
    httpStatus: 400,
    message_sv:
      'Organisationsnumret ser ut som ett personnummer. Spara kunden som privatperson i stället, så lagras numret skyddat och maskeras i listor.',
    message_en:
      'The org number looks like a Swedish personal identity number. Save the customer as an individual instead, so the number is stored protected and masked in lists.',
  },
  CUSTOMER_PERSONAL_NUMBER_CONFLICT: {
    httpStatus: 400,
    message_sv:
      'Kunden fick två olika personnummer: ett i fältet personnummer och ett i fältet organisationsnummer. En privatperson har sitt personnummer i fältet personnummer; lämna organisationsnumret tomt.',
    message_en:
      'The customer was given two different personal identity numbers: one in personal_number and one in org_number. An individual customer keeps its personnummer in personal_number; leave org_number empty.',
  },
  ARTICLE_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Artikeln kunde inte tas bort.',
    message_en: 'Failed to delete article.',
  },
  ARTICLE_IN_USE: {
    httpStatus: 409,
    message_sv:
      'Artikeln har använts på en faktura och kan därför inte tas bort. Inaktivera den i stället om du inte vill kunna välja den på nya fakturor.',
    message_en:
      'The article has been used on an invoice and cannot be deleted. Deactivate it instead if you no longer want it selectable on new invoices.',
  },
  ARTICLE_REVENUE_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Bokföringskontot finns inte eller är inte ett aktivt balans- eller intäktskonto (klass 1-3).',
    message_en: 'The posting account does not exist or is not an active balance-sheet or revenue account (class 1-3).',
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
  SI_CREATE_SLP_INVALID_ACCOUNT: {
    httpStatus: 400,
    message_sv:
      'Särskild löneskatt kan bara läggas till på rader med pensionskonto 7410-7419 (t.ex. 7412 Premier för tjänstepensioner). Byt konto på raden eller ta bort löneskatten.',
    message_en:
      'Särskild löneskatt (payroll tax on pension costs) can only be added on lines booked to a pension account 7410-7419 (e.g. 7412 occupational pension premiums). Change the line account or remove the flag.',
  },
  SI_CREATE_SLP_ACCRUAL: {
    httpStatus: 400,
    message_sv:
      'Särskild löneskatt kan inte kombineras med periodisering på samma rad. Löneskatten (7533/2514) beräknas på hela radbeloppet vid registrering och kan inte skjutas upp.',
    message_en:
      'Särskild löneskatt cannot be combined with periodisering on the same line. The payroll tax (7533/2514) is computed on the full line amount at registration and cannot be deferred.',
  },
  SI_DELETE_HAS_BOOKING: {
    httpStatus: 400,
    message_sv:
      'Leverantörsfakturan är bokförd, har registrerade betalningar eller en periodisering och kan inte tas bort. Skapa en kreditfaktura i stället för att återställa bokföringen.',
    message_en:
      'The supplier invoice has a posted journal entry, recorded payments, or an accrual schedule and cannot be deleted. Create a credit note instead to reverse the bookkeeping.',
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
  SI_BATCH_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Betalfilen kunde inte hittas.',
    message_en: 'Payment batch not found.',
  },
  SI_BATCH_INELIGIBLE_INVOICE: {
    httpStatus: 400,
    message_sv:
      'En eller flera fakturor kan inte ingå i betalfilen. Se detaljerna för orsak per faktura.',
    message_en:
      'One or more invoices cannot be included in the payment batch. See details for the per-invoice reason.',
  },
  SI_BATCH_INVALID_AMOUNT: {
    httpStatus: 400,
    message_sv: 'Betalbeloppet måste vara större än noll.',
    message_en: 'The payment amount must be greater than zero.',
  },
  SI_BATCH_AMOUNT_EXCEEDS_REMAINING: {
    httpStatus: 400,
    message_sv: 'Betalbeloppet är större än kvar att betala på fakturan.',
    message_en: "The payment amount exceeds the invoice's remaining amount.",
  },
  SI_BATCH_DUPLICATE_INVOICE: {
    httpStatus: 409,
    message_sv:
      'En eller flera fakturor ingår redan i en aktiv betalfil. Bekräfta att du vill skapa en ny betalning ändå.',
    message_en:
      'One or more invoices are already part of an active payment batch. Confirm to create another payment anyway.',
    remediation: {
      description:
        'Resend with confirm_already_batched: true to include the invoices anyway, or cancel the existing batch first via POST /api/supplier-invoices/payment-batches/{id}/cancel.',
    },
  },
  SI_BATCH_DEBTOR_INCOMPLETE: {
    httpStatus: 400,
    message_sv:
      'Företagets bankuppgifter är ofullständiga. Fyll i IBAN (och BIC om det inte kan härledas) under Inställningar → Fakturering.',
    message_en:
      'The company bank details are incomplete. Enter the IBAN (and BIC if it cannot be derived) under Settings → Invoicing.',
  },
  SI_BATCH_CANCELLED: {
    httpStatus: 409,
    message_sv: 'Betalfilen är makulerad och kan inte laddas ner.',
    message_en: 'The payment batch is cancelled and cannot be downloaded.',
  },
  SI_BATCH_ALREADY_CANCELLED: {
    httpStatus: 409,
    message_sv: 'Betalfilen är redan makulerad.',
    message_en: 'The payment batch is already cancelled.',
  },
  SI_BATCH_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte skapa betalfilen.',
    message_en: 'Failed to create the payment batch.',
  },
  SI_DELETE_IN_PAYMENT_BATCH: {
    httpStatus: 409,
    message_sv:
      'Leverantörsfakturan ingår i en betalfil och kan inte tas bort: betalfilens rader är underlag för betalningsinstruktionen, även om filen makulerats.',
    message_en:
      'The supplier invoice is part of a payment batch and cannot be deleted: the batch rows document the payment instruction, even if the batch was cancelled.',
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
  SALARY_RUN_LINE_NOT_DRAFT: {
    httpStatus: 400,
    message_sv: 'Lönebeskedets rader kan bara redigeras medan lönekörningen är ett utkast.',
    message_en: 'Payslip lines can only be edited while the salary run is a draft.',
  },
  SALARY_RUN_EMPLOYEE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Anställd finns inte i denna lönekörning.',
    message_en: 'Employee is not part of this salary run.',
  },
  SALARY_LINE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Lönebeskedsraden kunde inte hittas.',
    message_en: 'Payslip line not found.',
  },
  SALARY_RUN_EMPLOYEE_DUPLICATE: {
    httpStatus: 409,
    message_sv: 'Den anställda finns redan i lönekörningen.',
    message_en: 'Employee is already part of this salary run.',
  },
  SALARY_RUN_EMPLOYEES_NOT_DRAFT: {
    httpStatus: 400,
    message_sv: 'Anställda kan bara läggas till eller tas bort medan lönekörningen är ett utkast.',
    message_en: 'Employees can only be added or removed while the salary run is a draft.',
  },
  ABSENCE_RANGE_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Frånvarointervallet är för stort. Max 92 dagar per anrop.',
    message_en: 'Absence range too large. Maximum 92 days per request.',
  },
  ABSENCE_HOURS_CONFLICT: {
    httpStatus: 409,
    message_sv: 'Total frånvarotid för dagen överstiger 24 timmar.',
    message_en: 'Total absence hours for the day exceed 24 hours.',
  },
  OPENING_BALANCES_LOCKED: {
    httpStatus: 409,
    message_sv: 'Ingående saldon är låsta: den anställda har en bokförd lönekörning.',
    message_en: 'Opening balances are locked: the employee has a booked salary run.',
  },
  VACATION_YEAR_NOT_ENDED: {
    httpStatus: 400,
    message_sv: 'Semesteråret kan inte stängas innan det har tagit slut.',
    message_en: 'The vacation year cannot be closed before it has ended.',
  },
  VACATION_YEAR_ALREADY_CLOSED: {
    httpStatus: 409,
    message_sv: 'Semesteråret är redan stängt.',
    message_en: 'The vacation year is already closed.',
  },
  VACATION_CLOSE_ADJUSTMENT_FAILED: {
    httpStatus: 500,
    message_sv: 'Semestersaldon rullades men justeringsverifikationen kunde inte bokföras. Bokför justeringen manuellt från rapporten.',
    message_en: 'Vacation balances rolled but the adjustment entry failed to post. Book the adjustment manually from the report.',
  },
  VACATION_BALANCE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Inget semestersaldo finns för den anställda ännu.',
    message_en: 'No vacation balance exists for the employee yet.',
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
  SALARY_RUN_ALREADY_BOOKED: {
    httpStatus: 409,
    message_sv: 'Lönekörningen är redan bokförd.',
    message_en: 'Salary run is already booked.',
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
  // An API key minted for an account that has not created its first company
  // yet (signup from the MCP OAuth popup, issue #1814). Not a lookup miss:
  // there is nothing to look up until the company exists.
  NO_COMPANY_YET: {
    httpStatus: 409,
    message_sv: 'Kontot har inget företag ännu. Skapa företaget i appen och försök igen.',
    message_en: 'This account has no company yet. Create the company in the web app, then retry; the connection picks it up automatically.',
    remediation: {
      description:
        'Ask the user to finish company setup in the Accounted web app (/onboarding). No re-authentication is needed afterwards: the same connection binds to the new company on its next call.',
      tool: 'gnubok_list_companies',
    },
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
  COMPANY_RESET_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Företaget kunde inte hittas.',
    message_en: 'Company not found.',
  },
  COMPANY_RESET_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Endast företagets ägare kan starta om en migrering.',
    message_en: 'Only the company owner can reset a migration.',
  },
  COMPANY_RESET_INELIGIBLE: {
    httpStatus: 409,
    message_sv: 'Företaget kan inte återställas med självservice. Kontakta supporten för en individuell bedömning.',
    message_en: 'The company is not eligible for a self-service reset. Contact support for an individual review.',
  },
  COMPANY_RESET_CONFIRMATION_MISMATCH: {
    httpStatus: 400,
    message_sv: 'Företagsnamnet stämmer inte överens.',
    message_en: 'The company name does not match.',
  },
  COMPANY_RESET_REASON_INVALID: {
    httpStatus: 400,
    message_sv: 'Beskriv varför migreringen behöver göras om med 20 till 1 000 tecken.',
    message_en: 'Explain why the migration must be redone using 20 to 1,000 characters.',
  },
  COMPANY_RESET_CONFIRMATION_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Alla säkerhetsbekräftelser krävs.',
    message_en: 'All safety confirmations are required.',
  },
  COMPANY_RESET_FAILED: {
    httpStatus: 500,
    message_sv: 'Migreringen kunde inte startas om. Inga ändringar har sparats.',
    message_en: 'The migration reset failed. No changes were saved.',
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
  PROVIDER_API_MODULE_INACTIVE: {
    httpStatus: 403,
    message_sv:
      'Visma nekade åtkomst eftersom API-modulen inte är aktiverad för företaget ("No access to module: api_standard"). Aktivera API:et i Visma/Spiris under Inställningar, Appar och tillägg. På de mindre abonnemangen är API:et ett tillägg (Integration) som kostar extra. Kontrollera också att inget standardföretag är valt i menyn uppe till höger i Visma, det kan göra att inloggningen hamnar på ett företag utan giltig licens. Försök sedan igen. Du kan även importera via SIE-fil under tiden.',
    message_en:
      'Visma refused access because the API module is not activated for the company ("No access to module: api_standard"). Activate the API in Visma/Spiris under Settings, Apps and extensions (on smaller plans the API is a paid add-on called Integration), and make sure no default company is selected in the top-right menu. Then try again. You can also import via SIE file in the meantime.',
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
    remediation: {
      description:
        'POST /api/invoices/{id}/refresh-exchange-rate fetches the taxable-event rate from Riksbanken and fills in exchange_rate plus the *_sek columns, then retry the allocation. It refuses with INVOICE_FX_REFRESH_BOOKED once the invoice has a verifikat: from there the correction is a storno or an inline rättelse, never an update behind the posted entry.',
    },
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
  BULK_BOOK_FOREIGN_CURRENCY: {
    httpStatus: 400,
    message_sv:
      'Samlingsbokföring stödjer endast transaktioner i SEK. Bokför transaktioner i utländsk valuta enskilt, så att beloppet räknas om till kronor med rätt växelkurs.',
    message_en:
      'Bulk booking supports only SEK transactions. Book foreign-currency transactions individually so the amount is converted to kronor at the correct exchange rate.',
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
  // One code covers both never-connected and expired: splitting it would
  // ripple through every consumer, and the declaration-status path already
  // differentiates in its message (DECISIONS.md 2026-08-25). The copy is
  // agent-directive on purpose: only a person can run the BankID flow, so
  // the agent must hand the task to the user instead of retrying.
  SKATTEVERKET_NOT_CONNECTED: {
    httpStatus: 401,
    message_sv:
      'Anslutningen till Skatteverket saknas eller har gått ut. Om företaget varit anslutet tidigare är detta normalt: Skatteverkets personliga inloggning gäller bara ca 1 timme. Be användaren ansluta (igen) med BankID under Inställningar → Skatteverket.',
    message_en:
      'The Skatteverket connection is missing or has expired. If the company was connected before this is expected: Skatteverket personal sessions last only about 1 hour. Tell the user to connect (or reconnect) with BankID under Inställningar → Skatteverket in Accounted. Only a person can do this; do not retry until they confirm they have reconnected.',
    remediation: {
      description:
        'A person must connect (or reconnect) to Skatteverket with BankID under Inställningar → Skatteverket. Personal Skatteverket sessions expire after about 1 hour by SKV design, so an expired session is normal, not a fault. Do not retry until the user confirms they have reconnected.',
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
  SKATTEVERKET_API_ERROR: {
    httpStatus: 502,
    message_sv: 'Skatteverkets tjänst svarade med ett fel. Se detaljerna och försök igen.',
    message_en: 'The Skatteverket API returned an error. See details for the upstream message.',
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
  BOLAGSVERKET_NOT_RELEASED: {
    httpStatus: 503,
    message_sv:
      'Direktinlämning till Bolagsverket är inte öppnad i den här installationen. Använd pappersflödet tills anslutningen är godkänd.',
    message_en:
      'Connected filing to Bolagsverket is not enabled for this installation. Use the paper flow until acceptance is complete.',
    retryable: false,
  },
  BOLAGSVERKET_VERSION_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Den valda versionen av årsredovisningen finns inte.',
    message_en: 'The selected annual report version was not found.',
    retryable: false,
  },
  BOLAGSVERKET_VERSION_NOT_SIGNED: {
    httpStatus: 409,
    message_sv: 'Årsredovisningsversionen måste vara låst och undertecknad före inlämning.',
    message_en: 'The annual report version must be finalized and signed before submission.',
    retryable: false,
  },
  BOLAGSVERKET_DIGITAL_INELIGIBLE: {
    httpStatus: 409,
    message_sv:
      'Den låsta årsredovisningsversionen är inte godkänd för digital inlämning. Använd pappersflödet och följ kontrollpunkterna i årsredovisningsstudion.',
    message_en:
      'The locked annual report version is not eligible for connected filing. Use the paper workflow and review the Annual Report Studio checks.',
    retryable: false,
  },
  BOLAGSVERKET_SIGNATURE_EVIDENCE_INCOMPLETE: {
    httpStatus: 409,
    message_sv: 'Verifierbart underskriftsunderlag saknas för en eller flera undertecknare.',
    message_en: 'Verifiable signature evidence is missing for one or more required signers.',
    retryable: false,
  },
  BOLAGSVERKET_CERTIFICATE_SIGNER_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Undertecknaren av fastställelseintyget stämmer inte med den person som låstes i årsredovisningsversionen.',
    message_en:
      'The certificate signer does not match the person locked into the annual report version.',
    retryable: false,
  },
  BOLAGSVERKET_ARELLE_UNAVAILABLE: {
    httpStatus: 503,
    message_sv:
      'Taxonomivalideringen med Arelle är inte tillgänglig. Inlämningen har stoppats innan något skickades.',
    message_en:
      'Arelle taxonomy validation is unavailable. Filing was stopped before anything was sent.',
    retryable: true,
  },
  BOLAGSVERKET_ARELLE_FAILED: {
    httpStatus: 409,
    message_sv:
      'Arelle hittade blockerande fel i iXBRL-dokumentet. Rätta felen och skapa en ny version.',
    message_en:
      'Arelle found blocking errors in the iXBRL document. Correct them and create a new version.',
    retryable: false,
  },
  ARSREDOVISNING_INCOMPLETE: {
    httpStatus: 409,
    message_sv: 'Årsredovisningen har blockerande kontrollfel och kan inte versionssparas ännu.',
    message_en: 'The annual report has blocking validation errors and cannot be versioned yet.',
    retryable: false,
  },
  ARSREDOVISNING_VERSION_NOT_SIGNABLE: {
    httpStatus: 409,
    message_sv: 'Den valda årsredovisningsversionen är inte öppen för underskrift.',
    message_en: 'The selected annual report version is not open for signing.',
    retryable: false,
  },
  ARSREDOVISNING_SIGNATURE_DATE_INVALID: {
    httpStatus: 400,
    message_sv:
      'Underskriftsdatumet måste vara samma dag som eller senare än versionens låsdatum och får inte ligga i framtiden.',
    message_en:
      'The signature date must be on or after the version finalization date and cannot be in the future.',
    retryable: false,
  },
  ARSREDOVISNING_SIGNER_ROSTER_LOCKED: {
    httpStatus: 409,
    message_sv:
      'Undertecknarlistan är låst eftersom en årsredovisningsversion redan väntar på underskrift.',
    message_en:
      'The signer roster is locked because an annual report version is already awaiting signatures.',
    retryable: false,
  },
  ARSREDOVISNING_SIGNER_ALREADY_EXISTS: {
    httpStatus: 409,
    message_sv: 'Undertecknaren finns redan i den aktuella undertecknarlistan.',
    message_en: 'The signer is already present in the current signer roster.',
    retryable: false,
  },
  ARSREDOVISNING_REGISTERED: {
    httpStatus: 409,
    message_sv:
      'Årsredovisningen för räkenskapsåret är registrerad hos Bolagsverket och texterna kan inte längre ändras.',
    message_en:
      'The årsredovisning for this fiscal period has been registered with Bolagsverket; its narrative texts can no longer be edited.',
  },
}

const ASSETS: Record<string, StructuredErrorEntry> = {
  ASSET_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Tillgången kunde inte hittas.',
    message_en: 'Asset not found.',
  },
  ASSET_ALREADY_DISPOSED: {
    httpStatus: 409,
    message_sv: 'Tillgången är redan avyttrad.',
    message_en: 'The asset has already been disposed.',
  },
  ASSET_DISPOSAL_BLOCKED: {
    httpStatus: 409,
    message_sv:
      'Avyttringen kan inte bokföras eftersom avskrivningar redan finns för samma eller en senare period. Återför den felaktiga avskrivningen med storno först.',
    message_en:
      'The disposal cannot be posted because depreciation already exists for the same or a later period. Reverse the incorrect depreciation first.',
  },
  ASSET_JAMKNING_DATA_REQUIRED: {
    httpStatus: 422,
    message_sv:
      'Ange ursprunglig ingående moms och ursprunglig avdragsprocent för att bedöma justering enligt ML 15 kap.',
    message_en:
      'Enter the original input VAT and original deduction percentage to assess adjustment under ML chapter 15.',
  },
  ASSET_ADJUSTMENT_DOCUMENT_REQUIRED: {
    httpStatus: 422,
    message_sv:
      'Bekräfta att en justeringshandling upprättas när justeringsskyldigheten överförs.',
    message_en:
      'Confirm that an adjustment document is prepared when the adjustment obligation is transferred.',
  },
  ASSET_BUSINESS_TRANSFER_CONFIRMATION_REQUIRED: {
    httpStatus: 422,
    message_sv:
      'Bekräfta att överlåtelsen omfattar en hel verksamhet eller självständig verksamhetsgren och uppfyller villkoren i ML 5 kap. 38 §.',
    message_en:
      'Confirm that the transfer covers an entire business or independent branch and meets the conditions in ML chapter 5, section 38.',
  },
  ASSET_CORRECTION_BLOCKED: {
    httpStatus: 409,
    message_sv:
      'Anskaffningsdatum, anskaffningsvärde och kategori kan inte ändras efter att tillgången avyttrats eller avskrivningar bokförts. Återför (storno) först, eller använd avyttringsflödet.',
    message_en:
      'Acquisition date, cost and category cannot be changed once the asset has been disposed or depreciation has been posted. Reverse (storno) first, or use the disposal flow.',
  },
  // Generic on purpose: the flag covers accounts excluded from K2 for several
  // different reasons (egenupparbetade immateriella, uppskjuten skatt,
  // verkligt värde, säkringsredovisning, ...), so the static entry states only
  // what the BAS chart says. The asset routes override it with an
  // account-specific message from lib/bokslut/assets/k2-account-guard.ts,
  // which cites BFNAR 2016:10 punkt 10.4 only when the intangible group is
  // what actually triggered the gate.
  K2_EXCLUDED_ACCOUNT: {
    httpStatus: 422,
    message_sv:
      'Kontot är markerat Ej K2 i BAS-kontoplanen och förutsätter K3. Välj ett konto som är tillåtet enligt K2.',
    message_en:
      'The account is marked Ej K2 in the BAS chart of accounts and presumes the K3 framework. Pick an account that K2 permits.',
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
// Node.js / undici network system codes. These surface when an outbound call
// (email provider, Riksbanken, Skatteverket, a DB socket) fails at the
// network layer and the raw Error bubbles up with its `code` intact.
// Registered so they translate to a Swedish transient message instead of
// leaking strings like "connect ECONNREFUSED 10.0.0.1:443" (#337 follow-up).
// ─────────────────────────────────────────────────────────────────

const NETWORK_TRANSIENT_ENTRY: StructuredErrorEntry = {
  httpStatus: 503,
  message_sv: 'Kunde inte nå en extern tjänst. Försök igen om en stund.',
  message_en: 'An upstream network call failed. Retry the same request after a short backoff.',
  retryable: true,
}

const WEBSHOP_ORDERS: Record<string, StructuredErrorEntry> = {
  WEBSHOP_ORDER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Ordern hittades inte.',
    message_en: 'The order was not found.',
  },
  WEBSHOP_ORDER_ALREADY_BOOKED: {
    httpStatus: 409,
    message_sv: 'Ordern är redan bokförd.',
    message_en: 'The order is already booked.',
  },
  WEBSHOP_ORDER_ALREADY_INVOICED: {
    httpStatus: 409,
    message_sv:
      'Ordern är kopplad till en kundfaktura. Bokföringen sker via fakturaflödet, inte direkt från ordern.',
    message_en:
      'The order is linked to a customer invoice. Bookkeeping happens through the invoice flow, not directly from the order.',
  },
  WEBSHOP_ORDER_NOT_PAID: {
    httpStatus: 409,
    message_sv:
      'Ordern är inte betald ännu. Obetalda ordrar bokförs när betalningen kommer, eller faktureras via Skapa faktura.',
    message_en:
      'The order is not paid yet. Unpaid orders are booked when payment arrives, or invoiced via Create invoice.',
  },
  WEBSHOP_ORDER_LEGACY_TRANSACTION_OPEN: {
    httpStatus: 409,
    message_sv:
      'Samma order ligger redan som en obokförd transaktion under Transaktioner (importerad av det tidigare orderflödet). Bokför eller ignorera den transaktionen först, så att samma affärshändelse inte bokförs två gånger.',
    message_en:
      'The same order already exists as an unbooked transaction under Transactions (imported by the previous order feed). Book or ignore that transaction first so the same business event is not booked twice.',
  },
  WEBSHOP_ORDER_LEGACY_TRANSACTION_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Ordern är redan bokförd via en transaktion under Transaktioner (importerad av det tidigare orderflödet).',
    message_en:
      'The order is already booked via a transaction under Transactions (imported by the previous order feed).',
  },
  WEBSHOP_ORDER_FX_UNRESOLVED: {
    httpStatus: 422,
    message_sv:
      'Växelkursen för orderns valuta kunde inte hämtas ännu. Försök igen om en stund; ordern kan inte bokföras i SEK utan kurs.',
    message_en:
      'The exchange rate for the order currency could not be fetched yet. Try again shortly; the order cannot be booked in SEK without a rate.',
  },
  WEBSHOP_ORDER_REFUND_NOT_CONVERTIBLE: {
    httpStatus: 409,
    message_sv:
      'Återbetalningar kan inte omvandlas till fakturor. Hantera återbetalningen med en kreditfaktura från kundfakturan, eller bokför återbetalningsraden direkt.',
    message_en:
      'Refunds cannot be converted to invoices. Handle the refund with a credit note from the customer invoice, or book the refund row directly.',
  },
  WEBSHOP_ORDER_REFUND_PARENT_INVOICED: {
    httpStatus: 409,
    message_sv:
      'Ordern fakturerades via en kundfaktura. Återbetalningen hanteras med en kreditfaktura, inte genom att bokföra återbetalningsraden direkt.',
    message_en:
      'The order was invoiced through a customer invoice. Handle the refund with a credit note instead of booking the refund row directly.',
  },
  WEBSHOP_ORDER_VAT_BREAKDOWN_MISSING: {
    httpStatus: 422,
    message_sv:
      'Ordern saknar momsuppdelning från butiken, så konteringen kan inte härledas säkert. Bokför ordern enskilt och granska raderna.',
    message_en:
      'The order has no VAT breakdown from the store, so the posting cannot be derived reliably. Book the order individually and review the lines.',
  },
  WEBSHOP_ORDER_INVOICE_MODE_METHOD: {
    httpStatus: 409,
    message_sv:
      'Betalsättet är markerat som fakturaflöde i butiksinställningarna. Skapa faktura från ordern i stället, eller bokför den enskilt.',
    message_en:
      'The payment method is marked as invoice flow in the store settings. Create an invoice from the order instead, or book it individually.',
  },
  WEBSHOP_ORDER_UNSUPPORTED_VAT_RATE: {
    httpStatus: 422,
    message_sv:
      'Ordern har en momssats som inte är en svensk sats (25/12/6/0 %), till exempel utländsk OSS-moms. Bokför ordern enskilt och granska raderna.',
    message_en:
      'The order has a VAT rate that is not a Swedish rate (25/12/6/0 %), for example foreign OSS VAT. Book the order individually and review the lines.',
  },
  WEBSHOP_ORDER_REVENUE_ACCOUNT_UNKNOWN: {
    httpStatus: 422,
    message_sv:
      'Ett valt intäktskonto finns inte i kontoplanen eller är inaktivt. Lägg till eller aktivera kontot under Kontoplan och försök igen.',
    message_en:
      'A chosen revenue account is not in the chart of accounts or is inactive. Add or activate the account in the chart of accounts and try again.',
  },
  WEBSHOP_ORDER_RESIDUAL_TOO_LARGE: {
    httpStatus: 422,
    message_sv:
      'Orderns belopp stämmer inte med momsuppdelningen (differensen är större än öresavrundning). Bokför ordern enskilt och granska raderna.',
    message_en:
      'The order total does not match its VAT breakdown (the difference is larger than öre rounding). Book the order individually and review the lines.',
  },
  WEBSHOP_ORDER_CREATE_INVOICE_CUSTOMER_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunden kunde inte skapas från orderns uppgifter.',
    message_en: 'The customer could not be created from the order data.',
  },
  WEBSHOP_ORDER_CREATE_INVOICE_MISSING_CUSTOMER: {
    httpStatus: 422,
    message_sv:
      'Ordern saknar kunduppgifter. Välj en befintlig kund att fakturera.',
    message_en:
      'The order has no customer data. Choose an existing customer to invoice.',
  },
  WEBSHOP_ORDER_MANUALLY_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Ordern är markerad som bokförd utanför integrationen. Ångra markeringen först om du vill bokföra eller fakturera den härifrån.',
    message_en:
      'The order is marked as booked outside the integration. Undo the mark first if you want to book or invoice it from here.',
  },
  WEBSHOP_ORDER_MARK_ENTRY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikatet som ordern skulle kopplas till hittades inte.',
    message_en: 'The journal entry to link the order to was not found.',
  },
  WEBSHOP_ORDER_MARK_ENTRY_NOT_POSTED: {
    httpStatus: 409,
    message_sv:
      'Verifikatet är inte bokfört. Ordern kan bara kopplas till ett bokfört verifikat.',
    message_en:
      'The journal entry is not posted. The order can only be linked to a posted entry.',
  },
}

const NODE_SYSTEM: Record<string, StructuredErrorEntry> = {
  ECONNREFUSED: NETWORK_TRANSIENT_ENTRY,
  ECONNRESET: NETWORK_TRANSIENT_ENTRY,
  ETIMEDOUT: NETWORK_TRANSIENT_ENTRY,
  ENOTFOUND: NETWORK_TRANSIENT_ENTRY,
  EAI_AGAIN: NETWORK_TRANSIENT_ENTRY,
  EPIPE: NETWORK_TRANSIENT_ENTRY,
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
  ...SKATTEKONTO_FILE,
  ...OPENING_BALANCE_IMPORT,
  ...REGISTER_IMPORT,
  ...PROVIDER_MIGRATION,
  ...DOCUMENT,
  ...INBOX_UPLOAD,
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
  ...WEBSHOP_ORDERS,
  ...NODE_SYSTEM,
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
