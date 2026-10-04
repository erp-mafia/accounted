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
 * Adding a new code = add a row here.
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
  /**
   * When true, the thrower composes the Swedish message at runtime (a date,
   * an amount) and getErrorMessage() passes that message through verbatim;
   * message_sv is only the static fallback for an envelope that carries no
   * message. Without this flag a registered code always resolves to
   * message_sv, which would drop the runtime detail.
   */
  thrown_message_sv?: boolean
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
  // Webhook endpoint ownership handshake (lib/webhooks/verification.ts).
  WEBHOOK_NOT_VERIFIED: {
    httpStatus: 409,
    message_sv:
      'Webhookens mottagaradress är inte verifierad. Inga händelser skickas dit förrän den har klarat verifieringen.',
    message_en:
      'The webhook endpoint has not passed the ownership verification handshake, so no events are sent to it.',
    remediation: {
      description:
        'Make the endpoint answer the webhook.verification request with 2xx and {"challenge": "<the value sent>"}, then call POST /api/v1/companies/{companyId}/webhooks/{id}/verify.',
    },
  },
  WEBHOOK_VERIFICATION_FAILED: {
    httpStatus: 422,
    message_sv:
      'Webhookens mottagaradress klarade inte verifieringen. Den måste svara med samma challenge-värde som skickades.',
    message_en:
      'The webhook endpoint did not pass the verification handshake: it must answer with 2xx and {"challenge": "<the value sent>"} within 10 seconds.',
    remediation: {
      description:
        'Read details.reason, fix the receiver, then call POST /api/v1/companies/{companyId}/webhooks/{id}/verify again.',
    },
  },
}

// ─────────────────────────────────────────────────────────────────
// Bookkeeping engine codes (already used by lib/bookkeeping/errors.ts)
// ─────────────────────────────────────────────────────────────────

const BOOKKEEPING: Record<string, StructuredErrorEntry> = {
  // An approval-authority refusal, NOT a write failure: the operation is still
  // staged and a human can approve it in /pending. retryable is set FALSE
  // explicitly because getStructuredError falls back to isTransientFailure(),
  // and the message must never contain the words "rate limit": that phrase is
  // in TRANSIENT_MESSAGE_PATTERNS and would flip a permanent refusal into a
  // retryable one, which is how agents end up in retry storms.
  UNATTENDED_COMMIT_LIMIT_EXCEEDED: {
    httpStatus: 403,
    message_sv:
      'Beloppet överstiger vad den här API-nyckeln får bokföra utan mänskligt godkännande. Underlaget ligger kvar och kan godkännas i Accounted.',
    message_en:
      'Amount exceeds what this API key may post without human approval. The operation is preserved and can be approved in the app.',
    retryable: false,
    remediation: {
      description:
        'Do not retry, and do not split the entry into smaller ones: one affärshändelse is one verifikat (BFL 5 kap. 6 §). Ask a human to approve the staged operation in Accounted, or have the key owner raise the limit in API key settings. details.attempted and details.limit carry the numbers.',
    },
  },
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
        'Reactivate the existing account instead of creating it: POST /api/v1/companies/{companyId}/accounts/activate with { account_numbers: [number] }, or gnubok_update_account with is_active=true.',
      resource: 'Accounted://chart-of-accounts',
    },
  },
  // Chart of accounts writes (lib/bookkeeping/chart-of-accounts-service.ts,
  // operations accounts.*): one set of codes for the dashboard, v1 and MCP.
  ACCOUNT_EXISTS: {
    httpStatus: 409,
    message_sv: 'Kontonumret finns redan i din kontoplan.',
    message_en: 'The account number already exists in this company chart of accounts.',
    remediation: {
      description: 'Edit the existing account instead (PATCH /accounts/{number} or gnubok_update_account).',
      tool: 'gnubok_update_account',
    },
  },
  ACCOUNT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kontot hittades inte.',
    message_en: 'The account is not in this company chart of accounts.',
    remediation: {
      description: 'List the chart with GET /accounts?active=false, or create the account first.',
      tool: 'gnubok_list_accounts',
    },
  },
  ACCOUNT_DETAILS_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Kontonumret finns inte i BAS 2026: ange kontonamn, kontotyp och normal balans.',
    message_en:
      'The account number is not in the BAS 2026 catalogue: account_name, account_type and normal_balance are required.',
  },
  ACCOUNT_TYPE_CLASS_CONFLICT: {
    httpStatus: 400,
    message_sv: 'Kontotypen passar inte kontoklassen för det här kontonumret.',
    message_en:
      'account_type does not fit the account class (the first digit of the number); details.reason names the allowed types.',
  },
  ACCOUNT_VAT_TREATMENT_CLASS: {
    httpStatus: 400,
    message_sv: 'Momskoden kan inte användas för den här kontoklassen.',
    message_en:
      'default_vat_treatment is not valid for this account class: sales treatments go on class 3, reverse-charge purchase treatments on classes 4-6.',
  },
  ACCOUNT_VAT_BOX_NOT_VAT_ACCOUNT: {
    httpStatus: 400,
    message_sv: 'Momsruta kan bara väljas för momskonton (26xx, inte 2650).',
    message_en: 'vat_box is only valid on 26xx VAT accounts other than 2650.',
  },
  ACCOUNT_NOTHING_TO_UPDATE: {
    httpStatus: 400,
    message_sv: 'Inget att uppdatera.',
    message_en: 'Nothing to update: send at least one account field.',
  },
  ACCOUNT_SYSTEM_DELETE: {
    httpStatus: 400,
    message_sv: 'Systemkonton kan inte tas bort. Inaktivera kontot istället.',
    message_en: 'System accounts cannot be deleted. Deactivate the account instead (is_active=false).',
  },
  ACCOUNT_IN_USE: {
    httpStatus: 409,
    message_sv:
      'Kontot kan inte tas bort eftersom det används i bokförda verifikationer. Inaktivera det istället.',
    message_en:
      'The account has journal lines in this company and cannot be deleted (BFL: verifikat are immutable). Deactivate it instead (is_active=false).',
    remediation: {
      description: 'Deactivate the account: PATCH /accounts/{number} with { is_active: false }, or gnubok_update_account.',
      tool: 'gnubok_update_account',
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
  JOURNAL_LINE_NEGATIVE_AMOUNT: {
    httpStatus: 400,
    message_sv: 'En verifikationsrad har ett negativt belopp. Boka beloppet på motsatt sida i stället.',
    message_en: 'A journal line has a negative amount. Book it on the opposite side instead.',
    remediation: {
      description:
        'Every line carries one non-negative side: move a negative debit to credit_amount (and vice versa) before retrying.',
    },
  },
  JOURNAL_LINE_BOTH_SIDES_NONZERO: {
    httpStatus: 400,
    message_sv: 'En verifikationsrad kan inte ha både debet och kredit nollskilda.',
    message_en: 'A journal entry line cannot have both debit and credit non-zero.',
    remediation: {
      description:
        'Every line carries one side: net the two amounts onto the larger side, or split the line in two, before retrying.',
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
  CANNOT_CANCEL_NON_DRAFT: {
    httpStatus: 409,
    message_sv:
      'Endast utkast kan makuleras. En bokförd verifikation måste stornas i stället.',
    message_en:
      'Only draft entries can be cancelled; a posted entry must be reversed (storno) instead.',
    remediation: {
      description:
        'Storno the posted entry with POST /api/v1/companies/{companyId}/journal-entries/{id}/reverse. Cancelling a draft that is already cancelled succeeds: the endpoint is idempotent.',
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
      'Ett angivet dimensionsvärde finns inte i dimensionsregistret eller är arkiverat. Skapa värdet i registret först.',
    message_en:
      'One or more dimension codes on the entry lines are missing from the dimension registry or archived. details.issues lists each offending sie_dim_no/code.',
    remediation: {
      description:
        'Create the missing dimension value in the register (or re-activate the archived value or dimension), then retry. Only companies with dimensions enabled are validated; each issue in details.issues carries sie_dim_no, code, reason (unknown_dimension | unknown_value | archived_value | archived_dimension) and, when the dimension is registered, dimension_name.',
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
  // ── Wave 3: journal-entry actions (lib/core/bookkeeping/journal-entry-corrections.ts,
  // lib/core/bookkeeping/journal-entry-edits.ts, lib/bookkeeping/no-doc-required.ts) ──
  JOURNAL_RATTELSE_REFUSED: {
    httpStatus: 409,
    message_sv: 'Rättelsen kan inte göras i samma verifikat. Använd rättelseverifikat (storno) i stället.',
    message_en:
      'The inline rättelse was refused by a bookkeeping rule (the Swedish message names it). Correct the verifikat with storno instead: POST /journal-entries/{id}/correct.',
    remediation: {
      description:
        'Read the message. If the rule cannot be met inside the verifikat (linked underlag, foreign currency, bank-anchored amount, structural entry type), use the storno correction (gnubok_correct_entry) instead.',
      tool: 'gnubok_correct_entry',
    },
    thrown_message_sv: true,
  },
  JOURNAL_RATTELSE_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv: 'Perioden är stängd eller låst: använd rättelseverifikat (storno).',
    message_en:
      'Inline rättelse is only allowed in an open, unlocked period after the company lock date. Past a lock or close, storno is the only lawful correction (BFL 5 kap 5 §).',
    remediation: {
      description:
        'Correct the verifikat with storno (gnubok_correct_entry, POST /journal-entries/{id}/correct). Unlock the period only if the user explicitly asks for it.',
      tool: 'gnubok_correct_entry',
    },
    thrown_message_sv: true,
  },
  JOURNAL_RATTELSE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte rätta verifikationen. Försök igen.',
    message_en: 'The inline rättelse failed unexpectedly. Nothing was changed.',
    retryable: true,
  },
  JOURNAL_RATTELSE_LOG_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte hämta rättelsehistorik.',
    message_en: 'Could not read the rättelse log.',
    retryable: true,
  },
  JOURNAL_ENTRY_UPDATE_FAILED: {
    httpStatus: 400,
    message_sv: 'Utkastet kunde inte sparas.',
    message_en: 'The draft journal entry could not be saved.',
    thrown_message_sv: true,
  },
  JOURNAL_ENTRY_NOTE_FAILED: {
    httpStatus: 400,
    message_sv: 'Anteckningen kunde inte sparas.',
    message_en: 'The note could not be saved.',
    thrown_message_sv: true,
  },
  NO_DOC_REQUIRED_FAILED: {
    httpStatus: 400,
    message_sv: 'Markeringen "Inget underlag krävs" kunde inte sparas.',
    message_en: 'The "no document required" flag could not be saved.',
    thrown_message_sv: true,
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
        'Either unlock the period via gnubok_unlock_period (if status is "locked", not "closed") or change the entry date to fall inside an open period. A bank transaction that is not a business event (duplicate, never executed) needs no verifikat: ignore it instead (POST /transactions/{id}/ignore, gnubok_ignore_transaction).',
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
  // The route composes the message with the account and the amount; this is
  // the fallback for an envelope without one.
  TRANSACTION_BOOK_BANK_LINE_DIRECTION: {
    httpStatus: 400,
    message_sv:
      'Bankkontot står på fel sida i verifikationen. Ett uttag ska stå i kredit på bankkontot och en insättning i debet.',
    message_en:
      'The bank ledger is on the wrong side of the voucher: a withdrawal must credit the bank ledger, a deposit must debit it.',
    thrown_message_sv: true,
  },
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
  TX_CATEGORIZE_INVALID_VAT_AMOUNT: {
    httpStatus: 400,
    message_sv:
      'Underlagets moms kunde inte användas för den här bokföringen. Kontrollera beloppet och momssatsen.',
    message_en: "The document's VAT amount cannot be used for this booking. Check the amount and the VAT treatment.",
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
  // resolveSettlementAccount: the transaction's cash account is in another
  // currency than the transaction. The bank-booking guards look the account up
  // by the transaction's currency and refuse every booking and link on it, so
  // this is raised before a preview or a staged operation promises one.
  BANK_BOOKING_CURRENCY_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Transaktionens valuta stämmer inte med valutan på bankkontot den hör till, så den kan inte bokföras eller kopplas mot det kontot. Flytta transaktionen till ett bankkonto i samma valuta, eller kontakta supporten om bankkontot har fel valuta.',
    message_en:
      "The transaction's currency does not match the currency of its bank account, so it cannot be booked or linked on that account.",
    remediation: {
      description:
        'Retrying does not help: the database refuses every booking and link of this row on that bank account. If the row sits under the wrong bank account, move it to the company account in its currency (transactions.update with account_number); if the bank account itself has the wrong currency, only support can correct it.',
    },
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
  TX_CATEGORIZE_ORPHANED_COUNTER_ACCOUNT: {
    httpStatus: 400,
    message_sv:
      'Motkontot är ett bankkonto som hör till transaktionens eget konto eller till en frånkopplad bankanslutning och kan inte användas. Välj ett intäkts- eller kostnadskonto i stället.',
    message_en:
      'The counter-account is a bank ledger of the transaction\'s own account or of a disconnected bank connection and cannot be used. Pick a revenue or expense account instead.',
    remediation: {
      description: 'Choose a revenue or expense account as the counter-account; a twin or orphaned bank ledger must not receive new postings.',
      resource: 'Accounted://chart-of-accounts',
    },
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
  TX_CATEGORIZE_JOURNAL_ENTRY_FAILED: {
    httpStatus: 409,
    message_sv:
      'Verifikationen kunde inte skapas, så transaktionen är inte bokförd. Den ligger kvar under Att bokföra.',
    message_en:
      'The journal entry could not be created, so the transaction was not booked and stays in the unbooked list.',
    remediation: {
      description:
        'Fix the cause in details.cause (PERIOD_LOCKED / BOOKKEEPING_DATABASE_ERROR with a locked-period message: unlock the period or use gnubok_unlock_period; NO_OPEN_PERIOD_FOR_DATE: create or open the fiscal year) and retry the same request. Nothing was written.',
    },
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
  // Issue #1661: a private (is_business=false) marking is a real booking
  // (eget uttag/insättning on 2013/2018, or 2893 for an AB), so a locked or
  // closed period blocks it exactly like any other verifikat. The row the
  // caller usually wants to clear (a PSD2 ghost row, a duplicate, a never
  // executed transfer) is not an affärshändelse at all: ignoring it writes no
  // verifikat and is therefore allowed in a locked period. Returned instead
  // of PERIOD_LOCKED so the remediation names that path. The wording must not
  // contain "Bokföringen är låst" (inferCode maps that phrase to PERIOD_LOCKED).
  TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv:
      'Perioden är låst. En privat markering bokförs som eget uttag eller insättning i perioden. Är raden ingen affärshändelse (dubblett, aldrig genomförd)? Ignorera den i stället. Annars: lås upp perioden.',
    message_en:
      'The period is locked. A private marking is booked as an owner withdrawal or deposit inside the period. If the row is not a business event (a duplicate, never executed), ignore it instead; otherwise unlock the period.',
    remediation: {
      description:
        'If the row is not a business event, ignore it: POST /api/v1/companies/{companyId}/transactions/{id}/ignore, the Ignorera action on the Transaktioner page, or gnubok_ignore_transaction. Ignoring writes no verifikat, so it is allowed in a locked or closed period. Otherwise unlock the period via gnubok_unlock_period (status "locked", not "closed") and categorize again.',
      tool: 'gnubok_ignore_transaction',
    },
  },
  TX_IGNORE_ALREADY_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Transaktionen är redan bokförd: använd Avmatcha eller backa verifikationen för att ändra status.',
    message_en:
      'The transaction is already booked (directly, via a payment allocation, or via a voucher link). Unlink it or reverse the verifikat (storno) before ignoring it.',
    remediation: {
      description:
        'A booked bank row cannot be ignored: the booking IS its status. Reverse it with gnubok_uncategorize_transaction (storno) or unlink the payment/voucher first, then ignore.',
      tool: 'gnubok_uncategorize_transaction',
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
    retryable: false,
    remediation: {
      description:
        'Link the bank row to the existing voucher instead of booking a second one: gnubok_link_transaction_to_journal_entry (pass invoice_id to settle the kundfaktura at the same time) or gnubok_reconcile_match. Only if the row is a genuinely separate payment, call again with force=true and expected_journal_entry_id set to the id the refusal named.',
      tool: 'gnubok_link_transaction_to_journal_entry',
    },
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
    message_sv: 'Momssatsen är inte tillåten för denna kundtyp eller för fakturans momsbehandling.',
    message_en: "The VAT rate is not allowed for this customer type or for the invoice's VAT treatment.",
  },
  // Per-invoice VAT treatment (#2906): resolveInvoiceVatRules refuses a
  // treatment the stated facts do not support, instead of issuing 0 %
  // without them. details carry vat_treatment, delivery_country and why.
  INVOICE_VAT_TREATMENT_DELIVERY_COUNTRY_REQUIRED: {
    httpStatus: 400,
    message_sv:
      'Ange leveransland (delivery_country) för varor som lämnar Sverige. Utan leveransland gäller export och omvänd skattskyldighet bara tjänster, och bara när kunden redan har den behandlingen.',
    message_en:
      'Set delivery_country for goods leaving Sweden. Without a delivery country, export and reverse_charge only mean the services treatment, and only where the customer already has it.',
    remediation: {
      description:
        'For goods, send delivery_country (the ISO code of the country the goods are transported to). For services, omit vat_treatment: the customer record decides. See details.customer_vat_treatment.',
    },
  },
  INVOICE_VAT_TREATMENT_DELIVERY_COUNTRY_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Leveranslandet stämmer inte med momsbehandlingen. Export kräver att varorna transporteras ut ur EU; unionsintern leverans kräver transport till ett annat EU-land.',
    message_en:
      'The delivery country does not match the VAT treatment. Export requires the goods to leave the EU; an intra-EU supply requires transport to another EU member state.',
    remediation: {
      description:
        'Check delivery_country. Goods to another EU member state: vat_treatment reverse_charge (needs the buyer VAT number). Goods leaving the EU: export. Goods staying in Sweden: standard. details.required names what the treatment needs.',
    },
  },
  INVOICE_VAT_TREATMENT_BUYER_VAT_NUMBER_REQUIRED: {
    httpStatus: 400,
    message_sv:
      'Unionsintern leverans (0 %) kräver köparens momsregistreringsnummer i ett annat EU-land än Sverige, kontrollerat mot VIES (ML 10 kap. 42-43 §§). Utan det ska fakturan ha svensk moms.',
    message_en:
      "An intra-EU supply (0 %) requires the buyer's VAT number from an EU member state other than Sweden, validated against VIES (ML 10 kap. 42-43 §§). Without it the invoice carries Swedish VAT.",
    remediation: {
      description:
        'Add the buyer EU VAT number to the customer (it is validated against VIES when saved), or send vat_treatment standard for Swedish VAT (for example a consumer under the distance-sales threshold). details.reason: private_person, missing, not_another_member_state or not_validated.',
      tool: 'gnubok_update_customer',
    },
  },
  INVOICE_VAT_TREATMENT_NOT_VAT_REGISTERED: {
    httpStatus: 400,
    message_sv:
      'Företaget är inte momsregistrerat, så fakturan kan inte ange egen momsbehandling. Alla rader blir momsfria.',
    message_en:
      'The company is not VAT-registered, so the invoice cannot state its own VAT treatment. Every line is VAT-free.',
    remediation: {
      description: 'Omit vat_treatment and delivery_country.',
    },
  },
  INVOICE_CREATE_REVENUE_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Ett angivet bokföringskonto finns inte eller är inte ett aktivt balans- eller intäktskonto (klass 1-3).',
    message_en: 'A supplied posting account does not exist or is not an active balance-sheet or revenue account (class 1-3).',
  },
  INVOICE_CREATE_ARTICLE_INVALID: {
    httpStatus: 400,
    message_sv: 'En angiven artikel finns inte i företaget.',
    message_en: 'A supplied article does not exist in this company.',
  },
  INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT: {
    httpStatus: 400,
    message_sv: 'Ett balanskonto (klass 1-2) kan bara användas på rader utan moms. Använd ett intäktskonto (3xxx) för momspliktiga rader.',
    message_en: 'A balance-sheet account (class 1-2) can only be used on zero-VAT lines. Use a revenue account (3xxx) for VAT-bearing lines.',
  },
  // Code name kept for wire stability; it covers every skattereduktion kind
  // (ROT, RUT, grön teknik), so the text names none of them.
  INVOICE_CREATE_ROT_RUT_VALIDATION: {
    httpStatus: 400,
    message_sv: 'Skattereduktionen kunde inte valideras. Kontrollera personnummer, fastighetsbeteckning och raderna med avdrag.',
    message_en: 'The tax reduction failed validation. Check the personnummer, the property designation and the deduction lines.',
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
    message_sv: 'Personnumret för skattereduktionen är ogiltigt.',
    message_en: 'The personnummer provided for the tax reduction is invalid.',
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
  ROT_RUT_SETTLE_AMOUNT_EXCEEDS: {
    httpStatus: 400,
    message_sv:
      'Beloppet kan inte bokföras mot begäran: det är större än begärt eller beslutat belopp. Bokför transaktionen på annat sätt.',
    message_en:
      'The amount cannot be booked against the request: it exceeds the requested or decided amount. Book the transaction another way.',
  },
  ROT_RUT_SETTLE_SET_AMOUNT: {
    httpStatus: 400,
    message_sv:
      'Beloppet stämmer inte med summan av de valda begäran. Skatteverket betalar ut exakt beslutade belopp, så flera begäran kan bara bokföras tillsammans när transaktionen motsvarar summan till öret.',
    message_en:
      'The amount does not equal the sum of the selected requests. Skatteverket pays exactly the decided amounts, so several requests can only be booked together when the transaction equals their sum to the öre.',
  },
  ROT_RUT_SETTLE_RACE: {
    httpStatus: 409,
    message_sv:
      'Begäran hann redan bokföras som utbetald av en annan åtgärd. Verifikationen som skapades kan inte kopplas: kontrollera bokföringen på konto 1513.',
    message_en:
      'The request was already settled by another action. The voucher that was created could not be attached: check the bookkeeping on account 1513.',
  },
  ROT_RUT_LINK_VOUCHER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikatet hittades inte i det här företaget.',
    message_en: 'The voucher was not found in this company.',
  },
  ROT_RUT_LINK_VOUCHER_NOT_ELIGIBLE: {
    httpStatus: 400,
    message_sv:
      'Verifikatet kan inte kopplas: det måste vara bokfört och får inte vara makulerat, en rättelse eller en ingående balans.',
    message_en:
      'The voucher cannot be linked: it must be posted and not reversed, a storno or an opening balance.',
  },
  ROT_RUT_LINK_ALREADY_SETTLED: {
    httpStatus: 409,
    message_sv: 'Begäran är redan kopplad till ett annat utbetalningsverifikat.',
    message_en: 'The request is already linked to another payout voucher.',
  },
  ROT_RUT_LINK_VOUCHER_IN_USE: {
    httpStatus: 409,
    message_sv: 'Verifikatet är redan kopplat till en annan begäran.',
    message_en: 'The voucher is already linked to another request.',
  },
  ROT_RUT_LINK_AMOUNT_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Beloppet på konto 1513 i verifikatet stämmer inte med begäran. Välj verifikatet för just den här utbetalningen, eller alla begäran det betalade.',
    message_en:
      'The account 1513 amount on the voucher does not match the request. Pick the voucher for this payout, or every request it paid.',
  },
  ROT_RUT_MATCH_NOT_INCOME: {
    httpStatus: 400,
    message_sv: 'Endast inbetalningar kan matchas mot en ROT/RUT-utbetalning från Skatteverket.',
    message_en: 'Only income transactions can be matched to a ROT/RUT payout from Skatteverket.',
  },
  ROT_RUT_MATCH_TX_ALREADY_LINKED: {
    httpStatus: 400,
    message_sv: 'Transaktionen är redan bokförd eller kopplad till en verifikation.',
    message_en: 'The transaction is already booked or linked to a journal entry.',
  },
  ROT_RUT_MATCH_CURRENCY: {
    httpStatus: 400,
    message_sv: 'Transaktionen kan inte matchas: Skatteverket betalar ut i SEK och transaktionen har en annan valuta.',
    message_en: 'Skatteverket pays out in SEK; the transaction is in another currency.',
  },
  ROT_RUT_MATCH_TX_LINK_FAILED: {
    httpStatus: 409,
    message_sv:
      'Utbetalningen bokfördes men transaktionen kunde inte kopplas till verifikationen. Koppla den via "Matcha mot befintlig verifikation".',
    message_en:
      'The payout was booked but the transaction could not be linked to the voucher. Link it via "Match against existing voucher".',
  },
  EXPENSE_PAYOUT_MATCH_NOT_EXPENSE: {
    httpStatus: 400,
    message_sv: 'Endast utbetalningar kan matchas mot utlägg.',
    message_en: 'Only outgoing transactions can be matched to expense claims.',
  },
  EXPENSE_PAYOUT_MATCH_TX_ALREADY_LINKED: {
    httpStatus: 400,
    message_sv: 'Transaktionen är redan bokförd eller kopplad till en verifikation.',
    message_en: 'The transaction is already booked or linked to a journal entry.',
  },
  EXPENSE_PAYOUT_MATCH_CURRENCY: {
    httpStatus: 400,
    message_sv: 'Utlägg betalas ut i SEK och transaktionen har en annan valuta.',
    message_en: 'Expense claims are reimbursed in SEK; the transaction is in another currency.',
  },
  EXPENSE_PAYOUT_MATCH_AMOUNT: {
    httpStatus: 400,
    message_sv: 'Beloppet stämmer inte med de valda utläggen. Välj de utlägg som överföringen täcker.',
    message_en: 'The amount does not match the selected expense claims. Pick the claims this transfer covers.',
  },
  // Expense claims (utlägg): register, delete, payout (lib/expenses/expense-claim-actions.ts).
  EXPENSE_CLAIM_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Utlägget hittades inte.',
    message_en: 'Expense claim not found.',
  },
  EXPENSE_CLAIM_CLAIMANT_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Ange vem utlägget avser: välj anställd eller skriv ett namn.',
    message_en: 'Say who the expense claim is for: pick an employee or give a name.',
  },
  EXPENSE_CLAIM_VAT_EXCEEDS_AMOUNT: {
    httpStatus: 400,
    message_sv: 'Momsen måste vara mindre än totalbeloppet.',
    message_en: 'The VAT must be less than the total amount.',
  },
  EXPENSE_CLAIM_INVALID_LINES: {
    httpStatus: 400,
    message_sv: 'Verifikatraderna är ogiltiga: kontrollera att raderna balanserar och att skuldraden matchar beloppet.',
    message_en: 'The voucher lines are invalid: they must balance and carry exactly one credit on the liability account equal to the amount.',
  },
  EXPENSE_CLAIM_RATE_UNAVAILABLE: {
    httpStatus: 400,
    message_sv: 'Ingen växelkurs kunde hämtas för datumet. Ange kursen manuellt och försök igen.',
    message_en: 'No exchange rate could be fetched for the date. Pass exchange_rate and retry.',
  },
  EXPENSE_CLAIM_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv: 'Inget öppet räkenskapsår täcker datumet.',
    message_en: 'No open fiscal year covers the date.',
  },
  EXPENSE_CLAIM_DOCUMENT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Underlaget hittades inte i företaget.',
    message_en: 'The document was not found in this company.',
  },
  EXPENSE_CLAIM_INBOX_ITEM_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Inkorgsposten hittades inte i företaget.',
    message_en: 'The inbox item was not found in this company.',
  },
  EXPENSE_CLAIM_SAVE_FAILED: {
    httpStatus: 500,
    message_sv: 'Utlägget kunde inte sparas.',
    message_en: 'The expense claim could not be saved.',
  },
  EXPENSE_CLAIM_LINK_FAILED: {
    httpStatus: 500,
    message_sv: 'Utlägget bokfördes men kunde inte kopplas till sin verifikation. Kontakta supporten innan du försöker igen.',
    message_en: 'The expense claim was booked but could not be linked to its voucher. Contact support before retrying.',
  },
  EXPENSE_CLAIM_ALREADY_PAID: {
    httpStatus: 409,
    message_sv: 'Utlägget är redan utbetalt och kan inte tas bort.',
    message_en: 'The expense claim is already paid out and cannot be deleted.',
  },
  EXPENSE_CLAIM_ON_PAYSLIP: {
    httpStatus: 409,
    message_sv: 'Utlägget ligger på ett lönebesked som är under behandling. Ta bort raden från lönebeskedet först.',
    message_en: 'The expense claim is on a payslip that has left draft. Remove the line from the payslip first.',
  },
  EXPENSE_CLAIM_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Utlägget kunde inte tas bort.',
    message_en: 'The expense claim could not be deleted.',
  },
  EXPENSE_PAYOUT_NO_CLAIMS: {
    httpStatus: 400,
    message_sv: 'Välj minst ett utlägg att betala ut.',
    message_en: 'Pick at least one expense claim to pay out.',
  },
  EXPENSE_PAYOUT_CLAIMS_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Något av utläggen hittades inte.',
    message_en: 'One or more of the expense claims were not found.',
  },
  EXPENSE_PAYOUT_ALREADY_PAID: {
    httpStatus: 409,
    message_sv: 'Något av utläggen är redan utbetalt.',
    message_en: 'One or more of the expense claims are already paid out.',
  },
  EXPENSE_PAYOUT_MIXED_CLAIMANTS: {
    httpStatus: 400,
    message_sv: 'En utbetalning kan bara avse en person. Dela upp per person.',
    message_en: 'A payout covers one person only. Split it per person.',
  },
  EXPENSE_PAYOUT_MIXED_LIABILITY: {
    httpStatus: 400,
    message_sv: 'Utläggen har olika skuldkonton och kan inte betalas ut tillsammans.',
    message_en: 'The expense claims sit on different liability accounts and cannot be paid out together.',
  },
  EXPENSE_PAYOUT_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv: 'Inget öppet räkenskapsår täcker utbetalningsdatumet.',
    message_en: 'No open fiscal year covers the payout date.',
  },
  EXPENSE_PAYOUT_ACCOUNT_NOT_IN_CHART: {
    httpStatus: 400,
    message_sv: 'Kontot finns inte i kontoplanen.',
    message_en: 'The account is not active in the chart of accounts.',
  },
  EXPENSE_PAYOUT_INVALID_CASH_ACCOUNT: {
    httpStatus: 400,
    message_sv: 'Utbetalningen måste göras från ett likvidkonto i 19xx-serien (bank eller kassa).',
    message_en: 'The payout must come from a cash account in the 19xx range (bank or cash).',
  },
  EXPENSE_PAYOUT_ON_PAYSLIP: {
    httpStatus: 409,
    message_sv: 'Något av utläggen ligger på ett lönebesked och betalas ut via lön. Ta bort raden från lönebeskedet först.',
    message_en: 'One or more of the expense claims are on a payslip and are repaid through payroll. Remove the line from the payslip first.',
  },
  EXPENSE_PAYOUT_FAILED: {
    httpStatus: 500,
    message_sv: 'Utbetalningen kunde inte bokföras.',
    message_en: 'The payout could not be booked.',
  },
  // Reclaim: Skatteverkets avslag booked back onto the customer
  ROT_RUT_RECLAIM_NO_BESLUT: {
    httpStatus: 400,
    message_sv:
      'Skatteverkets beslut är inte registrerat för begäran. Importera beslutsfilen eller registrera beslutet först.',
    message_en:
      "Skatteverket's decision is not recorded for this request. Import the decision file or record the decision first.",
  },
  ROT_RUT_RECLAIM_NOTHING_REFUSED: {
    httpStatus: 400,
    message_sv: 'Skatteverket beviljade hela begäran: det finns inget nekat belopp att bokföra.',
    message_en: 'Skatteverket approved the whole request: there is no refused amount to book.',
  },
  ROT_RUT_RECLAIM_ALREADY_DONE: {
    httpStatus: 409,
    message_sv: 'Det nekade beloppet är redan bokfört för den här begäran.',
    message_en: 'The refused amount has already been booked for this request.',
  },
  ROT_RUT_RECLAIM_SPLIT_UNKNOWN: {
    httpStatus: 400,
    message_sv:
      'Beslutet är registrerat som en totalsumma för flera fakturor. Importera Skatteverkets beslutsfil så att det nekade beloppet kan fördelas per faktura.',
    message_en:
      "The decision was recorded as one total for several invoices. Import Skatteverket's decision file so the refused amount can be split per invoice.",
  },
  ROT_RUT_RECLAIM_INVOICE_NOT_BOOKED: {
    httpStatus: 400,
    message_sv:
      'Fakturan har ingen verifikation, så det finns ingen fordran på konto 1513 att flytta. Bokför fakturan först.',
    message_en:
      'The invoice has no voucher, so there is no receivable on account 1513 to move. Book the invoice first.',
  },
  ROT_RUT_RECLAIM_INVOICE_NOT_OPEN: {
    httpStatus: 400,
    message_sv: 'Fakturan är makulerad eller krediterad och kan inte öppnas igen för det nekade beloppet.',
    message_en: 'The invoice is cancelled or credited and cannot be reopened for the refused amount.',
  },
  ROT_RUT_RECLAIM_CURRENCY: {
    httpStatus: 400,
    message_sv: 'Det nekade beloppet kan bara bokföras för fakturor i SEK.',
    message_en: 'The refused amount can only be booked for invoices in SEK.',
  },
  ROT_RUT_RECLAIM_INVOICE_REREQUESTED: {
    httpStatus: 409,
    message_sv:
      'Minst en faktura i begäran ingår i en senare begäran som inte är avslagen. Det nekade beloppet kan inte bokföras på kunden när Skatteverket prövar fakturan igen.',
    message_en:
      'At least one invoice in this request is part of a later request that is not rejected. The refused amount cannot be booked onto the customer while Skatteverket is reviewing the invoice again.',
  },
  ROT_RUT_RECLAIM_RACE: {
    httpStatus: 409,
    message_sv:
      'Det nekade beloppet hann redan bokföras av en annan åtgärd. Verifikationen som skapades kan inte kopplas: kontrollera bokföringen på konto 1513 och 1510.',
    message_en:
      'The refused amount was already booked by another action. The voucher that was created could not be attached: check the bookkeeping on accounts 1513 and 1510.',
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
  INVOICE_CREDIT_ROT_RUT_RECLAIMED: {
    httpStatus: 400,
    message_sv:
      'Fakturan har ett nekat ROT/RUT-avdrag bokfört som kundfordran. Makulera den bokningen (verifikationen med nekat avdrag) innan fakturan krediteras, annars stämmer inte kreditfakturans fördelning mellan konto 1510 och 1513.',
    message_en:
      'The invoice carries a refused ROT/RUT deduction booked as a customer receivable. Reverse that voucher before crediting the invoice, otherwise the credit note splits 1510 and 1513 wrongly.',
  },
  INVOICE_CREDIT_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv: 'Bokföringen är låst för dagens datum. Kreditfakturan kan inte skapas.',
    message_en: 'Bookkeeping is locked for today\'s date; the credit note cannot be created.',
    remediation: {
      description:
        'The credit note is dated today (Europe/Stockholm) and that date falls in a closed or locked period, or on/before the company lock date (details.reason). Unlock the period in the dashboard or wait for the next open period; the API cannot backdate or forward-date a credit note.',
    },
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
      'E-posttjänsten är inte konfigurerad. Kontrollera att RESEND_API_KEY och RESEND_FROM_EMAIL är satta (eller SMTP_HOST och SMTP_FROM_EMAIL med EMAIL_PROVIDER=smtp).',
    message_en: 'Email service is not configured.',
    remediation: {
      description: 'Set RESEND_API_KEY and RESEND_FROM_EMAIL (or SMTP_HOST and SMTP_FROM_EMAIL with EMAIL_PROVIDER=smtp) in the deployment environment.',
    },
  },
  INVOICE_SEND_NO_CUSTOMER_EMAIL: {
    httpStatus: 400,
    message_sv: 'Kunden saknar e-postadress. Uppdatera kunduppgifterna först.',
    message_en: 'Customer has no email address.',
    remediation: { description: 'Add an email address on the customer record before sending.' },
  },
  // customer_id is null, usually because the customer was deleted while the
  // draft existed (crm#263). Without a buyer there is no invoice to issue or
  // render (ML 17 kap 24 §).
  INVOICE_CUSTOMER_MISSING: {
    httpStatus: 409,
    message_sv: 'Fakturan saknar kund. Välj en kund på utkastet under Redigera, eller ta bort utkastet.',
    message_en: 'The invoice has no customer. Choose a customer for the draft under Edit, or delete the draft.',
    remediation: {
      description:
        'The invoice has no customer (customer_id is null, usually because the customer was deleted). Set customer_id on the draft (gnubok_update_invoice, or PATCH the invoice) or delete the draft (gnubok_delete_draft_invoice). An invoice is never issued or rendered without a buyer.',
      tool: 'gnubok_update_invoice',
    },
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
  INVOICE_SEND_PAYMENT_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Bankkontot som fakturan ska betalas till kan inte längre användas: det är avstängt, borttaget från kundfakturor eller saknar uppgifter för fakturans valuta. Välj ett annat konto på fakturan eller uppdatera kontot under Inställningar → Fakturering.',
    message_en: 'The bank account this invoice is to be paid to can no longer be used: it is disabled, no longer shown on customer invoices, or lacks details for the invoice currency. Pick another account on the invoice or update the account under Inställningar → Fakturering (Settings → Invoicing).',
    remediation: {
      description: 'Välj ett annat bankkonto på fakturan, eller återaktivera kontot och fyll i dess betaluppgifter under Inställningar → Fakturering.',
    },
  },
  INVOICE_PAYEE_SNAPSHOT_FAILED: {
    httpStatus: 500,
    message_sv: 'Betaluppgifterna kunde inte sparas på fakturan. Fakturan skickades inte; försök igen.',
    message_en: 'The payment details could not be saved on the invoice. The invoice was not sent; try again.',
  },
  INVOICE_PAYEE_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Bankkontot kan inte användas som betalningsmottagare på fakturan: det tillhör inte företaget, visas inte på kundfakturor eller saknar uppgifter för fakturans valuta.',
    message_en: 'The bank account cannot be the payee on this invoice: it does not belong to the company, is not shown on customer invoices, or lacks details for the invoice currency.',
    remediation: {
      description: 'Välj ett av företagets bankkonton som är markerat "Visas på fakturor" och har betaluppgifter för fakturans valuta.',
    },
  },
  CASH_ACCOUNT_DISABLE_PRIMARY: {
    httpStatus: 400,
    message_sv: 'Det här är företagets primära bankkonto och kan inte stängas av. Välj "Gör primärt" på ett annat bankkonto först.',
    message_en: 'This is the company’s primary bank account and cannot be disabled. Choose "Make primary" on another bank account first.',
  },
  CASH_ACCOUNT_DISABLED_PAYEE: {
    httpStatus: 409,
    message_sv: 'Bankkontot är avstängt och visas på fakturor. En ägare eller administratör behöver aktivera det under Inställningar innan transaktioner kan läggas på det.',
    message_en: 'This bank account is turned off and is printed on invoices. An owner or admin needs to turn it on in Settings before transactions can be put on it.',
  },
  CASH_ACCOUNT_PRIMARY_INELIGIBLE: {
    httpStatus: 400,
    message_sv: 'Kontot kan inte vara primärt. Det primära kontot måste vara ett aktivt bankkonto i SEK (konto 1920-1999).',
    message_en: 'This account cannot be the primary. The primary account must be an active bank account in SEK (account 1920-1999).',
  },
  CASH_ACCOUNT_DISABLE_UNRESOLVED: {
    httpStatus: 400,
    message_sv: 'Kontot har obokförda transaktioner och kan inte stängas av förrän de är bokförda eller ignorerade.',
    message_en: 'The account has unbooked transactions and cannot be disabled until they are booked or ignored.',
  },
  CASH_ACCOUNT_ENABLED_BANK_MANAGED: {
    httpStatus: 409,
    message_sv: 'Kontot hör till en bankkoppling. Slå på eller av det under bankkopplingen i stället.',
    message_en: 'This account belongs to a bank connection. Turn it on or off from the bank connection instead.',
  },
  // Cash account operations (lib/cash-accounts/manage.ts): the dashboard,
  // v1 and MCP doors answer these same codes.
  CASH_ACCOUNT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Bankkontot hittades inte.',
    message_en: 'Bank account not found.',
  },
  CASH_ACCOUNT_LEDGER_TAKEN: {
    httpStatus: 409,
    message_sv: 'Bokföringskontot används redan av ett annat bankkonto i företaget. Välj ett annat konto eller låt systemet välja nästa lediga.',
    message_en: 'The ledger account is already used by another bank account of the company. Pick another one or omit it to get the next free one.',
  },
  CASH_ACCOUNT_NO_FREE_LEDGER: {
    httpStatus: 409,
    message_sv: 'Det finns inget ledigt bokföringskonto i 1931-1959 för ett nytt bankkonto. Ange ett bokföringskonto (1920-1999) själv.',
    message_en: 'No free ledger account in 1931-1959 is left for a new bank account. Pass a ledger_account (1920-1999) explicitly.',
  },
  CASH_ACCOUNT_IBAN_DUPLICATE: {
    httpStatus: 409,
    message_sv: 'Ett annat bankkonto i företaget har redan detta IBAN. Samma bankkonto ska bara finnas en gång: använd det befintliga kontot.',
    message_en: 'Another bank account of the company already carries this IBAN. One physical account must exist once: use the existing cash account.',
  },
  // Removing a bank account (remove_cash_account, #3130): one code per
  // refusal, each saying what keeps the account and the way out if there is
  // one. Nothing is removed when any of them is answered.
  CASH_ACCOUNT_REMOVE_BANK_CONNECTED: {
    httpStatus: 409,
    message_sv: 'Kontot hämtas fortfarande via en bankkoppling och kan inte tas bort. Koppla från banken först (kontona och deras transaktioner finns kvar), ta bort kontot och koppla sedan banken igen med bara rätt konton.',
    message_en: 'The account is still fetched through a bank connection and cannot be removed. Disconnect the bank first (the accounts and their transactions stay), remove the account, then connect the bank again with only the right accounts.',
  },
  CASH_ACCOUNT_REMOVE_PRIMARY: {
    httpStatus: 409,
    message_sv: 'Det här är företagets primära bankkonto och kan inte tas bort. Välj "Gör primärt" på rätt bankkonto först. Finns inget annat bankkonto: koppla eller lägg till rätt konto först.',
    message_en: 'This is the company’s primary bank account and cannot be removed. Choose "Make primary" on the right bank account first. If there is no other bank account, connect or add the right one first.',
  },
  CASH_ACCOUNT_REMOVE_BOOKED: {
    httpStatus: 409,
    message_sv: 'Transaktioner på kontot är bokförda eller kopplade till verifikat, fakturor eller betalningar, så kontot kan inte tas bort. Det som är bokfört rättas med ändring eller storno.',
    message_en: 'Transactions on the account are booked or linked to vouchers, invoices or payments, so the account cannot be removed. Booked items are corrected with a correction or a reversal.',
  },
  CASH_ACCOUNT_REMOVE_IGNORED: {
    httpStatus: 409,
    message_sv: 'Kontot har ignorerade transaktioner. Att ignorera är ett sparat beslut, så kontot kan inte tas bort medan de finns. Ångra ignoreringen först om kontot ska bort.',
    message_en: 'The account has ignored transactions. Ignoring is a recorded decision, so the account cannot be removed while they exist. Undo the ignore first if the account should go.',
  },
  CASH_ACCOUNT_REMOVE_MATCH_HISTORY: {
    httpStatus: 409,
    message_sv: 'Transaktioner på kontot har matchningshistorik som ska sparas, så kontot kan inte tas bort. Ignorera transaktionerna och stäng av kontot i stället, eller kontakta supporten.',
    message_en: 'Transactions on the account have payment matching history that must be kept, so the account cannot be removed. Ignore the transactions and turn the account off instead, or contact support.',
  },
  CASH_ACCOUNT_REMOVE_IN_USE: {
    httpStatus: 409,
    message_sv: 'Kontot används på fakturor (betaluppgifter, standardkonto för fakturor eller en skickad faktura) eller i en avstämning och kan inte tas bort.',
    message_en: 'The account is used on invoices (payment details, the default invoice account or a sent invoice) or in a reconciliation and cannot be removed.',
  },
  CASH_ACCOUNT_REMOVE_LEDGER_HISTORY: {
    httpStatus: 409,
    message_sv: 'Bokföringskontot som bankkontot bokför på har redan bokförda verifikat, så bankkontot kan inte tas bort.',
    message_en: 'The ledger account this bank account books on already has posted vouchers, so the bank account cannot be removed.',
  },
  INVOICE_SEND_PAYMENT_ACCOUNT_MISSING: {
    httpStatus: 400,
    // Currency-neutral by necessity (the registry has no details). Surfaces
    // that know the invoice currency say exactly what is missing through
    // describeMissingInvoicePaymentAccount() (lib/invoices/payment-accounts.ts).
    message_sv: 'Fakturan saknar betalningsuppgifter för sin valuta: bankgiro, plusgiro, Swish eller bankkonto för SEK, IBAN för andra valutor. Lägg till dem under Inställningar → Fakturering innan du skapar PDF-filen eller skickar fakturan.',
    message_en: 'The invoice has no payment details for its currency: bankgiro, plusgiro, Swish or a bank account for SEK, an IBAN for other currencies. Add them under Inställningar → Fakturering (Settings → Invoicing) before generating the PDF or sending the invoice.',
    remediation: {
      description: 'Lägg till betalningsuppgifter för fakturans valuta under Inställningar → Fakturering: bankgiro, plusgiro, Swish eller bankkonto för SEK, IBAN för andra valutor.',
    },
  },
  INVOICE_SEND_VAT_NUMBER_MISSING: {
    httpStatus: 400,
    message_sv: 'Företaget är momsregistrerat men saknar momsregistreringsnummer, som måste anges på fakturan (ML 17 kap. 24 §). Lägg till det under Inställningar → Skatt innan du skickar fakturan.',
    message_en: 'The company is VAT-registered but has no VAT number, which is a mandatory invoice element (ML 17 kap. 24 §). Add it under Inställningar → Skatt (Settings → Tax) before issuing the invoice.',
    remediation: {
      description: 'Lägg till företagets momsregistreringsnummer under Inställningar → Skatt.',
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
  // POST /api/invoices/[id]/send issues the invoice (status sent + verifikat)
  // before the email leaves, so a verifikat refusal can stop the send. When
  // the email itself then fails after a verifikat was posted, the invoice
  // stays issued (a posted verifikat is never undone) and is delivered by
  // hand; with nothing booked the draft is put back instead.
  INVOICE_SEND_ISSUED_NOT_DELIVERED: {
    httpStatus: 502,
    message_sv:
      'Fakturan är utfärdad men e-postmeddelandet kunde inte skickas. Ladda ned fakturan och skicka den till kunden.',
    message_en:
      'The invoice is issued (marked sent, and booked where the company books at issue) but the email could not be sent. Download the invoice and deliver it to the customer.',
    retryable: false,
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
  INVOICE_QUOTE_NOT_PAYABLE: {
    httpStatus: 400,
    message_sv: 'En offert kan inte betalas. Skapa en faktura från offerten först.',
    message_en: 'A quote cannot be paid. Convert it to an invoice first.',
    remediation: {
      description: 'Convert the accepted quote with POST /api/invoices/{id}/convert, then register the payment on the invoice.',
    },
  },
  INVOICE_NOT_A_QUOTE: {
    httpStatus: 400,
    message_sv: 'Dokumentet är inte en offert.',
    message_en: 'This document is not a quote.',
  },
  INVOICE_QUOTE_NOT_DECIDABLE: {
    httpStatus: 400,
    message_sv: 'Makulerade offerter kan inte accepteras eller avböjas.',
    message_en: 'A cancelled quote cannot be accepted or declined.',
  },
  INVOICE_QUOTE_ALREADY_INVOICED: {
    httpStatus: 409,
    message_sv: 'Offerten är redan fakturerad och kan inte ändras.',
    message_en: 'This quote has already been invoiced and can no longer change.',
  },
  INVOICE_QUOTE_ALREADY_ORDERED: {
    httpStatus: 409,
    message_sv: 'Offerten har redan en kundorder. Fakturera från kundordern i stället.',
    message_en: 'This quote already has a sales order. Invoice from the sales order instead.',
  },
  INVOICE_CONVERT_NOT_CONVERTIBLE: {
    httpStatus: 400,
    message_sv: 'Endast proformafakturor och offerter kan omvandlas till faktura.',
    message_en: 'Only proforma invoices and quotes can be converted to an invoice.',
  },
  INVOICE_CONVERT_SOURCE_CANCELLED: {
    httpStatus: 409,
    message_sv: 'Dokumentet är makulerat och kan inte omvandlas.',
    message_en: 'This document is cancelled and cannot be converted.',
  },
  INVOICE_CONVERT_SOURCE_CHANGED: {
    httpStatus: 409,
    message_sv: 'Dokumentet ändrades samtidigt (makulerat, omvandlat eller beslutat på annat sätt). Ladda om och försök igen.',
    message_en: 'The document changed concurrently (cancelled, converted or decided elsewhere). Reload and try again.',
  },
  INVOICE_QUOTE_CHANGED_CONCURRENTLY: {
    httpStatus: 409,
    message_sv: 'Offerten ändrades samtidigt (fakturerad, makulerad eller beslutad på annat sätt). Ladda om och försök igen.',
    message_en: 'The quote changed concurrently (invoiced, cancelled or decided elsewhere). Reload and try again.',
  },
  INVOICE_CONVERT_QUOTE_DECLINED: {
    httpStatus: 409,
    message_sv: 'Offerten är avböjd. Markera den som accepterad innan du skapar en faktura.',
    message_en: 'The quote was declined. Mark it accepted before creating an invoice.',
  },
  INVOICE_UPDATE_DOCUMENT_TYPE_LOCKED: {
    httpStatus: 400,
    message_sv: 'Dokumenttypen kan inte ändras på en offert eller följesedel: numret hör till serien. Skapa ett nytt dokument i stället.',
    message_en: 'The document type of a quote or delivery note cannot change: its number belongs to that series. Create a new document instead.',
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
  // Kundorder (sales orders): lib/sales-orders/*, app/api/sales-orders/*
  SALES_ORDER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kundordern hittades inte.',
    message_en: 'The sales order was not found.',
  },
  SALES_ORDER_INVALID_STATE: {
    httpStatus: 409,
    message_sv: 'Kundordern har inte en status som tillåter den här åtgärden.',
    message_en: 'The sales order is not in a state that allows this action.',
  },
  SALES_ORDER_NOT_EDITABLE: {
    httpStatus: 409,
    message_sv: 'Kundordern kan bara ändras medan den är utkast eller bekräftad.',
    message_en: 'A sales order can only be edited while it is a draft or confirmed.',
  },
  SALES_ORDER_HAS_INVOICES: {
    httpStatus: 409,
    message_sv: 'Kundordern kan inte makuleras: det finns fakturor som skapats från den. Makulera eller kreditera fakturorna först.',
    message_en: 'The sales order cannot be cancelled: invoices have been created from it. Cancel or credit those invoices first.',
  },
  SALES_ORDER_LINE_NOT_FOUND: {
    httpStatus: 400,
    message_sv: 'En angiven orderrad finns inte på kundordern.',
    message_en: 'A referenced line does not exist on the sales order.',
  },
  SALES_ORDER_OVER_INVOICED: {
    httpStatus: 409,
    message_sv: 'Angivet antal överstiger vad som återstår att fakturera på orderraden.',
    message_en: 'The requested quantity exceeds what remains to be invoiced on the order line.',
  },
  SALES_ORDER_OVER_DELIVERED: {
    httpStatus: 400,
    message_sv: 'Levererat antal kan inte överstiga beställt antal.',
    message_en: 'Delivered quantity cannot exceed the ordered quantity.',
  },
  SALES_ORDER_QUANTITY_BELOW_INVOICED: {
    httpStatus: 409,
    message_sv: 'Antalet på en orderrad kan inte sänkas under det som redan fakturerats.',
    message_en: 'An order line quantity cannot be lowered below what has already been invoiced.',
  },
  SALES_ORDER_NOTHING_TO_INVOICE: {
    httpStatus: 409,
    message_sv: 'Det finns inget kvar att fakturera på kundordern.',
    message_en: 'There is nothing left to invoice on the sales order.',
  },
  SALES_ORDER_CUSTOMER_MISSING: {
    httpStatus: 409,
    message_sv: 'Kundordern saknar kund. Ange en kund innan du fakturerar.',
    message_en: 'The sales order has no customer. Set a customer before invoicing.',
  },
  SALES_ORDER_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kundordern kunde inte sparas.',
    message_en: 'The sales order could not be saved.',
  },
  SALES_ORDER_LINE_LOCKED: {
    httpStatus: 409,
    message_sv: 'En orderrad med fakturerat eller levererat antal kan inte tas bort.',
    message_en: 'An order line with invoiced or delivered quantity cannot be removed.',
  },
  SALES_ORDER_SOURCE_NOT_PROFORMA: {
    httpStatus: 400,
    message_sv: 'Bara en proformafaktura eller offert kan omvandlas till kundorder.',
    message_en: 'Only a proforma invoice or a quote can be converted into a sales order.',
  },
  SALES_ORDER_SOURCE_UNSUPPORTED_LINES: {
    httpStatus: 400,
    message_sv: 'Underlaget innehåller rader som inte kan föras över till en kundorder (skattereduktion som ROT, RUT eller grön teknik, periodisering eller negativt antal). Skapa kundordern manuellt.',
    message_en: 'The source document has lines that cannot be carried into a sales order (a tax reduction such as ROT, RUT or green technology, an accrual period or a negative quantity). Create the sales order manually.',
  },
  SALES_ORDER_CUSTOMER_VAT_CHANGED: {
    httpStatus: 409,
    message_sv: 'Kundens momsuppgifter (kundtyp eller VAT-nummer) har ändrats sedan kundordern prissattes. Öppna och spara kundordern igen så att momssatserna kontrolleras innan du fakturerar.',
    message_en: 'The customer VAT facts (customer type or VAT number validation) changed after the sales order was priced. Open and save the order again so the VAT rates are re-checked before invoicing.',
  },
  INVOICE_UPDATE_DROPS_ORDER_LINK: {
    httpStatus: 409,
    message_sv: 'Fakturan är skapad från en kundorder och ändringen skulle tappa kopplingen till orderraderna. Skicka med sales_order_item_id på raderna, eller makulera fakturan och skapa en ny från kundordern.',
    message_en: 'The invoice was created from a sales order and this edit would drop the link to its order lines. Keep sales_order_item_id on the lines, or cancel the invoice and create a new one from the order.',
  },
  SALES_ORDER_SOURCE_ALREADY_CONVERTED: {
    httpStatus: 409,
    message_sv: 'Underlaget har redan en kundorder.',
    message_en: 'The source document already has a sales order.',
  },
  SALES_ORDER_INVOICE_FX_RATE_UNAVAILABLE: {
    httpStatus: 502,
    message_sv:
      'Kunde inte hämta växelkursen från Riksbanken för leverans-/fakturadatumet. Fakturan har inte skapats: en gissad kurs får inte bokföras. Försök igen om en stund.',
    message_en:
      'Could not fetch the Riksbanken exchange rate for the delivery/invoice date. No invoice was created: a guessed rate must not be booked. Try again shortly.',
  },
  // POST /api/invoices/{id}/peppol/send. The Access Point is an environment
  // decision (PEPPOL_TRANSPORT_PROVIDER + adapter credentials); the product
  // never pretends to send when no adapter is switched on.
  SCB_NOT_CONFIGURED: {
    httpStatus: 503,
    message_sv: 'Uppslag mot SCB:s företagsregister är inte aktiverat i den här miljön.',
    message_en: 'Lookups against the SCB business register are not enabled in this environment.',
  },
  SCB_LOOKUP_FAILED: {
    httpStatus: 502,
    message_sv: 'SCB:s företagsregister svarade inte. Försök igen om en stund.',
    message_en: 'The SCB business register did not answer. Try again shortly.',
  },
  SCB_NOT_A_LEGAL_PERSON: {
    httpStatus: 400,
    message_sv: 'Uppgifter hämtas bara för juridiska personer, inte för enskilda firmor.',
    message_en: 'Details are fetched for legal persons only, not for sole traders.',
  },
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
  // The two above once the invoice is issued: a draft is issued (and booked,
  // under faktureringsmetoden) before the network gets it, so the failure
  // must not say it was not sent. The send composes the sentence it answers
  // (booked or not, the access point's reason) in peppolAfterIssueMessages
  // (lib/invoices/peppol-send-service.ts); these static texts hold for every
  // case and are what an envelope without that sentence carries.
  PEPPOL_SUBMISSION_REJECTED_AFTER_ISSUE: {
    httpStatus: 422,
    message_sv: 'Fakturan är utfärdad, men Peppol-operatören tog inte emot den. Rätta och skicka igen, eller skicka PDF:en via e-post.',
    message_en: 'The invoice is issued, but the Peppol access point did not accept it. Correct it and send again, or send the PDF by email.',
    thrown_message_sv: true,
  },
  PEPPOL_SUBMISSION_FAILED_AFTER_ISSUE: {
    httpStatus: 502,
    message_sv: 'Fakturan är utfärdad, men kunde inte skickas via Peppol just nu. Försök igen om en stund, eller skicka PDF:en via e-post.',
    message_en: 'The invoice is issued, but could not be sent via Peppol right now. Try again shortly, or send the PDF by email.',
    thrown_message_sv: true,
  },
  // The access point already holds an invoice with this number for this
  // receiver (the connector's 409). Its verdict: the delivery ends failed,
  // and only a resend that replaces a failed submission gets past it.
  PEPPOL_DUPLICATE_INVOICE_NUMBER: {
    httpStatus: 409,
    message_sv: 'Mottagaren har redan en faktura med det här numret via Peppol. Behöver den rättas, kreditera den och skapa en ny faktura.',
    message_en: 'The recipient already holds an invoice with this number via Peppol. If it needs correcting, credit it and create a new invoice.',
  },
  // The buyer refused the invoice (a business response): the same document
  // is never sent again.
  PEPPOL_BUSINESS_REJECTED: {
    httpStatus: 409,
    message_sv: 'Mottagaren har avvisat fakturan via Peppol. Kreditera den och skapa en ny faktura.',
    message_en: 'The recipient rejected the invoice via Peppol. Credit it and create a new invoice.',
  },
  // The SMP lookup itself failed (#2484), as opposed to a lookup that
  // answered "not registered": the staged delivery stays staged and nothing
  // terminal is recorded. The route answers 502 when the transport says the
  // failure is retryable, 422 otherwise.
  PEPPOL_LOOKUP_FAILED: {
    httpStatus: 502,
    message_sv: 'Kunde inte slå upp mottagaren i Peppol-nätverket. Försök igen om en stund.',
    message_en: 'Could not look up the recipient in the Peppol network. Try again shortly.',
    retryable: true,
  },
  // The hosted service refused the submission for a reason about the sender,
  // the key or the service (not registered, quota, rate limit, scope,
  // upstream unconfigured), never about the document (#2484). The delivery
  // stays resendable; the route composes the hosted text onto the prefix
  // when the registry knows the code, else this generic pointer.
  PEPPOL_SEND_PRECONDITION_FAILED: {
    httpStatus: 409,
    message_sv: 'Fakturan kunde inte skickas via Peppol ännu: kontrollera Peppol-inställningarna och försök igen.',
    message_en: 'The invoice could not be sent via Peppol yet: check the Peppol settings and try again.',
    thrown_message_sv: true,
  },
  // stage_peppol_delivery raises P0002 when no fiscal period covers the
  // invoice date: the delivery row carries a retention basis (BFL 7 kap.)
  // derived from the period, so it cannot be staged without one.
  PEPPOL_FISCAL_PERIOD_MISSING: {
    httpStatus: 422,
    message_sv: 'Fakturadatumet saknar ett räkenskapsår. Skapa räkenskapsåret innan fakturan skickas via Peppol.',
    message_en: 'The invoice date falls outside every fiscal year. Create the fiscal year before sending the invoice via Peppol.',
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
    message_sv: 'Bolaget behöver ett giltigt organisationsnummer i företagsinställningarna innan det kan använda e-faktura via Peppol.',
    message_en: 'The company needs a valid organisation number in company settings before it can use e-invoicing via Peppol.',
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
    retryable: true,
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
    message_sv: 'Peppol är inte aktiverat för det här bolaget. Begär åtkomst under Inställningar > Kopplingar > E-faktura via Peppol, så aktiverar vi det.',
    message_en: 'Peppol is not enabled for this company. Request access under Settings > Connections > E-invoicing via Peppol and we will enable it.',
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
  // The access point gave a verdict on the identifier itself (#2483):
  // retrying the same registration cannot change it, unlike
  // PEPPOL_REGISTRATION_FAILED, which is the operational counterpart.
  PEPPOL_REGISTRATION_REJECTED: {
    httpStatus: 422,
    message_sv: 'Registreringen avvisades av Peppol-operatören. Kontakta support om felet kvarstår.',
    message_en: 'The Peppol access point rejected the registration. Contact support if the problem persists.',
  },
  // Hosted connector codes (packages/connect-contract) that a self-hosted
  // instance in connector mode stores as peppol_registrations.last_error_code
  // and shows translated. Permanent verdicts first, then transient ones.
  CONNECTOR_PEPPOL_PARTICIPANT_TAKEN: {
    httpStatus: 409,
    message_sv: 'Peppol-id:t är redan registrerat via ett annat konto. Kontakta support om det är ert bolag.',
    message_en: 'The Peppol id is already registered through another account. Contact support if it is your company.',
  },
  CONNECTOR_PEPPOL_PARTICIPANT_NOT_ALLOWED: {
    httpStatus: 422,
    message_sv: 'Peppol-id:t får inte registreras från det här kontot. Kontakta support.',
    message_en: 'The Peppol id may not be registered from this account. Contact support.',
  },
  // The two likeliest send preconditions (#2484): the route composes these
  // behind PEPPOL_SEND_PRECONDITION_FAILED's prefix.
  CONNECTOR_PEPPOL_SENDER_NOT_REGISTERED: {
    httpStatus: 422,
    message_sv: 'Bolagets Peppol-id är inte registrerat hos operatören. Slå på mottagning under Inställningar > Kopplingar > E-faktura via Peppol, eller kontakta support.',
    message_en: 'The company\'s Peppol id is not registered with the access point. Switch on receiving under Settings > Connections > E-invoicing via Peppol, or contact support.',
  },
  CONNECTOR_SCOPE_MISSING: {
    httpStatus: 403,
    message_sv: 'Kopplingsnyckeln saknar Peppol-behörighet. Kontakta support.',
    message_en: 'The connector key lacks Peppol permission. Contact support.',
  },
  CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE: {
    httpStatus: 409,
    message_sv: 'Peppol-id:t är redan publicerat hos en annan operatör. Avregistrera det där först.',
    message_en: 'The Peppol id is already published with another access point. Deregister it there first.',
  },
  CONNECTOR_QUOTA_EXCEEDED: {
    httpStatus: 409,
    message_sv: 'Kontots Peppol-platser är förbrukade. Hör av dig till support så öppnar vi fler.',
    message_en: 'The account has used its Peppol slots. Contact support and we will open more.',
  },
  CONNECTOR_PEPPOL_REGISTRATION_IN_PROGRESS: {
    httpStatus: 409,
    message_sv: 'En registrering av Peppol-id:t pågår redan. Försök igen om en stund.',
    message_en: 'A registration of the Peppol id is already in progress. Try again shortly.',
    retryable: true,
  },
  CONNECTOR_NOT_OWNED: {
    httpStatus: 404,
    message_sv: 'Peppol-id:t finns inte registrerat hos operatören för det här kontot.',
    message_en: 'The Peppol id is not registered with the access point for this account.',
  },
  CONNECTOR_UPSTREAM_ERROR: {
    httpStatus: 502,
    message_sv: 'Peppol-operatören svarade med ett fel. Försök igen om en stund.',
    message_en: 'The Peppol access point answered with an error. Try again shortly.',
    retryable: true,
  },
  CONNECTOR_UNREACHABLE: {
    httpStatus: 502,
    message_sv: 'Tjänsten som förmedlar Peppol kunde inte nås. Försök igen om en stund.',
    message_en: 'The service that brokers Peppol could not be reached. Try again shortly.',
    retryable: true,
  },
  CONNECTOR_RATE_LIMITED: {
    httpStatus: 429,
    message_sv: 'För många Peppol-anrop på kort tid. Vänta en stund och försök igen.',
    message_en: 'Too many Peppol calls in a short time. Wait a moment and try again.',
    retryable: true,
  },
  CONNECTOR_PROTOCOL_ERROR: {
    httpStatus: 502,
    message_sv: 'Svaret från Peppol-tjänsten kunde inte tolkas. Kontakta support om felet kvarstår.',
    message_en: 'The answer from the Peppol service could not be read. Contact support if the problem persists.',
  },
  // The access point answered a documented call in a shape the adapter does
  // not know (PEPPOL_UPSTREAM_SHAPE_CODE): not retryable, asking again gets
  // the same shape.
  // A resend that names a submission the access point has not reported as
  // failed (it is delivered or still in flight): the connector refuses the
  // overwrite so the buyer never gets the invoice twice.
  CONNECTOR_PEPPOL_RESEND_NOT_FAILED: {
    httpStatus: 409,
    message_sv: 'Peppol-operatören har inte rapporterat den tidigare leveransen som misslyckad, så fakturan skickas inte igen. Vänta på leveransstatusen eller kontakta support.',
    message_en: 'The Peppol access point has not reported the earlier delivery as failed, so the invoice is not sent again. Wait for the delivery status or contact support.',
  },
  CONNECTOR_UPSTREAM_SHAPE: {
    httpStatus: 502,
    message_sv: 'Peppol-operatören svarade i ett format som tjänsten inte känner igen. Kontakta support om felet kvarstår.',
    message_en: 'The Peppol access point answered in a format the service does not recognise. Contact support if the problem persists.',
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
  // Bokslutsdispositioner (periodiseringsfond, överavskrivningar, bolagsskatt,
  // särskild löneskatt) exist only for a form whose profile says so
  // (supportsCorporateTaxDispositions: today the aktiebolag). The wizard never
  // offers them to another form; this code closes the hand-made request path.
  YEAR_END_DISPOSITIONS_WRONG_LEGAL_FORM: {
    httpStatus: 400,
    message_sv:
      'Bokslutsdispositioner (periodiseringsfond, överavskrivningar, bolagsskatt och särskild löneskatt) stöds inte för företagets företagsform.',
    message_en:
      'Year-end tax dispositions (periodiseringsfond, excess depreciation, corporate tax and special payroll tax) are not supported for this company\'s legal form.',
  },
  // The EF declaration preview (egenavgifter, räntefördelning, EF
  // periodiseringsfond, expansionsfond) exists only for a form that files
  // NE-bilagan (filesIncomeReturn === 'NE'). Thrown by
  // lib/bokslut/enskild-firma/ef-declaration-preview.ts, surfaced as-is by
  // the MCP tool gnubok_preview_ef_declaration.
  EF_DECLARATION_WRONG_LEGAL_FORM: {
    httpStatus: 400,
    message_sv:
      'NE-bilagans beräkningar (egenavgifter, räntefördelning, periodiseringsfond och expansionsfond) gäller bara enskild firma, inte företagets företagsform.',
    message_en:
      'The NE-bilaga preview (egenavgifter, räntefördelning, periodiseringsfond and expansionsfond) applies only to an enskild firma, not to this company\'s legal form.',
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
    retryable: false,
    remediation: {
      description:
        'A lock only freezes the period. If the intent is bokslut, do not lock first: gnubok_run_year_end posts the closing entry into the period and then locks and closes it itself, so it needs an unlocked period (gnubok_unlock_period reopens a locked, not closed, one). If the period should simply stay frozen, nothing more is needed.',
      tool: 'gnubok_unlock_period',
    },
  },
  PERIOD_ALREADY_CLOSED: {
    httpStatus: 409,
    message_sv: 'Perioden är redan stängd: bokslutet är genomfört och perioden kan inte öppnas igen.',
    message_en: 'Period is already closed: year-end has been run and the period is sealed.',
    retryable: false,
    remediation: {
      description:
        'Nothing more to do on this period. gnubok_run_year_end locks, closes and seeds the next period\'s opening balances in one step, so gnubok_close_period, gnubok_lock_period and gnubok_set_opening_balances are not follow-up calls. Confirm the state with gnubok_list_fiscal_periods and continue in the next period.',
      tool: 'gnubok_list_fiscal_periods',
    },
  },
  PERIOD_UNLOCK_NOT_LOCKED: {
    httpStatus: 409,
    message_sv: 'Perioden är inte låst.',
    message_en: 'Period is not locked.',
  },
  PERIOD_UNLOCK_CLOSED: {
    httpStatus: 409,
    message_sv: 'Ett stängt räkenskapsår kan inte låsas upp. Klarmarkerades året som avslutat i ett tidigare program kan du i stället öppna det igen under Räkenskapsår.',
    message_en: 'A closed fiscal year cannot be unlocked. If the year was marked as closed in a previous system, reopen it from Fiscal years instead.',
  },
  PERIOD_REOPEN_NOT_CLOSED: {
    httpStatus: 409,
    message_sv: 'Räkenskapsåret är inte stängt.',
    message_en: 'Fiscal year is not closed.',
  },
  PERIOD_REOPEN_NOT_EXTERNAL: {
    httpStatus: 409,
    message_sv: 'Räkenskapsåret stängdes med ett bokslut i Accounted och kan inte öppnas igen här.',
    message_en: 'The fiscal year was closed with a year-end run in Accounted and cannot be reopened here.',
  },
  // Creating and editing a räkenskapsår (lib/core/bookkeeping/fiscal-year-service.ts,
  // operations fiscal-periods.create / .update). The shape rules are BFL 3 kap.
  // Codes flagged thrown_message_sv carry a Swedish sentence naming the dates
  // or the neighbouring year; details carry the same facts for agents.
  FISCAL_PERIOD_INVALID_DATES: {
    httpStatus: 400,
    thrown_message_sv: true,
    message_sv: 'Räkenskapsårets datum är ogiltiga: slutdatumet måste ligga efter startdatumet.',
    message_en: 'The fiscal year dates are invalid: period_end must be after period_start. details.rule names the rule.',
  },
  FISCAL_PERIOD_START_NOT_FIRST_OF_MONTH: {
    httpStatus: 400,
    message_sv:
      'Räkenskapsåret måste börja den 1:a i en månad. Bara företagets första räkenskapsår får börja mitt i en månad (BFL 3 kap. 1 och 3 §§).',
    message_en:
      "period_start must be the 1st of a month: only the company's first fiscal year may start mid-month (BFL 3 kap. 1 and 3 §§).",
  },
  FISCAL_PERIOD_END_NOT_MONTH_END: {
    httpStatus: 400,
    message_sv: 'Räkenskapsåret måste sluta på sista dagen i en månad (BFL 3 kap.).',
    message_en: 'period_end must be the last day of a month (BFL 3 kap.).',
  },
  FISCAL_PERIOD_TOO_LONG: {
    httpStatus: 400,
    thrown_message_sv: true,
    message_sv: 'Ett räkenskapsår får vara högst 18 månader (BFL 3 kap.).',
    message_en: 'A fiscal year may be at most 18 months (BFL 3 kap.). details.months holds the length requested.',
  },
  FISCAL_PERIOD_ENSKILD_FIRMA_CALENDAR_YEAR: {
    httpStatus: 400,
    thrown_message_sv: true,
    message_sv:
      'Enskild firma måste använda kalenderår: räkenskapsåret slutar 31 december och, efter det första året, börjar det 1 januari (BFL 3 kap.).',
    message_en:
      'An enskild firma must use the calendar year: the fiscal year ends on 31 December and, after the first year, starts on 1 January (BFL 3 kap.).',
  },
  FISCAL_PERIOD_NOT_CONTIGUOUS: {
    httpStatus: 400,
    thrown_message_sv: true,
    message_sv: 'Räkenskapsåren måste följa direkt på varandra, utan glapp.',
    message_en:
      'Fiscal years must be contiguous: a new year starts the day after the preceding year ends and ends the day before the following year starts. details.expected_start / details.expected_end hold the date that fits.',
  },
  FISCAL_PERIOD_OVERLAP: {
    httpStatus: 409,
    thrown_message_sv: true,
    message_sv: 'Räkenskapsåret överlappar ett befintligt räkenskapsår.',
    message_en:
      'The fiscal year overlaps an existing one (details.overlapping_period_id / overlapping_period_name). Fiscal years never overlap.',
    remediation: {
      description:
        'List the existing years with GET /fiscal-periods (gnubok_list_fiscal_periods) and choose dates that do not overlap any of them.',
      tool: 'gnubok_list_fiscal_periods',
    },
  },
  FISCAL_PERIOD_UPDATE_CLOSED: {
    httpStatus: 409,
    message_sv: 'Ett stängt räkenskapsår kan inte ändras.',
    message_en: 'A closed fiscal year cannot be edited.',
  },
  FISCAL_PERIOD_UPDATE_LOCKED: {
    httpStatus: 409,
    message_sv: 'Ett låst räkenskapsår kan inte ändras. Lås upp det först om det behöver rättas.',
    message_en: 'A locked fiscal year cannot be edited. Unlock it first if it needs correcting.',
    remediation: {
      description: 'Unlock the year (it must be locked, not closed), edit it, and lock it again.',
      tool: 'gnubok_unlock_period',
    },
  },
  FISCAL_PERIOD_HAS_POSTED_ENTRIES: {
    httpStatus: 409,
    thrown_message_sv: true,
    message_sv:
      'Datumen kan inte ändras eftersom det finns bokförda verifikationer i räkenskapsåret. Namnet kan fortfarande ändras.',
    message_en:
      'The dates cannot change while posted or reversed vouchers exist in the fiscal year (details.entry_count). The name can still be changed.',
  },
  FISCAL_PERIOD_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Räkenskapsåret kunde inte skapas. Försök igen.',
    message_en: 'Failed to create the fiscal year.',
  },
  FISCAL_PERIOD_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Räkenskapsåret kunde inte sparas. Försök igen.',
    message_en: 'Failed to update the fiscal year.',
  },
  // Klarmarkera (markPeriodClosedExternally): a migrated year closed in the
  // previous bookkeeping system.
  FISCAL_PERIOD_CLOSE_EXTERNAL_ALREADY_CLOSED: {
    httpStatus: 409,
    message_sv: 'Räkenskapsåret är redan stängt.',
    message_en: 'The fiscal year is already closed.',
  },
  FISCAL_PERIOD_CLOSE_EXTERNAL_HAS_CLOSING_ENTRY: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsåret har ett bokslutsverifikat i Accounted: stäng det med det vanliga årsbokslutet i stället.',
    message_en:
      'The fiscal year has a closing entry in Accounted: close it through the normal year-end instead.',
  },
  FISCAL_PERIOD_CLOSE_EXTERNAL_NOT_ENDED: {
    httpStatus: 409,
    message_sv: 'Ett räkenskapsår som inte har tagit slut kan inte klarmarkeras.',
    message_en: 'A fiscal year that has not ended yet cannot be marked as closed in a previous system.',
  },
  FISCAL_PERIOD_CLOSE_EXTERNAL_NATIVE_BOOKKEEPING: {
    httpStatus: 409,
    thrown_message_sv: true,
    message_sv:
      'Räkenskapsåret är bokfört i Accounted och ska stängas med det vanliga årsbokslutet, så att resultatet och balanserna förs över.',
    message_en:
      'The fiscal year was bookkept in Accounted, not migrated: close it with the normal year-end so the result and balances carry forward.',
    remediation: {
      description: 'Run the year-end instead (POST /fiscal-periods/{id}/year-end, gnubok_run_year_end).',
      tool: 'gnubok_run_year_end',
    },
  },
  FISCAL_PERIOD_CLOSE_EXTERNAL_CHECK_FAILED: {
    httpStatus: 503,
    thrown_message_sv: true,
    retryable: true,
    message_sv: 'Räkenskapsårets verifikat kunde inte kontrolleras. Året lämnas öppet. Försök igen.',
    message_en: 'The fiscal year could not be checked, so it was left open. Retry the same request.',
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
  // Interim block (#3440): the kontantmetoden cut-off as built declares the
  // moms on invoices unpaid at year end a second time when they are paid in
  // the next year. Both doors refuse while isKontantmetodCutoffSuspended()
  // (lib/core/bookkeeping/kontantmetod-cutoff-suspension.ts) is true: staging
  // (gnubok_post_kontantmetod_cutoff) and approval (commitPendingOperation,
  // before the claim, so a staged operation stays pending). The code stays
  // registered after the fix ships: agents pattern-match on codes.
  KONTANTMETOD_CUTOFF_SUSPENDED: {
    httpStatus: 409,
    message_sv:
      'Kontantmetodens bokslutsavgränsning är tillfälligt avstängd medan ett fel i momsredovisningen rättas. Bokför inte kundfordringarna eller leverantörsskulderna manuellt i stället: bokslutet för perioden får vänta tills avgränsningen går att bokföra igen.',
    message_en:
      'The kontantmetoden year-end cut-off is temporarily suspended while a VAT defect is fixed (erp-mafia/accounted#3440): as built, it would declare the moms on invoices unpaid at year end a second time when they are paid in the next year. Nothing was posted.',
    retryable: false,
    remediation: {
      description:
        'Do not retry, and do not work around it: never book the year-end receivables, payables or their moms by hand (gnubok_create_voucher or any other tool), and do not stage the cut-off again through gnubok_stage_tool. Tell the user the cut-off is temporarily unavailable and that the year-end close of this kontantmetoden period waits until it is back. A cut-off operation already staged stays pending; do not approve it again. Other year-end preparation (reconciliation, accruals, depreciation) can continue.',
    },
  },
}

const FX: Record<string, StructuredErrorEntry> = {
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
  CASH_FLOW_TAX_ALLOCATION_REQUIRED: {
    httpStatus: 422,
    message_sv: 'Kassaflödesanalysen kan inte beräkna betald inkomstskatt säkert från periodens skattebokningar. Inkomstskatt behöver skiljas från övriga skatter i rapportunderlaget. Bokföringen behöver inte ändras.',
    message_en: 'The cash flow statement cannot reliably calculate income tax paid from this period\'s tax postings. Income tax must be separated from other taxes in the report working papers. No bookkeeping changes are required.',
  },
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
  // gnubok_audit_package stores its zip in the documents bucket, whose cap per
  // file (50 MB) sits below the tool's own 80 MB estimate gate: an archive
  // between the two is built and then refused by Storage. A size limit, not a
  // fault, so the identical call can never succeed on a retry.
  AUDIT_PACKAGE_TOO_LARGE: {
    httpStatus: 413,
    message_sv:
      'Revisionspaketet blev för stort för att sparas som fil. Skapa det utan underlag, eller ladda ner det kompletta arkivet med underlag under Importera/Exportera.',
    message_en:
      'The audit package is too large to store as a file. Create it without documents (include_documents=false), or download the complete archive with documents in the web app under Import/Export.',
    remediation: {
      description:
        'If include_documents was true, call gnubok_audit_package again with include_documents=false: receipts and other documents are most of the size. For the archive with documents, the user downloads it in the web app under Importera/Exportera, Komplett arkiv (/import#full-archive), which streams the file instead of storing it.',
      tool: 'gnubok_audit_package',
    },
    retryable: false,
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

// Marking a momsperiod as filed by hand (issue #2746): the record is the
// period's moms deadline, so these guard the dates a manual filing may carry
// and the one state a manual action must not touch (a Skatteverket kvittens).
const VAT_FILING: Record<string, StructuredErrorEntry> = {
  VAT_FILING_PERIOD_NOT_ENDED: {
    httpStatus: 400,
    message_sv: 'Perioden har inte avslutats än och kan inte markeras som inlämnad.',
    message_en: 'The period has not ended yet and cannot be marked as filed.',
  },
  VAT_FILING_DATE_BEFORE_PERIOD_END: {
    httpStatus: 400,
    message_sv: 'Inlämningsdatumet ligger före periodens slut.',
    message_en: 'The filing date is before the end of the period.',
  },
  VAT_FILING_DATE_IN_FUTURE: {
    httpStatus: 400,
    message_sv: 'Inlämningsdatumet kan inte ligga i framtiden.',
    message_en: 'The filing date cannot be in the future.',
  },
  VAT_FILING_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Perioden är inte markerad som inlämnad.',
    message_en: 'The period is not recorded as filed.',
  },
  VAT_FILING_CONFIRMED_BY_SKATTEVERKET: {
    httpStatus: 409,
    message_sv:
      'Perioden är inlämnad via Skatteverket-kopplingen med kvittens och kan inte avmarkeras.',
    message_en:
      'The period was filed through the Skatteverket connection with a receipt and cannot be unmarked.',
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
  // ── Wave 3: filing reports and the momsredovisning verifikat over v1/MCP
  // (lib/reports/filing-report-service.ts, lib/reports/vat-settlement-booking.ts) ──
  TAX_DECL_INK2_WRONG_LEGAL_FORM: {
    httpStatus: 400,
    message_sv: 'INK2 lämnas bara av aktiebolag. En enskild firma lämnar NE-bilagan i stället.',
    message_en: 'INK2 is filed only by an aktiebolag. An enskild firma files the NE-bilaga instead.',
  },
  TAX_DECL_NE_WRONG_LEGAL_FORM: {
    httpStatus: 400,
    message_sv: 'NE-bilagan lämnas bara av enskild firma. Ett aktiebolag lämnar INK2 i stället.',
    message_en: 'The NE-bilaga is filed only by an enskild firma. An aktiebolag files INK2 instead.',
  },
  VAT_ESKD_SETTINGS_MISSING: {
    httpStatus: 404,
    message_sv: 'Företagsinställningar saknas: momsdeklarationsfilen kan inte skapas.',
    message_en: 'Company settings are missing; the VAT declaration file cannot be created.',
  },
  VAT_ESKD_ORG_NUMBER_INVALID: {
    httpStatus: 400,
    message_sv:
      'Organisationsnummer saknas eller är ogiltigt. Ange ett giltigt organisationsnummer i företagsinställningarna för att skapa momsdeklarationsfilen.',
    message_en:
      'The organisation number is missing or invalid. Set a valid organisation number in the company settings to create the VAT declaration file.',
  },
  VAT_SETTLEMENT_ALREADY_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Momsen för perioden är redan bokförd. Annullera det verifikatet först om perioden behöver bokföras om.',
    message_en:
      'The VAT for this period is already booked. Reverse that journal entry first if the period needs to be booked again.',
  },
  VAT_SETTLEMENT_EMPTY: {
    httpStatus: 400,
    message_sv: 'Ingen moms att bokföra för perioden.',
    message_en: 'There is no VAT to book for this period.',
  },
  VAT_SETTLEMENT_PROPOSAL_CHANGED: {
    httpStatus: 409,
    message_sv:
      'Bokföringen för perioden har ändrats sedan förslaget togs fram. Hämta ett nytt förslag och granska det innan momsen bokförs.',
    message_en:
      'The bookkeeping for the period changed after the proposal was made. Fetch a new proposal and review it before booking the VAT.',
  },
  VAT_SETTLEMENT_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv: 'Det finns inget öppet räkenskapsår som täcker periodens sista dag.',
    message_en: 'No open fiscal year covers the last day of the VAT period.',
  },
  VAT_SETTLEMENT_FAILED: {
    httpStatus: 500,
    message_sv: 'Momsen kunde inte bokföras.',
    message_en: 'Failed to book the VAT settlement.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Wave 3: imports (SIE, bank-file, opening-balance)
// ─────────────────────────────────────────────────────────────────

const SIE_IMPORT: Record<string, StructuredErrorEntry> = {
  SIE_IMPORT_LEGACY_REVIEW_REQUIRED: {
    httpStatus: 409,
    message_sv: 'Importhistoriken bevaras. Den här äldre SIE-importens utfall behöver granskas innan den kan ångras eller ersättas. Öppna importhistoriken och välj Granska.',
    message_en: 'Import history is retained. This legacy SIE import needs an outcome review before it can be undone or replaced. Open import history and choose Review.',
    retryable: false,
    remediation: {
      description: 'Read gnubok_sie_import_status with the same import_id for the assessment. In the app, open SIE import history and choose Review. No recovery mutation is available for this legacy import yet.',
      tool: 'gnubok_sie_import_status',
      resource: '/import?mode=sie',
    },
  },
  SIE_IMPORT_HISTORY_RETAINED: {
    httpStatus: 403,
    message_sv: 'Importhistoriken bevaras. Öppna importen för att granska dess status och tillgängliga åtgärder.',
    message_en: 'Import history is retained. Open the import to review its status and available actions.',
    retryable: false,
    remediation: { description: 'Read the import status with the same import_id.', tool: 'gnubok_sie_import_status', resource: '/import?mode=sie' },
  },
  SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS: {
    httpStatus: 400,
    message_sv: 'Konton med belopp måste mappas till konton 1000-8999 före import. Målkonton i klass 0 och 9 stöds inte i balans- och resultatrapporterna. Oanvända kontodefinitioner kan behållas.',
    message_en: 'Map accounts carrying amounts to accounts 1000-8999 before importing. Target classes 0 and 9 are not supported by the balance sheet and income statement. Unused account definitions may be retained.',
    retryable: false,
  },
  SIE_PARSE_NO_FILE: {
    httpStatus: 400,
    message_sv: 'Ingen fil bifogad i förfrågan.',
    message_en: 'No file attached to the request.',
  },
  SIE_PARSE_INVALID_TYPE: {
    httpStatus: 400,
    message_sv: 'Filtypen stöds inte. Ladda upp en fil med ändelsen .se, .sie eller .si.',
    message_en: 'Unsupported file type; upload a .se, .sie or .si file.',
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
  // start_sie_import_job's guard 'Existing SIE import requires reviewed
  // replacement or reconciliation' (55000), mapped by jobDatabaseError. The
  // guard also counts a posted ingående balans, so the sentence names both.
  SIE_IMPORT_PERIOD_ALREADY_IMPORTED: {
    httpStatus: 409,
    message_sv: 'Räkenskapsåret har redan en import eller en bokförd ingående balans. Öppna importhistoriken och ångra den tidigare importen innan du importerar året igen.',
    message_en: 'This fiscal year already has an import or a posted opening balance. Open import history and undo the earlier import before importing the year again.',
    retryable: false,
    remediation: {
      description: 'Read gnubok_sie_import_status for the earlier import of this fiscal year, undo it (gnubok_undo_sie_import or import history in the app), then import the year again.',
      tool: 'gnubok_sie_import_status',
      resource: '/import?mode=sie',
    },
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
    message_sv: 'Importens resultat kunde inte bekräftas. Kontrollera importhistoriken innan du försöker igen.',
    message_en: 'The import outcome could not be confirmed. Check import history before retrying.',
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
  BANK_FILE_INVALID_SETTLEMENT_ACCOUNT: {
    httpStatus: 400,
    message_sv: 'Bankkontot måste vara ett aktivt konto i kontoklass 19 i din kontoplan (till exempel 1930).',
    message_en: 'The bank account must be an active class 19 account in your chart of accounts (for example 1930).',
  },
  BANK_FILE_SETTLEMENT_ACCOUNT_UNAVAILABLE: {
    httpStatus: 409,
    message_sv: 'Det valda bankkontot kan inte användas för den här filen. Inget importerades.',
    message_en: 'The selected bank account cannot be used for this file. Nothing was imported.',
  },
  // ── Wave 3: bank transaction actions and import undo (lib/transactions/manage.ts,
  // lib/import/bank-file/undo-operation.ts, lib/import/sie-job-action-service.ts) ──
  TRANSACTION_DELETE_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Transaktionen är redan bokförd eller kopplad till en verifikation och kan inte raderas. Koppla bort den under Rapporter → Bankavstämning om kopplingen är fel, eller storna verifikationen.',
    message_en:
      'The transaction is already booked or linked to a journal entry and cannot be deleted. Unlink it under Reports → Bank reconciliation if the link is wrong, or reverse (storno) the voucher.',
  },
  TRANSACTION_DELETE_IMPORTED: {
    httpStatus: 409,
    message_sv:
      'Transaktionen har hämtats från banken eller importerats via fil och kan inte raderas. Du kan ignorera den så att den döljs från listan över transaktioner att bokföra.',
    message_en:
      'This transaction was fetched from your bank or imported from a file and cannot be deleted. You can ignore it to hide it from the list of transactions to book.',
  },
  TRANSACTION_DELETE_HAS_AUDIT_TRAIL: {
    httpStatus: 409,
    message_sv:
      'Transaktionen kan inte raderas eftersom den har en kopplad matchningshistorik (räkenskapsinformation, BFL 7 kap.). Matcha den mot en befintlig verifikation, eller ignorera den under Rapporter → Bankavstämning om du inte vill bokföra den.',
    message_en:
      'The transaction cannot be deleted because it has linked match-history records (accounting information, BFL ch. 7). Match it to an existing voucher, or ignore it under Reports → Bank reconciliation if you do not want to book it.',
  },
  TRANSACTION_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte ta bort transaktionen. Försök igen.',
    message_en: 'Could not delete the transaction. Please try again.',
    retryable: true,
  },
  TX_EXCHANGE_RATE_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Transaktionen är redan bokförd, så dess växelkurs kan inte ändras här. Bokförda verifikat rättas med storno.',
    message_en:
      'The transaction is already booked, so its exchange rate cannot be changed here. Posted vouchers are corrected with storno.',
  },
  BANK_FILE_UNDO_NOT_COMPLETED: {
    httpStatus: 409,
    message_sv: 'Bara slutförda bankfilsimporter kan ångras.',
    message_en: 'Only completed bank file imports can be undone.',
  },
  SIE_IMPORT_ACTION_CONFLICT: {
    httpStatus: 409,
    message_sv:
      'SIE-importen kan inte ångras eller återupptas just nu: en annan körning pågår, perioden är låst eller en rättelse av ett importerat verifikat behöver granskas först.',
    message_en:
      'The SIE import cannot be undone or resumed right now: another run is in progress, the period is locked, or a correction of an imported voucher needs review first.',
  },
}

/**
 * Agent-triggered PSD2 sync (v1 bank-connections sync + MCP gnubok_sync_bank).
 * Emitted by extensions/general/enable-banking/lib/trigger-sync.ts.
 */
// Refusals save_bank_account_selection raises by name. Nothing is saved when
// one of them fires; the picker shows message_sv as is. The PT409 name stays
// out of DB_CONFLICTS: other bank routes raise it too and keep CONFLICT.
const BANK_SELECTION: Record<string, StructuredErrorEntry> = {
  BANK_CONFIGURATION_CHANGED: {
    httpStatus: 409,
    message_sv: 'Bankkopplingen eller bankkontona ändrades medan du valde konton. Inget sparades. Öppna kontovalet igen och spara på nytt.',
    message_en: 'The bank connection or its accounts changed while you were choosing. Nothing was saved. Open the account picker again and save once more.',
  },
  BANK_SELECTION_LEDGER_CONFLICT: {
    httpStatus: 400,
    message_sv: 'Två bankkonton kan inte bokföras på samma bokföringskonto. Välj olika bokföringskonton. Inget sparades.',
    message_en: 'Two bank accounts cannot book to the same ledger account. Choose different ledger accounts. Nothing was saved.',
  },
  CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT: {
    httpStatus: 409,
    message_sv: 'Bokföringskontot används redan av ett annat bankkonto (annat IBAN eller annan valuta). Välj ett annat bokföringskonto. Inget sparades.',
    message_en: 'The ledger account is already used by another bank account (a different IBAN or currency). Choose another ledger account. Nothing was saved.',
  },
  CASH_ACCOUNT_LEDGER_CLAIMED: {
    httpStatus: 409,
    message_sv: 'Bokföringskontot används redan av ett bankkonto från en annan bankanslutning. Välj ett annat bokföringskonto. Inget sparades.',
    message_en: 'The ledger account is already used by a bank account from another bank connection. Choose another ledger account. Nothing was saved.',
  },
  CASH_ACCOUNT_LEDGER_IN_USE: {
    httpStatus: 409,
    message_sv: 'Bankkontot har redan historik på sitt bokföringskonto och kan inte flyttas till ett annat automatiskt. Inget sparades.',
    message_en: 'The bank account already has history on its ledger account and cannot be moved to another one automatically. Nothing was saved.',
  },
  // An unchecked account of another physical account holds the wanted ledger
  // and has transactions or invoice or reconciliation ties, so it cannot just
  // give the ledger up.
  BANK_SELECTION_YIELD_HAS_HISTORY: {
    httpStatus: 409,
    message_sv: 'Bokföringskontot hör till ett annat bankkonto som inte synkas men har transaktioner eller används i fakturor eller avstämningar. Välj ett annat bokföringskonto, eller markera först det andra bankkontot, ge det ett annat bokföringskonto och spara. Inget sparades.',
    message_en: 'The ledger account belongs to another bank account that is not synced but has transactions or is used on invoices or reconciliations. Choose another ledger account, or first select the other bank account, give it another ledger account and save. Nothing was saved.',
  },
}

const BANK_SYNC: Record<string, StructuredErrorEntry> = {
  BANK_SYNC_NOT_ACTIVE: {
    httpStatus: 409,
    message_sv: 'Bankanslutningen är inte aktiv och kan inte synkas. Förnya den med BankID i webbläsaren.',
    message_en: 'The bank connection is not active and cannot be synced. It needs BankID re-authorisation in a browser.',
    remediation: {
      description: 'Give the user the connect_url from gnubok_connect_bank (or GET /bank-connections); only they can re-authorise with BankID.',
      tool: 'gnubok_connect_bank',
    },
  },
  BANK_SYNC_NO_ACCOUNTS: {
    httpStatus: 409,
    message_sv: 'Inga konton är valda för synkning. Aktivera minst ett konto under Inställningar, Bank.',
    message_en: 'No accounts are selected for syncing. The user must enable at least one under Settings, Bank.',
  },
  BANK_SYNC_COOLDOWN: {
    httpStatus: 429,
    message_sv: 'Anslutningen synkades nyligen. Vänta tills next_allowed_at innan du synkar igen.',
    message_en: 'This connection was synced recently. Wait until next_allowed_at before syncing again; the data you have is already fresh.',
    retryable: true,
  },
  BANK_RATE_LIMITED: {
    httpStatus: 429,
    message_sv: 'Banken begränsar just nu hur ofta transaktioner får hämtas. Vänta tills next_allowed_at. Anslutningen behöver inte förnyas.',
    message_en: 'The bank is temporarily rate limiting this consent. Do not sync again before next_allowed_at: it is our cooldown (the bank\'s Retry-After when it sent one, bounded backoff otherwise), not a reset time confirmed by the bank. The connection is still valid: do not ask the user to renew it.',
    retryable: true,
  },
  BANK_SESSION_EXPIRED: {
    httpStatus: 409,
    message_sv: 'Bankanslutningen har löpt ut. Förnya anslutningen med BankID för att fortsätta synka.',
    message_en: 'The bank session has expired. The connection is now marked expired; only the user can renew it with BankID in a browser.',
    remediation: {
      description: 'Give the user the connect_url from gnubok_connect_bank (or GET /bank-connections). Do not retry: no API call can revive a dead consent.',
      tool: 'gnubok_connect_bank',
    },
  },
  BANK_SYNC_FAILED: {
    httpStatus: 502,
    message_sv: 'Banksynkningen misslyckades. Försök igen om en stund, eller förnya anslutningen om felet kvarstår.',
    message_en: 'The bank sync failed upstream. Retry after the cooldown; if it keeps failing the user should renew the connection.',
    retryable: true,
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
  // API parity wave 4: manual ingående balanser and the skattekonto file import over v1/MCP.
  OB_SET_COMPANY_LOCK_DATE: {
    httpStatus: 409,
    message_sv:
      'Bokföringen är låst t.o.m. ett låsdatum som täcker räkenskapsårets första dag, så ingående balanser kan inte bokföras. Flytta låsdatumet under Inställningar → Bokföring och försök igen.',
    message_en:
      'The company-wide bookkeeping lock date covers the first day of the fiscal year, so opening balances cannot be booked. Move the lock date under Settings → Bookkeeping and try again.',
    remediation: {
      description:
        'Move the bookkeeping lock date (company_settings.bookkeeping_locked_through) to a date before the period start, then retry.',
    },
  },
  OB_NON_BALANCE_SHEET_ACCOUNT: {
    httpStatus: 400,
    message_sv: 'Ingående balanser får bara bokas på balanskonton (klass 1 och 2).',
    message_en: 'Opening balances may only use balance sheet accounts (class 1 and 2).',
  },
  // "Dela upp IB per projekt" (#3313): lib/import/opening-balance/split-per-project.ts.
  // The split runs as an inline rättelse of the IB verifikat, which BFL 5 kap
  // 5 § only allows in an open, unlocked year: these say what to open first.
  OB_SPLIT_PERIOD_CLOSED: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsåret är stängt, så dess ingående balanser kan inte delas upp per projekt. Är året markerat som avslutat i ett tidigare program kan du öppna det igen (Inställningar › Bokföring › Räkenskapsår › Öppna igen) och försöka på nytt.',
    message_en:
      'The fiscal year is closed, so its opening balances cannot be split per project. If the year was marked as closed in a previous program, reopen it (Settings › Bookkeeping › Fiscal years › Reopen) and try again.',
    remediation: {
      description:
        'A year closed in Accounted (year-end posted) cannot be reopened: split the following year\'s opening balances instead. A year only marked closed externally is reopened with POST /fiscal-periods/{id}/reopen-external.',
    },
  },
  OB_SPLIT_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsåret är låst, så dess ingående balanser kan inte delas upp per projekt. Lås upp året först (Inställningar › Bokföring › Räkenskapsår › Lås upp) och försök sedan igen.',
    message_en:
      'The fiscal year is locked, so its opening balances cannot be split per project. Unlock the year first (Settings › Bookkeeping › Fiscal years › Unlock) and try again.',
    remediation: {
      description: 'Unlock the fiscal year (POST /fiscal-periods/{id}/unlock), then retry the split.',
    },
  },
  OB_SPLIT_NO_PREVIOUS_YEAR: {
    httpStatus: 409,
    message_sv:
      'Det finns inget tidigare räkenskapsår i Accounted att hämta projektsaldon från. Ingående balanser från en SIE-import delas upp per projekt när filen innehåller #OIB-rader.',
    message_en:
      'There is no earlier fiscal year in Accounted to take project balances from. Opening balances from an SIE import are split per project when the file carries #OIB records.',
  },
  OB_SPLIT_DIMENSION_UNRESOLVED: {
    httpStatus: 409,
    message_sv:
      'Ett eller flera projekt med saldo finns inte i dimensionsregistret. Lägg upp dem under Dimensioner och försök igen.',
    message_en:
      'One or more projects carrying a balance are missing from the dimension registry. Add them under Dimensions and try again.',
    thrown_message_sv: true,
    remediation: {
      description:
        'details.unresolved lists each dimension number and code. Create the missing values (POST /dimensions/{id}/values), then retry.',
    },
  },
  OB_SPLIT_NOTHING_TO_DO: {
    httpStatus: 409,
    message_sv:
      'Det finns ingenting att dela upp: ingående balanserna är redan uppdelade per projekt, eller så hoppas de berörda kontona över.',
    message_en:
      'There is nothing to split: the opening balances are already split per project, or the accounts concerned are skipped.',
    remediation: {
      description:
        'Nothing to stage or approve. GET /fiscal-periods/{id}/opening-balances/split-per-project shows each account\'s status (unchanged, or skipped with skip_reason).',
    },
  },
  OB_SPLIT_PROPOSAL_CHANGED: {
    httpStatus: 409,
    message_sv:
      'Ingående balanserna eller projektsaldona har ändrats sedan förhandsgranskningen. Förhandsgranska uppdelningen igen.',
    message_en:
      'The opening balances or the project balances changed since the preview. Preview the split again.',
    remediation: {
      description: 'Run the preview (GET or ?dry_run=true) again and pass its fingerprint as expected_fingerprint.',
    },
  },
  OB_SPLIT_REFUSED: {
    httpStatus: 409,
    message_sv: 'Uppdelningen nekades av reglerna för rättelse av verifikat.',
    message_en: 'The split was refused by the correction rules for posted entries.',
    thrown_message_sv: true,
  },
  OB_SPLIT_FAILED: {
    httpStatus: 500,
    message_sv: 'Uppdelningen av ingående balanser per projekt misslyckades.',
    message_en: 'Splitting the opening balances per project failed.',
  },
  SKATTEKONTO_FILE_ORG_NUMBER_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Kontoutdraget gäller ett annat organisationsnummer än företagets. Kontrollera att det är rätt fil och bekräfta för att importera ändå.',
    message_en:
      'The statement names a different organisation number than the company. Check the file, then send confirm_org_number_mismatch=true to import it anyway.',
  },
  SKATTEKONTO_FILE_SUM_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Kontoutdraget summerar inte: ingående saldo plus händelserna blir inte utgående saldo. Filen kan vara filtrerad eller ofullständig. Bekräfta för att importera ändå.',
    message_en:
      'The statement does not sum: opening saldo plus the events differs from the closing saldo. Send confirm_sum_mismatch=true to import it anyway.',
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
  BOKIO_PLAN_NO_API: {
    // 422, same reasoning as PROVIDER_TOKEN_INVALID. Bokio answered 403
    // price_plan_feature_required: the company's plan has no API access for
    // private integrations (Basic, or a plan that has expired). The token can
    // be fine, so this must not tell the user to re-check it. Plan names per
    // docs.bokio.se/docs/price-plan-requirements (read 2026-09-29).
    httpStatus: 422,
    message_sv:
      'Bokio nekar API-åtkomst eftersom företagets abonnemang inte omfattar egna integrationer. De ingår i Bokios Plus, Premium och Business men inte i Basic, och stängs av när abonnemanget har gått ut. Byt eller förnya abonnemanget i Bokio och försök igen, eller importera bokföringen med SIE-fil och kunder, leverantörer och artiklar med CSV eller Excel under Importera/Exportera.',
    message_en:
      "Bokio refuses API access because the company's plan does not include private integrations. They are included in Bokio's Plus, Premium and Business plans but not in Basic, and they stop when the plan has expired. Change or renew the plan in Bokio and try again, or import the bookkeeping with a SIE file, and customers, suppliers and articles with CSV or Excel under Import/Export.",
  },
  BL_INTEGRATION_NOT_ACTIVATED: {
    // 422, same reasoning as PROVIDER_TOKEN_INVALID. The User-Key opened a
    // real company, but that company has granted our service provider no
    // scopes (BL: "out of allowed scope for service provider"). Nothing the
    // user re-pastes can fix this: the integration must be activated on the
    // BL side, and until BL has released it for the company it cannot be.
    httpStatus: 422,
    message_sv:
      'Företagsnyckeln stämmer, men företaget har inte aktiverat Accounted som integration i Björn Lundén. Aktivera integrationen under Integrationer i Lundify eller BL Administration och försök igen. Saknas Accounted i listan är integrationen inte släppt för ditt företag ännu: importera via SIE-fil så länge.',
    message_en:
      'The company key is valid, but the company has not activated Accounted as an integration in Björn Lundén. Activate the integration under Integrations in Lundify or BL Administration and try again. If Accounted is missing from the list, the integration has not been released for your company yet: import via a SIE file for now.',
  },
  BL_COMPANY_KEY_NOT_FOUND: {
    // 422: BL could not bind any company to the pasted User-Key (typo,
    // truncated GUID, key from a different BL environment).
    httpStatus: 422,
    message_sv:
      'Björn Lundén hittade inget företag för den här företagsnyckeln. Kontrollera att hela nyckeln (GUID) är kopierad från Integrationer → kugghjulet i Lundify och försök igen.',
    message_en:
      'Björn Lundén found no company for this company key. Check that the whole key (GUID) was copied from Integrations → the gear icon in Lundify and try again.',
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
      'Bokföringsdata (SIE) måste importeras först. Ladda upp en SIE-fil med kontoplan, ingående balanser och verifikationer innan du hämtar kunder, leverantörer, fakturor och anläggningstillgångar från den här leverantören.',
    message_en:
      'A completed SIE import is required first. Import the SIE file (chart of accounts, opening balances and verifications) before importing customers, suppliers, invoices and fixed assets from this provider.',
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
  // Arkiv rolls out per company (ARKIV_COMPANY_IDS). Outside the rollout the
  // Arkiv tools refuse; coded so an agent reads "not switched on" and moves
  // on, instead of the generic "Något gick fel" that invites a retry.
  ARKIV_NOT_ENABLED: {
    httpStatus: 403,
    message_sv: 'Företagshjärnan är inte aktiverad för det här företaget ännu. Arkivet fungerar som vanligt.',
    message_en: 'The company brain is not switched on for this company yet. The archive works as usual.',
    retryable: false,
  },
  // Signed-URL (direct-to-storage) upload: completion found no object under
  // the reservation. The bytes never landed, or the reservation expired.
  DOCUMENT_UPLOAD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Den uppladdade filen hittades inte eller har gått ut. Ladda upp filen igen.',
    message_en: 'The uploaded file was not found or the upload has expired. Upload the file again.',
  },
  // Signed-URL upload completed against an empty object: the PUT sent no
  // bytes, or sent them somewhere else.
  DOC_UPLOAD_EMPTY: {
    httpStatus: 400,
    message_sv: 'Filen är tom. Ladda upp filen igen.',
    message_en: 'The uploaded file is empty. Upload the file again.',
  },
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
  // Documents, transaction underlag and the invoice inbox as operations
  // (lib/operations/documents.ts, lib/operations/inbox-items.ts).
  DOC_DELETE_LINKED: {
    httpStatus: 409,
    message_sv:
      'Underlaget är knutet till en verifikation och utgör räkenskapsinformation enligt Bokföringslagen 7 kap 2§. Räkenskapsinformation ska bevaras i minst 7 år och får inte raderas. Använd "Ersätt med ny version" om underlaget behöver korrigeras.',
    message_en:
      'The document is linked to a journal entry and is accounting records under BFL 7 kap 2 §: it must be kept for 7 years and cannot be deleted. Upload a new version instead.',
  },
  // The other records that hold a document (lib/documents/deletion.ts); the
  // Swedish texts are DOCUMENT_DELETE_REFUSALS' there, word for word.
  DOC_DELETE_SUPPLIER_INVOICE_UNDERLAG: {
    httpStatus: 409,
    message_sv:
      'Underlaget hör till en registrerad leverantörsfaktura och utgör räkenskapsinformation enligt Bokföringslagen (5 kap 6-7 §§ och 7 kap). Det ska bevaras i minst 7 år och får inte raderas så länge leverantörsfakturan finns kvar.',
    message_en:
      'The document is the underlag of a registered supplier invoice and is accounting records under BFL (5 kap 6-7 §§, 7 kap): it must be kept for 7 years and cannot be deleted while the supplier invoice exists.',
    remediation: {
      description:
        'A supplier invoice (supplier_invoices.document_id) holds this document, and it stays as long as the supplier invoice does. A supplier invoice registered by mistake and not yet booked or paid can be deleted first (DELETE /api/v1/companies/{companyId}/supplier-invoices/{id}); a booked one is credited instead, and its underlag is kept.',
    },
  },
  DOC_DELETE_EXPENSE_CLAIM_UNDERLAG: {
    httpStatus: 409,
    message_sv:
      'Underlaget hör till ett registrerat utlägg och utgör räkenskapsinformation enligt Bokföringslagen (5 kap 6-7 §§ och 7 kap). Det ska bevaras i minst 7 år och får inte raderas så länge utlägget finns kvar.',
    message_en:
      'The document is the underlag of a registered expense claim and is accounting records under BFL (5 kap 6-7 §§, 7 kap): it must be kept for 7 years and cannot be deleted while the expense claim exists.',
    remediation: {
      description:
        'An expense claim (expense_claims.document_id) holds this document, and it stays as long as the expense claim does.',
    },
  },
  DOC_DELETE_BOOKED_INBOX_ITEM: {
    httpStatus: 409,
    message_sv:
      'Underlaget hör till en mottagen faktura som redan har bokförts eller blivit en leverantörsfaktura. Det utgör räkenskapsinformation enligt Bokföringslagen 7 kap och ska bevaras i minst 7 år i det skick det togs emot, så det får inte raderas.',
    message_en:
      'The document belongs to a received invoice that has already been booked or turned into a supplier invoice. It is accounting records under BFL 7 kap and must be kept for 7 years in the form it was received, so it cannot be deleted.',
    remediation: {
      description:
        'An inbox item that created a journal entry or a supplier invoice (invoice_inbox_items.created_journal_entry_id or created_supplier_invoice_id) holds this document as its file or as the received Peppol XML (channel_context.peppol_xml_document_id). It is kept; the files of an inbox item that was never booked can still be discarded.',
    },
  },
  DOC_ATTACH_REPLACES_POSTED: {
    httpStatus: 409,
    message_sv: 'Bilagan är kopplad till en bokförd verifikation och kan inte ersättas. Storno verifikationen först.',
    message_en: 'The document currently on the transaction belongs to a posted journal entry and cannot be replaced. Reverse the entry first.',
  },
  DOC_ATTACH_OTHER_VERIFIKAT: {
    httpStatus: 409,
    message_sv: 'Underlaget är redan kopplat till en annan verifikation.',
    message_en: 'The document is already the underlag of another journal entry.',
  },
  DOC_ATTACH_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv:
      'Bilagan kopplades till transaktionen men verifikationens period är låst: den kunde inte länkas till verifikationen.',
    message_en:
      'The document was attached to the transaction, but its journal entry is in a locked period, so it could not be linked to the entry.',
  },
  DOC_ATTACH_PROPAGATION_FAILED: {
    httpStatus: 500,
    message_sv:
      'Bilagan kopplades till transaktionen men kunde inte länkas till verifikationen. Försök igen: operationen är idempotent.',
    message_en:
      'The document was attached to the transaction but could not be linked to its journal entry. Retry: the operation is idempotent.',
    retryable: true,
  },
  DOC_DETACH_POSTED: {
    httpStatus: 409,
    message_sv: 'Bilagan är kopplad till en bokförd verifikation och kan inte tas bort. Storno verifikationen först.',
    message_en: 'The document is the underlag of a journal entry and cannot be detached. Reverse the entry first.',
  },
  DOC_DETACH_INBOX_UNLINK_FAILED: {
    httpStatus: 500,
    message_sv: 'Inkorgsposten kunde inte släppas, så underlaget är fortfarande kopplat. Försök igen.',
    message_en: 'The inbox item could not be released, so the document is still attached. Retry.',
    retryable: true,
  },
  DOC_DETACH_CONCURRENT: {
    httpStatus: 409,
    message_sv: 'Transaktionen ändrades samtidigt. Ladda om sidan och försök igen.',
    message_en: 'The transaction changed at the same time. Reload and try again.',
  },
  INBOX_ITEM_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Inkorgsposten hittades inte.',
    message_en: 'Inbox item not found.',
  },
  INBOX_ITEM_ALREADY_CONVERTED: {
    httpStatus: 409,
    message_sv: 'Posten är redan kopplad till en leverantörsfaktura.',
    message_en: 'The inbox item is already linked to a supplier invoice.',
  },
  // Issue #2980: a credit note never becomes a payable of its own.
  INBOX_ITEM_IS_CREDIT_NOTE: {
    httpStatus: 409,
    message_sv:
      'Posten är en kreditfaktura. Kreditera fakturan den avser i stället för att registrera en ny leverantörsfaktura.',
    message_en:
      'The inbox item is a credit note. Credit the invoice it refers to instead of registering a new supplier invoice.',
    remediation: {
      description:
        'details.credit_target says which invoice it credits (status matched, partial, amount_differs, already_credited, ambiguous or none, with candidates). For a matched one, credit it with the inbox item: POST /supplier-invoices/{id}/credit with inbox_item_id. If the reading is wrong (it is a normal invoice), correct documentKind and the totals on the inbox item first.',
      tool: 'gnubok_credit_supplier_invoice',
    },
  },
  INBOX_ITEM_EDIT_LOCKED: {
    httpStatus: 409,
    message_sv: 'Posten är redan kopplad till en leverantörsfaktura och kan inte ändras.',
    message_en: 'The inbox item is linked to a supplier invoice and cannot be changed.',
  },
  INBOX_ITEM_EDIT_CONFLICT: {
    httpStatus: 409,
    message_sv: 'Posten ändrades samtidigt av någon annan. Försök igen.',
    message_en: 'The inbox item was changed by someone else at the same time. Try again.',
    retryable: true,
  },
  INBOX_ITEM_DELETE_CONVERTED: {
    httpStatus: 409,
    message_sv: 'Posten är kopplad till en leverantörsfaktura och kan inte tas bort.',
    message_en: 'The inbox item is linked to a supplier invoice and cannot be deleted.',
  },
  INBOX_ITEM_DELETE_BOOKED: {
    httpStatus: 409,
    message_sv: 'Posten är bokförd och kan inte tas bort.',
    message_en: 'The inbox item is booked and cannot be deleted.',
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
  // A read-only (viewer) member: the storage policy admits the bytes on
  // membership alone, the document_attachments insert policy does not.
  INBOX_UPLOAD_NOT_PERMITTED: {
    httpStatus: 403,
    message_sv: 'Du har inte behörighet att ladda upp underlag i det här företaget. Medlemmar med läsbehörighet kan inte lägga till dokument.',
    message_en: 'You do not have permission to upload documents to this company. Read-only members cannot add documents.',
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
  // A hard delete refused because rows still point at the customer and the
  // database would silently null them (ON DELETE SET NULL), crm#263.
  // lib/customers/delete-guard.ts picks the code; details.dependents has
  // every count.
  CUSTOMER_HAS_ISSUED_INVOICES: {
    httpStatus: 409,
    message_sv:
      'Kunden kan inte tas bort eftersom den finns på fakturor som ska sparas i sju år, även makulerade. Fakturorna behöver kundens namn och adress.',
    message_en:
      "The customer cannot be deleted because it is on invoices that must be kept for seven years, cancelled ones included. The invoices need the customer's name and address.",
    remediation: {
      description:
        'An invoice row stores no copy of the buyer, so a customer on an issued or numbered invoice (cancelled included) is kept for the retention period (ML 17 kap 24 §, BFL 7 kap 2 §). To take it out of the roster, archive it instead: DELETE /api/v1/companies/{companyId}/customers/{id} sets archived_at once no invoice is open.',
    },
  },
  CUSTOMER_HAS_DRAFT_INVOICES: {
    httpStatus: 409,
    message_sv: 'Kunden har fakturautkast. Ta bort utkasten först, sedan kan kunden tas bort.',
    message_en: 'The customer has draft invoices. Delete the drafts first, then delete the customer.',
    remediation: {
      description:
        'Unnumbered drafts point at this customer and would lose it. Delete them first (gnubok_delete_draft_invoice, or DELETE /api/v1/companies/{companyId}/invoices/{id}), then retry. details.dependents.draft_invoices says how many.',
      tool: 'gnubok_delete_draft_invoice',
    },
  },
  CUSTOMER_HAS_SALES_ORDERS: {
    httpStatus: 409,
    message_sv: 'Kunden har kundorder. Ta bort dem först, sedan kan kunden tas bort.',
    message_en: 'The customer has sales orders. Delete them first, then delete the customer.',
    remediation: {
      description:
        'Sales orders point at this customer and would lose it. Delete them first (a confirmed order is cancelled before it can be deleted), then retry.',
    },
  },
  CUSTOMER_HAS_RECURRING_INVOICES: {
    httpStatus: 409,
    message_sv: 'Kunden har en återkommande faktura. Ta bort den först, sedan kan kunden tas bort.',
    message_en: 'The customer has a recurring invoice. Delete it first, then delete the customer.',
    remediation: {
      description: 'A recurring invoice schedule points at this customer. Delete the schedule first, then retry.',
    },
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
      'Organisationsnumret ser ut som ett personnummer, vilket ett utländskt företag inte kan ha. Välj kundtypen Svenskt företag för en enskild firma, eller Privatperson för en privatperson.',
    message_en:
      'The org number looks like a Swedish personal identity number, which a foreign business cannot have. Choose the customer type Swedish business for a sole trader, or Individual for a private person.',
  },
  CUSTOMER_COUNTRY_MISMATCH: {
    httpStatus: 400,
    message_sv: 'Landet stämmer inte med kundtypen eller VAT-numrets landsprefix.',
    message_en: 'The country does not agree with the customer type or the VAT number\'s country prefix.',
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
  SI_CREATE_ITEM_ACCOUNT_MISSING: {
    httpStatus: 400,
    message_sv:
      'En eller flera fakturarader saknar konto. Ange konto för varje rad, eller sätt ett standardkonto för kostnader på leverantören.',
    message_en:
      'One or more invoice lines have no account. Set an account for each line, or set a default expense account on the supplier.',
    remediation: {
      description:
        'Choose a BAS account for each line from the underlag and stage again with line_overrides[].account_number. No account is ever guessed.',
      tool: 'gnubok_create_supplier_invoice_from_inbox',
    },
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
  SI_BANK_ENTERED_NOT_PAYABLE: {
    httpStatus: 400,
    message_sv:
      'Fakturan kan bara markeras som inlagd i banken när den är godkänd och har något kvar att betala.',
    message_en:
      'The invoice can only be marked as entered at the bank while it is approved and has an outstanding amount.',
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
      'Det finns redan en banktransaktion som kan vara denna betalning. Länka den istället, eller markera som betald ändå om du är säker.',
    message_en:
      'A likely-matching bank transaction was found for this supplier. Suggest linking it instead of creating a new payment entry.',
    remediation: {
      description:
        'Inspect details.candidates[].match_reason. For an unlinked row, match it via POST /api/transactions/{id}/match-supplier-invoice. For `already_booked`, the row is already a posted verifikat (booked straight from the bank side): do NOT pay the invoice, correct the double booking instead (reverse one of the two vouchers with a storno entry and attach the underlag to the remaining one). Resend mark-paid with force: true only when the payment really is separate; on the v1 endpoint that retry needs a fresh Idempotency-Key.',
    },
  },
  // #2955: a foreign-currency invoice's payment clears the SEK its linked
  // vouchers carry on 244x (lib/bookkeeping/supplier-payment-amounts.ts).
  // When those links contradict each other the SEK is refused, not guessed.
  SI_PAID_SEK_UNRESOLVED: {
    httpStatus: 409,
    message_sv:
      'Det gick inte att avgöra hur mycket i kronor fakturan har kvar på leverantörsskulder (2440): kopplingen mellan fakturan och dess verifikationer är inte entydig, eller skulden där stämmer inte med fakturans belopp och kurs. Bokför betalningen som en egen verifikation i kronor och koppla den till fakturan, eller rätta kopplingen först.',
    message_en:
      "Could not determine how much SEK the invoice still carries on accounts payable (2440): the links between the invoice and its vouchers are ambiguous, or the liability there does not match the invoice's amount and rate. Book the payment as its own SEK voucher and link it to the invoice, or fix the links first.",
    remediation: {
      description:
        "details.reason names the contradiction: registration_voucher_not_live (reversed with no single correction), registration_voucher_shared, payment_history_mismatch (payment rows do not add up to paid_amount), payment_voucher_not_posted (missing, or reversed with no single correction), payment_voucher_shared (a batch voucher), no_liability_left, or ledger_rate_mismatch (2440 carries more than 10% away from remaining_amount x exchange_rate, details.expected_sek vs details.ledger_sek: the registration was corrected for something other than the rate, so the gap is not a kursdifferens), or ledger_history_too_long (more than 50 payment rows or 20 storno hops to follow: past what one request resolves). Check the SEK against the ledger, then resend mark-paid with explicit SEK `lines` (Debit 2440 / Credit the payment account, plus 3960/7960 for a genuine kursdifferens), or book the voucher yourself and link it to the invoice.",
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
  // Issue #2980: a supplier's credit note from the inbox credits the invoice
  // it references, and only when it is for all of it.
  SI_CREDIT_PARTIAL: {
    httpStatus: 400,
    message_sv:
      'Kreditfakturan gäller bara en del av fakturan. Kreditera krediterar alltid hela fakturan, så den kan inte användas här. Bokför kreditfakturan som en egen verifikation, eller kreditera hela fakturan och registrera en ny för det som återstår.',
    message_en:
      'The credit note covers only part of the invoice. Crediting always reverses the whole invoice, so it cannot be used here. Book the credit note as a verifikat of its own, or credit the whole invoice and register a new one for what remains.',
    remediation: {
      description:
        'details carries credit_total and invoice_total. Do not credit the whole invoice for a partial credit note. Hand over to the user: book the credit note as its own verifikat (reverse the credited part on 2440, the cost account and 2641), or credit the whole invoice and register a corrected invoice for the rest.',
    },
  },
  SI_CREDIT_DOCUMENT_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Kreditfakturan stämmer inte med fakturan: leverantör, valuta eller belopp skiljer sig, eller så saknas beloppet. Kontrollera uppgifterna i inkorgen.',
    message_en:
      'The credit note does not fit the invoice: the supplier, the currency or the amount differs, or the amount was not read. Check the reading in the inbox.',
    remediation: {
      description:
        'details.reason is supplier, currency, exceeds or amount_missing. Correct the reading (PATCH /inbox-items/{id}) or pick the invoice the credit note actually references.',
    },
  },
  SI_CREDIT_DOCUMENT_UNAVAILABLE: {
    httpStatus: 409,
    message_sv: 'Kreditfakturans dokument hittades inte eller hör redan till en annan verifikation.',
    message_en: 'The credit note document was not found or already belongs to another verifikat.',
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
  SI_BATCH_PAYEE_CHANGED: {
    httpStatus: 409,
    message_sv:
      'Leverantörens betalningsuppgifter eller belopp har ändrats sedan betalfilen förbereddes. Förbered betalfilen igen och kontrollera mottagaren.',
    message_en:
      "The supplier's payment details or amount changed after the payment batch was staged. Stage the batch again and check the payee.",
    remediation: {
      description:
        "Check the supplier's bankgiro, plusgiro or bank account, then stage the batch again (gnubok_preview_supplier_payment_batch, then gnubok_create_supplier_payment_batch). details.invoices names each supplier and what changed.",
    },
  },
  SI_DELETE_IN_PAYMENT_BATCH: {
    httpStatus: 409,
    message_sv:
      'Leverantörsfakturan ingår i en betalfil och kan inte tas bort: betalfilens rader är underlag för betalningsinstruktionen, även om filen makulerats.',
    message_en:
      'The supplier invoice is part of a payment batch and cannot be deleted: the batch rows document the payment instruction, even if the batch was cancelled.',
  },
  // ── API parity wave 4: supplier-invoice actions, inbox matches, Skatteverket helpers ──
  SI_DELETE_CREDIT_NOTE: {
    httpStatus: 400,
    message_sv:
      'Kreditfakturor kan inte tas bort direkt. Gå till originalfakturan och välj "Ångra kreditering" för att frigöra numret och återställa bokföringen.',
    message_en:
      'A credit note cannot be deleted directly. Undo the credit on the original invoice (uncredit), which cancels its verifikat with a storno and restores the original.',
  },
  SI_DELETE_INVALID_STATUS: {
    httpStatus: 400,
    message_sv: 'Endast obetalda fakturor utan bokföring kan tas bort.',
    message_en: 'Only unpaid supplier invoices without bookkeeping can be deleted (status registered, approved or overdue).',
  },
  SI_UNCREDIT_FAILED: {
    httpStatus: 400,
    message_sv: 'Krediteringen kunde inte ångras.',
    message_en:
      'The credit could not be undone. A locked or closed period refuses the storno of the credit note; details.reason names the cause.',
  },
  SI_ITEM_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Fakturaraden kunde inte hittas.',
    message_en: 'Supplier invoice line not found on this invoice.',
  },
  SI_ITEM_ACCOUNT_SETTLED: {
    httpStatus: 409,
    message_sv: 'Fakturan är avslutad och dess rader kan inte flyttas.',
    message_en: 'The supplier invoice is settled; its lines can no longer be moved to another account.',
  },
  SI_ITEM_ACCOUNT_NO_MATCHING_LINE: {
    httpStatus: 409,
    message_sv:
      'Registreringsverifikatet har ingen rad på det gamla kontot som matchar raden. Rätta verifikatet för hand.',
    message_en:
      'The registration verifikat has no line on the old account that matches this invoice line (it was corrected by hand). Correct the verifikat directly.',
  },
  SI_ITEM_ACCOUNT_FX_RATE_UNKNOWN: {
    httpStatus: 409,
    message_sv:
      'Fakturan är i utländsk valuta och det går inte att avgöra vilken växelkurs registreringsverifikatet bokfördes med, så raden flyttas inte. Rätta verifikatet för hand.',
    message_en:
      'The supplier invoice is in a foreign currency and the exchange rate its registration verifikat was booked at cannot be determined, so the line is not moved. Correct the verifikat directly.',
  },
  SI_ITEM_ACCOUNT_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturaraden kunde inte flyttas till det nya kontot. Försök igen.',
    message_en: 'The supplier invoice line could not be moved to the new account. Try again.',
    retryable: true,
  },
  SKATTEVERKET_CAPABILITY_BLOCKED: {
    httpStatus: 403,
    message_sv:
      'Den här funktionen kräver en betald prenumeration. Uppgradera för att fortsätta använda externa tjänster.',
    message_en: 'Talking to Skatteverket directly requires a paid subscription for this company.',
  },
}

const SALARY: Record<string, StructuredErrorEntry> = {
  SALARY_RUN_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Lönekörningen kunde inte hittas.',
    message_en: 'Salary run not found.',
    retryable: false,
    remediation: {
      description:
        'Check the salary run id and the company: a run of another company reads as not found. To find the run for a month, call gnubok_get_salary_run with period_year and period_month (v1: GET /salary-runs?period_year=YYYY).',
      tool: 'gnubok_get_salary_run',
    },
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
    retryable: false,
    remediation: {
      description:
        'Only the lines of a draft run change. Send a run in review back to draft first (gnubok_revert_salary_run, v1 POST /salary-runs/{id}/revert); an approved run is unapproved before that (gnubok_unapprove_salary_run). A paid or booked run is never edited: it is corrected with a rättelsekörning.',
      tool: 'gnubok_revert_salary_run',
    },
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
  // lib/salary/calculated-line-items.ts: absence, Övertid 50/100 % and OB rows,
  // förmån and recurring-line rows, the engine's semesterersättning and
  // öresavrundning rows are deleted and re-derived by every calculation, so a
  // hand edit would silently vanish before booking (#3185).
  SALARY_LINE_CALCULATED: {
    httpStatus: 400,
    message_sv:
      'Raden räknas fram av lönekörningen och skrivs om vid varje beräkning. Ändra underlaget i stället: frånvaron, de arbetade timmarna, förmånen eller den återkommande raden. En engångsrad för övertid eller OB läggs som Övertid eller Övrigt.',
    message_en:
      'This payslip line is derived by the salary calculation and rewritten on every calculation. Change its source instead: the absence, the worked hours and premium rules, the benefit or the recurring line. Put a one-off overtime or OB amount on item_type overtime or other.',
    remediation: {
      description:
        'Absence: gnubok_register_absence / gnubok_delete_absence. Hours: gnubok_set_worked_days. Förmåner: gnubok_update_employee_benefit. Recurring lines: gnubok_update_employee_recurring_line. A one-off amount: gnubok_add_payslip_line with item_type overtime or other. Then gnubok_calculate_salary_run.',
    },
    retryable: false,
  },
  SALARY_RUN_EMPLOYEE_DUPLICATE: {
    httpStatus: 409,
    message_sv: 'Den anställda finns redan i lönekörningen.',
    message_en: 'Employee is already part of this salary run.',
  },
  SALARY_RUN_EMPLOYEES_NOT_DRAFT: {
    httpStatus: 400,
    message_sv: 'Lönekörningen måste vara ett utkast för att ändra anställda eller månadens lön.',
    message_en: 'The salary run must be a draft to change its employees or this month\'s salary.',
  },
  SALARY_RUN_SALARY_FIELD_MISMATCH: {
    httpStatus: 400,
    message_sv: 'Månadslön kan bara sättas för månadsavlönade och arbetade timmar bara för timavlönade.',
    message_en: 'monthly_salary applies to monthly-paid employees and hours_worked to hourly-paid employees only.',
  },
  SALARY_RUN_HOURS_FROM_CALENDAR: {
    httpStatus: 409,
    message_sv: 'Timmarna för perioden hämtas från kalendern: ändra de arbetade dagarna i stället.',
    message_en: 'Hours for this period come from the calendar of worked days: change those days instead.',
  },
  SALARY_RUN_HOURLY_RATE_MISSING: {
    httpStatus: 400,
    message_sv: 'Den anställda saknar timlön: ange timlönen på den anställda innan du sätter arbetade timmar.',
    message_en: 'The employee has no hourly rate: set it on the employee before setting hours worked.',
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
  // Not a lookup miss: the ledger row is seeded lazily (the first booked run
  // or the vacation year close), so before that there is no balance to read.
  // An empty balance would state 0 days, which is false for anyone entitled.
  VACATION_BALANCE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Inget semestersaldo finns för den anställda ännu.',
    message_en: 'No vacation balance exists for the employee yet.',
    retryable: false,
    remediation: {
      description:
        'The vacation ledger is seeded when the employee\'s first salary run is booked (gnubok_book_salary_run) or at the vacation year close, not before. Until then read the entitlement from the employee (gnubok_get_employee: vacation_rule, vacation_days_per_year). Retrying returns the same answer.',
      tool: 'gnubok_get_employee',
    },
  },
  SALARY_RUN_TAX_TABLE_MISSING: {
    httpStatus: 400,
    message_sv: 'Skattetabellen saknas för perioden. Importera skattetabellen först.',
    message_en: 'Tax table is missing for the period.',
  },
  // salary_payroll_config has no row for the year (lib/salary/payroll-config.ts,
  // PayrollConfigMissingError). The year's figures ship as a migration once they
  // are official; the calendar tripwire (tests/pg/payroll-rates-calendar.pg.test.ts)
  // fails CI before the year turns if they have not.
  SALARY_PAYROLL_CONFIG_MISSING: {
    httpStatus: 409,
    message_sv:
      'Lönesatserna för året (arbetsgivaravgifter, prisbasbelopp, traktamente med mera) är inte inlagda ännu. Beräkningen kan göras när de är på plats.',
    message_en: 'Payroll rates for this year are not loaded yet. The calculation can run once they are.',
    remediation: {
      description:
        'Accounted adds each year\'s statutory payroll rates in a release once they are officially set. Nothing in the input is wrong: do not move the payment date to get around it. Try again once the year\'s rates are in place.',
    },
    retryable: false,
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
  // A production deployment without PERSONNUMMER_ENCRYPTION_KEY: every
  // employee create (and every decrypt-on-read) throws before touching the
  // database. Deliberately not INTERNAL_ERROR: it is a configuration gap, not
  // transient, and retrying never helps, so the user should hear "contact
  // support" rather than "try again later". 503 like
  // INVOICE_SEND_EMAIL_NOT_CONFIGURED: the service is unavailable until an
  // operator sets the variable. #1996
  PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED: {
    httpStatus: 503,
    message_sv:
      'Lönemodulen är inte konfigurerad: krypteringsnyckeln för personnummer (PERSONNUMMER_ENCRYPTION_KEY) saknas i driftmiljön. Kontakta supporten.',
    message_en:
      'Payroll is not configured: the personal-number encryption key (PERSONNUMMER_ENCRYPTION_KEY) is missing from the deployment environment. Contact support.',
    remediation: {
      description:
        'Set PERSONNUMMER_ENCRYPTION_KEY in the deployment environment and redeploy. Retrying the request without it will fail identically.',
    },
  },
  SALARY_RUN_DUPLICATE_PERIOD: {
    httpStatus: 409,
    message_sv: 'En lönekörning för perioden finns redan.',
    message_en: 'A salary run for that period already exists.',
  },
  SALARY_RUN_UNDERLAG_NOT_BOOKED: {
    httpStatus: 409,
    message_sv: 'Bokföringsunderlaget skapas när lönekörningen är bokförd.',
    message_en: 'The accounting document is available once the salary run is booked.',
    retryable: false,
  },
  SALARY_RUN_CORRECT_NOT_BOOKED: {
    httpStatus: 409,
    message_sv: 'Bara bokförda lönekörningar kan korrigeras (rättelsekörning).',
    message_en: 'Only booked salary runs can be corrected (rättelsekörning).',
  },
  SALARY_RUN_ALREADY_CORRECTED: {
    httpStatus: 409,
    message_sv: 'Lönekörningen är redan korrigerad; arbeta vidare i korrigeringskörningen.',
    message_en: 'The salary run is already corrected; continue in its correction run.',
  },
  SALARY_REGISTER_DATES_LOCKED_BY_RUN: {
    httpStatus: 409,
    message_sv:
      'Datumen ingår i avvikelseperioden för en lönekörning som redan är beräknad, godkänd eller bokförd. Återställ körningen till utkast, eller gör en rättelsekörning, innan frånvaro eller arbetade timmar ändras.',
    message_en:
      'The dates fall inside the deviation period of a salary run that is already calculated, approved or booked. Revert that run to draft, or run a correction, before changing absence or worked hours.',
    remediation: {
      description:
        'details.salary_run_id names the run and details.locked_dates the dates it reads. Draft runs never lock; a run in review can be reverted to draft (POST /salary-runs/{id}/revert, gnubok_revert_salary_run).',
    },
  },
  SALARY_RUN_DEVIATION_PERIOD_INVALID: {
    httpStatus: 400,
    message_sv:
      'Ogiltig avvikelseperiod: ange både start- och slutdatum (ÅÅÅÅ-MM-DD), start före slut, högst två månader.',
    message_en:
      'Invalid deviation period: give both start and end (YYYY-MM-DD), start before end, at most two months.',
  },
  SALARY_RUN_DEVIATION_PERIOD_OVERLAP: {
    httpStatus: 409,
    message_sv:
      'Avvikelseperioden överlappar en annan lönekörning: samma frånvarodagar skulle dras två gånger. Ange en avvikelseperiod som inte överlappar, eller byt inställning först inför nästa nya månad.',
    message_en:
      'The deviation period overlaps another salary run: the same absence days would be deducted twice. Pass a non-overlapping deviation period, or change the setting before the next new month.',
    remediation: {
      description:
        'details.conflicting_run_id names the run that already reads these days. Pass deviation_period_start/deviation_period_end that start after its window, or leave the company setting unchanged.',
    },
  },
  SALARY_RUN_PATCH_NOT_DRAFT: {
    httpStatus: 400,
    message_sv: 'Endast utkast (draft) kan uppdateras.',
    message_en: 'Only draft salary runs can be patched.',
  },
  // Kontantprincipen guard: AGI derives its redovisningsperiod from the run's
  // period_year/period_month while the verifikat books on payment_date, so a
  // payment date outside the period month would declare the salary in the
  // wrong period (SFL 26 kap). For a payment that truly lands in another
  // month, the run itself belongs in that period.
  SALARY_RUN_PAYMENT_DATE_OUTSIDE_PERIOD: {
    httpStatus: 400,
    // No longer raised (#2191): the AGI period follows payment_date, so a
    // payout in another month is legal. Kept so clients mapping the code
    // keep compiling.
    message_sv: 'Utbetalningsdagen måste ligga i lönekörningens period.',
    message_en: 'The payment date must fall within the salary run\'s period month.',
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
  // lib/salary/salary-entries.ts: a retried booking resumes by adopting the
  // run's already-posted vouchers that are exactly what it would post, and
  // stops here on any other posted voucher of the run (a duplicate, or one
  // booked from data that has changed since) instead of posting it twice.
  SALARY_RUN_PARTIALLY_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Lönekörningen har redan bokförda verifikationer från ett tidigare försök som inte stämmer med körningen. Återför dem och bokför sedan lönekörningen igen.',
    message_en:
      'The salary run already has posted vouchers from an earlier attempt that do not match the run (details.voucher_numbers). Reverse them, then book the run again.',
    remediation: {
      description:
        'Reverse each voucher in details.entry_ids with storno (gnubok_reverse_journal_entry), then book the run again. Posted vouchers that match the run exactly are reused by the next booking, never posted twice.',
      tool: 'gnubok_reverse_journal_entry',
    },
    retryable: false,
    thrown_message_sv: true,
  },
  // lib/salary/book-run.ts (accounted#3251): another call holds the run's
  // booking claim (claim_salary_run_booking), so this one posted nothing.
  // The claim ends when that call finishes, or after 15 minutes if it died.
  SALARY_RUN_BOOKING_IN_PROGRESS: {
    httpStatus: 409,
    message_sv:
      'Lönekörningen håller redan på att bokföras (i en annan flik eller av en agent), så inget bokfördes nu. Vänta en stund och kontrollera sedan lönekörningens status.',
    message_en:
      'The salary run is already being booked by another request. Nothing was posted by this one.',
    remediation: {
      description:
        'Wait a moment, then fetch the run. Status booked means the other booking went through; status paid means it did not finish, so book the run again (vouchers an interrupted booking already posted are reused, never posted twice). A staged book_salary_run operation stays pending and can be approved again.',
    },
    retryable: true,
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
  // Salary-run lifecycle operations (lib/salary/payslips/send.ts,
  // lib/salary/run-status-recall.ts), shared by the dashboard, v1 and MCP.
  SALARY_PAYSLIPS_SEND_SANDBOX: {
    httpStatus: 403,
    message_sv: 'Lönebesked kan inte skickas från sandlådan. Skapa ett konto för att skicka e-post.',
    message_en: 'Payslips cannot be sent from the sandbox. Create an account to send email.',
  },
  SALARY_PAYSLIPS_SEND_CAPABILITY_BLOCKED: {
    httpStatus: 403,
    message_sv: 'Att skicka lönebesked med e-post kräver en betald prenumeration.',
    message_en: 'Emailing payslips requires a paid subscription.',
  },
  SALARY_RUN_REVERT_NOT_REVIEW: {
    httpStatus: 400,
    message_sv: 'Lönekörningen måste vara i granskningsstatus för att återställas till utkast.',
    message_en: 'The salary run must be in review status to revert it to draft.',
  },
  SALARY_RUN_UNAPPROVE_NOT_APPROVED: {
    httpStatus: 400,
    message_sv:
      'Bara en godkänd lönekörning kan låsas upp. En betald eller bokförd körning korrigeras via korrigeringsflödet.',
    message_en:
      'Only an approved salary run can be unlocked. A paid or booked run is corrected through the correction flow.',
  },
  SALARY_RUN_UNAPPROVE_AGI_FILED: {
    httpStatus: 409,
    message_sv:
      'AGI har redan skickats till Skatteverket för denna period. Ändra genom att lämna in en korrigerad AGI (samma specifikationsnummer) i stället.',
    message_en:
      'The AGI for this period has already been sent to Skatteverket. Change it by filing a corrected AGI (same specifikationsnummer) instead.',
  },
  SALARY_RUN_UNAPPROVE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte återkalla godkännandet.',
    message_en: 'Could not recall the approval.',
  },
  SALARY_RUN_STATUS_CHANGED: {
    httpStatus: 409,
    message_sv: 'Lönekörningens status har ändrats: ladda om sidan och försök igen.',
    message_en: 'The salary run status changed in the meantime: reload and try again.',
  },
  AGI_GENERATE_NOT_BOOKABLE: {
    httpStatus: 400,
    message_sv: 'AGI kan endast genereras för lönekörningar i status review, approved, paid, booked eller corrected.',
    message_en: 'AGI can only be generated for salary runs in review, approved, paid, booked, or corrected status.',
    retryable: false,
    remediation: {
      description:
        'The run is still a draft. Calculate and book it first (gnubok_book_salary_run stages the booking of a calculated draft run) so the AGI matches the books, then generate the AGI.',
      tool: 'gnubok_book_salary_run',
    },
  },
  // gnubok_agi_submit files the stored underlag; it never generates one, so a
  // run without an agi_declarations row has nothing to send yet.
  AGI_SUBMIT_NOT_GENERATED: {
    httpStatus: 409,
    message_sv: 'AGI-underlaget saknas för lönekörningen. Generera AGI först och lämna sedan in.',
    message_en: 'No AGI has been generated for this salary run yet. Generate the AGI first, then submit it.',
    retryable: false,
    remediation: {
      description:
        'Stage gnubok_generate_agi for the run and have it approved, then stage gnubok_agi_submit again.',
      tool: 'gnubok_generate_agi',
    },
  },
  AGI_PERIOD_CONFLICT: {
    httpStatus: 409,
    message_sv:
      'En annan lönekörning är redan deklarerad för samma redovisningsperiod (utbetalningsmånad). En arbetsgivardeklaration per månad ska omfatta alla utbetalningar den månaden: slå ihop körningarna eller rätta den befintliga deklarationen.',
    message_en:
      'Another salary run is already declared for the same reporting period (payout month). One employer declaration per month must cover every payment made that month: merge the runs or correct the existing declaration.',
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
  // Deletes the database refuses because other rows still point at the row
  // (Postgres 23503 on "update or delete"), #2831. lib/errors/foreign-key-
  // refusal.ts resolves the constraint to one of these codes and supplies the
  // specific sentence and remediation for each mapped register; the entries
  // below are the code-level defaults.
  JOURNAL_ENTRY_DELETE_BLOCKED_BY_REGISTER: {
    httpStatus: 409,
    message_sv:
      'Verifikatet används av ett register (anläggningar, periodiseringar eller lön) och kan inte raderas. Gör en rättelse (storno) i stället.',
    message_en:
      'This voucher is used by a register (fixed assets, accruals or payroll) and cannot be deleted. Make a correction (storno) instead.',
    remediation: {
      description:
        'A posted verifikat that a register points at is corrected, never deleted (BFL 5 kap. 5 §). Reverse it with storno (gnubok_reverse_journal_entry); details.register names the register and the remediation on the error names its own way back.',
      tool: 'gnubok_reverse_journal_entry',
    },
  },
  SALARY_RUN_DELETE_BLOCKED_BY_PAYMENT_FILE: {
    httpStatus: 409,
    message_sv:
      'Lönekörningen kan inte raderas eftersom en betalfil har skapats för den, och betalfilen ska sparas i sju år. Ändra lönekörningen i stället.',
    message_en:
      'This payroll run cannot be deleted because a payment file was generated for it, and that file must be kept for seven years. Edit the payroll run instead.',
    remediation: {
      description:
        'A generated payment file is kept for seven years, so the run it belongs to stays. Edit the draft run instead (gnubok_set_run_salary, gnubok_update_salary_run), or leave it unbooked.',
      tool: 'gnubok_update_salary_run',
    },
  },
  DOCUMENT_DELETE_BLOCKED_BY_TRANSACTION: {
    httpStatus: 409,
    message_sv:
      'Underlaget är kopplat till en banktransaktion och kan inte tas bort. Koppla bort det från transaktionen först.',
    message_en:
      'The document is attached to a bank transaction and cannot be deleted. Detach it from the transaction first.',
    remediation: {
      description:
        'The document is the underlag of a bank transaction (transactions.document_id). Detach it from the transaction first (POST /api/v1/companies/{companyId}/transactions/{id}/detach-document), then delete it. A document linked to a verifikat is never deleted.',
    },
  },
  RECORD_STILL_REFERENCED: {
    httpStatus: 409,
    message_sv: 'Posten kan inte tas bort eftersom annan data fortfarande hänvisar till den.',
    message_en: 'This record cannot be deleted because other records still refer to it.',
    remediation: {
      description:
        'Other records still point at this one; details.referenced_by names their table. Remove or re-point those records first, or keep this one (archive or deactivate it where the resource supports that). Retrying the same delete will not help.',
    },
  },
  // Utlägg repaid with the salary (#2331).
  SALARY_RUN_NO_OPEN_EXPENSE_CLAIMS: {
    httpStatus: 404,
    message_sv: 'Den anställda har inga öppna utlägg att lägga till.',
    message_en: 'The employee has no open expense claims to add.',
  },
  EXPENSE_CLAIM_ALREADY_ON_PAYSLIP: {
    httpStatus: 409,
    message_sv: 'Utlägget ligger redan på ett lönebesked.',
    message_en: 'The expense claim is already on a payslip.',
  },
  SALARY_RUN_EXPENSE_CLAIM_NOT_OPEN: {
    httpStatus: 409,
    message_sv: 'Ett utlägg på lönebeskedet är inte längre öppet (utbetalt eller borttaget). Ta bort raden och beräkna om innan bokföring.',
    message_en: 'An expense claim on the payslip is no longer open (paid or removed). Remove the line and recalculate before booking.',
  },
  // Salary payment file (ISO 20022 pain.001 / Bankgirot LB) on the v1 API.
  // The dashboard routes keep their legacy messages; both surfaces share
  // lib/salary/payment/build-payment-file.ts. `details.problem` names the
  // field that is missing or invalid.
  SALARY_RUN_PAYMENT_FILE_NOT_READY: {
    httpStatus: 409,
    message_sv: 'Betalfil kan bara genereras efter godkännande (status approved, paid eller booked).',
    message_en: 'A payment file can only be generated after approval (status approved, paid or booked).',
  },
  SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS: {
    httpStatus: 422,
    message_sv:
      'Företagets bankuppgifter för betalfilen saknas eller är ogiltiga: IBAN och BIC för ISO 20022 (pain.001), bankgironummer för Bankgirot LB. Fyll i dem under Inställningar → Fakturering.',
    message_en:
      'The company bank details the payment file needs are missing or invalid: IBAN and BIC for ISO 20022 (pain.001), bankgiro number for Bankgirot LB. Fill them in under Settings → Invoicing.',
  },
  SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_MISSING: {
    httpStatus: 422,
    message_sv:
      'En eller flera anställda med nettoutbetalning saknar clearingnummer eller kontonummer. Komplettera bankuppgifterna under Anställda.',
    message_en:
      'One or more employees with a net payout lack a clearing number or account number. Complete their bank details under Employees.',
  },
  SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_INVALID: {
    httpStatus: 422,
    message_sv:
      'En eller flera anställda har bankuppgifter som betalfilen inte kan ta med. details.employees anger vem och vad som behöver rättas.',
    message_en:
      'One or more employees have bank details the payment file cannot carry. details.employees names who and what to correct.',
  },
  SALARY_RUN_PAYMENT_FILE_GENERATION_FAILED: {
    httpStatus: 400,
    message_sv: 'Betalfilen kunde inte skapas: kontrollera bankuppgifterna för företaget och de anställda.',
    message_en: 'The payment file could not be generated: check the bank details of the company and its employees.',
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
  PROVIDER_CONFIGURATION_ERROR: {
    httpStatus: 503,
    message_sv: 'Fortnox-anslutningen behöver åtgärdas av Accounted. Kontakta supporten. Du behöver inte återansluta.',
    message_en: 'The Fortnox connection needs attention from Accounted. Contact support. You do not need to reconnect.',
  },
  PROVIDER_AUTH_EXPIRED: {
    httpStatus: 401,
    message_sv: 'Anslutningen till leverantören har gått ut. Återanslut för att fortsätta.',
    message_en: 'Provider authentication expired or refresh failed.',
  },
  // The provider refused ONE register while the same access token keeps
  // answering for the rest (Fortnox: "Saknar behörighet för
  // leverantörsregister.", code 2003275). Never "återanslut" here: the
  // reconnect re-mints the same grant and meets the same 403.
  PROVIDER_RESOURCE_FORBIDDEN: {
    httpStatus: 403,
    message_sv:
      'Leverantören nekade åtkomst till en del av uppgifterna, men anslutningen fungerar. Att återansluta hjälper inte: kontrollera behörigheterna för det registret hos leverantören (i Fortnox användarens rättigheter och licens, i Bokio rättigheterna på integrationstoken) och försök igen.',
    message_en:
      'The provider refused access to part of the data, but the connection itself works. Reconnecting will not help: check that register\'s permissions with the provider (in Fortnox the user rights and licence, in Bokio the integration token rights) and try again.',
  },
  PROVIDER_LICENSE_MISSING: {
    httpStatus: 403,
    message_sv:
      'Fortnox nekade åtkomst eftersom en licens saknas eller inte är aktiv. Kontrollera integrations- eller applicensen i Fortnox och försök sedan igen. Du kan även importera via SIE-fil under tiden.',
    message_en:
      'Fortnox refused access because a license is missing or inactive. Check the integration or app license in Fortnox, then try again. You can also import via SIE file in the meantime.',
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
  // The three below only arise on the kontantmetod side (19xx credit): see
  // supplier_invoice_settlement_side, migration 20260921190300.
  LINK_SI_VOUCHER_NO_BANK_CREDIT: {
    httpStatus: 400,
    message_sv:
      'Verifikationen krediterar inget kassa- eller bankkonto (19xx), så den kan inte vara betalningen av fakturan. Välj verifikationen där pengarna lämnade kontot.',
    message_en:
      'The journal entry does not credit a cash or bank account (19xx), so it cannot be the payment of this invoice. On kontantmetoden the payment verifikat is the one where the money left the account (Dr cost, Dr 2641 / Cr 19xx).',
  },
  LINK_SI_VOUCHER_FULLY_ALLOCATED: {
    httpStatus: 409,
    message_sv:
      'Verifikationens utbetalning är redan kopplad till andra leverantörsfakturor och har inget belopp kvar. Välj en annan verifikation.',
    message_en:
      'The voucher\'s bank credit is already used by payment rows for other supplier invoices; nothing is left to settle this one. Pick a different voucher.',
  },
  LINK_SI_VOUCHER_CUTOFF_ALREADY_POSTED: {
    httpStatus: 409,
    message_sv:
      'Bokslutets periodisering enligt kontantmetoden är redan bokförd för ett år som omfattar både fakturan och betalningen, och den räknade fakturan som obetald. Rätta periodiseringen först (storno och bokför om), koppla sedan verifikationen.',
    message_en:
      'A posted kontantmetod year-end cut-off covers both the invoice and the payment voucher and counted this invoice as unpaid. Correct the cut-off first (storno and re-post), then link the voucher.',
  },
  LINK_SI_VOUCHER_ALREADY_LINKED: {
    httpStatus: 409,
    message_sv: 'Verifikationen är redan länkad till den här leverantörsfakturan.',
    message_en: 'This journal entry is already linked to this supplier invoice.',
  },
  LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING: {
    httpStatus: 400,
    message_sv:
      'Verifikationens belopp är större än leverantörsfakturans återstående belopp. Verifikationen täcker fler fakturor: välj en annan verifikation eller rätta beloppet först.',
    message_en:
      'The voucher\'s settlement amount (details.ap_debit: the 244x debit, or details.bank_credit: the 19xx credit on kontantmetoden) exceeds the supplier invoice\'s remaining balance. Split the voucher across multiple supplier invoices via gnubok_correct_entry first, or pick a different voucher.',
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
  BATCH_TX_POSSIBLE_DUPLICATE: {
    httpStatus: 409,
    message_sv:
      'Transaktionen ser redan ut att vara bokförd: en eller flera verifikationer utan bankkoppling summerar exakt till beloppet. Koppla transaktionen till dem i stället, eller bokför ändå om de inte hör ihop.',
    message_en:
      'The transaction already looks booked: one or more posted vouchers with no bank link add up exactly to its amount. Link the transaction to them instead, or pass force=true with expected_journal_entry_ids to book anyway.',
    retryable: false,
    // Names the scope: a key without reconciliation:write was sent to a tool
    // it cannot call (feedback seqs 817176, 817189). The MCP door replaces
    // this hint when it knows the key's scopes.
    remediation: {
      description:
        'Link the bank row to the vouchers the message names instead of booking it again: gnubok_reconcile_match (needs the reconciliation:write scope) with account_key "bank:<cash_account_id>" and one pair { external_ids: [transaction_id], journal_entry_ids: [...], allocations }. One voucher also links with gnubok_link_transaction_to_journal_entry. A key without reconciliation:write: the user links the row on the Avstämning page in Accounted, or reconnects the connector so its new key carries that scope. Only if the row is a genuinely separate affärshändelse, call again with force=true and expected_journal_entry_ids set to exactly the ids the refusal listed.',
      tool: 'gnubok_reconcile_match',
    },
  },
  // force=true reached a door whose already-explained check could not run:
  // an override that cannot be re-verified against the current voucher set
  // is refused, never waved through. Transient by nature (a ledger scan that
  // timed out), hence retryable; a staged operation refused this way is
  // auto-rejected and has to be staged again.
  BATCH_TX_EXPLAINED_CHECK_FAILED: {
    httpStatus: 409,
    message_sv:
      'Dubblettkontrollen kunde inte köras, så "bokför ändå" avvisades: ett åsidosättande som inte kan verifieras igen bokförs aldrig. Försök igen.',
    message_en:
      'The already-explained check could not run, so force=true was refused: an override that cannot be re-verified against the current vouchers is never honoured. Retry the request.',
    retryable: true,
    remediation: {
      description:
        'Retry after a short backoff. A staged operation refused this way is auto-rejected: stage it again with the same force + expected_journal_entry_ids, or link the row to the vouchers with gnubok_reconcile_match instead.',
    },
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
  BATCH_CASH_METHOD_UNBOOKED_INVOICE: {
    httpStatus: 400,
    message_sv:
      'Företaget använder kontantmetoden och minst en av fakturorna är inte bokförd än: intäkt eller kostnad och moms ska bokföras vid betalningen. En samlingsmatchning kvittar bara mot kundfordringar eller leverantörsskulder och skulle hoppa över det. Matcha fakturan direkt mot transaktionen om den ensam motsvarar beloppet, annars markera varje faktura som betald och koppla sedan transaktionen till verifikaten.',
    message_en:
      'The company uses the cash method and at least one of the invoices is not booked yet: revenue or cost and VAT must be booked at payment. A batch match only clears receivables or payables and would skip that. Match the invoice directly to the transaction if it alone covers the amount; otherwise mark each invoice as paid and then link the transaction to those vouchers.',
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
      'Alla transaktioner i en samlingsbokföring måste ha samma datum: BFL 5 kap 6 § tredje stycket tillåter en gemensam verifikation bara för likartade affärshändelser samma dag. Dela upp bokföringen per dag.',
    message_en:
      'All transactions in a bulk booking must share the same date: BFL 5 kap 6 § tredje stycket allows a gemensam verifikation only for likartade affärshändelser on the same day. Split the batch per day.',
    retryable: false,
    remediation: {
      description:
        'This is a legal limit, not a technical one: a monthly samlingsverifikat over several days is not an option under BFL 5 kap 6 §. Group the tx_ids by date and call gnubok_bulk_book_transactions once per date (and per direction).',
      tool: 'gnubok_bulk_book_transactions',
    },
  },
  BULK_BOOK_DIRECTION_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Alla transaktioner i en samlingsbokföring måste ha samma riktning (alla intäkter eller alla utgifter): BFL 5 kap 6 § tredje stycket tillåter en gemensam verifikation bara för likartade affärshändelser. Dela upp bokföringen per riktning.',
    message_en:
      'All transactions in a bulk booking must share the same direction (all income or all expense): BFL 5 kap 6 § tredje stycket allows a gemensam verifikation only for likartade affärshändelser. Split the batch per direction.',
    retryable: false,
    remediation: {
      description:
        'This is a legal limit, not a technical one: an inflow and an outflow are not likartade affärshändelser under BFL 5 kap 6 §. Call gnubok_bulk_book_transactions once for the income rows and once for the expense rows (each batch still on one date).',
      tool: 'gnubok_bulk_book_transactions',
    },
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
  // A live connection whose skattekonto has not been fetched yet, so the
  // reconciliation account "skattekonto" does not exist. It fills by itself
  // (right after each BankID consent, and on the scheduled sync), which makes
  // this the one retryable answer; an expired connection is
  // SKATTEVERKET_NOT_CONNECTED. Both reached agents as UNKNOWN_ERROR before.
  SKATTEKONTO_NOT_SYNCED: {
    httpStatus: 409,
    message_sv:
      'Skatteverket är kopplat men inga skattekontohändelser har hämtats ännu. Skattekontot går att stämma av när den första hämtningen är klar.',
    message_en:
      'Skatteverket is connected but no skattekonto rows have been fetched yet, so account_key "skattekonto" does not exist yet. It appears once the first fetch completes.',
    retryable: true,
    remediation: {
      description:
        'Skip the skattekonto for now and continue with the other accounts; ask again later. The skattekonto is fetched right after each BankID consent and by the scheduled sync, and the user can fetch it now on the Skattekonto page in Accounted. If it stays empty, check the connection with gnubok_connect_skatteverket and have the user reconnect.',
      tool: 'gnubok_connect_skatteverket',
    },
    thrown_message_sv: true,
  },
  // A skattekonto row whose event a live verifikat already carries on 1630
  // (typically imported by SIE from the previous system): booking it would
  // record the event twice. The thrown Swedish text names the verifikat.
  SKATTEKONTO_BOOK_LEDGER_TWIN_EXISTS: {
    httpStatus: 409,
    message_sv:
      'Händelsen finns redan i bokföringen: ett verifikat innehåller den redan på konto 1630. Koppla raden till verifikatet i stället för att bokföra den en gång till.',
    message_en:
      'The event is already in the ledger: a live verifikat carries it on account 1630. Link the row to that verifikat instead of booking it a second time.',
    retryable: false,
    remediation: {
      description:
        'Link the row to the verifikat the message names with gnubok_reconcile_match (account_key "skattekonto", pairs [{ external_ids: [row id, plus any same-day rows the verifikat carries with it], journal_entry_ids: [verifikat id] }]). Book it anyway (allow_duplicate / allow_duplicate_ids) only when the user confirms the event really happened twice.',
      tool: 'gnubok_reconcile_match',
    },
    thrown_message_sv: true,
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
  // Årsredovisning workflow operations (lib/operations/arsredovisning.ts).
  SIGNATURE_INVALID_TRANSITION: {
    httpStatus: 409,
    message_sv:
      'Underskriften kan inte ändras: den är redan signerad eller avböjd, hör till en annan version eller finns inte för räkenskapsåret.',
    message_en:
      'The signature cannot transition: it is already signed or declined, bound to another version, or not found for this fiscal period.',
    retryable: false,
  },
  ARSREDOVISNING_CONTENT_CHANGED: {
    httpStatus: 409,
    message_sv:
      'Årsredovisningens innehåll har ändrats sedan förhandsgranskningen. Granska den nya förhandsgranskningen och försök igen.',
    message_en:
      'The annual report content has changed since it was previewed (content hash mismatch). Review a new dry run and retry.',
    retryable: false,
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
  ASSET_OPENING_CHANGED: {
    httpStatus: 409,
    message_sv:
      'Tillgångens ingående avskrivning har ändrats. Beräkna avskrivningsförslaget på nytt innan du bokför.',
    message_en:
      'The asset opening depreciation has changed. Recalculate the depreciation proposal before posting.',
  },
  ASSET_DELETE_BLOCKED: {
    httpStatus: 409,
    message_sv:
      'Tillgången kan inte tas bort eftersom den har nått bokföringen: avskrivningar är bokförda eller tillgången är avyttrad. Registerraden är då räkenskapsinformation (BFL 7 kap.). Använd avyttring, eller återför verifikatet med storno först.',
    message_en:
      'The asset cannot be deleted because it has reached the books: depreciation is posted or the asset is disposed. The register row is then accounting information (BFL ch. 7). Dispose it, or reverse the voucher with storno first.',
  },
  INVALID_OPENING_DEPRECIATION: {
    httpStatus: 400,
    // The thrower (AssetOpeningDepreciationInvalidError) names the failed rule
    // in Swedish; message_sv is the fallback that lists every rule.
    thrown_message_sv: true,
    message_sv:
      'Redan avskrivet belopp är ogiltigt: det måste vara mellan 0 och anskaffningsvärdet minus restvärdet, ha ett datum som inte är senare än i dag eller före anskaffningsdatumet, och kan inte kombineras med komponentuppdelning.',
    message_en:
      'The opening accumulated depreciation is invalid: it must be between 0 and the acquisition cost less the residual value, carry a date that is not after today or before the acquisition date, and cannot be combined with a component breakdown.',
  },
  K3_REQUIRED_FOR_COMPONENTS: {
    httpStatus: 422,
    message_sv:
      'Komponentuppdelning (k3_components) kräver att företaget tillämpar K3 (BFNAR 2012:1).',
    message_en:
      'Component depreciation (k3_components) requires the company to apply K3 (BFNAR 2012:1).',
  },
  INVALID_K3_COMPONENTS: {
    httpStatus: 400,
    message_sv:
      'Komponentuppdelningen är ogiltig: komponenternas anskaffningsvärden måste summera till tillgångens anskaffningsvärde.',
    message_en:
      'The component breakdown is invalid: component costs must sum to the acquisition cost of the asset.',
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

// Dimensions registry (kostnadsställe/projekt)
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
  DIMENSION_SYSTEM_DELETE: {
    httpStatus: 400,
    message_sv: 'Systemdimensioner (kostnadsställe och projekt) kan inte tas bort: avaktivera dem istället.',
    message_en: 'System dimensions (kostnadsställe/projekt) cannot be deleted: archive (inactivate) them instead.',
  },
  // The DB registry guard (enforce_dimension_registry_guards) raises when any
  // posted/reversed line is tagged with the dimension's number, and the value
  // retention trigger fires on the cascade to dimension_values. Routes surface
  // the trigger's own Swedish message via `messageSv`.
  DIMENSION_REFERENCED: {
    httpStatus: 409,
    message_sv:
      'Dimensionen används på bokförda verifikat och kan inte tas bort: avaktivera den istället.',
    message_en:
      'The dimension is referenced by posted vouchers and cannot be deleted: archive (inactivate) it instead.',
    remediation: {
      description:
        'Archive the dimension instead: PATCH /api/dimensions/[id] with { "is_active": false }. Numbers tagged on posted lines are retained for the BFL 7-year period.',
    },
  },
  DIMENSION_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Dimensionen kunde inte tas bort.',
    message_en: 'Failed to delete dimension.',
  },
  ACCOUNTING_METHOD_CHANGE_MID_YEAR: {
    httpStatus: 409,
    message_sv: 'Bokföringsmetoden kan inte bytas mitt i ett räkenskapsår som har bokförda verifikationer.',
    message_en: 'The accounting method cannot change in the middle of a fiscal year that has posted vouchers: it governs the whole year. A person changes it in the settings before the next fiscal year.',
  },
  BOOKKEEPING_LOCK_REOPENS_FILED_VAT: {
    httpStatus: 409,
    message_sv: 'Låsdatumet skulle öppna momsperioder som redan är deklarerade till Skatteverket.',
    message_en: 'The lock date would reopen VAT periods already filed with Skatteverket. Send acknowledge_filed_vat_periods: true if a correction must be booked there (then file a corrected return).',
  },
  DIMENSION_NUMBER_TAKEN: {
    httpStatus: 409,
    message_sv: 'Dimensionsnumret finns redan i registret.',
    message_en: 'That dimension number is already in the registry. Omit sie_dim_no to get the next free number from 20.',
  },
  DIMENSION_PARENT_INVALID: {
    httpStatus: 400,
    message_sv: 'Den överordnade dimensionen finns inte i registret.',
    message_en: 'parent_sie_dim_no must name another existing dimension in the registry.',
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
  // Account dimension rules (lib/dimensions/rules-service.ts, operations
  // dimension-rules.*): one set of codes for the dashboard, v1 and MCP.
  DIMENSION_RULE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Regeln finns inte.',
    message_en: 'Account dimension rule not found in this company.',
  },
  DIMENSION_RULE_EXISTS: {
    httpStatus: 409,
    message_sv: 'Kontot har redan en regel för den dimensionen.',
    message_en:
      'The account already has a rule for that dimension (one rule per account and dimension): update the existing rule instead.',
  },
  DIMENSION_VALUE_ARCHIVED: {
    httpStatus: 400,
    message_sv: 'Värdet är arkiverat: återaktivera det innan det används i en regel.',
    message_en: 'The dimension value is archived: reactivate it (PATCH the value with is_active true) before a rule uses it.',
  },
  // A retag of posted lines (lib/dimensions/retag-service.ts) where the RPC
  // refused every line. Partial success is not an error: each line is its
  // own transaction and the refused ones are listed.
  DIMENSION_RETAG_FAILED: {
    httpStatus: 400,
    message_sv: 'Ingen rad kunde taggas om.',
    message_en:
      'No line could be retagged: every line was refused. details.failed names each line and why (locked or closed period, lock date, a draft, a code missing from the registry or archived, a line of another company).',
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
  WEBSHOP_ORDER_REVENUE_ACCOUNT_RATE_MISMATCH: {
    httpStatus: 422,
    message_sv:
      'Ett valt intäktskonto är inte upplagt för momssatsen det ska ta emot, så försäljningen skulle falla ur momsdeklarationens ruta 05. Ange kontots momssats i kontoplanen (eller välj ett konto för rätt sats) och försök igen.',
    message_en:
      'A chosen revenue account is not configured for the VAT rate it would receive, so the sale would drop out of ruta 05 in the VAT declaration. Set the account VAT rate in the chart of accounts (or pick an account for the right rate) and try again.',
  },
  WEBSHOP_ORDER_ZERO_RATE_CONTEXT_MISMATCH: {
    httpStatus: 422,
    message_sv:
      'Ordern har en momsfri del men faktureringslandet stämmer inte med det valda 0 %-kontot (export- eller EU-konto). Kontrollen bygger på faktureringsadressen, inte leveransadressen: går varorna till ett annat land kan kontot ändå vara rätt. Bokför ordern enskilt och bekräfta kontot för ruta 35-42.',
    message_en:
      'The order has a 0 % part but the billing country does not match the chosen 0 % account (export or EU account). The check uses the billing address, not the delivery address: if the goods ship to another country the account may still be right. Book the order individually and confirm the account for the right box (ruta 35-42).',
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

// ─────────────────────────────────────────────────────────────────
// Reconciliation sign-off (lib/reconciliation/signoff.ts)
// ─────────────────────────────────────────────────────────────────

// Policy refusals from signOffAccount / reopenSignoff. Shipped as-is on the
// dashboard, v1 and MCP surfaces before this registry knew them, so the code
// names stay. The thrower's Swedish text is the message (thrown_message_sv):
// before that, getErrorMessage() fell through to its generic fallback and the
// user read "Något gick fel. Försök igen." for a refused sign-off.
// ─────────────────────────────────────────────────────────────────
// POS sales (kassasystem, daily takings): lib/pos-sales
// ─────────────────────────────────────────────────────────────────

const POS_SALES: Record<string, StructuredErrorEntry> = {
  POS_READ_FAILED: {
    httpStatus: 500,
    message_sv: 'Kassadata kunde inte läsas. Försök igen.',
    message_en: 'The point-of-sale data could not be read. Try again.',
    retryable: true,
  },
  POS_CONNECTION_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kopplingen till kassasystemet hittades inte.',
    message_en: 'The point-of-sale connection was not found.',
  },
  POS_ALREADY_CONNECTED: {
    httpStatus: 409,
    message_sv: 'Kassan är redan kopplad till företaget.',
    message_en: 'This point-of-sale venue is already connected to the company.',
  },
  POS_SANDBOX_BLOCKED: {
    httpStatus: 403,
    message_sv: 'Kassasystem kan inte kopplas i sandlådan.',
    message_en: 'Point-of-sale systems cannot be connected in the sandbox.',
  },
  POS_ORG_NUMBER_MISSING: {
    httpStatus: 400,
    message_sv: 'Företaget saknar organisationsnummer. Lägg in det under Inställningar innan du kopplar kassasystemet.',
    message_en: 'The company has no organisation number. Add it in Settings before connecting the point-of-sale system.',
  },
  POS_SYNC_FROM_INVALID: {
    httpStatus: 400,
    message_sv: 'Första dagen att hämta måste ligga före dagens datum.',
    message_en: 'The first day to fetch must be before today.',
  },
  POS_CONNECT_UNCONFIGURED: {
    httpStatus: 503,
    message_sv: 'Kassakopplingar är inte tillgängliga på den här installationen (Accounted Connect saknas).',
    message_en: 'Point-of-sale connections are not available on this installation (Accounted Connect is not configured).',
  },
  POS_CONNECT_FAILED: {
    httpStatus: 502,
    message_sv: 'Kassasystemet kunde inte nås via Accounted Connect. Försök igen om en stund.',
    message_en: 'The point-of-sale system could not be reached through Accounted Connect. Try again shortly.',
    retryable: true,
  },
  POS_DISCONNECT_FAILED: {
    httpStatus: 500,
    message_sv: 'Kopplingen kunde inte avslutas. Försök igen.',
    message_en: 'The connection could not be ended. Try again.',
    retryable: true,
  },
  POS_SETTINGS_ACCOUNT_UNKNOWN: {
    httpStatus: 400,
    message_sv: 'Ett eller flera konton finns varken i kontoplanen eller i BAS. Välj ett konto som finns.',
    message_en: 'One or more accounts are neither in the chart of accounts nor in BAS. Choose an existing account.',
  },
  POS_SETTINGS_FAILED: {
    httpStatus: 500,
    message_sv: 'Kontoinställningarna kunde inte sparas. Försök igen.',
    message_en: 'The account settings could not be saved. Try again.',
    retryable: true,
  },
  POS_DAY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kassadagen hittades inte.',
    message_en: 'The point-of-sale day was not found.',
  },
  POS_DAY_ALREADY_BOOKED: {
    httpStatus: 409,
    message_sv: 'Dagen är redan bokförd. Rätta verifikatet med storno om något behöver ändras.',
    message_en: 'This day is already booked. Correct the journal entry with a reversal if something must change.',
  },
  POS_DAY_CHANGED: {
    httpStatus: 409,
    message_sv: 'Kassasystemet har skickat en ny version av dagen sedan du granskade den. Öppna dagen igen och kontrollera innan du bokför.',
    message_en: 'The point-of-sale system sent a new version of the day since you reviewed it. Open the day again and check it before booking.',
  },
  POS_DAY_EMPTY: {
    httpStatus: 400,
    message_sv: 'Ingen försäljning den dagen: inget att bokföra.',
    message_en: 'No sales that day: nothing to book.',
  },
  POS_DAY_NEEDS_REVIEW: {
    httpStatus: 409,
    message_sv: 'Dagen behöver granskas innan den kan bokföras. Se vad som saknas på dagen.',
    message_en: 'The day needs a review before it can be booked. See what is missing on the day.',
  },
  POS_DAY_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv: 'Det finns inget öppet räkenskapsår för dagen.',
    message_en: 'There is no open fiscal year for the day.',
  },
  POS_DAY_BOOKING_FAILED: {
    httpStatus: 500,
    message_sv: 'Dagen kunde inte bokföras. Inget verifikat skapades.',
    message_en: 'The day could not be booked. No journal entry was created.',
  },
}

const RECONCILIATION_SIGNOFF: Record<string, StructuredErrorEntry> = {
  INVALID_DATE: {
    httpStatus: 400,
    message_sv: 'Ogiltigt datum. Ange ÅÅÅÅ-MM-DD.',
    message_en: 'Invalid date. Use YYYY-MM-DD.',
    thrown_message_sv: true,
  },
  DATE_IN_FUTURE: {
    httpStatus: 400,
    message_sv: 'Du kan inte stämma av framåt i tiden.',
    message_en: 'The through date cannot be in the future.',
    thrown_message_sv: true,
  },
  NOT_FETCHED_THROUGH: {
    httpStatus: 400,
    message_sv: 'Skattekontot är inte hämtat t.o.m. det datumet. Hämta igen innan du stämmer av ett senare datum.',
    message_en: 'The skattekonto has not been fetched through that date. Fetch it again before signing off a later date.',
    thrown_message_sv: true,
  },
  OUTSIDE_UNKNOWN: {
    httpStatus: 400,
    message_sv: 'Saldot utanför bokföringen är okänt, så kontot kan inte stämmas av. Hämta det först, eller signera med en notering.',
    message_en: 'The outside balance is unknown, so the account cannot be reconciled. Fetch it first, or sign with force and a note.',
    thrown_message_sv: true,
  },
  NOT_RECONCILED: {
    httpStatus: 400,
    message_sv: 'Kontot har en oförklarad differens. Koppla eller bokför raderna först, eller signera med en notering.',
    message_en: 'The account has an unexplained difference. Link or book the rows first, or sign with force and a note.',
    thrown_message_sv: true,
  },
  NOTE_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Skriv en rad om varför du signerar trots att allt inte är förklarat.',
    message_en: 'A note is required when signing with force.',
    thrown_message_sv: true,
  },
  ALREADY_SIGNED_OFF: {
    httpStatus: 409,
    message_sv: 'Kontot är redan avstämt t.o.m. ett senare datum. Öppna den signeringen igen om du vill ändra.',
    message_en: 'The account is already signed off through that date or later. Reopen that sign-off to change it.',
    thrown_message_sv: true,
  },
  SIGNOFF_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Signeringen hittades inte.',
    message_en: 'The sign-off was not found.',
    thrown_message_sv: true,
  },
  ALREADY_REOPENED: {
    httpStatus: 409,
    message_sv: 'Signeringen är redan öppnad igen.',
    message_en: 'The sign-off is already reopened.',
    thrown_message_sv: true,
  },
  SIGNOFF_RACE: {
    httpStatus: 409,
    message_sv: 'Kontot signerades precis av någon annan. Ladda om.',
    message_en: 'Someone else just changed this sign-off. Reload and try again.',
    thrown_message_sv: true,
  },
  EXTERNAL_BALANCE_NOT_ALLOWED: {
    httpStatus: 400,
    message_sv: 'Kontot har redan en sanning utanför bokföringen (bank, Skatteverket, reskontra eller beräkning). Ange inget saldo manuellt; signera med en notering om något avviker.',
    message_en: 'The account already has an outside truth (bank, Skatteverket, ledger or calculation). Do not state a balance; sign with a note if something differs.',
    thrown_message_sv: true,
  },
}

// Company settings (lib/company/settings-service.ts): the cross-field rules
// every settings door applies. message_sv is the exact sentence the
// dashboard's PUT /api/settings has always answered.
const COMPANY_SETTINGS: Record<string, StructuredErrorEntry> = {
  SETTINGS_REMINDER_DAYS_ORDER: {
    httpStatus: 400,
    message_sv: 'Påminnelsedagarna måste ligga i stigande ordning.',
    message_en: 'reminder_days_level_1 < reminder_days_level_2 < reminder_days_level_3 must hold (stored values fill in the ones not sent).',
  },
  SETTINGS_EF_CALENDAR_YEAR: {
    httpStatus: 400,
    message_sv: 'Enskild firma måste använda kalenderår (BFL 3 kap.)',
    message_en: 'An enskild firma must use the calendar year: fiscal_year_start_month must be 1 (BFL 3 kap.).',
  },
  SETTINGS_SHARE_CAPITAL_PAIR: {
    httpStatus: 400,
    message_sv: 'Aktiekapital och antal aktier måste anges tillsammans. Fyll i båda fälten eller lämna båda tomma.',
    message_en: 'aktiekapital and antal_aktier are set (or cleared) together.',
  },
  SETTINGS_VACATION_BASIS_OPEN_BALANCES: {
    httpStatus: 400,
    message_sv: 'Semesterårets basis kan inte ändras medan öppna semestersaldon finns. Stäng semesteråret först.',
    message_en: 'salary_vacation_year_basis cannot change while open vacation balances exist: close the vacation year first.',
    remediation: { description: 'Close the vacation year first.', tool: 'gnubok_close_vacation_year' },
  },
  SETTINGS_VAT_NUMBER_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Momsregistreringsnummer krävs när företaget är momsregistrerat (ML 17 kap. 24 §)',
    message_en: 'A VAT-registered company needs vat_number (SE + 12 digits; ML 17 kap. 24 §).',
  },
  SETTINGS_MOMS_PERIOD_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Momsperiod krävs när företaget är momsregistrerat (SFL 26 kap.)',
    message_en: 'A VAT-registered company needs moms_period (SFL 26 kap.).',
  },
  SETTINGS_VAT_40M_REQUIRES_MONTHLY: {
    httpStatus: 400,
    message_sv: 'Företag med beskattningsunderlag över 40 miljoner kronor måste redovisa moms varje månad.',
    message_en: 'With vat_taxable_base_over_40m the moms_period must be monthly.',
  },
  SETTINGS_PS_REQUIRES_VAT_AND_EU_TRADE: {
    httpStatus: 400,
    message_sv: 'Periodisk sammanställning kräver momsregistrering och EU-handel.',
    message_en: 'periodisk_sammanstallning_enabled requires vat_registered and vat_has_eu_trade.',
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
// Database refusals raised by name with SQLSTATE PT409
// ─────────────────────────────────────────────────────────────────

// The bank-booking guards raise `RAISE EXCEPTION '<NAME>' USING ERRCODE =
// 'PT409'`. The name is the only part that says what went wrong, so a
// registered name becomes the response code (see conflictCode) instead of
// the catch-all CONFLICT, whose "reload the page" advice fits only some.
const DB_CONFLICTS = {
  BANK_BOOKING_SETTLEMENT_CHANGED: {
    httpStatus: 409,
    message_sv:
      'Verifikationen bokför inte transaktionens belopp på bankkontot åt rätt håll. Ett uttag ska stå i kredit på bankkontot och en insättning i debet. Har bankkontots inställningar nyss ändrats, ladda om sidan och försök igen.',
    message_en:
      'The voucher does not book the transaction amount on the bank ledger in the bank direction: a withdrawal must credit the bank ledger, a deposit must debit it. If the bank account settings just changed, reload and try again.',
  },
  BANK_BOOKING_SOURCE_CHANGED: {
    httpStatus: 409,
    message_sv: 'Transaktionen har ändrats sedan du öppnade den. Ladda om sidan och bokför igen.',
    message_en: 'The transaction changed after the booking was prepared. Reload it and book again.',
  },
  BANK_ANCHOR_SETTLEMENT_CHANGED: {
    httpStatus: 409,
    message_sv:
      'Verifikationen bokför inte transaktionens belopp på bankkontot åt rätt håll, så transaktionen kan inte kopplas till den. Ett uttag ska stå i kredit på bankkontot och en insättning i debet.',
    message_en:
      'The voucher does not book the transaction amount on the bank ledger in the bank direction, so the transaction cannot be linked to it: a withdrawal must credit the bank ledger, a deposit must debit it.',
  },
  BANK_ANCHOR_CASH_ACCOUNT_CHANGED: {
    httpStatus: 409,
    message_sv: 'Transaktionens bankkonto har ändrats eller tagits bort. Ladda om sidan och försök igen.',
    message_en: 'The bank account of the transaction was changed or removed. Reload and try again.',
  },
  CASH_ACCOUNT_OPERATION_BUSY: {
    httpStatus: 409,
    message_sv: 'En annan ändring av bankkontona pågår just nu. Vänta en stund och försök igen.',
    message_en: 'Another change to the bank accounts is in progress. Wait a moment and retry.',
    retryable: true,
  },
  // resolve_bank_ingest_route: an enabled account of the connection has no
  // bound cash account, or its stored ledger differs from the bound one.
  // Retrying never helps; saving the account picker rewrites both sides. The
  // sync paths also store message_sv as the connection's error_message.
  BANK_INGEST_ROUTE_UNRESOLVED: {
    httpStatus: 409,
    message_sv: 'Banksynkningen har stannat: kontovalet för bankkopplingen behöver sparas om. Öppna Välj konton och spara igen.',
    message_en: 'Bank sync has stopped: the account selection for this bank connection needs to be saved again. Open Choose accounts and save again.',
  },
} satisfies Record<string, StructuredErrorEntry>

/**
 * The response code for a PT409 database refusal: its own code when the
 * raised name is registered above, else the generic CONFLICT.
 */
export function conflictCode(dbMessage: unknown): keyof typeof DB_CONFLICTS | 'CONFLICT' {
  return typeof dbMessage === 'string' && Object.hasOwn(DB_CONFLICTS, dbMessage)
    ? (dbMessage as keyof typeof DB_CONFLICTS)
    : 'CONFLICT'
}

// ─────────────────────────────────────────────────────────────────
// Combined registry
// ─────────────────────────────────────────────────────────────────

const REGISTRY: Record<string, StructuredErrorEntry> = {
  ...GENERIC,
  ...DB_CONFLICTS,
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
  ...FX,
  ...REPORT,
  ...VAT_REPORT,
  ...VAT_FILING,
  ...PS_REPORT,
  ...SIE_EXPORT,
  ...TAX_DECL,
  ...SIE_IMPORT,
  ...BANK_FILE,
  ...BANK_SELECTION,
  ...BANK_SYNC,
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
  ...COMPANY_SETTINGS,
  ...WEBSHOP_ORDERS,
  ...POS_SALES,
  ...RECONCILIATION_SIGNOFF,
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
