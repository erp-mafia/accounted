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
  // An opt-in extension this request needs is not enabled on the deployment
  // (extensions.config.json, or its env flag). Raised for several features
  // (bank sync, the Inkorg, Skatteverket), so the copy names none: details
  // carry which one where the raiser knows it. A raiser's own Swedish message
  // (the Skatteverket extension's results) still passes through verbatim.
  EXTENSION_DISABLED: {
    httpStatus: 503,
    message_sv: 'Funktionen är inte aktiverad i den här installationen.',
    message_en: 'This feature is not enabled on this installation.',
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
    message_sv: 'Ett oväntat fel uppstod. Försök igen om en stund, och kontakta support om det fortsätter.',
    message_en: 'Internal server error.',
  },
  VALIDATION_ERROR: {
    httpStatus: 400,
    message_sv: 'Några uppgifter stämmer inte. Kontrollera fälten och försök igen.',
    message_en: 'Validation error.',
  },
  // A typed handle (lib/handles: je_..., inv_...) sent in a field or path
  // parameter that takes another kind of record. Refused at the door, before
  // any lookup, so a mixed-up id never reaches a query as the wrong row.
  HANDLE_TYPE_MISMATCH: {
    httpStatus: 400,
    message_sv: 'Id:t hör till fel sorts post för det här fältet. Skicka id:t för rätt post, eller dess vanliga UUID.',
    message_en:
      'A typed handle names a different kind of record than the field or path parameter takes (e.g. an inv_ invoice handle where a je_ journal entry id belongs).',
    remediation: {
      description:
        'details.issues names each field, the prefix it takes (expected_prefix, null for a plain UUID only) and the prefix sent. Send the id of the record the field names: its handle with that prefix, or the plain UUID.',
    },
  },
  UNAUTHORIZED: {
    httpStatus: 401,
    message_sv: 'Din session har gått ut. Logga in igen.',
    message_en: 'Authentication required.',
  },
  FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Du har inte behörighet att göra det här i företaget. Be en ägare eller administratör om behörighet.',
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
    message_sv: 'Det gick inte att hitta. Det kan ha tagits bort: ladda om sidan.',
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
  IDEMPOTENCY_KEY_IN_PROGRESS: {
    httpStatus: 409,
    message_sv: 'En begäran med samma idempotensnyckel pågår fortfarande. Försök igen om en liten stund.',
    message_en: 'A request with the same idempotency key and body is still in progress.',
    retryable: true,
    remediation: {
      description:
        'The first request with this key is still running. Retry the identical request with the same key after Retry-After seconds: once the first one has finished, the retry returns its response without writing again. Do not switch to a fresh key, which would run the write a second time.',
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
        'Do not retry, and do not split the entry into smaller ones: one affärshändelse is one verifikat (BFL 5 kap. 6 §). Nothing was posted. Ask a human to approve the staged operation in Accounted (on the v1 API, resend a write with ?stage=true where the endpoint stages, or let a person do it in the app), or have the key owner raise the limit in API key settings. details.attempted and details.limit carry the numbers.',
    },
  },
  // Hard blocks (accounted#130 step 2): a booking a booking review rule
  // matches is booked only by a person, from its review, in the app.
  BOOKING_REVIEW_REQUIRED: {
    httpStatus: 409,
    message_sv:
      'Företaget har en spärr som säger att den här bokföringen alltid ska granskas av en person. Den bokförs från granskningen i Accounted, inte med ett klick, i massbokning, av en regel för automatisk bokföring eller av en agent.',
    message_en:
      'The company has a block saying a person always reviews this booking. It is booked from its review in Accounted, never with one click, in bulk, by a rule for automatic booking or by an agent.',
    retryable: false,
    remediation: {
      description:
        'Nothing was posted. Do not retry and do not change the booking to get around the block. Stage it instead (on the v1 API resend with ?stage=true where the endpoint stages; over MCP the categorize tool and gnubok_create_supplier_invoice_from_inbox stage already) and tell the user it waits for their review in Accounted, under Att godkänna, or, for a supplier invoice or a document, in the Inkorg, where a person registers it. Blocks hold bank rows, supplier invoices (registered, or paid under kontantmetoden) and Inkorg documents; they are listed under Bokföringsregler, Spärrar.',
    },
  },
  // A periodisering's own verifikat (source_type 'accrual') is posted only by
  // the periodisering, with the month it books (lib/bookkeeping/accruals).
  ACCRUAL_DRAFT_POSTED_BY_SCHEDULE: {
    httpStatus: 409,
    message_sv:
      'Periodiseringens verifikat bokförs av periodiseringen själv, tillsammans med månaden det gäller, och kan inte bokföras härifrån. Förfallna månader bokförs varje natt eller med Bokför förfallna under Periodiseringar, och ett utkast som blivit kvar makuleras automatiskt.',
    message_en:
      'A periodisering (accrual) voucher is posted by its schedule, together with the month it books, and cannot be committed here. Due months are posted every night or with Post due accruals on the accruals page, and a leftover draft is cancelled automatically.',
    retryable: false,
    remediation: {
      description:
        'Do not commit, edit or copy this draft: nothing was posted. It was left by an accrual run that did not finish. The nightly accrual run posts the month together with its schedule row and cancels the draft; a person can post due months now with Bokför förfallna under Periodiseringar in Accounted.',
    },
  },
  // guard_bank_booking_context refuses (23514) to post a verifikat with
  // source_type 'bank_transaction' whose bank_booking_context does not name
  // its source row: a draft left from before the context existed, or made
  // without it. BookkeepingDatabaseError answers the raised name with this
  // code. As BOOKKEEPING_DATABASE_ERROR it read "Verifikationen kunde inte
  // sparas. Försök igen.", and no retry posts it (2026-11-16, two tries).
  BANK_BOOKING_CONTEXT_REQUIRED: {
    httpStatus: 409,
    message_sv:
      'Utkastet kommer från en banktransaktion men saknar kopplingen till den, så det kan inte bokföras härifrån. Öppna transaktionen under Transaktioner och bokför den där. Är den redan bokförd behövs inte utkastet.',
    message_en:
      'This draft comes from a bank transaction but lacks the link to it, so it cannot be posted from here. Open the transaction under Transaktioner and book it there. If it is already booked, the draft is not needed.',
    retryable: false,
    remediation: {
      description:
        "Nothing was posted. The draft's source_type is bank_transaction, but its bank_booking_context does not name its source_id. Book the bank transaction (source_id) with gnubok_categorize_transaction instead, or create the draft again with a bank_booking_context entry for that transaction.",
      tool: 'gnubok_categorize_transaction',
    },
  },
  BOOKING_REVIEW_WEB_ONLY: {
    httpStatus: 403,
    message_sv:
      'Företaget har en spärr som matchar den här bokföringen, så den godkänns av en person i Accounted, inte via API, MCP, en regel för automatisk bokföring eller i massgodkännande.',
    message_en:
      'A company block matches this booking, so a person approves it in Accounted, never through the API, MCP, a rule for automatic booking or a bulk approval.',
    retryable: false,
    remediation: {
      description:
        'The operation stays pending. Do not retry the approval with a key. Tell the user it waits for their review in Accounted, under Att godkänna.',
    },
  },
  BOOKING_REVIEW_LIMIT: {
    httpStatus: 403,
    message_sv:
      'Bokföringen matchar en spärr, och din attestgräns för granskning täcker inte beloppet. En person med högre gräns bokför den.',
    message_en:
      'The booking matches a block, and your attest limit for booking reviews does not cover the amount. Someone with a higher limit books it.',
    retryable: false,
    remediation: {
      description:
        'Nothing was posted. details.amount_sek is the amount judged (the bank rows, else the supplier invoice total in SEK) and details.limit_sek the reviewer limit (null: the reviewer has none while the company has set limits). Ask an owner or admin, or a person whose booking_review limit covers it, to book it.',
    },
  },
  BOOKING_REVIEW_BULK_REFUSED: {
    httpStatus: 409,
    message_sv:
      'En eller flera av raderna matchar en spärr och kan inte massbokföras. Bokför dem en och en från granskningen.',
    message_en: 'One or more of the rows match a block and cannot be booked in bulk. Book them one at a time from their review.',
    retryable: false,
    remediation: {
      description:
        'details.transaction_ids names the rows a booking review rule matches. Leave them out of the bulk booking; a person books each from its review in the app.',
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
  CANNOT_REVERSE_COLLECTED_PAYMENT: {
    httpStatus: 409,
    message_sv: 'Betalningen kom via inkassobolaget och kan inte stornas här. Bokför om den under Avräkningar.',
    message_en: 'The payment came through the collection agency and cannot be reversed here. Rebook it under Settlements.',
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
  DRAFT_HAS_DOCUMENTS: {
    httpStatus: 409,
    message_sv:
      'Utkastet har bilagor som inte kan flyttas när utkastet har makulerats. Bokför utkastet, eller kontakta supporten.',
    message_en:
      'The draft holds documents that can never be moved to another verifikat once the draft is cancelled. Book the draft, or contact support.',
    remediation: {
      description:
        'Do not cancel this draft. details.documents lists its underlag. Ask the user to book the draft (commit it), or to contact support to move the documents first.',
    },
  },
  JOURNAL_ENTRY_ALREADY_CANCELLED: {
    httpStatus: 409,
    message_sv: 'Utkastet är redan makulerat. Det finns inget kvar att göra.',
    message_en: 'The draft is already cancelled. There is nothing left to do.',
    remediation: {
      description:
        'Nothing to stage or approve: the draft no longer blocks the year-end close. Re-run gnubok_year_end_readiness to see what remains.',
    },
  },
  ENTRY_ALREADY_REVERSED: {
    httpStatus: 409,
    message_sv:
      'Verifikationen har redan stornats av en annan användare. Ladda om sidan och försök igen.',
    message_en: 'Entry was already reversed by a concurrent operation.',
  },
  MIGRATED_DEDUCTION_HELD_BY_REQUEST: {
    httpStatus: 409,
    message_sv:
      'Fakturan ingår i en begäran om utbetalning till Skatteverket. Avbryt begäran innan du stornerar omföringen av skattereduktionen.',
    message_en:
      'The invoice is part of a payout request to Skatteverket. Cancel the request before reversing the deduction reclassification.',
  },
  REVERSAL_HOOK_MISSING: {
    httpStatus: 500,
    message_sv:
      'Verifikationen kan inte stornas: den hör till ett register som måste följa med i stornot, och den kopplingen saknas i den här installationen. Inget har bokförts. Kontakta supporten.',
    message_en:
      'The entry cannot be reversed: its source type needs a reversal hook to keep its sub-ledger in step, and none is registered in this installation. Nothing was written. Contact support.',
    retryable: false,
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
  // Kontantmetod year-end carry (årsomföring, #3440): a storno or rättelse
  // of a carry verifikat. The engine refuses by name before any write
  // (lib/bookkeeping/kontantmetod-carry-guard.ts); the database refuses the
  // same in kontantmetod_carry_on_reversal (20261018131100).
  CUTOFF_CARRY_REVERSAL_DATE: {
    httpStatus: 409,
    message_sv:
      'Verifikatet är kontantmetodens årsomföring av en obetald faktura och kan bara makuleras på sitt eget datum (räkenskapsårets sista dag), så att momsen lämnar samma momsperiod som den redovisades i.',
    message_en:
      'This verifikat carries an unpaid invoice over the kontantmetod year end and can only be reversed on its own date (the last day of the fiscal year), so its moms leaves the VAT period it was declared in.',
    remediation: {
      description:
        'Reverse the carry with reversal_date equal to its entry_date, then run the kontantmetod cut-off again.',
    },
  },
  KONTANTMETOD_CARRY_HAS_SETTLEMENTS: {
    httpStatus: 409,
    message_sv:
      'Fakturan som årsomföringen avser har betalningar efter bokslutsdagen eller en bokförd kreditfaktura. Makulera dem först: annars blir kundfordran eller leverantörsskulden kvar utan motpost.',
    message_en:
      'The invoice this year-end carry books has payments after the year end or a booked credit note. Undo those first, or the receivable or payable they cleared is left without its counterpart.',
    remediation: {
      description:
        'Reverse the payment and credit note verifikat of the invoice first, then reverse the carry on its own date.',
    },
  },
  CUTOFF_CARRY_CORRECTION_REFUSED: {
    httpStatus: 409,
    message_sv:
      'Kontantmetodens årsomföring av en faktura rättas inte med rättelseverifikat. Makulera den på sitt eget datum och kör bokslutsavgränsningen igen, så byggs den om från fakturan.',
    message_en:
      'A kontantmetod year-end carry is not corrected with a rättelse. Reverse it on its own date and run the cut-off again, which rebuilds it from the invoice.',
    remediation: {
      description:
        'Fix the invoice if it is wrong, reverse the carry with reversal_date equal to its entry_date, then stage the kontantmetod cut-off again.',
    },
  },
  KONTANTMETOD_CARRY_CANCEL_REFUSED: {
    httpStatus: 409,
    message_sv:
      'Kontantmetodens årsomföring av en faktura kan inte annulleras. Makulera den på sitt eget datum i stället.',
    message_en:
      'A kontantmetod year-end carry cannot be cancelled. Reverse it on its own date instead.',
  },
  // The integrity of a carry's link (20261018131120): a posted carry is never
  // deleted, its invoice link is never moved by hand, an invoice has at most
  // one posted carry, and a carry is restored only together with its link.
  KONTANTMETOD_CARRY_DELETE_REFUSED: {
    httpStatus: 409,
    message_sv:
      'Verifikatet är kontantmetodens årsomföring av en faktura och kan inte raderas: fakturan är kopplad till det och momsen kan redan vara redovisad. Makulera årsomföringen på sitt eget datum i stället.',
    message_en:
      'This verifikat is a kontantmetod year-end carry and cannot be deleted: the invoice is linked to it and its moms may already be declared. Reverse the carry on its own date instead.',
    remediation: {
      description:
        'Reverse the carry with reversal_date equal to its entry_date (refused while the invoice has later payments or a booked credit note), then run the cut-off again if the invoice is still open.',
    },
  },
  KONTANTMETOD_CARRY_LINK_LOCKED: {
    httpStatus: 409,
    message_sv:
      'Fakturan är kopplad till sin årsomföring vid kontantmetodens bokslut. Kopplingen styr hur betalningen bokförs och kan bara släppas genom att årsomföringen makuleras på sitt eget datum.',
    message_en:
      'The invoice is linked to its kontantmetod year-end carry. The link decides how the payment is booked and is released only by reversing the carry on its own date.',
    remediation: {
      description:
        'Do not change invoices.journal_entry_id / supplier_invoices.registration_journal_entry_id of a carried invoice. Reverse the carry with reversal_date equal to its entry_date instead.',
    },
  },
  KONTANTMETOD_CARRY_ALREADY_LIVE: {
    httpStatus: 409,
    message_sv:
      'Fakturan har redan en bokförd årsomföring. En faktura årsomförs bara en gång, annars redovisas momsen två gånger.',
    message_en:
      'The invoice already has a posted year-end carry. An invoice is carried once; a second carry would declare its moms twice.',
  },
  KONTANTMETOD_CARRY_RESTORE_REFUSED: {
    httpStatus: 409,
    message_sv:
      'Makuleringen av årsomföringen kan inte tas bort: fakturan har efter makuleringen fått betalningar, en kreditfaktura eller en ny årsomföring, och årsomföringen skulle då redovisa momsen en gång till.',
    message_en:
      'The storno of this year-end carry cannot be removed: since it, the invoice has received payments, a credit note or a new carry, and restoring the carry would declare its moms again.',
    remediation: {
      description:
        'Leave the storno in place. If the invoice is still open, run the kontantmetod cut-off again; it carries the invoice afresh.',
    },
  },
  // The database backstops of a carry (20261018131100): a payment row dated on
  // or before the carry, and a kontantmetod cash verifikat for a carried
  // invoice. Both raise with the code as the exception message (23514), which
  // getErrorMessage maps through this registry.
  KONTANTMETOD_CARRIED_PAYMENT_BEFORE_CUTOFF: {
    httpStatus: 409,
    message_sv:
      'Fakturan är årsomförd som obetald vid bokslutet, så en betalning daterad på eller före bokslutsdagen kan inte registreras. Makulera årsomföringen på sitt eget datum först och bokför sedan betalningen.',
    message_en:
      'The invoice was carried as unpaid over the kontantmetod year end, so a payment dated on or before that date cannot be registered. Reverse the carry on its own date first, then book the payment.',
    remediation: {
      description:
        'Check the payment date. If the invoice really was paid before the year end, reverse its carry verifikat with reversal_date equal to the carry entry_date, then book the payment and run the cut-off again.',
    },
  },
  KONTANTMETOD_CARRIED_INVOICE_CASH_ENTRY: {
    httpStatus: 409,
    message_sv:
      'Fakturan är årsomförd vid bokslutet och ligger på kund- eller leverantörsreskontran. Betalningen bokförs mot 1510 eller 2440 utan moms, inte som en kontantbetalning med intäkt eller kostnad.',
    message_en:
      'The invoice was carried over the kontantmetod year end and sits on 1510 / 2440. Its payment is a clearing against 1510 / 2440 with no moms, never a cash payment that books revenue or cost again.',
    remediation: {
      description:
        'Register the payment through the invoice payment or bank match flow, which clears 1510 / 2440 for a carried invoice.',
    },
  },
  // Pre-flight of the cut-off (lib/vat/kontantmetod-cutoff-preflight.ts), at
  // staging and again at approval, before any write.
  KONTANTMETOD_CUTOFF_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv:
      'Kontantmetodens bokslutsavgränsning behöver bokföra på ett datum som är låst. Flytta tillbaka låsdatumet för bokföringen eller lås upp perioden och försök igen.',
    message_en:
      'The kontantmetoden cut-off has to book on a date that is locked (the period end, or the date of a payment verifikat it corrects).',
    remediation: {
      description:
        'Move the company lock date back (company settings; the settings ask you to acknowledge any filed VAT period it reopens) or unlock the fiscal period, then stage the cut-off again. Only with the user: it is an accountant decision.',
    },
  },
  KONTANTMETOD_CUTOFF_VAT_PERIOD_FILED: {
    httpStatus: 409,
    message_sv:
      'Kontantmetodens bokslutsavgränsning ändrar momsen i en momsperiod som redan är deklarerad. Bekräfta perioden för att bokföra ändå och lämna sedan en rättad momsdeklaration för perioden.',
    message_en:
      'The kontantmetoden cut-off changes the moms of a VAT period already filed. The moms belongs to that period, so it is not moved; a corrected momsdeklaration is needed.',
    remediation: {
      description:
        'Tell the user which tax periods are affected and that a corrected momsdeklaration must be filed for each (voluntarily and before Skatteverket finds it, without skattetillägg). With their agreement, stage again with acknowledge_filed_vat_periods listing those tax_period labels; the result lists amended_vat_periods_required. If the momsredovisning verifikat of such a period is already booked, the added moms also needs a supplementary momsredovisning dated in that period that moves it to 2650.',
      tool: 'gnubok_post_kontantmetod_cutoff',
    },
  },
  // What the cut-off cannot do by rule: a person decides (#3440).
  KONTANTMETOD_CUTOFF_ROT_PARTIAL_MANUAL: {
    httpStatus: 409,
    message_sv:
      'En ROT-, RUT- eller grön teknik-faktura var delvis betald eller fick avdraget återkrävt före bokslutet och kan inte årsomföras automatiskt: momsen och Skatteverkets andel för den betalda delen är redan bokförda. Redovisningsbyrån skriver årsomföringen av den obetalda delen, och bokslutsavgränsningen bokför och kopplar den till fakturan per bokslutsdagen.',
    message_en:
      'A ROT/RUT or green-technology invoice was partly paid (or its deduction reclaimed) before the year end and cannot be carried by rule: the moms and the Skatteverket share of the paid part were booked at payment. The accountant writes the carry of the open part, and the cut-off posts it on the period end and links it to the invoice.',
    remediation: {
      description:
        'Have the accountant write the carry of the open part: exactly the open customer share on 151x, exactly Skatteverket\'s share of the open part on 1513, and the revenue (3xxx) and output moms (261x to 263x) behind both. Stage gnubok_post_kontantmetod_cutoff again with manual_carries [{ invoice_id, lines }]; it posts the carry on the period end and links it to the invoice, then re-run year-end readiness. Never book it as a separate manual voucher: an unlinked voucher leaves the invoice open and its payment books the moms again.',
      tool: 'gnubok_post_kontantmetod_cutoff',
    },
  },
  KONTANTMETOD_MANUAL_CARRY_INVALID: {
    httpStatus: 409,
    message_sv:
      'Den manuella årsomföringen kan inte bokföras: raderna måste balansera, sätta exakt den obetalda kunddelen på 151x och exakt Skatteverkets andel av den obetalda delen på 1513, motbokas med intäkt (3xxx) och, när den obetalda delen har moms, utgående moms (261x till 263x), och inga pengar på 19xx, och fakturan måste vänta på en manuell årsomföring.',
    message_en:
      'The manual carry cannot be posted: its lines must balance, put exactly the open customer share on 151x and exactly Skatteverket\'s share of the open part on 1513, book the revenue (3xxx) and, when the open part carries moms, the output moms (261x to 263x) against them, and nothing on 19xx; the invoice must be one listed as KONTANTMETOD_CUTOFF_ROT_PARTIAL_MANUAL.',
    remediation: {
      description:
        'Fix the lines named in the message and stage gnubok_post_kontantmetod_cutoff again with the corrected manual_carries.',
      tool: 'gnubok_post_kontantmetod_cutoff',
    },
  },
  KONTANTMETOD_MANUAL_CARRY_DEDUCTION_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Den manuella årsomföringen kan inte bokföras: 1513 ska vara exakt Skatteverkets andel av fakturans obetalda del, varken mer eller mindre. Bokförs mindre nollställer Skatteverkets utbetalning 1513 utan moms, så momsen på mellanskillnaden redovisas aldrig och 1513 blir negativt. Andelen för den betalda delen bokfördes redan vid betalningen.',
    message_en:
      'The manual carry cannot be posted: 1513 must equal Skatteverket\'s share of the invoice\'s open part exactly, neither more nor less. With less, Skatteverket\'s payout clears 1513 with no moms, so the moms on the difference is never declared and 1513 goes negative. The share of the part paid before the year end was booked at that payment.',
    remediation: {
      description:
        'Put exactly the amount named in the message on 1513 (debit; credit for a credit note), with the matching revenue and moms against it, and stage gnubok_post_kontantmetod_cutoff again with the corrected manual_carries.',
      tool: 'gnubok_post_kontantmetod_cutoff',
    },
  },
  KONTANTMETOD_CUTOFF_PAID_BEFORE_POSTING_MANUAL: {
    httpStatus: 409,
    message_sv:
      'En faktura som var obetald vid bokslutet har betalats efter det med en verifikation som inte kan rättas automatiskt (ett samlingsverifikat, ett manuellt eller importerat verifikat, eller en betalning utan verifikat). Rätta verifikationen manuellt så att betalningen bokförs mot kund- eller leverantörsreskontran utan intäkt, kostnad eller moms.',
    message_en:
      'An invoice unpaid at the year end was paid after it through a verifikat that cannot be corrected by rule (shared by several invoices, manual or imported, or a payment without a verifikat). Correct it by hand so the payment clears 1510 / 2440 with no revenue, cost or moms, after the carry is posted.',
    remediation: {
      description:
        'After the cut-off has carried the invoice, correct the payment verifikat with gnubok_correct_entry: keep the bank leg and replace the revenue or cost and moms lines with one line clearing 1510 (customer) or 2440 (supplier). A payment with no verifikat (reason no_verifikat): undo that payment registration and register the payment again through the invoice payment or bank match flow, which books the clearing. Each corrected verifikat dated in a VAT period already filed needs a corrected momsdeklaration (amended_vat_periods_required). Then re-run year-end readiness.',
      tool: 'gnubok_correct_entry',
    },
  },
  // A supplier invoice that is only a header (a provider migration's, crm#1712):
  // its carry has no cost account or moms to book (CutoffCollection.rowlessSupplierInvoices).
  KONTANTMETOD_CUTOFF_ROWLESS_SUPPLIER_INVOICE: {
    httpStatus: 409,
    message_sv:
      'En leverantörsfaktura som var obetald vid bokslutet saknar fakturarader, så årsomföringen kan inte avgöra kostnadskonto och moms. Lägg till raderna på fakturan, eller koppla den till den befintliga verifikation som redan bokförde den, och kör avgränsningen igen.',
    message_en:
      'A supplier invoice unpaid at the year end has no rows, only a header (as a provider migration imports one), so its carry has no cost account or moms to book. Nothing is guessed.',
    remediation: {
      description:
        'For each invoice named: if a verifikat already books it (its registration, or the payment that settled it), link it with gnubok_link_supplier_invoice_to_voucher; otherwise ask the user to add its rows (account, amount, moms) on the supplier invoice in Accounted. Then stage the cut-off again.',
      tool: 'gnubok_link_supplier_invoice_to_voucher',
    },
  },
  KONTANTMETOD_LEGACY_COVERED: {
    httpStatus: 409,
    message_sv:
      'Fakturan omfattades redan av en äldre kontantmetodavgränsning med vändning vid ett tidigare bokslut och årsomförs därför inte automatiskt: momsen kan redan vara redovisad. Redovisningsbyrån avgör om den ska årsomföras.',
    message_en:
      'The invoice was already covered by an earlier legacy kontantmetod cut-off with vändning, so it is withheld from the automatic carry: its moms may already have been declared. The accountant decides.',
    remediation: {
      description:
        'Ask the accountant. To carry it anyway, stage the cut-off again with acknowledge_legacy_invoice_ids listing the invoice ids.',
      tool: 'gnubok_post_kontantmetod_cutoff',
    },
  },
  // Momsdeklaration findings (lib/reports/vat-declaration-checks.ts). WARNING
  // tier: they never gate a filing, and manual filing stays ungated.
  KONTANTMETOD_CUTOFF_INCOMPLETE: {
    httpStatus: 409,
    message_sv:
      'Momsperioden innehåller slutet på ett räkenskapsår med kontantmetoden, men bokslutsavgränsningen är inte klar. Momsen på fakturor som var obetalda vid årets slut hör till den här perioden.',
    message_en:
      'The VAT period contains the end of a kontantmetoden fiscal year whose year-end cut-off is not complete. The moms on invoices unpaid at the year end belongs to this period.',
    remediation: {
      description:
        'Run gnubok_year_end_readiness for the fiscal year and post the cut-off with gnubok_post_kontantmetod_cutoff before filing this period.',
      tool: 'gnubok_year_end_readiness',
    },
  },
  LEGACY_KONTANTMETOD_VANDNING: {
    httpStatus: 409,
    message_sv:
      'Ett räkenskapsår stängdes med en äldre kontantmetodavgränsning med vändning. Makulera inte vändningarna: de bokförda och redovisade beloppen ska stå kvar.',
    message_en:
      'A fiscal year was closed with a legacy kontantmetod cut-off with a day-one vändning. Never reverse those vändningar: the posted and declared figures stand. Invoices it covered and that were paid the year after may have had their moms declared twice; the accountant decides on a corrected momsdeklaration.',
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
  // The note lives on the verifikat row, and a closed or locked period is
  // read-only, the note included (enforce_period_lock, migration 017).
  JOURNAL_ENTRY_NOTE_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv: 'Perioden är stängd eller låst, anteckningen kan inte ändras.',
    message_en:
      'The verifikat is in a closed or locked period, which is read-only, its notes included. Nothing was changed.',
    remediation: {
      description:
        'Report it to the user. Never unlock a period just to change a note: a closed year cannot be unlocked, and a locked period is unlocked only when the user explicitly asks (gnubok_unlock_period). Context that must be recorded now belongs on a verifikat in an open period, e.g. the one that corrects or refers to this one.',
    },
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
  // A year closed with a year-end run in Accounted. Which correction path is
  // lawful depends on the årsredovisning, which the refusing code does not
  // read: unsigned and unfiled, the owner reopens the year (Räkenskapsår,
  // lib/core/bookkeeping/fiscal-year-reopen.ts) and corrects where the
  // affärshändelse belongs; signed or filed, the correction is a new
  // verifikation in the open year (rättelse av fel, K2 punkt 2.12). Support
  // only when the reopen's own gate refuses and says so (crm#1290).
  TARGET_PERIOD_CLOSED: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsåret som täcker datumet är stängt med bokslut, så inget kan bokföras eller stornas där. Är årsredovisningen för året inte undertecknad, fastställd eller inskickad kan företagets ägare öppna året igen under Inställningar → Bokföring → Räkenskapsår. Annars bokför du rättelsen som ett nytt verifikat i det öppna räkenskapsåret, med hänvisning till originalverifikatet.',
    message_en:
      'The fiscal year covering the date is closed with a year-end closing, so nothing can be posted or reversed in it. If the annual report for that year has not been signed, adopted or filed, the company owner can reopen the year under Settings → Bookkeeping → Fiscal years. Otherwise, post the correction as a new voucher in the open fiscal year, referring to the original voucher.',
    remediation: {
      description:
        'Do not retry and do not unlock: a closed year cannot be unlocked. Ask the user whether the årsredovisning for that year has been signed, adopted or filed. Not signed, adopted or filed: the company owner reopens the year in the app under Inställningar → Bokföring → Räkenskapsår (owner only, typed confirmation; there is no API or MCP door), which reverses the year-end closing by storno; the user then books the correction in that year and runs the year-end again. Signed, adopted or filed: book the correction as a new verifikation dated in the open fiscal year (rättelse av fel, K2 punkt 2.12), naming the original voucher in the description.',
      tool: 'gnubok_create_voucher',
    },
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
    remediation: {
      description: 'Run the year-end closing first (gnubok_run_year_end, POST /fiscal-periods/{id}/year-end), then close.',
      tool: 'gnubok_run_year_end',
    },
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
  // Importmoms (rutor 60-62) on a bank-row, inbox or bulk booking, or left in
  // the verifikat by a rättelse (#94), with no line in ruta 50 (#83,
  // lib/bookkeeping/import-vat-base.ts). The door names the accounts; this is
  // the fallback for an envelope without them.
  IMPORT_VAT_WITHOUT_BASE: {
    httpStatus: 400,
    message_sv:
      'Verifikationen har importmoms (2615/2625/2635, ruta 60-62) men inget beskattningsunderlag i ruta 50. Bokför underlaget på 4545, 4546 eller 4547, eller den utgående momsen på 2614, 2624 eller 2634 om köpet är omvänd skattskyldighet.',
    message_en:
      'The voucher carries import VAT (2615/2625/2635, boxes 60-62) but no taxable amount in box 50. Book the taxable amount on 4545, 4546 or 4547, or the output VAT on 2614, 2624 or 2634 if the purchase is reverse charge.',
    thrown_message_sv: true,
    remediation: {
      description:
        'Import of goods: add the beskattningsunderlag on 4545/4546/4547 in the same voucher. Reverse charge (EU goods, services from abroad): book the self-assessed output VAT on 2614/2624/2634, not 2615/2625/2635.',
    },
  },
  // A storno + rättelse that moves a bank row's leg to another bank account
  // (lib/core/bookkeeping/correction-bank-leg.ts). The door names both
  // accounts; this is the fallback for an envelope without them.
  CORRECTION_BANK_ACCOUNT_CHANGED: {
    httpStatus: 409,
    message_sv:
      'Verifikationen är kopplad till en banktransaktion, och rättelsen flyttar beloppet till ett annat bankkonto än det banken visar. Behåll beloppet på bankkontot. Hör banktransaktionen inte till verifikationen, makulera verifikationen i stället, så kommer transaktionen tillbaka till Att bokföra.',
    message_en:
      'The voucher is linked to a bank transaction, and the correction moves the amount to another bank account than the one the bank shows. Keep the amount on the bank account. If the bank transaction does not belong to the voucher, reverse the voucher instead: the transaction returns to Att bokföra.',
    thrown_message_sv: true,
    remediation: {
      description:
        'Keep the line on details.bank_account in the corrected lines. If the bank transaction is wrong for this voucher (a duplicate, another account), reverse the voucher instead: the bank row is released and can be booked or ignored.',
    },
  },
  TRANSACTION_BOOK_POSSIBLE_DUPLICATE: {
    httpStatus: 409,
    message_sv:
      'Den här affärshändelsen ser redan ut att vara bokförd: en annan transaktion på samma datum och belopp, en verifikation som redan bokar samma belopp på bankkontot (t.ex. en betald faktura eller en lönekörning), eller ett samlingsverifikat på samma konto som omfattar dagen och har en del som ingen transaktion är kopplad till. Bokför inte samma affärshändelse två gånger. Granska den befintliga verifikationen och länka transaktionen till den, eller bokför ändå om de inte hör ihop.',
    message_en:
      'This business event already appears to be booked: another transaction with the same date and amount, a voucher that already books the same amount on the bank account (e.g. a paid invoice or a salary run), or a combined voucher (samlingsverifikat) on the same account that covers the day and has a part no transaction is linked to (details.candidate.covering). Do not book the same business event twice. Review the existing voucher and link this transaction to it, or pass force=true to book it anyway if they are genuinely unrelated.',
  },
  // crm#1264: one open proposal per bank row (lib/pending-operations/transaction-claims.ts).
  TRANSACTION_ALREADY_STAGED: {
    httpStatus: 409,
    message_sv:
      'Transaktionen ligger redan i ett förslag som väntar på godkännande. En banktransaktion kan bara finnas i ett förslag i taget. Godkänn eller avvisa det förslaget under Att göra innan ett nytt läggs.',
    message_en:
      'The transaction is already in a proposal awaiting approval that this call cannot replace (another stager, rows the new proposal leaves out, or an approval running now). A bank row can be in one proposal at a time: approve or reject that proposal first, then stage again. force=true does not override this.',
  },
  TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Den möjliga dubbletten som visades matchar inte längre. Ladda om och försök igen så att rätt kandidat visas.',
    message_en:
      'The duplicate candidate echoed in expected_duplicate_transaction_id / expected_duplicate_journal_entry_id no longer matches the one detected at request time. Re-run the booking pre-flight to obtain the current candidate, then retry.',
  },
  // Booking-time warnings on a typed verifikat (lib/bookkeeping/voucher-warnings-guard.ts).
  VOUCHER_NEEDS_CONFIRMATION: {
    httpStatus: 409,
    message_sv:
      'Verifikationen behöver bekräftas innan den bokförs. Läs varningarna och bekräfta att den stämmer, eller rätta den.',
    message_en:
      'The voucher needs a person\'s confirmation before it is booked (details.warnings: code, message_sv, message_en, details): it deviates from what such a voucher normally looks like, repeats something already booked, or changes the VAT of a period already declared. Show the warnings to the person; if they confirm, send the same request again with acknowledged_warnings listing every code. Otherwise correct the voucher.',
  },
  TX_CATEGORIZE_TX_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Transaktionen kunde inte hittas.',
    message_en: 'Transaction not found.',
  },
  TX_CATEGORIZE_INVALID_VAT_AMOUNT: {
    httpStatus: 400,
    message_sv:
      'Underlagets moms kan inte användas för den här bokföringen: den är högre än 25 % moms på beloppet, eller så har bokföringen ingen momsrad med momssats. Bokför med förslagets moms i stället, eller välj Ändra rader och ange momsen själv.',
    message_en:
      "The document's VAT cannot be used for this booking: it is more than 25 % VAT on the amount, or the booking has no rate-based VAT line. Book with the proposal's VAT instead, or choose Edit lines and enter the VAT yourself.",
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
      'Transaktionen är bokförd eller kopplad till en verifikation och kan inte flyttas till ett annat konto. Koppla bort den under Konton, på bankkontot, eller storna verifikationen först.',
    message_en:
      'The transaction is booked or linked to a voucher and cannot be moved to another account. Unlink it under Accounts, on the bank account, or reverse (storno) the voucher first.',
  },
  TRANSACTION_MOVE_UNKNOWN_ACCOUNT: {
    httpStatus: 404,
    message_sv: 'Kontot finns inte bland företagets registrerade bankkonton.',
    message_en: "The account is not one of the company's registered cash accounts.",
  },
  TRANSACTION_MOVE_KIND_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Raden kan inte flyttas mellan ett bankkonto och ett företagskort: kortets köp sparas med omvänt tecken mot bankens. Ångra importen och importera filen till rätt konto.',
    message_en:
      'The row cannot be moved between a bank account and a company card: card purchases are stored with the opposite sign of bank rows. Undo the import and import the file to the right account.',
  },
  TRANSACTION_MOVE_CURRENCY_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Transaktionens valuta stämmer inte med kontots valuta. En transaktion kan bara flyttas till ett konto i samma valuta.',
    message_en:
      'The transaction currency does not match the target account currency. A transaction can only be moved to an account in the same currency.',
  },
  // updateTransaction: a bank-feed row onto another bank account's cash
  // account. The move answers with a sentence naming the row's own account.
  TRANSACTION_MOVE_OTHER_BANK_ACCOUNT: {
    httpStatus: 409,
    message_sv:
      'Transaktionen hämtades från ett annat bankkonto och kan inte flyttas hit. Flytta den till kontot den hämtades från, eller byt bokföringskonto för hela bankkontot under Inställningar → Kopplingar.',
    message_en:
      'The transaction was fetched from another bank account and cannot be moved here. Move it to the account it was fetched from, or change the ledger account of the whole bank account under Settings → Connections.',
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
  // The pinned underlag shows the seller already charged moms, so the
  // purchase is not reverse charge: the foreign VAT is part of the cost. The
  // service composes the message with the document and the amount.
  // A reverse charge sent without its box at an agent or API door, whose
  // underlag does not tell the seller's country or the category does not
  // say goods or service (#94, lib/vat/reverse-charge-box.ts). The service
  // names the reason and the door's parameter; this is the fallback.
  TX_CATEGORIZE_REVERSE_CHARGE_BOX_UNKNOWN: {
    httpStatus: 400,
    message_sv:
      'Rutan för omvänd skattskyldighet (20, 21 eller 22) kan inte avgöras ur underlaget. Ange den: tjänst från ett annat EU-land ruta 21, tjänst från ett land utanför EU ruta 22, varor från ett annat EU-land ruta 20.',
    message_en:
      'The reverse-charge box (20, 21 or 22) cannot be told from the underlag. Name it: a service from another EU country box 21, a service from outside the EU box 22, goods from another EU country box 20.',
    thrown_message_sv: true,
    remediation: {
      description:
        'Resend with reverse_charge_kind eu_services, non_eu_services or eu_goods (MCP: vat_treatment reverse_charge_eu_services, reverse_charge_non_eu_services or reverse_charge_eu_goods), read off the seller country on the invoice. details.reason says why the box could not be read.',
    },
  },
  // A reverse charge on a cost account that cannot take it
  // (reverseChargeAccountConflict, the rule the utlägg books by): one that
  // declares a box of its own, where the basis pair would declare the
  // purchase twice, or one whose own ruta 20-24 is another than the box the
  // caller stated. The service names the account, the boxes and the remedy;
  // this is the fallback.
  TX_CATEGORIZE_REVERSE_CHARGE_ACCOUNT: {
    httpStatus: 400,
    message_sv:
      'Omvänd betalningsskyldighet kan inte bokföras på det valda kostnadskontot: kontot redovisar själv en momsruta som köpet då också skulle deklareras i, eller en annan ruta än den angivna. Redovisar kontot trepartshandel (ruta 37) eller import (ruta 50) ska köpet bokföras utan omvänd betalningsskyldighet.',
    message_en:
      'Reverse charge cannot be booked on the chosen cost account: the account reports a VAT box of its own that the purchase would then also be declared in, or another box than the one stated. If the account reports triangulation (box 37) or import (box 50), book the purchase without reverse charge.',
    thrown_message_sv: true,
    remediation: {
      description:
        'details.reason "other_box": details.account_number reports details.account_box itself (ruta37 trepartshandel, ruta50 import); such a purchase is not reverse charge, so book it without reverse charge (trepartshandel without VAT, an import with its import VAT). "basis_offset": 4598 is the basis offset, book the purchase on its cost account. "no_rate": the account\'s reverse-charge momskod has no rate of 25, 12 or 6 %; correct the rate in the chart of accounts or book on an ordinary cost account. "other_kind": the account reports details.account_box itself, not details.requested_box; resend with no box (or with that box when it is ruta20, ruta21 or ruta22, the boxes a caller can name), or book the purchase on an ordinary cost account.',
      resource: 'Accounted://chart-of-accounts',
    },
  },
  TX_CATEGORIZE_REVERSE_CHARGE_SELLER_VAT: {
    httpStatus: 400,
    message_sv:
      'Omvänd skattskyldighet avvisas: underlaget visar att säljaren har debiterat moms. Är det utländsk moms som säljaren debiterat felaktigt, bekräfta det (confirm_foreign_seller_vat): köpet bokförs då med omvänd skattskyldighet på hela det betalda beloppet och den utländska momsen dras inte av. Svensk moms bokförs med momssatsen.',
    message_en:
      'Reverse charge refused: the attached document shows the seller charged VAT. If it is foreign VAT the seller charged in error, confirm it (confirm_foreign_seller_vat): the purchase is then booked as reverse charge on the whole amount paid and the foreign VAT is not deducted. Swedish VAT is booked at its rate.',
    remediation: {
      description:
        'details.reason "not_confirmed" with details.address_country: the document\'s VAT number is Swedish but its address is in that country. Ask the user. If the purchase is a service taxed in Sweden under the main rule and the seller is not established in Sweden for the sale (ML 16 kap. 4 and 9 §§), resend with confirm_foreign_seller_vat=true: the reverse charge is booked on the whole amount paid and the VAT the seller charged is never deducted. If the seller\'s establishment in Sweden takes part in the sale, resend with the rate (standard_25). details.reason "not_confirmed" without it: if the VAT on the document is another country\'s VAT the seller charged in error, resend with confirm_foreign_seller_vat=true. That states the VAT is foreign: the reverse charge is booked on the whole amount paid (the foreign VAT included, never deducted), and the user should ask the seller for a credit note. If it is Swedish VAT, resend with the rate (standard_25) and no reverse charge. details.reason "seller_vat_swedish": the document names a Swedish seller, so the flag is not honoured; book with the rate.',
    },
  },
  // The row's one click (review_shown false) on a proposal the direct-booking
  // policy sends to a review: the company switched one click off, the rule
  // always asks, it is an imported rule nobody has confirmed here, or its
  // evidence is not settled (lib/transactions/direct-booking.ts). Nothing is
  // written; the page opens the review instead.
  TX_CATEGORIZE_LEDGER_DAY_COVERED: {
    httpStatus: 409,
    message_sv: 'Dagen är redan bokförd i ett manuellt samlingsverifikat eller i den gamla bokföringen. Länka raden till det verifikatet eller ignorera den, i stället för att bokföra den igen.',
    message_en: 'This day is already covered by a manual combined voucher or the migrated ledger. Link the row to that voucher or ignore it instead of booking it again.',
    remediation: {
      description: 'Link the bank row to the existing combined voucher, or ignore it as already booked.',
      tool: 'gnubok_reconcile_match',
    },
  },
  BULK_BOOK_LEDGER_DAY_COVERED: {
    httpStatus: 409,
    message_sv: 'Dagen är redan bokförd i ett manuellt samlingsverifikat eller i den gamla bokföringen. Länka raderna till det verifikatet eller ignorera dem, i stället för att skapa ett nytt samlingsverifikat.',
    message_en: 'This day is already covered by a manual combined voucher or the migrated ledger. Link the rows to that voucher or ignore them instead of creating another combined voucher.',
    remediation: {
      description: 'Use bulk booking with existing_journal_entry_id to link the rows to the existing combined voucher instead of creating a new one.',
      tool: 'gnubok_bulk_book_transactions',
    },
  },
  // The dashboard's bulk-book door asks before a new samlingsverifikat dated
  // in a filed momsperiod is booked with lines the declaration reads
  // (lib/transactions/filed-vat-bulk-book.ts).
  BULK_BOOK_VAT_PERIOD_FILED: {
    httpStatus: 409,
    message_sv:
      'Samlingsverifikationen ändrar underlaget för en momsdeklaration som redan är inlämnad. Bekräfta det för att bokföra samlingsverifikationen.',
    message_en:
      'The combined voucher changes the figures behind a VAT return already filed. Confirm that to book it.',
  },
  // The dashboard's categorize door asks before a bank row dated in a filed
  // momsperiod is booked with lines the declaration reads
  // (lib/transactions/filed-vat-categorize.ts).
  TX_CATEGORIZE_VAT_PERIOD_FILED: {
    httpStatus: 409,
    message_sv:
      'Bokningen ändrar underlaget för en momsdeklaration som redan är inlämnad. Bokför raden för sig för att bekräfta det.',
    message_en:
      'Booking this row changes the figures behind a VAT return already filed. Book the row on its own to confirm it.',
  },
  TX_CATEGORIZE_REVIEW_REQUIRED: {
    httpStatus: 409,
    message_sv: 'Förslaget behöver granskas innan det bokförs. Öppna granskningen och bokför därifrån.',
    message_en: 'The suggestion needs a review before it is booked. Open the review and book it from there.',
    remediation: {
      description:
        'details.reason says why: booking_blocked (a booking review rule matches; details.matched_rules names it), company_off, rule_always_review, rule_import_unconfirmed, evidence, or proposal_not_on_offer. Show the booking to the person and send it again with review_shown true.',
    },
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
  TX_CATEGORIZE_SKATTEVERKET_VAT: {
    httpStatus: 400,
    message_sv:
      'En betalning till Skatteverket har ingen moms. Bokför den som Insättning skattekonto och bokför skatterna den betalar från skattekontot.',
    message_en:
      'A payment to Skatteverket carries no VAT. Book it as a deposit to the tax account and book the taxes it pays from the tax account.',
    remediation: {
      description:
        'Book the bank line on the skattekonto account (template financial_tax_account) with no vat_treatment. The liabilities it pays (2510, 2650, 2710, 2731) are cleared from the skattekonto rows, not from the bank line.',
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
  // contain "Bokföringen är låst" (classifyError reads that phrase as PERIOD_LOCKED).
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
  TX_EXCHANGE_RATE_UNAVAILABLE: {
    httpStatus: 502,
    message_sv:
      'Kunde inte hämta växelkursen från Riksbanken. Försök igen om en stund: verifikationen måste bokföras i SEK.',
    message_en:
      'Could not fetch the exchange rate from Riksbanken. The verifikation must be posted in SEK.',
    retryable: true,
  },
  // A foreign-currency bank row with neither amount_sek nor exchange_rate
  // (the rate lookup failed at ingest, or the currency had no Riksbanken
  // series then). Booking it used to post the raw foreign amount as kronor.
  TX_MISSING_SEK_VALUE: {
    httpStatus: 400,
    message_sv:
      'Transaktionen är i utländsk valuta men saknar SEK-belopp och växelkurs, så den kan inte bokföras: verifikationen måste vara i kronor. Hämta växelkursen för transaktionsdatumet och försök igen.',
    message_en:
      'The transaction is in a foreign currency but has neither amount_sek nor exchange_rate, so it cannot be booked: the verifikation must be in SEK. Fetch the exchange rate for the transaction date, then retry.',
    remediation: {
      description:
        'POST /api/v1/companies/{companyId}/transactions/{id}/refresh-exchange-rate (operation transactions.refresh-exchange-rate) fetches the Riksbanken rate for the transaction date and stores amount_sek and exchange_rate on the unbooked row; then retry the same booking. In the app, the booking dialog fetches the rate automatically when it opens the row. Without the v1 API (an MCP agent: the refresh has no MCP tool), ask the user to open the transaction in Accounted for booking once (the dialog stores the rate), then retry. A currency Riksbanken does not publish answers TX_EXCHANGE_RATE_UNAVAILABLE: book that row as a manual verifikat with the SEK amount from the bank statement (gnubok_create_voucher), then attach the row to it (gnubok_link_transaction_to_journal_entry).',
    },
    retryable: false,
  },
  // The lines a kontering builds for a bank row do not balance
  // (TransactionLinesNotBalancedError): refused where the lines are built,
  // before any draft. In practice a learned line pattern replayed on a row it
  // does not fit; the categorize doors write a message with the two totals.
  TX_LINES_NOT_BALANCED: {
    httpStatus: 400,
    message_sv:
      'Konteringen går inte ihop för den här transaktionen: debet och kredit blir olika. Inget är bokfört. Välj en kategori eller ett konto i stället, eller bokför raden manuellt.',
    message_en:
      'The booking built for this transaction does not balance: debits and credits differ. Nothing was booked. Pick a category or an account instead, or book the row manually.',
    remediation: {
      description:
        'Nothing was written. details.total_debit and details.total_credit are what the chosen booking would have posted. With details.from_line_pattern true the learned counterparty template (counterparty_template_id) does not fit this row: categorize it with a category, template_id or account_override instead, or post the lines yourself (gnubok_create_voucher) and link the row.',
    },
    retryable: false,
  },
  // gnubok_create_transactions: the shared ingest dedup found the movement
  // already stored (the same external_id, or the same date, amount and text
  // from a bank feed or an import). A second row would invite a second booking.
  TX_CREATE_DUPLICATE: {
    httpStatus: 409,
    message_sv:
      'Transaktionen finns redan: samma rörelse är redan inläst, med samma externa id eller från bankkopplingen eller en import. Bokför den befintliga transaktionen i stället för att skapa en till.',
    message_en:
      'The transaction is already stored: the same movement exists with the same external_id, or from the bank feed or an import. Book the stored transaction instead of creating another.',
    remediation: {
      description:
        'Book the stored row (matched_transaction_id) with gnubok_categorize_transaction or POST /api/v1/companies/{companyId}/transactions/{id}/categorize. A row typed by hand is for a movement no bank feed or import delivers.',
    },
    retryable: false,
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
  MATCH_INVOICE_TX_ALREADY_BOOKED: {
    httpStatus: 409,
    message_sv: 'Banktransaktionen är redan bokförd, så betalningen skulle bokföras två gånger. Inget har sparats.',
    message_en: 'The bank transaction is already booked, so matching it would book the payment twice. Nothing was saved.',
    remediation: {
      description:
        'Nothing is reversed here. details.undo says how the transaction opens again: uncategorize (gnubok_uncategorize_transaction), unlink (gnubok_reconcile_unmatch: the verifikat stays posted) or reverse_voucher (gnubok_reverse_journal_entry: every transaction on that verifikat returns to the worklist). If the verifikat already is this payment, link the invoice to it instead: gnubok_link_invoice_to_voucher.',
    },
  },
  // One code on every door that refuses an ignored row before it posts
  // (decideBankRowRebooking); the row can carry no verifikat
  // (CHECK transactions_is_ignored_no_journal_entry).
  BANK_ROW_IGNORED: {
    httpStatus: 409,
    message_sv: 'Banktransaktionen är ignorerad. Återställ den innan du bokför den.',
    message_en: 'The bank transaction is ignored. Restore it before booking it.',
    remediation: {
      description:
        'Restore the transaction first: gnubok_ignore_transaction with restore: true, or DELETE /transactions/{id}/ignore. Nothing was booked.',
      tool: 'gnubok_ignore_transaction',
    },
  },
  // A read behind decideBankRowRebooking failed. Nothing is known about the
  // row, so it is no answer about the booking: the door stops, and a retry is
  // the way on. An approval stays pending (the dispatcher in commit.ts).
  BANK_ROW_READ_FAILED: {
    httpStatus: 503,
    message_sv: 'Banktransaktionen kunde inte läsas, så inget bokfördes. Försök igen om en stund.',
    message_en: 'The bank transaction could not be read, so nothing was booked. Retry the same request after a short backoff.',
    retryable: true,
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
  MATCH_OVERPAYMENT_ROUNDING_CAP: {
    httpStatus: 400,
    message_sv:
      'Överskottet är för stort för att bokas som kronutjämning på 3740. Boka det som förskott från kund på 2420 i stället.',
    message_en:
      'The excess is too large to book as rounding on 3740. Book it on 2420 (advances from customers) instead, a liability to refund or offset.',
  },
  MATCH_OVERPAYMENT_CHANGED: {
    httpStatus: 409,
    message_sv:
      'Fakturans återstående belopp har ändrats sedan matchningen förbereddes, så överskottet blir ett annat än det som visades. Förbered matchningen igen.',
    message_en:
      'The invoice remaining amount changed after the match was staged, so the excess differs from the one shown for approval. Stage the match again.',
  },
  MATCH_PAYMENT_FEE_NOT_ALLOWED: {
    httpStatus: 400,
    message_sv:
      'Mellanskillnaden kan inte bokas som betaltjänstens avgift: det går bara när både betalningen och fakturan är i kronor och avgiften är under 10 % av fakturans återstående belopp. Matcha utan avgift som en delbetalning, eller kontrollera utbetalningen.',
    message_en:
      'The shortfall cannot be booked as the payment provider\'s fee: that works only when the payment and the invoice are both in SEK and the fee is under 10% of the invoice remaining amount. Match without the fee as a partial payment, or check the payout.',
  },
  MATCH_PAYMENT_FEE_CHANGED: {
    httpStatus: 409,
    message_sv:
      'Fakturans återstående belopp har ändrats sedan matchningen förbereddes, så avgiften blir en annan än den som visades. Förbered matchningen igen.',
    message_en:
      'The invoice remaining amount changed after the match was staged, so the fee differs from the one shown for approval. Stage the match again.',
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
  // Neither can be a bank row's movement: an ingående balans predates the
  // feed and a storno cancels a verifikat (prepareBankLink).
  LINK_TX_JE_NOT_BANK_MOVEMENT: {
    httpStatus: 400,
    message_sv: 'Verifikationen är en ingående balans eller en storno och kan inte kopplas till en banktransaktion.',
    message_en: 'The journal entry is an opening balance or a storno and cannot be linked to a transaction.',
  },
  LINK_TX_TX_ALREADY_LINKED: {
    httpStatus: 400,
    message_sv: 'Transaktionen är redan kopplad till en verifikation.',
    message_en: 'Transaction is already linked to a journal entry.',
  },
  // An ignored row can never carry a link (CHECK transactions_is_ignored_no_
  // journal_entry); the reconciliation page refuses it by the same sentence.
  LINK_TX_TX_IGNORED: {
    httpStatus: 400,
    message_sv: 'Transaktionen är ignorerad. Återställ den innan du kopplar.',
    message_en: 'The transaction is ignored. Restore it before linking it.',
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
  // The verifikat does not settle the invoice on the invoice's own side
  // (invoice_settlement_side): a kontantmetod invoice never booked settles on
  // the 19xx debit, every other invoice, a carried one included (#3440), on
  // the 151x credit.
  LINK_TX_INVOICE_SETTLEMENT_SIDE: {
    httpStatus: 409,
    message_sv:
      'Verifikationen reglerar inte fakturan: en faktura som är bokförd (eller årsomförd vid kontantmetodens bokslut) betalas mot kundfordran 1510, och en obokförd faktura under kontantmetoden mot bankkontot. Välj den verifikation som bokför betalningen på rätt sida, eller matcha transaktionen mot fakturan så bokförs betalningen rätt.',
    message_en:
      'The verifikat does not settle this invoice: a booked invoice (or one carried over the kontantmetod year end) is settled by a 151x credit, an unbooked kontantmetod invoice by a 19xx debit. Pick the verifikat that books the payment on that side, or match the transaction to the invoice so the payment is booked correctly.',
    remediation: {
      description:
        'details.accountPrefix and details.entrySide name the line the verifikat must have. Link a verifikat with that line, or settle the invoice through the bank match (gnubok_match_transaction_to_invoice), which books the right shape.',
    },
  },
  // Other bank rows already hold the verifikat's bank leg, in this row's
  // direction, so the row does not fit in what is left (GitHub #3507: a
  // second Swish payment of the same amount linked to the verifikat of the
  // first). Every door that links a row to a posted verifikat refuses it:
  // the bank link core, the account-keyed reconciliation, the 1:N split and
  // the bulk link to an existing verifikat. N:1 rows that together stay
  // within the leg (instalments) still link.
  VOUCHER_BANK_LEG_CONSUMED: {
    httpStatus: 409,
    message_sv:
      'Verifikationens bankrad är redan kopplad till andra banktransaktioner, så den här transaktionen ryms inte i den. Är transaktionen en egen affärshändelse, bokför den som ett eget verifikat. Är den andra kopplingen fel, koppla bort den transaktionen först.',
    message_en:
      "The voucher's bank line is already linked to other bank transactions, so this transaction does not fit in it. If the transaction is a business event of its own, book it as its own voucher. If the other link is wrong, unlink that transaction first.",
    remediation: {
      description:
        'details.remaining is what the voucher still books on the bank account in this transaction\'s direction, details.held what other transactions already hold. Book the transaction as its own voucher (gnubok_categorize_transaction), or undo the wrong link (gnubok_reconcile_unmatch) and link again.',
    },
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
  // accounted#58: a supplier match on a booked bank row posted a second
  // payment verifikat. The envelope names the verifikat
  // (matchSiTxAlreadyBookedMessages, match-si-tx-already-booked.ts); details
  // carry journal_entry_id, voucher, via and storno_allowed.
  MATCH_SI_TX_ALREADY_BOOKED: {
    httpStatus: 409,
    message_sv: 'Banktransaktionen är redan bokförd, så betalningen skulle bokföras två gånger. Inget har sparats.',
    message_en: 'The bank transaction is already booked, so matching it would book the payment twice. Nothing was saved.',
    remediation: {
      description:
        'When details.storno_allowed is true the booking is the transaction\'s own categorization: resend with storno_existing: true to reverse it (storno) and book the payment. Otherwise the transaction is booked through a samlingsverifikat, a split or a link to an existing verifikat: unlink or correct that booking first, or link the invoice to the existing verifikat.',
    },
  },
  // accounted#58: the customer match's soft-duplicate guard on the supplier
  // doors. details.candidate names the verifikat (detectDuplicatePaymentVoucher).
  MATCH_SI_POSSIBLE_DUPLICATE: {
    httpStatus: 409,
    message_sv:
      'Det finns redan en bokförd verifikation på samma belopp nära samma datum. Har du redan bokfört denna betalning? Koppla leverantörsfakturan till den befintliga verifikationen, eller skapa ny verifikation ändå om de inte hör ihop.',
    message_en:
      'A posted journal entry already books the same amount on a nearby date. The payment may already be booked by hand: link the supplier invoice to the existing voucher, or pass force=true to create a new one anyway.',
    retryable: false,
    remediation: {
      description:
        'Link the supplier invoice to the existing voucher instead of booking a second payment (POST /supplier-invoices/{id}/link-to-voucher with details.candidate.journal_entry_id). Only if the row is a genuinely separate payment, call again with force=true and expected_journal_entry_id set to the id the refusal named.',
    },
  },
  MATCH_SI_FORCE_CANDIDATE_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Verifikationen som dubblettkontrollen visade matchar inte längre. Stäng dialogen och försök igen så att rätt verifikation visas.',
    message_en:
      'The candidate journal entry echoed in expected_journal_entry_id does not match the one detected at request time. Retry without force to obtain the current candidate.',
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
      'Beloppet är större än leverantörsfakturans återstående belopp. Ange det som återstår, eller dela betalningen och fördela överskottet på en eller flera andra leverantörsfakturor.',
    message_en:
      'The amount exceeds the supplier invoice remaining amount. State what remains, or split the payment and allocate the excess across one or more other supplier invoices.',
    remediation: {
      description:
        'details.remaining_amount is what the invoice still owes and details.excess what the payment is above it. Pay at most the remaining amount. For over-billing issue a credit note; a real overpayment is a claim on the supplier, booked as its own verifikat.',
    },
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
        'Check delivery_country. Goods to another EU member state: vat_treatment reverse_charge (needs the buyer VAT number). Goods leaving the EU: export. Goods staying in Sweden: standard. reverse_charge_domestic (construction services) takes no delivery_country. details.required names what the treatment needs.',
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
  INVOICE_VAT_TREATMENT_DOMESTIC_BUYER_REQUIRED: {
    httpStatus: 400,
    message_sv:
      'Omvänd betalningsskyldighet för byggtjänster kräver att kunden är ett svenskt företag med svenskt momsregistreringsnummer (SE + 12 siffror) på kundkortet. Numret skrivs ut på fakturan (ML 17 kap. 24 §).',
    message_en:
      "Domestic reverse charge for construction services requires a Swedish business customer with a Swedish VAT number (SE + 12 digits) on the customer card. The number is printed on the invoice (ML 17 kap. 24 §).",
    remediation: {
      description:
        "Add the buyer's Swedish VAT number (vat_number, SE + organisationsnummer + 01) to the customer, or omit vat_treatment for Swedish VAT. details.reason: private_person, not_swedish_business, missing or not_swedish_vat_number.",
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
    message_sv: 'Ett angivet bokföringskonto finns inte eller är inte ett aktivt balans- eller intäktskonto (klass 1-3) eller ränteintäktskonto (825x, 826x, 831x, 836x).',
    message_en: 'A supplied posting account does not exist or is not an active balance-sheet or revenue account (class 1-3) or interest income account (825x, 826x, 831x, 836x).',
  },
  INVOICE_CREATE_ARTICLE_INVALID: {
    httpStatus: 400,
    message_sv: 'En angiven artikel finns inte i företaget.',
    message_en: 'A supplied article does not exist in this company.',
  },
  INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT: {
    httpStatus: 400,
    message_sv: 'Ett balanskonto (klass 1-2) eller ränteintäktskonto (8xxx) kan bara användas på rader utan moms. Använd ett intäktskonto (3xxx) för momspliktiga rader.',
    message_en: 'A balance-sheet account (class 1-2) or interest income account (8xxx) can only be used on zero-VAT lines. Use a revenue account (3xxx) for VAT-bearing lines.',
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
  INVOICE_CREATE_ACCRUAL_INVOICE_MONTH: {
    httpStatus: 400,
    message_sv: 'Perioden måste omfatta en annan månad än fakturamånaden. En period som bara ligger i fakturamånaden flyttar inget belopp.',
    message_en: 'The period must cover a month other than the invoice month. A period that lies only in the invoice month moves no amount.',
  },
  // Upplupen intäkt (17xx) on a customer invoice line (#62): refused by the
  // invoice builder and, typed (lib/bookkeeping/errors.ts), before the
  // revenue entry is posted.
  INVOICE_ACCRUED_INCOME_PERIOD_INVALID: {
    httpStatus: 400,
    message_sv:
      'En upplupen intäkt (17xx) måste avse månader före fakturamånaden. Perioden fortsätter in i fakturans månad: dela raden i en del för månaderna före fakturamånaden (17xx) och en del för resten (29xx eller intäktskontot).',
    message_en:
      'Accrued income (17xx) must cover months before the invoice month. The period reaches the month of the invoice: split the line into the months before the invoice month (17xx) and the rest (29xx or the revenue account).',
  },
  // A 29xx deferral of months that ended before the invoice month
  // (accounted#113): those months are an upplupen intäkt (1790).
  INVOICE_DEFERRED_INCOME_PERIOD_PAST: {
    httpStatus: 400,
    message_sv:
      'Perioden slutar före fakturamånaden, så intäkten är redan intjänad: den är en upplupen intäkt, inte en förutbetald. Välj 1790 (Övriga förutbetalda kostnader och upplupna intäkter) som balanskonto, så bokförs varje månads intäkt i sin egen månad. På 29xx skulle hela beloppet bokföras på fakturadatumet.',
    message_en:
      'The period ends before the invoice month, so the revenue is already earned: it is accrued income, not deferred income. Choose 1790 (Övriga förutbetalda kostnader och upplupna intäkter) as the balance account and each month books in its own month. On 29xx the whole amount would book on the invoice date.',
  },
  INVOICE_ACCRUED_INCOME_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv:
      'En upplupen intäkt (17xx) bokförs sista dagen i varje månad i perioden, och minst en av månaderna kan inte ta emot verifikationer (låst, stängd, inom företagets låsdatum eller utan räkenskapsår). Intäkten flyttas inte till en annan månad, så inget har bokförts. Lås upp perioden eller lägg upp räkenskapsåret, eller bokför raden utan periodisering.',
    message_en:
      'Accrued income (17xx) books on the last day of each month in the period, and at least one of those months cannot take entries (locked, closed, behind the company lock date or without a fiscal year). The revenue is never moved to another month, so nothing was booked. Unlock the period or create the fiscal year, or book the line without periodisering.',
    remediation: {
      description:
        'details.blocked lists each month-end date with its reason (company_lock_date_covers, period_locked_at_set, period_is_closed, no_fiscal_period, lookup_failed). Unlock a locked period (gnubok_unlock_period), create the missing fiscal year, or send the line without the accrual fields. Nothing was written.',
      tool: 'gnubok_unlock_period',
    },
  },
  ACCRUAL_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Periodiseringen kunde inte hittas.',
    message_en: 'Accrual schedule not found.',
  },
  // A periodisering set up by hand (lib/bookkeeping/accruals/manual.ts, accounted#164).
  ACCRUAL_ORIGIN_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikatet som periodiseringen ska utgå från finns inte eller är inte bokfört.',
    message_en: 'The verifikat the accrual schedule should start from does not exist or is not posted.',
  },
  ACCRUAL_ORIGIN_REVERSED: {
    httpStatus: 400,
    message_sv: 'Verifikatet som periodiseringen ska utgå från är makulerat. Utgå från rättelsen eller det verifikat som står kvar.',
    message_en: 'The verifikat the accrual schedule should start from is reversed. Start from its correction or the verifikat that stands.',
  },
  ACCRUAL_ORIGIN_ACCOUNT_MISSING: {
    httpStatus: 400,
    message_sv: 'Verifikatet för inte upp något belopp på balanskontot. Välj raden som förde upp beloppet, eller rätt balanskonto.',
    message_en: 'The verifikat puts no amount on the balance account. Pick the line that put the amount there, or the right balance account.',
  },
  ACCRUAL_OPENING_BALANCE_MISSING: {
    httpStatus: 400,
    message_sv: 'Balanskontot har ingen ingående balans att periodisera. Öppna verifikatet som förde upp beloppet och välj Periodisera på raden.',
    message_en: 'The balance account has no opening balance to spread. Open the verifikat that put the amount there and choose Periodisera on its line.',
  },
  ACCRUAL_BALANCE_EXCEEDED: {
    httpStatus: 400,
    message_sv: 'Beloppet är större än det som finns kvar att periodisera på balanskontot. Ange det belopp som återstår och den första månad som inte redan är upplöst.',
    message_en: 'The amount exceeds what remains to spread on the balance account. Enter the remaining amount and the first month not yet released.',
  },
  ACCRUAL_PERIOD_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Ange antal månader eller ett slutdatum som inte ligger före första månaden.',
    message_en: 'Give the number of months or an end date that is not before the first month.',
  },
  ACCRUAL_AMOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Beloppet måste vara större än noll och räcka till minst ett öre per månad.',
    message_en: 'The amount must be greater than zero and cover at least one öre per month.',
  },
  ACCRUAL_BALANCE_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Balanskontot måste vara ett 17xx- eller 29xx-konto.',
    message_en: 'The balance account must be a 17xx or 29xx account.',
  },
  ACCRUAL_TARGET_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Resultatkontot måste vara ett konto i klass 3-8.',
    message_en: 'The P&L account must be an account in class 3-8.',
  },
  ACCRUAL_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Periodiseringen kunde inte skapas.',
    message_en: 'The accrual schedule could not be created.',
  },
  ACCRUAL_ROOM_FAILED: {
    httpStatus: 500,
    message_sv: 'Det gick inte att läsa hur mycket som finns kvar att periodisera.',
    message_en: 'Could not read how much remains to spread.',
  },
  ACCRUAL_CANCEL_NOT_MANUAL: {
    httpStatus: 400,
    message_sv: 'En periodisering från en faktura ångras genom att fakturan krediteras.',
    message_en: 'An accrual schedule from an invoice is undone by crediting the invoice.',
  },
  ACCRUAL_CANCEL_FAILED: {
    httpStatus: 500,
    message_sv: 'Periodiseringen kunde inte ångras.',
    message_en: 'The accrual schedule could not be undone.',
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
  // details.reason names the rule (lib/bookkeeping/accruals/errors.ts); the
  // Swedish message the service answers names it in words.
  ACCRUAL_REPLAN_INVALID: {
    httpStatus: 400,
    message_sv: 'Periodiseringen kan inte planeras om så här.',
    message_en: 'The accrual schedule cannot be re-planned this way.',
  },
  ACCRUAL_REPLAN_CONFLICT: {
    httpStatus: 409,
    message_sv: 'Periodiseringen ändrades samtidigt, till exempel bokfördes en månad. Försök igen.',
    message_en: 'The accrual schedule changed at the same time, for example a month was booked. Try again.',
    retryable: true,
  },
  ACCRUAL_REPLAN_FAILED: {
    httpStatus: 500,
    message_sv: 'Periodiseringen kunde inte planeras om.',
    message_en: 'The accrual schedule could not be re-planned.',
  },
  INVOICE_CREATE_ROT_RUT_PERSONNUMMER_INVALID: {
    httpStatus: 400,
    message_sv: 'Personnumret för skattereduktionen är ogiltigt.',
    message_en: 'The personnummer provided for the tax reduction is invalid.',
  },
  // Konsumentkreditlag (2026:1011), särskild fakturakredit (1 kap. 3 §)
  INVOICE_CONSUMER_CREDIT_TERMS_TOO_LONG: {
    httpStatus: 400,
    message_sv:
      'En faktura till en privatperson ska förfalla inom 50 dagar från leveransen (konsumentkreditlagen). Välj ett tidigare förfallodatum.',
    message_en:
      'An invoice to a private person must fall due within 50 days of delivery (the Swedish Consumer Credit Act). Choose an earlier due date.',
    remediation: {
      description:
        'details.latestDueDate is the last due date allowed, counted from details.countedFrom (the delivery date, else the invoice date). Send a due_date on or before it. Longer terms would make the invoice a regulated consumer credit with a credit assessment, which is not supported.',
    },
  },
  INVOICE_CONSUMER_CREDIT_FEE: {
    httpStatus: 400,
    message_sv:
      'En faktura till en privatperson kan inte ha en fakturaavgift (konsumentkreditlagen). Ta bort raden eller lägg kostnaden i priset.',
    message_en:
      'An invoice to a private person cannot carry an invoice fee (the Swedish Consumer Credit Act). Remove the line or include the cost in the price.',
    remediation: {
      description:
        'details.lines names the lines read as a fee for paying by invoice. Remove them. A reminder fee or late-payment interest on an overdue invoice is not affected.',
    },
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
  ROT_RUT_SETTLE_DEDUCTION_SPLIT_UNKNOWN: {
    httpStatus: 400,
    message_sv:
      'Utbetalningen kan inte delas upp per faktura. Under kontantmetoden bokförs Skatteverkets andel som försäljning och moms per faktura, så beslutet måste ange godkänt belopp för varje faktura. Importera beslutsfilen från Skatteverket och försök igen.',
    message_en:
      'The payout cannot be split per invoice. Under the cash method Skatteverket\'s share is booked as sales and VAT per invoice, so the decision must state the approved amount for each invoice. Import the decision file from Skatteverket and try again.',
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
    message_sv: 'Verifikatraderna är ogiltiga: kontrollera att raderna balanserar och att skuldraden matchar beloppet. Med omvänd skattskyldighet måste kostnadskontot vara ett vanligt kostnadskonto.',
    message_en: 'The voucher lines are invalid: they must balance and carry exactly one credit on the liability account equal to the amount. With reverse_charge the expense account must be an ordinary cost account.',
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
        'The credit note is dated today (Europe/Stockholm) and that date falls in a closed or locked period, on/before the company lock date, or in no fiscal period at all (details.reason: no_fiscal_period; create the fiscal year first). Unlock the period in the dashboard or wait for the next open period; the API cannot backdate or forward-date a credit note.',
    },
  },
  // accounted#45: a deferred-booking original that was never booked is booked
  // (the Bokför step) before its credit posts. These two refuse the credit
  // when that booking cannot happen; nothing was written.
  INVOICE_CREDIT_ORIGINAL_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv:
      'Originalfakturan saknar verifikation och måste bokföras innan den krediteras, men dess fakturadatum ligger i en låst eller stängd period. Finns försäljningen redan i bokföringen, koppla fakturan till den verifikationen. Annars: lås upp perioden och försök igen.',
    message_en:
      'The original invoice has no voucher and must be booked before it is credited, but its invoice date is in a locked or closed period. If the sale is already in the books, link the invoice to that voucher. Otherwise unlock the period and try again.',
    remediation: {
      description:
        'Under faktureringsmetoden with deferred booking, crediting an invoice that has no verifikat first books it on its own invoice date (the Bokför step, POST /invoices/{id}/book), then posts the credit. details.invoice_date and details.reason say which lock refused it. If the sale is already in the books (a migrated or imported verifikat), link the invoice to it (gnubok_link_invoice_to_voucher) and credit again: the credit then reverses that verifikat. Otherwise unlock that period (gnubok_unlock_period, if it is locked and not closed) and retry. Nothing was written.',
      tool: 'gnubok_unlock_period',
    },
  },
  INVOICE_CREDIT_ORIGINAL_BOOK_FAILED: {
    httpStatus: 400,
    message_sv:
      'Originalfakturan saknar verifikation och kunde inte bokföras, så den har inte krediterats. Finns försäljningen redan i bokföringen, koppla fakturan till den verifikationen. Annars: öppna fakturan och välj Bokför för att se vad som hindrar.',
    message_en:
      'The original invoice has no voucher and could not be booked, so it was not credited. If the sale is already in the books, link the invoice to that voucher. Otherwise open the invoice and choose Book to see what stops it.',
    remediation: {
      description:
        'Under faktureringsmetoden with deferred booking, crediting an invoice that has no verifikat first books it (the Bokför step, POST /invoices/{id}/book), then posts the credit. That booking was refused: details.original_booking_code is the Bokför step\'s own code (e.g. INVOICE_BOOK_NO_FISCAL_PERIOD). If the sale is already in the books (a migrated or imported verifikat), link the invoice to it (gnubok_link_invoice_to_voucher) and credit again. Otherwise book the original first, fix what that refusal names, then credit it. Nothing was written.',
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
  // Linking an existing credit note to the invoice it credits (crm#1852,
  // lib/invoices/link-credit-note.ts). The link never books, so every pair
  // an ordinary credit would have booked is refused.
  INVOICE_CREDIT_LINK_NOT_A_CREDIT_NOTE: {
    httpStatus: 400,
    message_sv: 'Dokumentet är inte en utfärdad kreditfaktura som går att koppla. Det ska ha ett negativt belopp, vara utfärdat och inte ha någon återbetalning registrerad.',
    message_en: 'The document is not an issued credit note that can be linked. It must have a total below zero, be issued and have no refund recorded.',
    remediation: {
      description: 'Pass the id of the existing credit note as credit_note_id and the invoice it credits as the invoice. details.reason says what was wrong: not_an_invoice, not_negative, status or refunded.',
    },
  },
  INVOICE_CREDIT_LINK_ALREADY_LINKED: {
    httpStatus: 409,
    message_sv: 'Kreditfakturan är redan kopplad till en faktura.',
    message_en: 'The credit note is already linked to an invoice.',
    remediation: {
      description: 'details.credited_invoice_id is the invoice it credits; details.same_invoice is true when that is the invoice you named. A credit note credits one invoice and the link cannot be moved.',
    },
  },
  INVOICE_CREDIT_LINK_ORIGINAL_NOT_OPEN: {
    httpStatus: 409,
    message_sv: 'Fakturan kan inte krediteras av den här kreditfakturan. Den ska vara en utfärdad kundfaktura som inte redan är krediterad, makulerad eller har en kreditfaktura.',
    message_en: 'The invoice cannot be credited by this credit note. It must be an issued sales invoice that is not already credited, cancelled or carrying a credit note.',
    remediation: {
      description: 'details.reason: same_document, not_an_invoice, is_credit_note, status (details.status is the current one) or has_credit_note. Re-read the invoice and pick the invoice the credit note actually credits.',
    },
  },
  INVOICE_CREDIT_LINK_CUSTOMER_MISMATCH: {
    httpStatus: 400,
    message_sv: 'Kreditfakturan och fakturan har olika kunder. En kreditfaktura kan bara kopplas till en faktura till samma kund.',
    message_en: 'The credit note and the invoice belong to different customers. A credit note can only be linked to an invoice of the same customer.',
    remediation: {
      description: 'Compare customer_id on both documents. If the same customer exists twice in the register, merge the two customers first.',
    },
  },
  INVOICE_CREDIT_LINK_CURRENCY_MISMATCH: {
    httpStatus: 400,
    message_sv: 'Kreditfakturan och fakturan har olika valuta eller växelkurs och kan inte kvittas mot varandra.',
    message_en: 'The credit note and the invoice carry different currencies or exchange rates and cannot be set against each other.',
    remediation: {
      description: 'details.reason is currency or exchange_rate. A credit note carries the currency and the rate of the invoice it credits.',
    },
  },
  INVOICE_CREDIT_LINK_BOOKING_REQUIRED: {
    httpStatus: 409,
    message_sv: 'Kopplingen bokför ingenting, och för de här två dokumenten skulle en vanlig kreditering ha bokfört ett verifikat. Bokför krediteringen i bokföringen först.',
    message_en: 'The link books nothing, and for these two documents an ordinary credit would have booked a verifikat. Make the entries in the bookkeeping first.',
    remediation: {
      description: 'details.reason: accrual_method (faktureringsmetoden: a credit always reverses the invoice in the ledger), original_paid_or_booked (the invoice has a verifikat or a payment), credit_note_booked (the credit note has a verifikat), rot_rut (part of the claim is on Skatteverket) or customer_loss_decision (the invoice has a kundförlust decision whose reserve is released by a verifikat). Nothing is booked for you here.',
    },
  },
  INVOICE_CREDIT_LINK_AMOUNT_MISMATCH: {
    httpStatus: 400,
    message_sv: 'Kreditfakturans belopp stämmer inte med det som står öppet på fakturan. Kopplingen kräver att kreditfakturan krediterar hela det öppna beloppet.',
    message_en: 'The credit note amount does not match what is open on the invoice. The link requires the credit note to credit the whole open amount.',
    remediation: {
      description: 'details.credit_amount and details.open_amount are the two figures. details.reason: exceeds_open_amount, partial_credit (a partial credit cannot be linked yet) or credit_cap (the database refused the pair).',
    },
  },
  INVOICE_CREDIT_LINK_RACE: {
    httpStatus: 409,
    message_sv: 'Fakturan eller kreditfakturan ändrades samtidigt och kopplingen gjordes inte. Ladda om och försök igen.',
    message_en: 'The invoice or the credit note changed concurrently and the link was not made. Reload and retry.',
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
  // crm#1281: issuing a kontantfaktura (paid at issue) is refused for a
  // document that is not a plain faktura, or one with periodiserade lines or
  // user-edited issuance lines. details.reason names which.
  INVOICE_PAID_AT_ISSUE_NOT_ALLOWED: {
    httpStatus: 400,
    message_sv:
      'Den här fakturan kan inte utfärdas som redan betald (kontantfaktura). Det går bara för en vanlig faktura utan periodiserade rader, daterad senast i dag. Skicka den som vanligt och registrera betalningen efteråt.',
    message_en:
      'This invoice cannot be issued as already paid (cash invoice). Only a plain invoice without periodised lines, dated today at the latest, can. Send it as usual and register the payment afterwards.',
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
  // Every company's own sending domain is registered in the platform's one
  // Resend account, and that account has used every domain its plan includes
  // (crm#1288). Nothing the company can fix: the operators grow the plan or
  // remove unused domains. Invoice mail keeps leaving from the platform address.
  SENDING_DOMAIN_CLAIM_PROVIDER_LIMIT: {
    httpStatus: 503,
    message_sv:
      'Det går inte att lägga till en egen avsändardomän just nu på grund av en tillfällig begränsning hos vår e-postleverantör. Fakturamejl skickas som vanligt från vår adress under tiden. Försök igen senare.',
    message_en:
      'Adding your own sending domain is temporarily unavailable because of a limit at our email provider. Invoice emails keep going out from our address in the meantime. Try again later.',
    remediation: {
      description:
        'Operator action, not the caller: the platform Resend account has no domain left on its plan. Retrying does not help until the plan grows or unused domains are removed.',
    },
  },
  // The rest of the sending-domain answers when Resend fails or refuses. The
  // customer gets these sentences; Resend's own name, status and text go to
  // the log only (crm#1288 follow-up: that text used to reach the toast).
  SENDING_DOMAIN_CLAIM_PROVIDER_ERROR: {
    httpStatus: 502,
    message_sv:
      'Kunde inte registrera domänen hos e-postleverantören. Försök igen om en stund och kontakta supporten om felet kvarstår.',
    message_en:
      'The domain could not be registered with our email provider. Try again in a moment and contact support if the problem persists.',
    retryable: true,
  },
  SENDING_DOMAIN_VERIFY_PROVIDER_ERROR: {
    httpStatus: 502,
    message_sv:
      'Kunde inte kontrollera domänen hos e-postleverantören just nu. Försök igen om en stund och kontakta supporten om felet kvarstår.',
    message_en:
      'The domain could not be checked with our email provider right now. Try again in a moment and contact support if the problem persists.',
    retryable: true,
  },
  // Resend answers 404 for the stored domain id: it was removed on the
  // provider's side. Checking again never helps; claiming it again does.
  SENDING_DOMAIN_VERIFY_PROVIDER_DOMAIN_MISSING: {
    httpStatus: 409,
    message_sv: 'Domänen finns inte längre hos e-postleverantören. Ta bort den här och lägg till den igen.',
    message_en: 'The domain no longer exists at our email provider. Remove it here and add it again.',
    remediation: { description: 'DELETE the sending domain, then claim it again and publish the new DNS records.' },
  },
  SENDING_DOMAIN_REMOVE_PROVIDER_ERROR: {
    httpStatus: 502,
    message_sv:
      'Kunde inte ta bort domänen hos e-postleverantören just nu, så den ligger kvar. Försök igen om en stund och kontakta supporten om felet kvarstår.',
    message_en:
      'The domain could not be removed at our email provider right now, so it is still in place. Try again in a moment and contact support if the problem persists.',
    retryable: true,
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
  // reenableIfUnused: rows were put on a turned-off account marked to be
  // printed on invoices, which rows never turn back on (its payment details
  // may be stale). A turned-off account is printed on no invoice, so the
  // sentence says "marked". Either fix lets the rows land: turning it on
  // prints it on invoices again, hiding it on invoices lets the rows turn it
  // on as an ordinary account.
  CASH_ACCOUNT_DISABLED_PAYEE: {
    httpStatus: 409,
    message_sv:
      'Bankkontot är avstängt och markerat att visas på fakturor. En ägare eller administratör behöver aktivera det under Inställningar → Bokföring (då visas det på fakturor igen) eller dölja det på fakturor under Inställningar → Fakturering innan transaktioner kan läggas på det.',
    message_en:
      'This bank account is turned off and marked to be printed on invoices. An owner or admin needs to turn it on under Inställningar → Bokföring (Settings → Bookkeeping; it is then printed on invoices again) or hide it on invoices under Inställningar → Fakturering (Settings → Invoicing) before transactions can be put on it.',
    remediation: {
      description:
        'Retrying does not help until an owner or admin turns the account on (it is then printed on invoices again) or hides it on invoices: gnubok_update_cash_account stages either (enabled or invoice_payee). Or send the row with the ledger_account of another bank account (gnubok_list_cash_accounts).',
    },
    retryable: false,
  },
  // ensureManualCashAccount: the kassakonto already on the row's ledger
  // account is in another currency, and a ledger holds one (cash_accounts is
  // UNIQUE on company and ledger). details: ledger_account, account_currency,
  // currency. The sentence names only the cause: the bank-file import and the
  // Stripe sync read it through getErrorMessage too, and each caller says its
  // own next step (the create_transactions approval in commit.ts).
  CASH_ACCOUNT_CURRENCY_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Bankkontot på det bokföringskontot har en annan valuta än transaktionen, och ett bankkonto har bara en valuta.',
    message_en:
      'The bank account on that ledger account is in another currency than the transaction, and a bank account holds one currency.',
    remediation: {
      description:
        'Retrying does not help. Send the row again with ledger_account set to the bank account in its currency (gnubok_list_cash_accounts), or to a free BAS 19xx account: a missing kassakonto is created in the row\'s currency.',
    },
    retryable: false,
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
    message_sv: 'Bokföringskontot används redan av ett annat bankkonto eller företagskort i företaget. Välj ett annat konto eller låt systemet välja nästa lediga.',
    message_en: 'The ledger account is already used by another bank account or company card of the company. Pick another one or omit it to get the next free one.',
  },
  CASH_ACCOUNT_NO_FREE_LEDGER: {
    httpStatus: 409,
    message_sv: 'Det finns inget ledigt bokföringskonto i 1931-1959 för ett nytt bankkonto. Ange ett bokföringskonto (1920-1999) själv.',
    message_en: 'No free ledger account in 1931-1959 is left for a new bank account. Pass a ledger_account (1920-1999) explicitly.',
  },
  // Company cards (lib/cash-accounts/card-ledger.ts): the card books its
  // purchases against a liability account, never a 19xx bank account.
  CARD_ACCOUNT_LEDGER_INVALID: {
    httpStatus: 400,
    message_sv: 'Ett företagskort bokförs på ett skuldkonto: 2480-2489, 2890, 2894, 2896 eller 2899. Välj ett av dem.',
    message_en: 'A company card books on a liability account: 2480-2489, 2890, 2894, 2896 or 2899. Pick one of them.',
  },
  CARD_ACCOUNT_NO_FREE_LEDGER: {
    httpStatus: 409,
    message_sv: 'Alla skuldkonton ett företagskort kan bokföras på (2480-2489, 2890, 2894, 2896, 2899) används redan av andra kort eller konton.',
    message_en: 'Every liability account a company card can book on (2480-2489, 2890, 2894, 2896, 2899) is already used by another card or account.',
  },
  CASH_ACCOUNT_IBAN_DUPLICATE: {
    httpStatus: 409,
    message_sv: 'Ett annat bankkonto i företaget har redan detta IBAN, även om det är avstängt: en bankkoppling hamnar på det kontot. Samma bankkonto ska bara finnas en gång, så lägg uppgifterna på det befintliga kontot. Lades det andra kontot till av misstag: stäng av det och töm dess IBAN, eller ta bort det under Inställningar, Bokföring.',
    message_en: 'Another bank account of the company already carries this IBAN, also when it is turned off: a bank connection lands on that account. One physical account must exist once, so put the details on the existing account. If the other account was added by mistake, turn it off and clear its IBAN, or remove it under Settings, Bookkeeping.',
  },
  // Removing a bank account (remove_cash_account, #3130): one code per
  // refusal, each saying what keeps the account and the way out if there is
  // one. Nothing is removed when any of them is answered.
  CASH_ACCOUNT_REMOVE_BANK_CONNECTED: {
    httpStatus: 409,
    message_sv: 'Kontot hämtas fortfarande via en bankkoppling och kan inte tas bort. Koppla från banken först under Inställningar > Kopplingar > Bank, tre punkter vid banken, Koppla från (kontona och deras transaktioner finns kvar), ta bort kontot och koppla sedan banken igen med bara rätt konton.',
    message_en: 'The account is still fetched through a bank connection and cannot be removed. Disconnect the bank first under Settings > Connections > Bank, three dots at the bank, Disconnect (the accounts and their transactions stay), remove the account, then connect the bank again with only the right accounts.',
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
  // Archiving a bank account removal must keep (archive_cash_account, PH 222).
  // A connected or primary account answers with the removal codes above.
  CASH_ACCOUNT_ARCHIVE_ALREADY: {
    httpStatus: 409,
    message_sv: 'Kontot är redan arkiverat.',
    message_en: 'The account is already archived.',
  },
  CASH_ACCOUNT_ARCHIVE_INVOICE_PAYEE: {
    httpStatus: 409,
    message_sv: 'Kontot skrivs ut som betalningsmottagare på kundfakturor och kan inte arkiveras. Välj ett annat konto för fakturor under Inställningar först.',
    message_en: 'Customer invoices print this account as the payee, so it cannot be archived. Choose another account for invoices in Settings first.',
  },
  CASH_ACCOUNT_ARCHIVE_REMOVABLE: {
    httpStatus: 409,
    message_sv: 'Inget på kontot är bokfört, så det behöver inte arkiveras. Ta bort det i stället.',
    message_en: 'Nothing on the account is booked, so it does not need archiving. Remove it instead.',
  },
  INVOICE_SEND_PAYMENT_ACCOUNT_MISSING: {
    httpStatus: 400,
    // Currency-neutral by necessity (the registry has no details). Surfaces
    // that know the invoice currency say exactly what is missing through
    // describeMissingInvoicePaymentAccount() (lib/cash-accounts/invoice-payment-accounts.ts).
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
  INVOICE_SEND_DELIVERY_NOTE: {
    httpStatus: 400,
    message_sv: 'En följesedel skickas inte med e-post. Markera den som skickad.',
    message_en: 'A delivery note is not emailed; mark it as sent instead.',
  },
  INVOICE_CREDIT_NOTE_NOT_ISSUABLE: {
    httpStatus: 400,
    message_sv:
      'Det här är en kreditfaktura utan koppling till originalfakturan, så den kan inte utfärdas som en vanlig faktura. Ta bort utkastet och kreditera originalfakturan.',
    message_en:
      'This is a credit note with no link to its original, so it cannot be issued as an ordinary invoice. Delete the draft and credit the original invoice.',
  },
  INVOICE_SEND_CREDIT_NOTE_DRAFT: {
    httpStatus: 409,
    message_sv:
      'En kreditfaktura skickas inte den här vägen. Utkastet skickas från kreditfakturans sida i Accounted, där den också utfärdas och bokförs.',
    message_en:
      "A credit note is not sent this way. The draft is sent from the credit note's page in Accounted, which also issues and books it.",
  },
  INVOICE_SEND_CREDIT_NOTE_ISSUED: {
    httpStatus: 409,
    message_sv:
      'Kreditfakturan är redan utfärdad, och Accounted mejlar den inte i efterhand. Ladda ner PDF:en på kreditfakturans sida och skicka den själv till kunden.',
    message_en:
      "The credit note is already issued, and Accounted does not email it afterwards. Download its PDF from the credit note's page and send it to the customer yourself.",
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
  // payment_account on mark-paid (resolveInvoicePaymentAccount, crm#1823).
  INVOICE_PAID_PAYMENT_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Betalkontot kan inte ta emot betalningen: det är inte ett av företagets aktiva kassa- eller bankkonton (19xx).',
    message_en: 'The payment account cannot receive the payment: it is not one of the company\'s enabled cash or bank accounts (19xx).',
    remediation: {
      description: 'Name one of details.available_payment_accounts (the ledger_account of an enabled cash account), or leave payment_account out to book on the account the invoice asked to be paid to.',
    },
  },
  // Every door that records a payment by hand (lib/invoices/payment-date.ts).
  PAYMENT_DATE_IN_FUTURE: {
    httpStatus: 400,
    message_sv: 'Betalningsdatumet ligger i framtiden. En betalning bokförs den dag pengarna flyttades.',
    message_en: 'The payment date is in the future. A payment is booked on the day the money moved.',
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
  INVOICE_QUOTE_PART_OUT_OF_RANGE: {
    httpStatus: 409,
    message_sv: 'Delen måste vara större än noll och får inte överstiga det som återstår att fakturera på offerten.',
    message_en: 'The part must be above zero and at most what remains to be invoiced on the quote.',
    remediation: {
      description:
        'details.remaining is what is left (net, excl. VAT). Ask for at most that amount, or leave out percent and amount to invoice the rest.',
    },
  },
  INVOICE_CONVERT_PART_QUOTE_ONLY: {
    httpStatus: 400,
    message_sv: 'Bara en offert kan faktureras i delar. En proformafaktura omvandlas i sin helhet.',
    message_en: 'Only a quote can be invoiced in parts; a proforma converts in full.',
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
    message_sv: 'Dokumenttypen kan inte ändras på en offert, en följesedel eller ett dokument som redan har fått nummer: numret hör till serien. Skapa ett nytt dokument i stället.',
    message_en: 'The document type of a quote, a delivery note or an already numbered document cannot change: its number belongs to that series. Create a new document instead.',
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
  // POST /api/invoices/[id]/resend (crm#1339): emails the archived invoice
  // again as a copy, so only an unpaid, issued faktura or kreditfaktura.
  INVOICE_RESEND_NOT_ELIGIBLE: {
    httpStatus: 409,
    message_sv:
      'Bara en skickad eller förfallen faktura som inte är betald kan skickas igen. Till en betald faktura finns en betalningsbekräftelse.',
    message_en:
      'Only a sent or overdue invoice that is not paid can be sent again. A paid invoice has a payment confirmation instead.',
  },
  INVOICE_RESEND_NO_ARCHIVED_COPY: {
    httpStatus: 409,
    message_sv:
      'Fakturan har inte mejlats härifrån, så det finns ingen sparad kopia att skicka igen. Ladda ner PDF:en och skicka den själv.',
    message_en:
      'The invoice was not emailed from here, so there is no saved copy to send again. Download the PDF and send it yourself.',
  },
  INVOICE_RESEND_ARCHIVE_UNAVAILABLE: {
    httpStatus: 503,
    message_sv: 'Den sparade kopian av fakturan kunde inte läsas. Ingen e-post skickades. Försök igen om en stund.',
    message_en: 'The saved copy of the invoice could not be read. No email was sent. Try again shortly.',
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
  // Refund of a kreditfaktura through the mark-paid doors (lib/invoices/refund-credit-note.ts).
  CREDIT_NOTE_REFUND_NOTHING_OWED: {
    httpStatus: 409,
    message_sv:
      'Kunden har inget tillgodo på kreditfakturan: originalfakturan var inte betald, eller så är krediten redan återbetald eller kvittad mot en annan faktura.',
    message_en:
      'Nothing is owed to the customer on this credit note: the original was unpaid, or the credit was already refunded or set off against another invoice.',
  },
  CREDIT_NOTE_REFUND_UNSUPPORTED: {
    httpStatus: 409,
    message_sv:
      'Återbetalningen kan inte registreras på den här kreditfakturan (den är inte utfärdad, saknar verifikation, är i utländsk valuta eller har ROT/RUT). Bokför återbetalningen som en egen verifikation: debet 1510 Kundfordringar, kredit bankkontot.',
    message_en:
      'This credit note cannot take a refund here (details.reason: not_issued, not_booked, foreign_currency, rot_rut or no_original). Book the refund as its own voucher: debit 1510, credit the bank account.',
    remediation: {
      description:
        'not_booked: complete the credit note\'s bookkeeping first (its reversing voucher is missing). Otherwise create the voucher Dr 1510 / Cr the bank account with the journal-entries endpoints.',
    },
  },
  CREDIT_NOTE_REFUND_EXCEEDS_OWED: {
    httpStatus: 400,
    message_sv: 'Återbetalningen är större än det kunden har tillgodo på kreditfakturan.',
    message_en: 'The refund is larger than what the customer is owed on the credit note (details.owed).',
  },
  CREDIT_NOTE_REFUND_LINES_INVALID: {
    httpStatus: 400,
    message_sv: 'En återbetalning debiterar 1510 Kundfordringar och krediterar kontot pengarna gick ut från.',
    message_en: 'Refund lines must debit 1510 only and credit the account the money left from (never a 151x receivable).',
  },
  CREDIT_NOTE_REFUND_LIKELY_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Återbetalningen ser redan ut att vara bokförd: en verifikation debiterar 1510 med samma belopp. Registrera den bara om det är en annan återbetalning.',
    message_en:
      'A posted voucher already debits 1510 with this amount (details.candidates): the refund is most likely booked already.',
    remediation: {
      description:
        'Check the candidate vouchers. Only when this is a separate refund, resend with force: true (dashboard and v1; a fresh Idempotency-Key on v1) or allow_duplicate: true (gnubok_mark_invoice_as_paid).',
    },
  },
  CREDIT_NOTE_REFUND_RACE: {
    httpStatus: 409,
    message_sv: 'Kreditfakturan ändrades samtidigt (en annan återbetalning registrerades). Ladda om och försök igen.',
    message_en: 'The credit note changed concurrently (another refund was recorded). Reload and retry.',
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
  // Staging a cancel of a quote or proforma that is already cancelled
  // (lib/operations/invoice-cancel.ts): nothing is left to stage.
  INVOICE_ALREADY_CANCELLED: {
    httpStatus: 409,
    message_sv: 'Dokumentet är redan makulerat. Det finns inget kvar att göra.',
    message_en: 'The document is already cancelled. There is nothing left to do.',
    remediation: {
      description: 'Nothing to stage or approve: the quote or proforma is already cancelled.',
    },
  },
  INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA: {
    httpStatus: 400,
    message_sv: 'Bara offerter och proformafakturor kan makuleras. Ta bort ett utkast eller kreditera en skickad faktura.',
    message_en: 'Only quotes and proforma invoices can be cancelled. Delete a draft or credit an issued invoice.',
  },
  INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Fakturan kunde inte hittas.',
    message_en: 'Invoice not found.',
  },
  // Files emailed with an invoice after its PDF (crm#1269,
  // lib/invoices/invoice-attachments.ts). They change only on a draft that
  // has never been emailed; afterwards they are part of what the customer
  // received and stay with the invoice.
  INVOICE_ATTACHMENTS_FIXED: {
    httpStatus: 409,
    message_sv: 'Bilagorna kan inte ändras när fakturan har skickats. De sparas tillsammans med fakturan enligt bokföringslagen.',
    message_en: 'Attachments cannot change once the invoice has been sent. They are kept with the invoice under the Swedish Bookkeeping Act.',
  },
  INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Underlaget hittades inte i företagets arkiv.',
    message_en: 'The document was not found in this company\'s archive.',
    remediation: {
      description: 'Pass the id of a current document of the same company: upload the file first, or find its id among the company\'s documents.',
    },
  },
  INVOICE_ATTACHMENT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Filen är inte bifogad till fakturan.',
    message_en: 'The file is not attached to this invoice.',
  },
  INVOICE_ATTACHMENTS_TOO_MANY: {
    httpStatus: 400,
    message_sv: 'En faktura kan ha högst 10 bilagor.',
    message_en: 'An invoice can have at most 10 attachments.',
  },
  INVOICE_ATTACHMENTS_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Bilagorna får vara högst 25 MB tillsammans. Ta bort en bilaga eller komprimera filen och försök igen.',
    message_en: 'Attachments may total at most 25 MB. Remove an attachment or compress the file and try again.',
  },
  INVOICE_ATTACHMENT_LOAD_FAILED: {
    httpStatus: 503,
    message_sv: 'En bilaga kunde inte hämtas från arkivet. Fakturan skickades inte, försök igen om en stund.',
    message_en: 'An attachment could not be read from the archive. The invoice was not sent; try again shortly.',
    retryable: true,
  },
  // Underlag behind an invoice (accounted#42, lib/invoices/invoice-underlag.ts):
  // archived documents the invoice rests on, linked by reference and never sent.
  INVOICE_UNDERLAG_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Dokumentet är inte underlag till fakturan.',
    message_en: 'The document is not underlag of this invoice.',
  },
  INVOICE_UNDERLAG_TOO_MANY: {
    httpStatus: 400,
    message_sv: 'En faktura kan ha högst 100 underlag.',
    message_en: 'An invoice can rest on at most 100 documents.',
  },
  INVOICE_UNDERLAG_UNAVAILABLE: {
    httpStatus: 503,
    message_sv: 'Underlag till fakturor går inte att ändra just nu. Försök igen om en stund.',
    message_en: 'Invoice underlag cannot be changed right now. Try again shortly.',
    retryable: true,
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
  // "Skapa faktura nu" lost the run claim to another run of the same schedule
  // (another tab, or the hourly cron): nothing was created by this request.
  RECURRING_RUN_IN_PROGRESS: {
    httpStatus: 409,
    message_sv:
      'En faktura skapas redan från det här schemat. Ingen ny faktura skapades. Ladda om sidan och se om fakturan finns innan du försöker igen.',
    message_en:
      'An invoice is already being created from this schedule. No new invoice was created. Reload and check for the invoice before trying again.',
  },
  // "Skapa faktura nu" stopped with its invoice in place, or possibly in
  // place (lib/invoices/recurring-schedule-run.ts): a retry could bill the
  // period twice, so the person checks first. A schedule left waiting for a
  // person shows a note that says what to do next; one whose record landed
  // shows none, hence the condition.
  RECURRING_RUN_INVOICE_KEPT: {
    httpStatus: 500,
    message_sv:
      'Fakturan kan ha skapats, men körningen kunde inte slutföras. Kontrollera bland fakturorna om den finns innan du försöker igen. Visar schemat en anvisning, följ den.',
    message_en:
      'The invoice may have been created, but the run could not be completed. Check your invoices for it before trying again. If the schedule shows a note, follow it.',
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
  // Digital mailboxes (Kivra, Billo): /api/digital-mailboxes/* and
  // POST /api/invoices/{id}/digital-mailbox/send (src/lib/digital-mailboxes).
  DIGITAL_MAILBOX_UNKNOWN_PROVIDER: {
    httpStatus: 404,
    message_sv: 'Den digitala brevlådan finns inte. Välj Kivra eller Billo.',
    message_en: 'Unknown digital mailbox provider. Use kivra or billo.',
  },
  DIGITAL_MAILBOX_NOT_CONFIGURED: {
    httpStatus: 503,
    message_sv: 'Den digitala brevlådan är inte aktiverad i den här miljön.',
    message_en: 'This digital mailbox provider is not configured in this environment.',
  },
  DIGITAL_MAILBOX_SANDBOX: {
    httpStatus: 403,
    message_sv: 'Demoföretaget kan inte kopplas till en riktig digital brevlåda.',
    message_en: 'The demo company cannot be connected to a real digital mailbox.',
  },
  DIGITAL_MAILBOX_ORG_NUMBER_MISSING: {
    httpStatus: 400,
    message_sv: 'Lägg in företagets namn och organisationsnummer under Inställningar först.',
    message_en: 'Add the company name and organisation number under Settings first.',
  },
  DIGITAL_MAILBOX_SOLE_TRADER_UNSUPPORTED: {
    httpStatus: 400,
    message_sv: 'Kivra och Billo har ingen företagsbrevlåda för enskild firma. Dokument från din privata brevlåda kan du ladda upp eller dela till Accounted.',
    message_en: 'Kivra and Billo have no business mailbox for a sole trader. Upload or share documents from your private mailbox instead.',
  },
  DIGITAL_MAILBOX_ADDRESS_MISSING: {
    httpStatus: 400,
    message_sv: 'Billo behöver företagets adress. Lägg in gatuadress, postnummer och ort under Inställningar.',
    message_en: 'Billo needs the company address. Add street address, postal code and city under Settings.',
  },
  DIGITAL_MAILBOX_EMPLOYER_CONTACT_MISSING: {
    httpStatus: 400,
    message_sv: 'Kivra visar arbetsgivarens adress, e-post och telefonnummer på lönebeskedet. Lägg in dem under Inställningar och skicka igen.',
    message_en: 'Kivra shows the employer address, email and phone number on the payslip. Add them under Settings and send again.',
  },
  DIGITAL_MAILBOX_BANKID_REQUIRED: {
    httpStatus: 403,
    message_sv: 'Billo behöver en företrädare som har loggat in med BankID. Logga in med BankID och försök igen.',
    message_en: 'Billo needs a representative who has signed in with BankID. Sign in with BankID and try again.',
  },
  // Kivra receive: lib/digital-mailboxes/connect.ts, kivraOwnershipRefusal.
  DIGITAL_MAILBOX_SIGNATORY_BANKID_REQUIRED: {
    httpStatus: 403,
    message_sv:
      'Kivra-brevlådan får bara kopplas av en firmatecknare för företaget, och det ser vi när du loggar in med BankID. Koppla BankID under Inställningar om du inte har gjort det, logga sedan in med BankID och försök igen.',
    message_en:
      'Only a signatory of the company may connect the Kivra mailbox, and we see that when you sign in with BankID. Link BankID under Settings if you have not, then sign in with BankID and try again.',
  },
  DIGITAL_MAILBOX_NOT_SIGNATORY: {
    httpStatus: 403,
    message_sv:
      'Enligt Bolagsverket, som vi läste när du senast loggade in med BankID, är du inte firmatecknare för företaget. Be en styrelseledamot, vd eller annan firmatecknare att koppla Kivra-brevlådan. Har du nyss blivit firmatecknare: logga in med BankID igen.',
    message_en:
      'The companies register, read at your last BankID sign-in, does not list you as a signatory of the company. Ask a board member, the managing director or another signatory to connect the Kivra mailbox. Just became one: sign in with BankID again.',
  },
  DIGITAL_MAILBOX_ORG_NUMBER_SHARED: {
    httpStatus: 409,
    message_sv:
      'Ett annat företag i Accounted har samma organisationsnummer, så Kivra-brevlådan kan inte kopplas. Arkivera det företag ni inte använder, eller kontakta oss så hjälper vi till.',
    message_en:
      'Another company in Accounted has the same organisation number, so the Kivra mailbox cannot be connected. Archive the company you do not use, or contact us and we will help.',
  },
  DIGITAL_MAILBOX_ALREADY_CONNECTED: {
    httpStatus: 409,
    message_sv: 'Brevlådan är redan kopplad till Accounted.',
    message_en: 'The mailbox is already connected to Accounted.',
  },
  DIGITAL_MAILBOX_ALREADY_ENROLLED_ELSEWHERE: {
    httpStatus: 409,
    message_sv: 'Företagets Billo-brevlåda är redan kopplad till en annan tjänst. Koppla bort den där först.',
    message_en: 'The company\'s Billo mailbox is already connected to another partner. Disconnect it there first.',
  },
  DIGITAL_MAILBOX_SENDER_ELSEWHERE: {
    httpStatus: 409,
    message_sv: 'Företaget skickar redan via Kivra genom en annan tjänst, och Kivra tog inte emot vår förfrågan om att Accounted också får skicka. Kontakta oss så löser vi det.',
    message_en: 'The company already sends through Kivra via another service, and Kivra did not take our request for Accounted to send too. Contact us and we will sort it out.',
  },
  DIGITAL_MAILBOX_SENDER_REQUEST_REJECTED: {
    httpStatus: 409,
    message_sv: 'Kivra nekade att Accounted skickar för företaget, eftersom det redan skickar via en annan tjänst. Kontakta oss så hjälper vi till.',
    message_en: 'Kivra declined to let Accounted send for the company, since it already sends through another service. Contact us and we will help.',
  },
  DIGITAL_MAILBOX_PROVIDER_FAILED: {
    httpStatus: 502,
    message_sv: 'Den digitala brevlådan svarade inte som väntat. Försök igen om en stund.',
    message_en: 'The digital mailbox provider did not answer as expected. Try again shortly.',
    retryable: true,
  },
  DIGITAL_MAILBOX_NOT_CONNECTED: {
    httpStatus: 409,
    message_sv: 'Brevlådan är inte kopplad ännu.',
    message_en: 'The mailbox is not connected yet.',
  },
  DIGITAL_MAILBOX_INBOX_UNAVAILABLE: {
    httpStatus: 503,
    message_sv: 'Inkorgen är inte aktiverad i den här miljön, så brevlådan kan inte läsas in.',
    message_en: 'The inbox is not enabled in this environment, so the mailbox cannot be read.',
  },
  DIGITAL_MAILBOX_SENDING_NOT_ACTIVE: {
    httpStatus: 409,
    message_sv: 'Aktivera utskick via den digitala brevlådan först.',
    message_en: 'Activate sending through this digital mailbox first.',
  },
  DIGITAL_MAILBOX_INVOICE_NOT_SENDABLE: {
    httpStatus: 409,
    message_sv: 'Bara fakturor kan skickas till en digital brevlåda: inte kreditfakturor, offerter, proformafakturor eller följesedlar, och inte makulerade fakturor.',
    message_en: 'Only invoices can be sent to a digital mailbox: not credit notes, quotes, proformas or delivery notes, and not cancelled invoices.',
  },
  DIGITAL_MAILBOX_CURRENCY_UNSUPPORTED: {
    httpStatus: 422,
    message_sv: 'Digitala brevlådor tar bara emot fakturor i svenska kronor.',
    message_en: 'Digital mailboxes accept invoices in SEK only.',
  },
  DIGITAL_MAILBOX_RECIPIENT_UNIDENTIFIED: {
    httpStatus: 422,
    message_sv: 'Kunden saknar organisationsnummer (företag) eller personnummer (privatperson), så fakturan kan inte adresseras till en digital brevlåda.',
    message_en: 'The customer has no organisation number (business) or personal identity number (private person), so the invoice cannot be addressed to a digital mailbox.',
  },
  DIGITAL_MAILBOX_RECIPIENT_NOT_REACHABLE: {
    httpStatus: 422,
    message_sv: 'Mottagaren har ingen brevlåda som tar emot från ert företag. Skicka fakturan på annat sätt.',
    message_en: 'The recipient has no mailbox that accepts content from your company. Deliver the invoice another way.',
  },
  DIGITAL_MAILBOX_DOCUMENT_TOO_LARGE: {
    httpStatus: 413,
    message_sv: 'Fakturans PDF är för stor för den digitala brevlådan. Ta bort bilagor eller en stor logotyp och försök igen.',
    message_en: 'The invoice PDF is too large for the digital mailbox. Remove attachments or a large logo and try again.',
  },
  DIGITAL_MAILBOX_SEND_FAILED: {
    httpStatus: 502,
    message_sv: 'Fakturan kunde inte levereras till den digitala brevlådan. Fakturan är utfärdad: försök skicka igen.',
    message_en: 'The invoice could not be delivered to the digital mailbox. The invoice is issued: try sending again.',
    retryable: true,
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
    message_sv: 'Bolaget har nått månadens gräns för Peppol-fakturor. Gränsen nollställs den 1:a nästa månad.',
    message_en: "The company has reached this month's Peppol invoice limit. It resets on the 1st of next month.",
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
  // Not permanent: it clears once the other access point withdraws the id,
  // which every company moving from another operator waits for. Retryable so
  // the settings page offers the retry; the inbound cron also retries daily.
  CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE: {
    httpStatus: 409,
    message_sv: 'Peppol-id:t är redan publicerat hos en annan operatör. Avregistrera det där först och försök sedan igen.',
    message_en: 'The Peppol id is already published with another access point. Deregister it there first, then try again.',
    retryable: true,
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
  // The attest policy (lib/supplier-invoices/attest-policy.ts).
  ATTEST_NOT_ALLOWED: {
    httpStatus: 403,
    message_sv: 'Du kan inte attestera den här fakturan. Företagets attestregler bestämmer vem som attesterar, och den som registrerade fakturan attesterar den inte själv.',
    message_en: 'You may not attest this invoice. The company\'s attest policy decides who attests, and the person who registered the invoice does not attest it.',
    remediation: {
      description: 'Ask one of the attesters named by gnubok_get_attest_policy (GET /supplier-invoices/attest-policy) to attest the invoice.',
      tool: 'gnubok_get_attest_policy',
    },
  },
  ATTEST_ALREADY_GIVEN: {
    httpStatus: 409,
    message_sv: 'Du har redan attesterat fakturan. Den väntar på de andra attestanterna.',
    message_en: 'You have already attested this invoice. It waits for the other attesters.',
  },
  // Attest levels (#135): a limit per person, two attesters from an amount.
  ATTEST_LIMIT_EXCEEDED: {
    httpStatus: 403,
    message_sv:
      'Din attestgräns räcker inte för fakturans belopp, och fakturan behöver nu attest av någon vars gräns gör det. Via en API-nyckel gäller den lägre av din gräns och nyckelns gräns för obevakade åtgärder.',
    message_en:
      'Your attest limit does not cover the invoice amount, and the invoice now needs attest by someone whose limit does. Through an API key, the lower of your limit and the key\'s unattended limit applies.',
    remediation: {
      description:
        'Ask an attester whose limit covers the amount (GET /supplier-invoices/{id}/attestations names them under remaining), or attest it in the app if the key capped it.',
      tool: 'gnubok_get_attest_policy',
    },
  },
  ATTEST_POLICY_TWO_STEP_NEEDS_TWO: {
    httpStatus: 400,
    message_sv: 'Två attestanter från ett belopp kräver minst två attestanter.',
    message_en: 'Two attesters from an amount needs at least two attesters.',
  },
  ATTEST_LIMIT_NOT_ATTESTER: {
    httpStatus: 400,
    message_sv: 'En attestgräns kan bara sättas för någon som är attestant.',
    message_en: 'An attest limit can only be set for an attester.',
  },
  ATTEST_NOT_PENDING: {
    httpStatus: 409,
    message_sv: 'Fakturan väntar inte på attest.',
    message_en: 'The invoice is not waiting for attest.',
  },
  ATTEST_POLICY_NO_ATTESTERS: {
    httpStatus: 400,
    message_sv: 'Välj minst en attestant innan attestreglerna slås på.',
    message_en: 'Choose at least one attester before switching the attest policy on.',
  },
  ATTEST_POLICY_ATTESTER_NOT_MEMBER: {
    httpStatus: 400,
    message_sv: 'En attestant måste vara medlem i företaget: ägare, administratör, medlem eller med läsbehörighet.',
    message_en: 'An attester must be a member of the company: owner, admin, member or viewer.',
  },
  // Ordered steps and substitutes (#192).
  ATTEST_PROJECT_NOT_FOUND: {
    httpStatus: 400,
    message_sv: 'Projektet finns inte bland företagets projekt (dimension 6). Lägg upp det under Dimensioner först.',
    message_en: 'The project is not one of the company\'s projects (dimension 6). Add it under Dimensions first.',
  },
  ATTEST_SUBSTITUTE_NOT_MEMBER: {
    httpStatus: 400,
    message_sv: 'En ersättare måste vara medlem i företaget: ägare, administratör, medlem eller med läsbehörighet.',
    message_en: 'A substitute must be a member of the company: owner, admin, member or viewer.',
  },
  ATTEST_SUBSTITUTE_NO_POLICY: {
    httpStatus: 409,
    message_sv: 'Spara attestreglerna innan du väljer en ersättare.',
    message_en: 'Save the attest policy before choosing a substitute.',
  },
  ATTEST_SUBSTITUTE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Ersättaren finns inte, eller har redan tagits bort.',
    message_en: 'The substitute does not exist, or was already removed.',
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
  // Lock, close or klarmarkera of a year an SIE import or its undo still holds
  // (assertNoUnfinishedSieImport in lib/core/bookkeeping/period-service.ts;
  // the database refuses it too, guard_sie_period_hold). The thrower names
  // the year; the remediation carries the import id when it is known.
  PERIOD_HAS_UNFINISHED_SIE_IMPORT: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsåret har en SIE-import som inte är klar. Slutför eller ångra importen först och försök sedan igen.',
    message_en:
      'An SIE import, or the undo of one, still holds this fiscal year. Finish or undo it first, then retry.',
    retryable: false,
    remediation: {
      description:
        'Read the import\'s state with gnubok_sie_import_status; resuming or undoing it is the user\'s decision. Retry once it is completed or undone. Never lock first: a lock stops the import\'s own writes.',
      tool: 'gnubok_sie_import_status',
    },
    thrown_message_sv: true,
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
  // Both refusals end where TARGET_PERIOD_CLOSED does for a year closed with
  // a year-end run here: the owner reopens it under Räkenskapsår while the
  // årsredovisning has no legal weight, otherwise corrections go into the
  // open year (crm#1290).
  PERIOD_UNLOCK_CLOSED: {
    httpStatus: 409,
    message_sv: 'Ett stängt räkenskapsår kan inte låsas upp, men det kan öppnas igen under Inställningar → Bokföring → Räkenskapsår. Ett år som klarmarkerats i ett tidigare program öppnas av ägare eller administratör; ett år som stängts med bokslut i Accounted öppnas av företagets ägare så länge årsredovisningen inte är undertecknad, fastställd eller inskickad. Annars bokför du rättelser som nya verifikat i det öppna räkenskapsåret.',
    message_en: 'A closed fiscal year cannot be unlocked, but it can be reopened under Settings → Bookkeeping → Fiscal years. An owner or admin reopens a year marked as closed in a previous system; the company owner reopens a year closed with a year-end closing in Accounted, as long as the annual report has not been signed, adopted or filed. Otherwise, post corrections as new vouchers in the open fiscal year.',
    remediation: {
      description:
        'A year marked closed in a previous system (closed_externally, no closing entry): reopen it with gnubok_reopen_fiscal_period_external. A year closed by a year-end run here: ask the user whether its årsredovisning has been signed, adopted or filed. Not signed, adopted or filed: the company owner reopens it in the app under Inställningar → Bokföring → Räkenskapsår (no API or MCP door). Signed, adopted or filed: book corrections as new verifikationer dated in the open fiscal year (rättelse av fel, K2 punkt 2.12).',
      tool: 'gnubok_list_fiscal_periods',
    },
  },
  PERIOD_REOPEN_NOT_CLOSED: {
    httpStatus: 409,
    message_sv: 'Räkenskapsåret är inte stängt.',
    message_en: 'Fiscal year is not closed.',
  },
  PERIOD_REOPEN_NOT_EXTERNAL: {
    httpStatus: 409,
    message_sv: 'Räkenskapsåret stängdes med ett bokslut i Accounted och öppnas inte som ett klarmarkerat år. Är årsredovisningen inte undertecknad, fastställd eller inskickad kan företagets ägare öppna det igen under Inställningar → Bokföring → Räkenskapsår; annars bokför du rättelser som nya verifikat i det öppna räkenskapsåret.',
    message_en: 'The fiscal year was closed with a year-end run in Accounted and is not reopened as a year marked closed elsewhere. If the annual report has not been signed, adopted or filed, the company owner can reopen it under Settings → Bookkeeping → Fiscal years; otherwise, post corrections as new vouchers in the open fiscal year.',
  },
  // Creating and editing a räkenskapsår (lib/core/bookkeeping/fiscal-year-service.ts,
  // operations fiscal-periods.create / .update). The shape rules are BFL 3 kap.
  // Codes flagged thrown_message_sv carry a Swedish sentence naming the dates
  // or the neighbouring year; details carry the same facts for agents.
  // message_en is what the fiscal-year dialog shows an English UI, so it is
  // written for a person; where details hold the facts, the remediation says
  // so for agents (accounted#18).
  FISCAL_PERIOD_INVALID_DATES: {
    httpStatus: 400,
    thrown_message_sv: true,
    message_sv: 'Räkenskapsårets datum är ogiltiga: slutdatumet måste ligga efter startdatumet.',
    message_en: 'The fiscal year dates are invalid: the end date must be after the start date.',
    remediation: { description: 'details.rule names the rule the dates broke.' },
  },
  FISCAL_PERIOD_START_NOT_FIRST_OF_MONTH: {
    httpStatus: 400,
    message_sv:
      'Räkenskapsåret måste börja den 1:a i en månad. Bara företagets första räkenskapsår får börja mitt i en månad (BFL 3 kap. 1 och 3 §§).',
    message_en:
      "The fiscal year must start on the 1st of a month: only the company's first fiscal year may start mid-month (BFL 3 kap. 1 and 3 §§).",
  },
  FISCAL_PERIOD_END_NOT_MONTH_END: {
    httpStatus: 400,
    message_sv: 'Räkenskapsåret måste sluta på sista dagen i en månad (BFL 3 kap.).',
    message_en: 'The fiscal year must end on the last day of a month (BFL 3 kap.).',
  },
  FISCAL_PERIOD_TOO_LONG: {
    httpStatus: 400,
    thrown_message_sv: true,
    message_sv: 'Ett räkenskapsår får vara högst 18 månader (BFL 3 kap.).',
    message_en: 'A fiscal year may be at most 18 months (BFL 3 kap.).',
    remediation: {
      description:
        'details.months holds the length requested. One year cannot close a gap between two recorded years that is longer than 18 months: create a year of normal length (12 months) starting on details.expected_start, then the next one, until the last one ends on details.gap_end. The message names both dates.',
    },
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
      'Fiscal years must follow each other without a gap: a year starts the day after the previous one ends.',
    remediation: {
      description:
        'A new year starts the day after the preceding year ends, and one that fills a gap of at most 18 months also ends the day before the following year starts. details.expected_start / details.expected_end hold the date that fits; the message names it. A gap longer than 18 months is filled one year at a time from its oldest end: create a year of normal length (12 months) starting on details.expected_start, then the next one, until the last one ends on details.gap_end.',
    },
  },
  FISCAL_PERIOD_OVERLAP: {
    httpStatus: 409,
    thrown_message_sv: true,
    message_sv: 'Räkenskapsåret överlappar ett befintligt räkenskapsår.',
    message_en: 'The fiscal year overlaps an existing fiscal year.',
    remediation: {
      description:
        'details.overlapping_period_id / overlapping_period_name name the year it overlaps. List the existing years with GET /fiscal-periods (gnubok_list_fiscal_periods) and choose dates that do not overlap any of them.',
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
  // redate_fiscal_period (crm#1010): a year that holds verifikat may move a
  // boundary over days that hold nothing; anything the move would affect
  // refuses it. The Swedish sentence names every blocker.
  FISCAL_PERIOD_DATES_BLOCKED: {
    httpStatus: 409,
    thrown_message_sv: true,
    message_sv:
      'Datumen kan inte ändras: något i räkenskapsåret skulle påverkas. Namnet kan fortfarande ändras.',
    message_en:
      'The dates cannot be changed: something in the fiscal year would be affected. The name can still be changed.',
    remediation: {
      description:
        'details.blockers lists each reason (code, message_sv and its facts): entries_outside / drafts_outside (verifikat or drafts dated outside the new dates), other_year_entries, budget_months_outside (a budget holds amounts for months the new dates leave out; message_sv names it), opening_balance (posted opening balances pin the start), period_locked, period_closed, company_lock_date, sie_import_hold, opening_balance_review, year_end_entries, kontantmetod_cutoff, depreciation_posted, tax_depreciation, annual_report, tax_assessment, annual_filing, plus the BFL 3 kap. shape and chain rules. Send only name to rename.',
    },
  },
  // crm#1450: only the company's first räkenskapsår, and only while it holds
  // nothing, can be removed. The Swedish sentence names every blocker.
  FISCAL_PERIOD_DELETE_BLOCKED: {
    httpStatus: 409,
    thrown_message_sv: true,
    message_sv: 'Räkenskapsåret kan inte tas bort: bara ett tomt första räkenskapsår kan tas bort.',
    message_en: 'The fiscal year cannot be removed: only an empty first fiscal year can be removed.',
    remediation: {
      description:
        'details.blockers lists each reason (code, message_sv): not_first_year, only_year, period_closed, period_locked, company_lock_date, sie_import_hold, opening_balance_review, has_entries (any verifikat or draft), voucher_numbers_issued, sie_import, linked_records (tables), annual_filing.',
    },
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
  // The owner's reopen of a year closed with a bokslut (crm#1290,
  // lib/core/bookkeeping/fiscal-year-reopen.ts). INELIGIBLE carries the
  // blockers in details; the dialog names each one.
  FISCAL_YEAR_REOPEN_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsåret kunde inte hittas.',
    message_en: 'Fiscal year not found.',
  },
  FISCAL_YEAR_REOPEN_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Bara företagets ägare kan öppna ett stängt räkenskapsår igen.',
    message_en: 'Only the company owner can reopen a closed fiscal year.',
  },
  FISCAL_YEAR_REOPEN_INELIGIBLE: {
    httpStatus: 409,
    message_sv: 'Räkenskapsåret kan inte öppnas igen i sitt nuvarande läge. Inget har ändrats.',
    message_en: 'The fiscal year cannot be reopened in its current state. Nothing was changed.',
  },
  FISCAL_YEAR_REOPEN_CONFIRMATION_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Bekräfta att årsredovisningen inte är undertecknad, fastställd eller inskickad. Inget har ändrats.',
    message_en: 'Confirm that the annual report has not been signed, adopted or filed. Nothing was changed.',
  },
  FISCAL_YEAR_REOPEN_CONFIRMATION_MISMATCH: {
    httpStatus: 400,
    message_sv: 'Räkenskapsårets namn stämmer inte överens. Inget har ändrats.',
    message_en: 'The fiscal year name does not match. Nothing was changed.',
  },
  FISCAL_YEAR_REOPEN_INCOMPLETE: {
    httpStatus: 500,
    retryable: true,
    message_sv: 'Räkenskapsåret är öppnat, men bokslutet kunde inte återföras helt. Öppna året igen en gång till: det fortsätter där det stannade.',
    message_en: 'The fiscal year is open, but the year-end closing could not be fully reversed. Reopen it once more: it continues where it stopped.',
  },
  FISCAL_YEAR_REOPEN_FAILED: {
    httpStatus: 500,
    message_sv: 'Räkenskapsåret kunde inte öppnas igen. Inget har ändrats.',
    message_en: 'The fiscal year could not be reopened. Nothing was changed.',
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
  // gnubok_run_year_end refused at staging: the company lock date
  // (company_settings.bookkeeping_locked_through) covers the year's last day,
  // where the closing entry is posted. Readiness says the same as the blocker
  // COMPANY_LOCK_DATE (lib/core/bookkeeping/year-end-service.ts).
  YEAR_END_COMPANY_LOCK_DATE: {
    httpStatus: 409,
    message_sv:
      'Bokföringens låsdatum täcker räkenskapsårets sista dag, där bokslutet bokförs. Flytta först tillbaka låsdatumet under Inställningar → Bokföring. Om automatisk låsning är på: stäng av den medan bokslutet görs, annars kan datumet låsas igen nästa natt.',
    message_en:
      'The company lock date covers the last day of the fiscal year, where the year-end closing is posted. Move the lock date back first under Settings → Bookkeeping. If automatic locking is on, turn it off while the closing is done: otherwise the date can be locked again the next night.',
    retryable: false,
    remediation: {
      description:
        'Tell the user why, then stage gnubok_update_bookkeeping_lock with bookkeeping_locked_through before the period end (or null). When auto_lock_period_days is set, send auto_lock_period_days: null in the same call: the automatic lock can move the date forward again the next night. After approval, run gnubok_year_end_readiness again. The user can turn automatic locking back on once the year is closed.',
      tool: 'gnubok_update_bookkeeping_lock',
    },
  },
  YEAR_END_NO_ACTIVITY: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsperioden saknar bokförd aktivitet och kan därför inte skapa en bokslutsverifikation. Bokför eller importera periodens affärshändelser innan du kör bokslutet.',
    message_en:
      'The fiscal period has no posted activity, so no year-end voucher can be created. Post or import the period activity before running year-end closing.',
    retryable: false,
  },
  // Interim block (#3442), lifted when the per-invoice cut-off (årsomföring,
  // #3440) shipped: nothing raises it any more. The code stays registered:
  // agents pattern-match on codes, and a cut-off operation staged while it
  // was suspended may still have recorded it.
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
  // A voucher gap explanation is write-once (lib/core/bookkeeping/voucher-gaps.ts):
  // a second one for the same gap would overwrite the first without a trace.
  VOUCHER_GAP_ALREADY_EXPLAINED: {
    httpStatus: 409,
    message_sv: 'Luckan i verifikationsserien har redan en förklaring. En sparad förklaring kan inte ändras.',
    message_en: 'This voucher number gap already has an explanation; an explanation is write-once.',
    retryable: false,
  },
  // Pågående arbeten under K3 kapitel 23 (lib/bokslut/pagaende-arbeten),
  // behind NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED.
  CONTRACT_REVENUE_DISABLED: {
    httpStatus: 503,
    message_sv: 'Pågående arbeten finns inte här ännu.',
    message_en: 'Work in progress is not available here yet.',
  },
  CONTRACT_REVENUE_NOT_CONFIGURED: {
    httpStatus: 409,
    message_sv: 'Välj först metod och intäktskonto för pågående arbeten.',
    message_en: 'First choose the method and the revenue account for work in progress.',
  },
  CONTRACT_REVENUE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Uppdraget hittades inte.',
    message_en: 'The contract was not found.',
  },
  CONTRACT_REVENUE_NO_PERIOD: {
    httpStatus: 404,
    message_sv: 'Räkenskapsåret hittades inte.',
    message_en: 'The financial year was not found.',
  },
  CONTRACT_REVENUE_FIGURES_DATE: {
    httpStatus: 409,
    message_sv: 'Alla uppdrag ska ha siffror per balansdagen innan året bokförs.',
    message_en: 'Every contract needs figures as of the balance sheet date before the year is booked.',
  },
  CONTRACT_REVENUE_INCOMPLETE: {
    httpStatus: 409,
    message_sv: 'Uppgifter saknas för ett uppdrag, till exempel färdigställandegraden eller det upparbetade värdet.',
    message_en: 'A contract is missing figures, such as the stage of completion or the value of work performed.',
  },
  CONTRACT_REVENUE_ACCOUNT_MISSING: {
    httpStatus: 404,
    message_sv: 'Kontot finns inte i kontoplanen. Lägg till det först.',
    message_en: 'The account is not in the chart of accounts. Add it first.',
  },
  CONTRACT_REVENUE_ACCOUNT_VAT: {
    httpStatus: 409,
    message_sv: 'Kontot ingår i momsdeklarationen eller har en momskod eller momssats. Välj ett intäktskonto utan moms för de upparbetade intäkterna.',
    message_en: 'The account is part of the VAT return or has a VAT code or rate. Choose a revenue account without VAT for the earned revenue.',
  },
  CONTRACT_REVENUE_ACCOUNT_IN_USE: {
    httpStatus: 409,
    message_sv: 'Kontot har redan bokförda rader för annat än pågående arbeten. Välj ett konto som bara används för de upparbetade intäkterna.',
    message_en: 'The account already has posted lines for other things than work in progress. Choose an account used only for the earned revenue.',
  },
  CONTRACT_REVENUE_NOT_K3: {
    httpStatus: 409,
    message_sv: 'Pågående arbeten bokförs här enligt K3 kapitel 23, och räkenskapsåret upprättas inte enligt K3.',
    message_en: 'Work in progress is booked here under K3 chapter 23, and the financial year is not prepared under K3.',
  },
  CONTRACT_REVENUE_LATER_YEAR_BOOKED: {
    httpStatus: 409,
    message_sv: 'Pågående arbeten är redan bokförda för ett senare räkenskapsår, och de bygger på det här årets saldo. Gör storno på det årets verifikat innan det här året bokförs.',
    message_en: 'Work in progress is already booked for a later financial year, which builds on this year\'s balance. Reverse that year\'s voucher before booking this year.',
  },
  CONTRACT_REVENUE_STALE: {
    httpStatus: 409,
    message_sv: 'Pågående arbeten ändrades medan året bokfördes, till exempel av en annan bokning. Ladda om sidan och försök igen.',
    message_en: 'Work in progress changed while the year was being booked, for example by another booking. Reload the page and try again.',
  },
}

const FX: Record<string, StructuredErrorEntry> = {
  // A staged foreign-currency operation (bank row, invoice, supplier invoice)
  // whose rate lookup was rate-limited or failed at Riksbanken. The rate
  // exists; it could not be fetched right now. The operation is handed back
  // to 'pending' (never consumed, never written at 1:1), so the remedy is to
  // approve the SAME operation again, not to stage it again.
  FX_RATE_TEMPORARILY_UNAVAILABLE: {
    httpStatus: 503,
    message_sv:
      'Riksbanken svarar inte just nu, så växelkursen kunde inte hämtas. Inget har bokförts och åtgärden ligger kvar: godkänn den igen om en stund.',
    message_en:
      'Riksbanken rate-limited or failed the exchange rate request. Nothing was written and the operation is still pending.',
    retryable: true,
    remediation: {
      description:
        'Wait about a minute and approve the same pending operation again. Do not stage it again, and do not replace the rate with an estimate.',
    },
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
  FX_MONTHLY_REVALUATION_DISABLED: {
    httpStatus: 503,
    message_sv: 'Valutaomvärdering per månadsskifte är inte tillgänglig här ännu.',
    message_en: 'Month-end currency revaluation is not available here yet.',
  },
  FX_MONTHLY_REVALUATION_NOT_ENABLED: {
    httpStatus: 409,
    message_sv: 'Välj valutaomvärdering per månadsskifte under Inställningar, Bokföring först.',
    message_en: 'Choose month-end currency revaluation under Settings, Bookkeeping first.',
  },
  FX_MONTHLY_REVALUATION_DATE_INVALID: {
    httpStatus: 422,
    message_sv: 'Välj ett månadsskifte före räkenskapsårets sista dag. Balansdagen omvärderas i bokslutet.',
    message_en: 'Choose a month end before the last day of the financial year. The closing date is revalued in the year-end close.',
  },
  FX_MONTHLY_REVALUATION_EXISTS: {
    httpStatus: 409,
    message_sv: 'Valutaomvärdering per det här månadsskiftet är redan bokförd.',
    message_en: 'A currency revaluation for this month end is already booked.',
  },
  FX_MONTHLY_REVALUATION_NO_PERIOD: {
    httpStatus: 404,
    message_sv: 'Inget räkenskapsår omfattar det valda månadsskiftet.',
    message_en: 'No financial year covers the chosen month end.',
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
  // A report whose database functions arrive with a migration that has not
  // reached this database yet: Vercel serves new code up to an hour before
  // CI applies the migration (accounted#133, the dimension cross report).
  REPORT_NOT_READY: {
    httpStatus: 503,
    message_sv: 'Rapporten är inte tillgänglig än. Försök igen om en stund.',
    message_en: 'This report is not available yet. Try again in a while.',
    retryable: true,
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

// Defined measures (lib/measures): a measure that cannot be computed refuses
// with one of these and a Swedish sentence naming what is missing, never a
// zero. The runtime sentence travels as the thrown message.
const MEASURE: Record<string, StructuredErrorEntry> = {
  MEASURE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Måttet finns inte.',
    message_en: 'No measure with this id. details.valid lists the measure ids.',
    remediation: {
      description: 'List the measures (GET /measures, gnubok_list_measures) and send one of their measure_id values.',
      tool: 'gnubok_list_measures',
    },
    retryable: false,
    thrown_message_sv: true,
  },
  MEASURE_PARAMETER_NOT_ACCEPTED: {
    httpStatus: 400,
    message_sv: 'Måttet tar inte den parametern.',
    message_en:
      'The measure does not take a parameter that was sent: details.refused names it and details.accepted lists what the measure takes. It is refused rather than ignored, so the answer is never another figure than the one asked for.',
    retryable: false,
    thrown_message_sv: true,
  },
  MEASURE_PERIOD_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Måttet gäller en momsperiod: ange period_type, year och period.',
    message_en: 'The measure is defined per momsperiod and has no default: send period_type, year and period.',
    retryable: false,
    thrown_message_sv: true,
  },
  MEASURE_PERIOD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Inget räkenskapsår i bokföringen omfattar perioden.',
    message_en:
      'No fiscal period in the books covers the date, or the period_id is not one of the company\'s. Nothing was computed.',
    remediation: {
      description: 'List the fiscal periods (gnubok_list_fiscal_periods, GET /fiscal-periods) and send a date inside one, or its period_id.',
      tool: 'gnubok_list_fiscal_periods',
    },
    retryable: false,
    thrown_message_sv: true,
  },
  MEASURE_RANGE_INVALID: {
    httpStatus: 400,
    message_sv: 'Datumen eller perioden är ogiltiga för måttet.',
    message_en: 'A date or period is malformed, outside its fiscal period, or out of order.',
    retryable: false,
    thrown_message_sv: true,
  },
  MEASURE_ACCOUNT_ROLE_UNAVAILABLE: {
    httpStatus: 422,
    message_sv: 'Måttet kan inte beräknas för bolagets land: kontoplanen saknar ett konto för rollen.',
    message_en:
      'The company\'s jurisdiction pack has no account for an account role the measure needs (lib/bookkeeping/account-roles). Refused rather than read off another country\'s chart.',
    retryable: false,
    thrown_message_sv: true,
  },
  MEASURE_SOURCE_FAILED: {
    httpStatus: 500,
    message_sv: 'Måttet kunde inte beräknas: underlaget gick inte att läsa. Inget värde har räknats fram.',
    message_en:
      'The report the measure equals could not be read, so no value was computed. Not a zero: details.report names the report.',
    retryable: false,
    thrown_message_sv: true,
  },
}

// The unexplained queue (lib/unexplained): a check that cannot run answers
// cannot_check inside the data, never one of these. These refuse only what
// the caller sent wrong. The runtime sentence travels as the thrown message.
const UNEXPLAINED: Record<string, StructuredErrorEntry> = {
  UNEXPLAINED_CHECK_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kontrollen finns inte.',
    message_en: 'No check with this id. details.valid lists the check ids.',
    remediation: {
      description: 'List the queue (GET /unexplained, gnubok_list_unexplained) and send one of its check_id values.',
      tool: 'gnubok_list_unexplained',
    },
    retryable: false,
    thrown_message_sv: true,
  },
  UNEXPLAINED_PARAMETER_NOT_ACCEPTED: {
    httpStatus: 400,
    message_sv: 'Kontrollen tar inte den parametern.',
    message_en:
      'The check does not take a subject parameter that was sent: details.refused names it and details.accepted lists what the check takes. Refused rather than ignored.',
    retryable: false,
    thrown_message_sv: true,
  },
  UNEXPLAINED_SUBJECT_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Kontrollen har flera resultat: ange vilket som ska förklaras.',
    message_en:
      'The check has several results (bank accounts or momsperioder): send the subject, as the explain handle of the queue row gives it. details.subjects lists them.',
    retryable: false,
    thrown_message_sv: true,
  },
  UNEXPLAINED_SUBJECT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kontrollen har inget resultat för det angivna kontot eller den angivna perioden.',
    message_en: 'The check has no result for the subject that was sent. details.subjects lists the ones it has.',
    remediation: {
      description: 'Take the subject from the explain handle of the row in GET /unexplained (gnubok_list_unexplained).',
      tool: 'gnubok_list_unexplained',
    },
    retryable: false,
    thrown_message_sv: true,
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
  // Korrigera on the reverse-charge basis worklist (crm#1096): the route reads
  // the verifikat again at correction time and refuses rather than add a basis
  // the declaration would count twice.
  VAT_RC_BASIS_NOTHING_MISSING: {
    httpStatus: 409,
    message_sv:
      'Verifikationen redovisar redan hela basbeloppet för sin fiktiva moms, så det finns inget att korrigera. ' +
      'Ladda om sidan så uppdateras listan.',
    message_en:
      'The voucher already reports the full basis for its reverse-charge VAT, so there is nothing to correct. ' +
      'Reload the page to refresh the list.',
  },
  VAT_RC_BASIS_RATE_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Verifikationen redovisar redan basbelopp i ruta 20-24, men med en annan momssats än den fiktiva momsen. ' +
      'Rätta momssatsen med rättelse eller storno av verifikationen, eller kontrollera kontots Standard moms i kontoplanen.',
    message_en:
      'The voucher already reports a basis in boxes 20-24, but at another VAT rate than its reverse-charge VAT. ' +
      'Correct the rate by correcting or reversing the voucher, or check the account\'s "Standard moms" in the chart of accounts.',
  },
  VAT_RC_BASIS_ACCOUNT_WITHOUT_RATE: {
    httpStatus: 409,
    message_sv:
      'Verifikationen bokför på ett konto som har en momskod för omvänd skattskyldighet men ingen Standard moms ' +
      'på 25, 12 eller 6 %. Välj samma sats som den fiktiva momsen under Standard moms på kontot i kontoplanen, ' +
      'eller ta bort momskoden om kontot inte ska redovisas i ruta 20-24, och ladda sedan om sidan.',
    message_en:
      'The voucher books on an account with a reverse-charge VAT code but no "Standard moms" (default VAT rate) ' +
      'of 25, 12 or 6 %. Set it to the rate of the reverse-charge VAT in the chart of accounts, or remove the VAT ' +
      'code if the account should not report in boxes 20-24, and reload the page.',
  },
  VAT_RC_BASIS_ACCOUNT_RATE_CONFLICT: {
    httpStatus: 409,
    message_sv:
      'Kontot som basbeloppet ska bokföras på redovisas inte i ruta 20-24 med den fiktiva momsens sats enligt ' +
      'kontoplanen, så det skulle inte täcka den fiktiva momsen. Kontrollera kontots momskod och Standard moms ' +
      'i kontoplanen och ladda sedan om sidan.',
    message_en:
      'The account the basis goes on does not report in boxes 20-24 at the rate of the reverse-charge VAT ' +
      'according to the chart of accounts, so it would not cover that VAT. Check its VAT code and "Standard moms" ' +
      'in the chart of accounts and reload the page.',
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
  AGI_DEADLINE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Företaget har ingen deadline för arbetsgivardeklarationen den månaden.',
    message_en: 'The company has no arbetsgivardeklaration deadline for that month.',
    remediation: {
      description:
        'Check the month (the redovisningsperiod, not the month the deadline falls in). AGI deadlines exist for the months the company is registered as an employer (Inställningar); nothing needs marking for a month without one.',
    },
  },
  AGI_FILING_DATE_IN_FUTURE: {
    httpStatus: 400,
    message_sv: 'Inlämningsdatumet kan inte ligga i framtiden.',
    message_en: 'The filing date cannot be in the future.',
  },
  AGI_FILING_MARK_FAILED: {
    httpStatus: 500,
    message_sv: 'Det gick inte att markera arbetsgivardeklarationen som inlämnad. Försök igen.',
    message_en: 'The AGI period could not be marked as filed.',
    retryable: true,
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
  // Ticking a deadline off or putting it back (lib/deadlines/completion.ts,
  // crm#1848): the dashboard's /deadlines and gnubok_complete_deadline.
  DEADLINE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Deadline hittades inte.',
    message_en: 'Deadline not found.',
    remediation: {
      description:
        'List the deadlines (gnubok_list_deadlines) and use a deadline_id from the answer. A deadline the company removed from its list is not found.',
    },
  },
  DEADLINE_CONFIRMED_BY_SKATTEVERKET: {
    httpStatus: 409,
    message_sv:
      'Deadlinen är klar genom en inlämning med kvittens via Skatteverket-kopplingen och kan inte sättas tillbaka härifrån.',
    message_en:
      'The deadline was completed by a filing Skatteverket confirmed through the connection and cannot be put back from here.',
    remediation: {
      description:
        'Leave it completed. A person can put it back under Deadlines in the app if the confirmation is wrong.',
    },
  },
  // The server-side "Kontroll av underlaget" gate (vatFilingVerdict,
  // lib/reports/vat-close-check.ts) refused: nothing was sent to Skatteverket.
  // A staged submit that meets it at approval is consumed, not released.
  VAT_DECLARATION_INCOMPLETE: {
    httpStatus: 422,
    message_sv:
      'Momsdeklarationen är ofullständig: kontrollen av underlaget hittade fel, så inget skickades till Skatteverket. Åtgärda felen under Kontroll av underlaget och försök igen.',
    message_en:
      'The momsdeklaration is incomplete: the completeness checks found an ERROR, so nothing was sent to Skatteverket. Fix the findings, then submit again.',
    remediation: {
      description:
        'gnubok_vat_declaration_validate (completeness_checks) or gnubok_vat_close_check lists the findings and their fixes. The manual eSKD/PDF filing is not gated.',
      tool: 'gnubok_vat_declaration_validate',
    },
  },
  // Reviewed VAT warnings (lib/vat/check-review-service.ts, crm#1171).
  VAT_CHECK_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Perioden visar inte den varningen längre. Ladda om sidan så uppdateras kontrollen.',
    message_en: 'The period no longer shows that warning. Reload the page to refresh the checks.',
  },
  VAT_CHECK_NOT_REVIEWABLE: {
    httpStatus: 409,
    message_sv:
      'Bara en varning kan markeras som granskad. Ett fel måste rättas i bokföringen, och en kontroll som inte kunde köras finns det inget att granska i.',
    message_en:
      'Only a warning can be marked as reviewed. An error must be fixed in the books, and a check that could not run has nothing to review.',
  },
  VAT_CHECK_CHANGED: {
    httpStatus: 409,
    message_sv: 'Underlaget för varningen har ändrats sedan du såg den. Ladda om sidan och granska den igen.',
    message_en: 'The figures behind the warning have changed since you saw it. Reload the page and review it again.',
  },
  VAT_CHECK_REVIEW_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Varningen är inte markerad som granskad för perioden.',
    message_en: 'The warning is not marked as reviewed for the period.',
  },
  VAT_MARK_NOT_POSTED: {
    httpStatus: 409,
    message_sv: 'Bara ett bokfört verifikat kan markeras som rättelse.',
    message_en: 'Only a posted journal entry can be marked as a correction.',
  },
  VAT_MARK_TAGGED_SETTLEMENT: {
    httpStatus: 409,
    message_sv:
      'Verifikatet är periodens momsredovisning från momssidan. Annullera det i stället om perioden behöver bokföras om.',
    message_en:
      'This journal entry is the VAT settlement booked from the VAT page. Reverse it instead if the period needs to be booked again.',
  },
  VAT_MARK_STORNO: {
    httpStatus: 409,
    message_sv: 'En makulering följer sitt originalverifikat. Markera originalet i stället.',
    message_en: 'A reversal follows its original journal entry. Mark the original instead.',
  },
  VAT_MARK_NOT_SHAPE: {
    httpStatus: 409,
    message_sv:
      'Momsdeklarationen räknar inte verifikatet som momsredovisning, så en markering skulle inte ändra något.',
    message_en:
      'The VAT return does not take this journal entry for a VAT settlement, so a mark would change nothing.',
  },
  VAT_MARK_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv: 'Perioden är stängd eller låst, så verifikatet kan inte markeras om.',
    message_en: 'The period is closed or locked, so the journal entry cannot be marked again.',
  },
  VAT_MARK_PERIOD_FILED: {
    httpStatus: 409,
    message_sv: 'Momsdeklarationen för perioden är redan inlämnad, så verifikatet kan inte markeras om här.',
    message_en: 'The VAT return for the period is already filed, so the journal entry cannot be marked again here.',
  },
  VAT_MARK_NOT_READY: {
    httpStatus: 503,
    message_sv: 'Markeringen håller på att slås på. Försök igen om några minuter.',
    message_en: 'Marking is being switched on. Try again in a few minutes.',
  },
  VAT_MARK_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikatet är inte markerat som rättelse.',
    message_en: 'The journal entry is not marked as a correction.',
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
  FILING_IDENTITY_REFUSED: {
    httpStatus: 422,
    message_sv:
      'Ogiltigt organisationsnummer: numret passar inte företagsformen. Ett aktiebolag eller en förening lämnar in på sitt organisationsnummer, en enskild firma på ägarens personnummer. Rätta numret under Inställningar → Företagsuppgifter. Går det inte att ändra där, kontakta supporten så rättar vi det.',
    message_en:
      "Invalid organisation number: it does not fit the legal form. An aktiebolag or association files on its organisation number, an enskild firma on the owner's personnummer. Correct it under Settings → Company details. If it cannot be changed there, contact support and we will fix it.",
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
  TAX_DECL_NE_SRU_BLOCKED: {
    httpStatus: 422,
    message_sv: 'SRU-filen kan inte laddas ner förrän bokföringen är rättad. Orsaken står i NE-bilagans varningar.',
    message_en: 'The NE-bilaga SRU file is refused until the books are corrected. details.reason and the NE-bilaga warnings name the cause.',
  },
  TAX_DECL_INK2_SRU_BLOCKED: {
    httpStatus: 422,
    message_sv: 'SRU-filen kan inte laddas ner förrän deklarationen stämmer med bokföringen. Orsaken står i INK2-deklarationens varningar.',
    message_en: 'The INK2 SRU file is refused until the declaration ties to the books. details.reason and the INK2 warnings name the cause.',
  },
  // INK3 underlag for ideell förening (lib/reports/ink3, product decisions on #47).
  TAX_DECL_INK3_WRONG_LEGAL_FORM: {
    httpStatus: 400,
    message_sv: 'INK3-underlaget gäller bara ideella föreningar.',
    message_en: 'The INK3 underlag is only for an ideell förening.',
  },
  TAX_DECL_INK3_PERIOD_NOT_SUPPORTED: {
    httpStatus: 422,
    // The refusal names the räkenskapsår's period and the pinned ones.
    thrown_message_sv: true,
    message_sv:
      'Skatteverkets fältkoder för räkenskapsårets beskattningsperiod är inte inlagda, så INK3-underlaget kan inte tas fram för det året.',
    message_en:
      "Skatteverket's INK3 field codes for this räkenskapsår's beskattningsperiod are not pinned, so the underlag is refused rather than guessed. details names the period and the supported ones.",
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
      'Momsen för perioden är redan bokförd. Om perioden behöver bokföras om, återför först varje momsredovisning som är bokförd för den.',
    message_en:
      'The VAT for this period is already booked. If the period needs to be booked again, first reverse every VAT settlement booked for it.',
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
  // submitSIEJob: the file's #ORGNR is not the company's. A confirmation gate
  // like SKATTEKONTO_FILE_ORG_NUMBER_MISMATCH, not a hard block.
  SIE_IMPORT_ORG_NUMBER_MISMATCH: {
    httpStatus: 409,
    message_sv: 'SIE-filen gäller ett annat organisationsnummer än företagets. Kontrollera att det är rätt fil och rätt företag, och bekräfta för att importera ändå.',
    message_en: 'The SIE file names a different organisation number than the company. Check the file and the company, then confirm to import it anyway.',
    retryable: false,
    remediation: {
      description: 'Ask the user whether this file belongs in this company (an ombildning or a company registered under the wrong number can be legitimate). Only on their yes, resend with confirm_org_number_mismatch=true (gnubok_import_sie) or options.confirmOrgNumberMismatch=true (REST).',
      tool: 'gnubok_import_sie',
      resource: '/import?mode=sie',
    },
  },
  // archiveSIEIntakeText: a provider migration's SIE files were fetched, but
  // storage kept failing to keep one (PH 193: a storage timeout). Not the
  // provider's fault, so never PROVIDER_SIE_FETCH_FAILED. Nothing imported.
  SIE_INTAKE_ARCHIVE_UNAVAILABLE: {
    httpStatus: 503,
    message_sv: 'Bokföringen hämtades, men Accounted kunde inte spara filerna just nu. Inget har importerats. Försök igen om en stund.',
    message_en: 'The books were fetched, but Accounted could not store the files right now. Nothing was imported. Try again in a moment.',
    retryable: true,
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
  // crm#1049: a file with verifikat and no balances (SIE 4I shape: a card
  // provider's, payroll's or POS system's export) offered as the replacement
  // of a year's import: it would drop every verifikat it does not carry.
  // Such a file is appended instead (issue #108).
  SIE_IMPORT_VOUCHERS_ONLY_FILE: {
    httpStatus: 409,
    message_sv:
      'Filen innehåller bara verifikationer, till exempel från ett kortföretag eller ett lönesystem, och kan inte ersätta räkenskapsårets import: allt den inte innehåller skulle försvinna. Ångra inte den tidigare importen: välj Lägg till nya verifikat, så bokförs bara filens verifikationer som inte redan finns.',
    message_en:
      'The file holds only vouchers, for example from a card provider or a payroll system, and cannot replace the fiscal year\'s import: everything it does not hold would be lost. Do not undo the earlier import: choose Add new vouchers, which books only the file\'s vouchers that are not already posted.',
    retryable: false,
    remediation: {
      description:
        'Do not undo or replace the year\'s import (details.existing_import_id). Stage gnubok_import_sie again with on_existing_year=append: only the file\'s vouchers that are not already posted are added, as their own batch.',
      tool: 'gnubok_import_sie',
      args: { on_existing_year: 'append' },
    },
  },
  // start_sie_import_job's guard 'Existing SIE import requires reviewed
  // replacement or reconciliation' (55000), mapped by jobDatabaseError: the
  // year holds an earlier import's verifikat, or an import record overlaps
  // it. An ingående balans booked outside an import has its own code below
  // (crm#1272).
  SIE_IMPORT_PERIOD_ALREADY_IMPORTED: {
    httpStatus: 409,
    message_sv: 'Räkenskapsåret har redan importerats, och SIE-importen läser in hela räkenskapsår. Ska året ersättas: öppna importhistoriken och ångra den tidigare importen först. Ska bara filens nya verifikationer läggas till: välj Lägg till nya verifikat.',
    message_en: 'This fiscal year has already been imported, and the SIE import reads whole fiscal years. To replace the year: open import history and undo the earlier import first. To add only the file\'s new vouchers: choose Add new vouchers.',
    retryable: false,
    remediation: {
      description: 'Only when the file replaces the whole year: read gnubok_sie_import_status for the earlier import of this fiscal year, undo it (gnubok_undo_sie_import or import history in the app), then import the year again. When the file only adds verifikat (the last weeks from the old system, a card provider, payroll or POS export), never undo: stage gnubok_import_sie with on_existing_year=append, which adds only the vouchers not already posted.',
      tool: 'gnubok_sie_import_status',
      resource: '/import?mode=sie',
    },
  },
  // request_sie_import_undo's guard 'SIE undo requires review: an imported
  // voucher has a live correction' (55000), mapped by jobDatabaseError. It
  // also stops a replacement, which undoes the previous import first (PH
  // 223). nameLiveCorrections (sie-jobs.ts) writes the sentence naming the
  // imported verifikat and their corrections; this one is its fallback.
  SIE_IMPORT_HAS_LIVE_CORRECTION: {
    httpStatus: 409,
    message_sv: 'Verifikat från importen har rättats efter importen, och rättelserna skulle ligga kvar om importen ångrades eller ersattes. Återför rättelserna först (Bokföring > Verifikationer, Återför (storno)) och försök sedan igen, eller behåll importen.',
    message_en: 'Vouchers of the import were corrected after it, and the corrections would stay in the ledger if the import were undone or replaced. Reverse the corrections first (storno), then retry, or keep the import.',
    retryable: false,
    remediation: {
      description: 'Nothing was queued. The Swedish message names each imported voucher and its live correction. Reversing a correction is the user\'s decision: only on their word, reverse each named correction (gnubok_reverse_journal_entry), then retry the same request. Otherwise keep the existing import.',
      tool: 'gnubok_reverse_journal_entry',
      resource: '/bookkeeping',
    },
    thrown_message_sv: true,
  },
  // sie_import_admission_refusal (crm#1272): the year already has an IB
  // verifikat that no import owns (booked by hand, by the year-end close or
  // carried forward) and the import would book the file's IB on top of it.
  // The database writes the Swedish sentence, naming the verifikat.
  SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE: {
    httpStatus: 409,
    message_sv: 'Räkenskapsåret har redan en bokförd ingående balans. Importera filen utan ingående balanser, så läggs verifikationerna ovanpå den bokförda.',
    message_en: 'This fiscal year already has a posted opening balance (ingående balans), and the import would book the file\'s opening balance a second time. Import the file without opening balances to add its vouchers on top of the posted one.',
    retryable: false,
    remediation: {
      description: 'Stage gnubok_import_sie again with the same file and import_opening_balances=false: the vouchers are imported and the posted ingående balans stays. If the file\'s ingående balans is the correct one, correct the posted one first (gnubok_correct_opening_balances, a storno and a new IB verifikat), then import with import_opening_balances=false. Never reverse the IB just to let the import book its own.',
      tool: 'gnubok_import_sie',
      args: { import_opening_balances: false },
      resource: '/import?mode=sie',
    },
    thrown_message_sv: true,
  },
  // Appending a file's new vouchers to an imported year (issue #108,
  // lib/import/sie-append.ts). The planner writes the Swedish sentence that
  // names the vouchers; these are the fallbacks and the remediation.
  SIE_IMPORT_APPEND_NO_BASE: {
    httpStatus: 409,
    message_sv: 'Räkenskapsåret har ingen färdig SIE-import att lägga till verifikationer i. Importera filen som en vanlig import i stället.',
    message_en: 'The fiscal year has no completed SIE import to add vouchers to. Import the file as an ordinary import instead.',
    retryable: false,
    remediation: { description: 'Import the file without on_existing_year (or onExistingPeriod=block): the year holds no import yet. With details.reason = legacy_import the year is imported, by an import from before import jobs that cannot be appended to: book the file\'s vouchers as ordinary vouchers instead, and do not retry the import.', tool: 'gnubok_import_sie' },
    thrown_message_sv: true,
  },
  SIE_IMPORT_APPEND_CONFLICT: {
    httpStatus: 409,
    message_sv: 'Filen har verifikationer med samma nummer som bokförda verifikationer men annat innehåll. En påfyllnad lägger bara till nya verifikationer och ändrar aldrig bokförda. Är filen den rätta: ersätt räkenskapsårets import i stället.',
    message_en: 'The file has vouchers with the same numbers as posted vouchers but different content. Appending only adds new vouchers and never changes posted ones. If the file is the correct one, replace the fiscal year\'s import instead.',
    retryable: false,
    remediation: { description: 'details.conflicts names each source voucher and the posted verifikat it differs from. Nothing was imported. Ask the user whether the file or the books are right; replacing the year is their decision.', tool: 'gnubok_sie_import_status' },
    thrown_message_sv: true,
  },
  SIE_IMPORT_APPEND_OPENING_BALANCE_DIFFERS: {
    httpStatus: 409,
    message_sv: 'Filens ingående balans skiljer sig från räkenskapsårets bokförda. En påfyllnad kan inte ändra ingående balansen. Är filen den rätta: rätta ingående balansen eller ersätt räkenskapsårets import.',
    message_en: 'The file\'s opening balance differs from the fiscal year\'s posted one. Appending cannot change the opening balance. If the file is right, correct the opening balance or replace the year\'s import.',
    retryable: false,
    remediation: { description: 'details.differences lists each account. Nothing was imported.', tool: 'gnubok_correct_opening_balances' },
    thrown_message_sv: true,
  },
  SIE_IMPORT_APPEND_INVALID_VOUCHERS: {
    httpStatus: 409,
    message_sv: 'Några av filens nya verifikationer balanserar inte eller har konton utan mappning. En påfyllnad bokför verifikationerna exakt som i källsystemet. Rätta dem där eller mappa kontona, och försök igen.',
    message_en: 'Some of the file\'s new vouchers do not balance or use unmapped accounts. Appending books vouchers exactly as in the source system. Fix them there or map the accounts, then retry.',
    retryable: false,
    remediation: { description: 'details.vouchers names each voucher and why. Nothing was imported.' },
    thrown_message_sv: true,
  },
  SIE_IMPORT_APPEND_NOTHING_NEW: {
    httpStatus: 409,
    message_sv: 'Filen innehåller inga verifikationer som inte redan är bokförda.',
    message_en: 'The file holds no vouchers that are not already posted.',
    retryable: false,
    thrown_message_sv: true,
  },
  // request_sie_import_undo's guard 'SIE undo requires review: an append
  // batch is live' (55000), mapped by jobDatabaseError. A replacement undoes
  // the previous import first, so it is refused too.
  SIE_IMPORT_HAS_LIVE_APPEND: {
    httpStatus: 409,
    message_sv: 'Verifikationer har lagts till i importen från en annan fil. Ångra de tilläggen först i importhistoriken, och sedan importen.',
    message_en: 'Vouchers were appended to this import from another file. Undo those appends first in import history, then the import.',
    retryable: false,
    remediation: { description: 'Nothing was queued. Read gnubok_sie_import_status (no import_id) for the appends of this import (base_import_id); each undoes alone.', tool: 'gnubok_sie_import_status', resource: '/import?mode=sie' },
  },
  SIE_IMPORT_UNMAPPED_ACCOUNTS: {
    httpStatus: 400,
    message_sv: 'Vissa konton saknar mappning. Gå tillbaka till kontomappningssteget och koppla alla konton.',
    message_en: 'One or more accounts have no mapping target.',
    remediation: { description: 'Map every source account to a BAS account before importing.' },
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
  // The Excel reader could not open the file: broken, password-protected or
  // a zip it cannot follow. The file's problem, so a refusal, not a 500.
  BANK_FILE_WORKBOOK_UNREADABLE: {
    httpStatus: 400,
    message_sv:
      'Excelfilen kunde inte läsas. Öppna den i Excel, spara den som Excel-arbetsbok (.xlsx) och ladda upp den igen, eller exportera kontoutdraget som CSV från banken.',
    message_en:
      'The Excel file could not be read. Open it in Excel, save it as an Excel workbook (.xlsx) and upload it again, or export the statement from the bank as CSV.',
    remediation: {
      description: 'Re-save the workbook as .xlsx, or send the bank export as CSV or camt.053 instead.',
    },
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
  BANK_FILE_DEPOSIT_SPEC_DETECTED: {
    httpStatus: 400,
    message_sv:
      'Filen är insättningsuppgifter (BG Max eller camt.054), inte ett kontoutdrag. Den kopplar inbetalningarna till bankrader som redan finns.',
    message_en:
      'This file is a deposit specification (BG Max or camt.054), not a bank statement. It attaches the payments to bank rows that already exist.',
  },
  BGMAX_NOT_DEPOSIT_FILE: {
    httpStatus: 400,
    message_sv: 'Filen är varken en BG Max-fil från Bankgirot eller bankens avisering av inbetalningar (camt.054).',
    message_en: 'The file is neither a Bankgirot BG Max file nor the bank\'s notification of incoming payments (camt.054).',
  },
  BGMAX_TEST_FILE: {
    httpStatus: 400,
    message_sv: 'Filen är märkt som testfil hos Bankgirot och kopplas inte till riktiga bankrader.',
    message_en: 'The file is marked as a Bankgirot test file and is not attached to real bank rows.',
  },
  BGMAX_NO_DEPOSITS: {
    httpStatus: 400,
    message_sv: 'Filen innehåller inga insättningar som går att koppla: summan av betalningarna stämmer inte med insättningen, eller filen är avkortad.',
    message_en: 'The file holds no deposit that can be attached: the payments do not add up to the deposit, or the file is truncated.',
  },
  CAMT054_NO_DEPOSITS: {
    httpStatus: 400,
    message_sv: 'Filen innehåller inga bokförda inbetalningar som går att koppla: posterna saknar betalningsuppgifter, eller betalningarna summerar inte till posten.',
    message_en: 'The file holds no booked incoming payment that can be attached: the entries carry no payment details, or the payments do not add up to the entry.',
  },
  BANK_FILE_UNDO_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Bankfilsimporten kunde inte hittas.',
    message_en: 'Bank file import not found.',
    // A live bank feed row has no file to undo (crm#1647).
    remediation: {
      description:
        'Rows from the live bank feed (PSD2) came from no file and cannot be undone. To clear the unbooked ones before a date, stage gnubok_bulk_ignore_transactions (cash_account_id, before_date): nothing is deleted or posted.',
      tool: 'gnubok_bulk_ignore_transactions',
    },
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
    message_sv: 'Kontot måste vara ett aktivt konto i kontoklass 19 i din kontoplan (till exempel 1930) eller ett av företagets företagskort.',
    message_en: 'The account must be an active class 19 account in your chart of accounts (for example 1930) or one of the company cards.',
  },
  BANK_FILE_SETTLEMENT_ACCOUNT_UNAVAILABLE: {
    httpStatus: 409,
    message_sv: 'Det valda bankkontot kan inte användas för den här filen. Inget importerades.',
    message_en: 'The selected bank account cannot be used for this file. Nothing was imported.',
  },
  // crm#1204: the file names a bank account that is already a cash account on
  // another ledger. The route interpolates both ledgers into the message.
  BANK_FILE_ACCOUNT_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Filen gäller ett bankkonto som redan finns på ett annat bokföringskonto. Importera den dit, eller byt konto under Inställningar > Kopplingar > Bank > Välj konton. Inget importerades.',
    message_en:
      'This file is for a bank account already set up on another ledger account. Import it there, or change the account under Settings > Connections > Bank > Choose accounts. Nothing was imported.',
  },
  // ── Wave 3: bank transaction actions and import undo (lib/transactions/manage.ts,
  // lib/import/bank-file/undo-operation.ts, lib/import/sie-job-action-service.ts) ──
  TRANSACTION_DELETE_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Transaktionen är redan bokförd eller kopplad till en verifikation och kan inte raderas. Koppla bort den under Konton, på bankkontot, om kopplingen är fel, eller storna verifikationen.',
    message_en:
      'The transaction is already booked or linked to a journal entry and cannot be deleted. Unlink it under Accounts, on the bank account, if the link is wrong, or reverse (storno) the voucher.',
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
      'Transaktionen kan inte raderas eftersom den har en kopplad matchningshistorik (räkenskapsinformation, BFL 7 kap.). Matcha den mot en befintlig verifikation, eller ignorera den under Transaktioner om du inte vill bokföra den.',
    message_en:
      'The transaction cannot be deleted because it has linked match-history records (accounting information, BFL ch. 7). Match it to an existing voucher, or ignore it under Transactions if you do not want to book it.',
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
  // start_sie_import_job and start_sie_append_job refuse a new import while
  // another import of the company is queued, running or stopped mid-way, or
  // another run holds the year, and replace_sie_import_job refuses to replace
  // an import that is itself unfinished (55000 "SIE import is unfinished:
  // resume or undo it", with "first" from the replacement; both mapped in
  // lib/import/sie-jobs.ts). As CONFLICT it read "En
  // konflikt uppstod" on the import page and "Ett oväntat serverfel uppstod"
  // on an approval: SIE imports approved one after another while the first
  // still ran, six refusals in two days (2026-11-16 and 17).
  SIE_IMPORT_UNFINISHED: {
    httpStatus: 409,
    message_sv:
      'En annan SIE-import för företaget är inte klar än. Vänta tills den är klar, eller öppna den under Bokföring > Importera/Exportera > Importhistorik och tryck Fortsätt eller Ångra import. Starta sedan den här importen igen.',
    message_en:
      'Another SIE import of the company is not finished yet. Wait until it completes, or open it under Bokföring > Importera/Exportera > Importhistorik and resume or undo it. Then start this import again.',
    retryable: false,
    remediation: {
      description:
        "Another SIE import of the company is queued, running or stopped mid-way, or another run holds the fiscal year. Read it with gnubok_sie_import_status: a running import finishes on its own, and resuming or undoing a stopped one is the user's decision. Start this import again once that one is completed or undone.",
      tool: 'gnubok_sie_import_status',
    },
  },
  // The undo, the resume of an undo and the replacement refuse before anything
  // is queued when a date they must write is locked (migration
  // 20261005193558, crm#1022): stornos carry the dates of the vouchers they
  // reverse. The database composes the sentence (the locked fiscal year or the
  // lock date, the dates the run writes, the setting to change).
  SIE_IMPORT_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsåret eller bokföringens låsdatum täcker datum som importen behöver bokföra på. Lås upp under Inställningar > Bokföring och försök igen.',
    message_en:
      'The fiscal year, or the company lock date, covers dates this SIE run must write: stornos are dated like the vouchers they reverse. Unlock under Settings > Bookkeeping, then retry.',
    retryable: false,
    remediation: {
      description:
        'Nothing was queued. The Swedish message names the locked fiscal year or the lock date and the first date the run writes. Unlocking is the user\'s decision: move the lock date back (gnubok_update_bookkeeping_lock) or unlock the fiscal year (gnubok_unlock_period) only when they ask, then retry the same request.',
      tool: 'gnubok_update_bookkeeping_lock',
      resource: '/settings/bookkeeping',
    },
    thrown_message_sv: true,
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
  // Moving an account onto a ledger another row holds adopts that row and
  // retires the account's own row (promote_psd2_cash_account). These refuse
  // that retirement. Unregistered, each reached the picker as the generic
  // "Förfrågan innehåller ogiltiga uppgifter" (crm#1021). The database names
  // the account in a DETAIL, which lib/cash-accounts/selection-refusal.ts
  // turns into a sentence; these are the answers without one.
  CASH_ACCOUNT_RETIREMENT_HAS_DEPENDENCIES: {
    httpStatus: 409,
    message_sv: 'Bankkontot kan inte flyttas till det bokföringskontot automatiskt: kontot det bokförs på nu har underlag bifogade till en avstämning eller används i fakturor. Behåll det nuvarande bokföringskontot, eller kontakta supporten så hjälper vi dig att flytta det. Inget sparades.',
    message_en: 'The bank account cannot be moved to that ledger account automatically: the account it books to now has attachments on a reconciliation or is used on invoices. Keep the current ledger account, or contact support to have it moved. Nothing was saved.',
  },
  CASH_ACCOUNT_RETIREMENT_IDENTITY_CONFLICT: {
    httpStatus: 409,
    message_sv: 'Bankkontot kan inte slås ihop med kontot på det bokföringskontot: de har olika IBAN eller valuta. Välj ett annat bokföringskonto, eller kontakta supporten. Inget sparades.',
    message_en: 'The bank account cannot be merged with the account on that ledger account: they have different IBANs or currencies. Choose another ledger account, or contact support. Nothing was saved.',
  },
  CASH_ACCOUNT_RETIREMENT_STILL_LIVE: {
    httpStatus: 409,
    message_sv: 'Ett av bankkontona hämtas fortfarande via en annan bankkoppling och kan inte slås ihop automatiskt. Koppla från den andra kopplingen under Inställningar > Kopplingar > Bank och spara sedan igen. Inget sparades.',
    message_en: 'One of the bank accounts is still fetched through another bank connection and cannot be merged automatically. Disconnect the other connection under Settings > Connections > Bank, then save again. Nothing was saved.',
  },
  BANK_SELECTION_CHART_ACCOUNT_MISSING: {
    httpStatus: 400,
    message_sv: 'Ett av de valda bokföringskontona finns inte i kontoplanen. Ladda om sidan, välj konton igen och spara. Inget sparades.',
    message_en: 'One of the chosen ledger accounts is not in the chart of accounts. Reload the page, choose the accounts again and save. Nothing was saved.',
  },
  // Changing a synced account's ledger account (lib/cash-accounts/ledger-change.ts)
  // on a connection that is not active: waiting for its first account choice,
  // ended or failed. Nothing to save until it is chosen or renewed.
  BANK_LEDGER_CHANGE_NOT_ACTIVE: {
    httpStatus: 409,
    message_sv: 'Bankkopplingen är inte aktiv, så bokföringskontot kan inte bytas nu. Välj konton eller förnya kopplingen under Inställningar > Kopplingar och byt sedan. Inget sparades.',
    message_en: 'The bank connection is not active, so the ledger account cannot be changed now. Choose the accounts or renew the connection under Settings > Connections, then change it. Nothing was saved.',
  },
  // The change would carry the bank account's invoice payee details to the
  // row on its new ledger account (crm#1445), and those are owner/admin only
  // (cash_accounts_payee_admin_only). Refused before anything is written
  // (crm#1683); the service names the account and ledgers in its own sentence.
  BANK_LEDGER_CHANGE_PAYEE_ADMIN_ONLY: {
    httpStatus: 403,
    message_sv: 'Bytet av bokföringskonto flyttar också betalningsuppgifterna för fakturor, och dem kan bara företagets ägare eller en administratör ändra. Inget sparades. Be en ägare eller administratör att göra bytet.',
    message_en: 'The ledger account change also moves the invoice payment details, which only the company owner or an administrator can change. Nothing was saved. Ask an owner or administrator to make the change.',
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
    // Never a field name in the Swedish half: a person reads it. With the
    // time (details.next_allowed_at) the reader words it exactly; this is
    // what stands without one. The sentences of the three sync holds
    // (this one, BANK_RATE_LIMITED, BANK_THROTTLED) are those of
    // lib/bank-sync/sync-hold-message.ts, kept in step by its test.
    message_sv: 'En synkning startades nyligen. Vänta en kvart mellan synkningarna.',
    message_en: 'This connection was synced recently. Wait until next_allowed_at before syncing again; the data you have is already fresh.',
    retryable: true,
  },
  BANK_RATE_LIMITED: {
    httpStatus: 429,
    message_sv: 'Banken begränsar just nu hur ofta transaktioner får hämtas. Försök igen senare. Anslutningen behöver inte förnyas.',
    message_en: 'The bank is temporarily rate limiting this consent. Do not sync again before next_allowed_at: it is our cooldown (the bank\'s Retry-After when it sent one, bounded backoff otherwise), not a reset time confirmed by the bank. The connection is still valid: do not ask the user to renew it.',
    retryable: true,
  },
  BANK_THROTTLED: {
    httpStatus: 429,
    message_sv: 'Banken är upptagen just nu. Försök igen om en stund.',
    message_en: 'The bank is busy right now: a short throttle, not the daily cap. Try again after next_allowed_at (about a minute). The connection is still valid.',
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
  // The Enable Banking feed is over (lib/bank-feed/switch-campaign.ts
  // enableBankingSunset): the campaign deadline has passed, so a sync of an
  // Enable Banking connection is refused before any provider call. 410: the
  // resource is gone for good, no retry and no renewal at the old provider.
  ENABLE_BANKING_SUNSET: {
    httpStatus: 410,
    message_sv: 'Den gamla bankkopplingen har upphört. Byt till ny koppling för att fortsätta hämta transaktioner.',
    message_en: 'The old bank connection (Enable Banking) has ended and fetches nothing any more. The person switches to the new connection from switch_url in gnubok_connect_bank (BankID in a browser); where the new provider does not reach the bank, bank statements are imported as files. Do not retry.',
    remediation: {
      description: 'Give the user the switch_url of this connection from gnubok_connect_bank (or GET /bank-connections); only they can sign the new consent with BankID.',
      tool: 'gnubok_connect_bank',
    },
  },
  // The Enable Banking to Open Payments switch campaign (lib/bank-feed/switch-campaign.ts).
  BANK_SWITCH_CAMPAIGN_OFF: {
    httpStatus: 409,
    message_sv: 'Bytet av bankkoppling är inte igång: inget slutdatum är satt.',
    message_en: 'The bank connection switch campaign is not running: no deadline is set (OPENPAYMENTS_SWITCH_DEADLINE).',
  },
  BANK_SWITCH_MAILS_OFF: {
    httpStatus: 409,
    message_sv: 'Mejl om bytet av bankkoppling är inte påslagna ännu.',
    message_en: 'Bank switch mails are not switched on (OPENPAYMENTS_SWITCH_MAILS).',
  },
  BANK_SWITCH_NOT_PENDING: {
    httpStatus: 409,
    message_sv: 'Kunden har ingen bankkoppling som behöver bytas.',
    message_en: 'The client has no bank connection left to switch.',
  },
  BANK_SWITCH_RECENTLY_SENT: {
    httpStatus: 429,
    message_sv: 'Kunden fick ett mejl om bytet för mindre än sju dagar sedan. Vänta med nästa.',
    message_en: 'The client was mailed about the switch less than seven days ago (details.last_sent_at). Wait before the next one.',
    retryable: true,
  },
  BANK_SWITCH_NO_RECIPIENT: {
    httpStatus: 422,
    message_sv: 'Kunden har ingen ägare eller administratör med e-postadress att mejla.',
    message_en: 'The client has no owner or admin with an email address to mail.',
  },
  BANK_SWITCH_MAIL_FAILED: {
    httpStatus: 502,
    message_sv: 'Mejlet om bytet kunde inte skickas. Försök igen om en stund.',
    message_en: 'The bank switch mail could not be sent. Retry in a while.',
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
      'Bokföringen är låst t.o.m. ett låsdatum som täcker periodens start: ingående balanser kan inte korrigeras. Ta bort eller flytta låsdatumet under Inställningar → Bokföring och försök igen.',
    message_en:
      'The company-wide bookkeeping lock date covers the period start: opening balances cannot be corrected. Remove or move the lock date under Settings → Bookkeeping and try again.',
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
  // Booking a year's IB from its SIE file in the opening balance review (crm#1099).
  OB_SIE_FILE_MISSING: {
    httpStatus: 404,
    message_sv:
      'Det finns inga sparade ingående balanser från en SIE-fil för räkenskapsåret. Lägg in dem under Importera/Exportera > CSV eller Excel > Ingående balanser.',
    message_en:
      'No opening balances from a SIE file are stored for this fiscal year. Enter them under Import/Export > CSV or Excel > Opening balances.',
  },
  OB_REVIEW_CHANGED: {
    httpStatus: 409,
    message_sv: 'Granskningen har ändrats sedan du öppnade den. Ladda om sidan och försök igen.',
    message_en: 'The review changed after you opened it. Reload the page and try again.',
    remediation: {
      description:
        'A new import or a changed IB verifikat replaced the review that was read. Preview gnubok_acknowledge_opening_balance_review again without review_token and opening_balance_entry_id, check the differences, then stage it.',
      tool: 'gnubok_acknowledge_opening_balance_review',
    },
  },
  // Confirming the opening balance review over MCP (crm#1967):
  // lib/import/opening-balance/review.ts.
  OB_REVIEW_NOT_PENDING: {
    httpStatus: 409,
    message_sv: 'Räkenskapsåret har ingen granskning av ingående balanser som väntar.',
    message_en: 'The fiscal year has no opening balance review waiting.',
    remediation: {
      description:
        'Nothing to confirm for this year. gnubok_sie_import_status names the year a review waits on under opening_balance_review.',
      tool: 'gnubok_sie_import_status',
    },
  },
  OB_REVIEW_IMPORT_RUNNING: {
    httpStatus: 409,
    message_sv: 'En SIE-import i bolaget är inte klar. Bekräfta granskningen när den är klar.',
    message_en: 'An SIE import of the company is not finished. Confirm the review once it has completed.',
    remediation: {
      description: 'Poll gnubok_sie_import_status until the import is completed or undone, then confirm the review again.',
      tool: 'gnubok_sie_import_status',
    },
  },
  // PH 193: the year before was imported again after the undo that raised the
  // review, so the year already opens on that year's utgående balanser.
  OB_PREVIOUS_YEAR_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Föregående räkenskapsår är inläst igen, så årets ingående balanser följer dess utgående balanser och ska inte bokföras en gång till från filen. Stäm av dem och bekräfta granskningen. Ska året i stället öppna med filens balanser, ångra först importen av föregående år under Importera/Exportera > Importhistorik.',
    message_en:
      "The previous fiscal year has been imported again, so this year's opening balances follow its closing balances and must not be booked a second time from the file. Reconcile them and confirm the review. If the year should open on the file's balances instead, first undo the previous year's import under Import/Export > Import history.",
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
  // The workbook reader could not open the file (UnreadableWorkbookError
  // carries this code): broken, password-protected or a zip it cannot
  // follow. The file's problem, so a refusal, not a 500. Answered by the
  // customer, supplier, article and opening balance imports; a bank file
  // answers BANK_FILE_WORKBOOK_UNREADABLE.
  IMPORT_WORKBOOK_UNREADABLE: {
    httpStatus: 400,
    message_sv:
      'Filen kunde inte läsas. Den kan vara skadad eller lösenordsskyddad. Öppna den i Excel, spara den utan lösenord som Excel-arbetsbok (.xlsx) eller som CSV och ladda upp den igen.',
    message_en:
      'The file could not be read. It may be damaged or password-protected. Open it in Excel, save it without a password as an Excel workbook (.xlsx) or as CSV and upload it again.',
    remediation: {
      description: 'Re-save the file as .xlsx without a password, or as CSV, and send it again.',
    },
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

// Undo of a customer/supplier/article import (lib/import/register-runs.ts).
const REGISTER_IMPORT_UNDO: Record<string, StructuredErrorEntry> = {
  REG_IMPORT_UNDO_INVALID_ID: {
    httpStatus: 400,
    message_sv: 'Ogiltigt import-id.',
    message_en: 'Invalid import run id.',
  },
  REG_IMPORT_UNDO_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Importen kunde inte hittas.',
    message_en: 'Register import run not found.',
  },
  REG_IMPORT_UNDO_ALREADY_UNDONE: {
    httpStatus: 409,
    message_sv: 'Importen är redan ångrad.',
    message_en: 'This register import has already been undone.',
  },
  REG_IMPORT_UNDO_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Du har inte behörighet att ångra importer i det här företaget.',
    message_en: 'You do not have write access to undo imports in this company.',
  },
  REG_IMPORT_UNDO_FAILED: {
    httpStatus: 500,
    message_sv: 'Importen kunde inte ångras. Försök igen.',
    message_en: 'Failed to undo the register import.',
    retryable: true,
  },
  REG_IMPORT_LIST_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte hämta importhistoriken.',
    message_en: 'Failed to list register imports.',
    retryable: true,
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
  // 422, same reasoning as PROVIDER_TOKEN_INVALID. What was pasted as the
  // Bokio company id holds no GUID (an org number, or the token in the wrong
  // field), so no retry can work; Bokio answered such a request with a 400
  // that read as "try again" (crm#1081 follow-up, 2026-10-27).
  BOKIO_COMPANY_ID_INVALID: {
    httpStatus: 422,
    message_sv:
      'Företags-ID:t från Bokio har fel format. Det är en lång kod med bokstäver, siffror och bindestreck (ett GUID) som syns i webbadressen när du visar företagets översikt i Bokio, inte organisationsnumret. Klistra in den eller hela webbadressen i fältet Företags-ID, och integrationstoken i fältet Integrationstoken.',
    message_en:
      'The Bokio company ID has the wrong format. It is a long code of letters, digits and hyphens (a GUID) shown in the address bar when you view the company overview in Bokio, not the organisation number. Paste it, or the whole address, into the Company ID field, and the integration token into the Integration token field.',
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
    // The routes compose the message from the error (the company the
    // credentials opened, both org numbers: arcim-migration's
    // company-mismatch-message.ts); this is the fallback without those facts.
    // Both ways out, because the common case is a bookkeeper still standing in
    // their own company while bringing in a client's (PH 193), whom choosing
    // again at the provider can never help.
    httpStatus: 422,
    message_sv:
      'Anslutningen gäller ett annat företag än det du importerar till. Ska det företaget flyttas till Accounted? Välj då Lägg till företag i företagsmenyn (klicka på företagsnamnet) och anslut därifrån. Annars: anslut igen och välj rätt företag.',
    message_en:
      'The connection opened a different company than the one you are importing into. To move that company to Accounted, choose Add company in the company menu (click the company name) and connect from there. Otherwise, connect again and pick the right company.',
    thrown_message_sv: true,
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
  // create_provider_migration_job: the consent has no source identity (the
  // provider company's organisation number), because the provider did not
  // answer the company information read. A subscription refusal there is
  // answered with its own code before the RPC runs (migration-job-routes).
  MIGRATION_SOURCE_IDENTITY_MISSING: {
    httpStatus: 409,
    message_sv:
      'Kunder, leverantörer och fakturor kan inte hämtas: leverantören lämnade inte ut företagets organisationsnummer, så Accounted kan inte kontrollera att registren hör till det här företaget. Bokföringen du redan importerat påverkas inte. Koppla om anslutningen och försök igen; nekar leverantören igen, kontakta supporten.',
    message_en:
      'Customers, suppliers and invoices cannot be fetched: the provider did not return the company\'s organisation number, so Accounted cannot check that the registers belong to this company. The bookkeeping already imported is unaffected. Reconnect and try again; if the provider refuses again, contact support.',
  },
  // create_provider_migration_job: the company's earlier register fetch is
  // still open (running, or finished and waiting for its review), and one
  // runs at a time. The migration workspace opens that fetch instead
  // (crm#1660); every other caller shows this sentence (crm#2002).
  MIGRATION_ALREADY_ACTIVE: {
    httpStatus: 409,
    message_sv:
      'Kunder, leverantörer och fakturor hämtas en gång i taget, och en tidigare hämtning är inte avslutad. Bokföringen du har importerat finns kvar. Öppna den (Bokföring › Import och flytt › Hämta från annat system) och låt den bli klar. Väntar den på granskning tar Försök igen med fakturorna från år du har importerat sedan dess, och Godkänn importen avslutar den så att du kan köra importen igen.',
    message_en:
      'Customers, suppliers and invoices are fetched one at a time, and an earlier fetch has not finished. The bookkeeping you imported is kept. Open it (Bookkeeping › Import and migration › Import from another system) and let it finish. If it is waiting for review, Retry takes in the invoices of years you have imported since, and Accept the import finishes it so you can run the import again.',
  },
  // /migrate no longer imports customers, suppliers or invoices: the
  // background import job does, reading every record in full (crm#1436).
  // Only a client from before that change sends them.
  PROVIDER_REGISTERS_VIA_JOB: {
    httpStatus: 409,
    message_sv: 'Kunder, leverantörer och fakturor importeras nu i bakgrunden. Ladda om sidan och starta importen igen.',
    message_en: 'Customers, suppliers and invoices are now imported in the background. Reload the page and start the import again.',
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
  // crm#1581: the server carries a run on once its tab leaves it silent; a
  // second chain from a tab would only go over the same files again.
  PROVIDER_IMPORT_DOCUMENTS_RUNNING_ON_SERVER: {
    httpStatus: 409,
    message_sv: 'Hämtningen av underlag pågår redan och fortsätter av sig själv. Du kan stänga fliken.',
    message_en: 'The document import is already running and carries on by itself. You can close this tab.',
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
    message_sv: 'Anropet saknar sin signerade token. Skicka den i Authorization-headern.',
    message_en:
      'The request is missing its signed token. Send the headers returned next to the URL (upload_headers, signed_url_headers, download_headers, original_url_headers): Authorization: Bearer <token>.',
  },
  // CASA 2.1.1: a credential never rides in a URL this application serves.
  STORAGE_PROXY_TOKEN_IN_URL: {
    httpStatus: 400,
    message_sv: 'Token får inte skickas i adressen. Skicka den i Authorization-headern i stället.',
    message_en:
      'The token must not be sent in the URL. Remove the token query parameter and send it in the header instead: Authorization: Bearer <token>. Fetch the URL again from the tool or endpoint that gave it: the answer carries the headers to send.',
  },
  // An Accounted API key (or MCP refresh token) sent where the storage token
  // belongs: refused before anything is forwarded to Storage.
  STORAGE_PROXY_API_KEY_REFUSED: {
    httpStatus: 400,
    message_sv: 'Det här är en API-nyckel, inte filens signerade token. Skicka headern som följde med adressen.',
    message_en:
      'This is an Accounted API key, not the file\'s signed token. Send the headers returned next to the URL (upload_headers, signed_url_headers, download_headers, original_url_headers), not your API key.',
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

/**
 * The way out of a locked or closed year for a document: the first part of
 * every document door's next step (DOCUMENT_LOCKED_YEAR,
 * DOC_ATTACH_PERIOD_LOCKED), before what becomes of the file if the year
 * stays closed.
 */
const DOCUMENT_LOCKED_YEAR_WAY_OUT =
  'The verifikat\'s fiscal year is locked or closed, and the database refuses every document on it. Read the year with gnubok_list_fiscal_periods (GET /fiscal-periods). Locked, not closed: unlock it with gnubok_unlock_period (POST /fiscal-periods/{id}/unlock). Marked closed in a previous system (closed_externally, no closing entry): reopen it with gnubok_reopen_fiscal_period_external (POST /fiscal-periods/{id}/reopen-external). Closed by a year-end run in Accounted: only the company owner reopens it, in the app under Inställningar → Bokföring → Räkenskapsår, while its årsredovisning is not signed, adopted or filed (no API or MCP door). Reopening a year is the user\'s decision. Then send the request again, on /api/v1 with a new Idempotency-Key (the refusal is cached under the old one), and lock or close the year again.'

/**
 * Why a verifikat in a locked or closed year takes no document, and the ways
 * out the product has: unlock, the two reopens under Räkenskapsår (crm#1290
 * for a year closed with bokslut), or the file kept unlinked. The one answer
 * of every door that uploads, links, versions or attaches a document
 * (DOC_UPLOAD_PERIOD_LOCKED, DOC_ATTACH_PERIOD_LOCKED, and the doors that
 * keep a published PERIOD_LOCKED), so its last sentence holds for a file
 * that was refused at upload and for one already stored. Unlinked files are
 * not named by place: the Dokument section is not shown to every company
 * (lib/arkiv/flag.ts). Its next step ends with what becomes of the file if
 * the year stays closed at the doors that store or link one; attach-document,
 * whose document is already stored, ends its own (DOC_ATTACH_PERIOD_LOCKED).
 */
const DOCUMENT_LOCKED_YEAR = {
  message_sv:
    'Verifikationen ligger i ett låst eller stängt räkenskapsår, och där går det inte att lägga till underlag. Lås upp året eller öppna det igen under Inställningar → Bokföring → Räkenskapsår, lägg till underlaget och lås eller stäng sedan året igen. Ett år som stängts med bokslut i Accounted kan bara företagets ägare öppna, och bara så länge årsredovisningen inte är undertecknad, fastställd eller inskickad. Går året inte att öppna kan filen ändå sparas, utan koppling till verifikationen.',
  message_en:
    'The voucher is in a locked or closed fiscal year, where no document can be added. Unlock or reopen the year under Settings → Bookkeeping → Fiscal years, add the document, then lock or close the year again. Only the company owner can reopen a year closed with a year-end closing in Accounted, and only while its annual report has not been signed, adopted or filed. If the year cannot be reopened, the file can still be kept, without a link to the voucher.',
  remediation: {
    description: `${DOCUMENT_LOCKED_YEAR_WAY_OUT} A year that stays closed: the file is kept unlinked. Send an upload again without journal_entry_id; a document that is already stored stays as it is (GET /documents?linked=false lists both).`,
    tool: 'gnubok_list_fiscal_periods',
  },
} satisfies Pick<StructuredErrorEntry, 'message_sv' | 'message_en' | 'remediation'>

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
  // A document on a verifikat in a locked or closed year
  // (DOCUMENT_PERIOD_LOCK_REFUSAL in document-period-lock-refusal.ts, the trigger's
  // text), refused with nothing written: the one
  // answer (DOCUMENT_LOCKED_YEAR) of every door that uploads, links or
  // versions a document. v1 documents.link keeps the PERIOD_LOCKED code it
  // publishes and speaks this answer.
  DOC_UPLOAD_PERIOD_LOCKED: {
    httpStatus: 400,
    ...DOCUMENT_LOCKED_YEAR,
    retryable: false,
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
  // A waiting proposal already links the document to another verifikat: only
  // one of the two could ever be approved (crm#1158).
  DOC_LINK_PROPOSED_ELSEWHERE: {
    httpStatus: 409,
    message_sv:
      'Underlaget är redan föreslaget för en annan verifikation, och ett underlag kan bara kopplas till en verifikation. Ska båda verifikationerna ha det, till exempel ett kontoutdrag med flera avgifter eller en rättelse som vilar på originalets faktura, kopplas en exakt kopia till den här verifikationen. Annars avvisa det andra förslaget först.',
    message_en:
      'The document is already proposed for another verifikat, and a document can be linked to only one verifikat.',
    remediation: {
      description:
        'If both verifikat need this underlag (a bank statement covering several fees, a correction resting on the original\'s invoice), stage this link again with copy: true (or a copy: true row in gnubok_link_documents_to_vouchers): approval archives a byte-identical copy on this verifikat. Do not re-upload or alter the file. If the other proposal is the wrong one, reject it first, then stage this link again.',
    },
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
    remediation: {
      description:
        'One document backing two purchases (an order paid in two charges, one agreement for two deposits): book this row, then link a byte-identical copy to its verifikat with copy: true. details.journal_entry_id is the verifikat that holds the document and details.transaction_journal_entry_id the one this row is booked on (null while unbooked); when the row is booked, details.next is that call with its arguments. details.held_by_transaction_id, when present, is the booked bank transaction the document sits on: attaching it elsewhere never takes a document off a booked transaction. Never re-upload or alter the file. A receipt for one purchase stays where it is.',
      tool: 'gnubok_link_document_to_voucher',
    },
  },
  // The pin on the bank row was saved; only the link to its verifikat was
  // refused. The sentences are the one answer for a locked year
  // (DOCUMENT_LOCKED_YEAR); the next step is attach-document's own, read also
  // by its refusal with nothing written (PERIOD_LOCKED,
  // lib/transactions/document-attach.ts): the document is already stored, so
  // it ends without the upload doors' advice to send the file again.
  DOC_ATTACH_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv: `Bilagan kopplades till transaktionen men inte till verifikationen. ${DOCUMENT_LOCKED_YEAR.message_sv}`,
    message_en: `The document was attached to the transaction but not to its voucher. ${DOCUMENT_LOCKED_YEAR.message_en}`,
    remediation: {
      description: `${DOCUMENT_LOCKED_YEAR_WAY_OUT} A year that stays closed: the document is already stored and stays as it is, without a link to the verifikat (GET /documents?linked=false lists it); it needs no new upload.`,
      tool: DOCUMENT_LOCKED_YEAR.remediation.tool,
    },
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
  DOC_ROW_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Underlaget verkar höra till ett annat köp: beloppet är större än transaktionens och säljaren är en annan, eller så går pengarna åt andra hållet. Koppla det bara om det verkligen hör hit.',
    message_en:
      'The document looks like it belongs to another purchase: it asks for more than the transaction paid and names another seller, or its money goes the other way (a purchase on money in, a refund on money out). Nothing was linked.',
    remediation: {
      description:
        'details names both sides, and kind says what disagrees: other_purchase (a larger amount and another seller) or direction (a purchase on money in, a refund or credit note on money out). Pick the bank transaction that paid this document instead. If it does belong here (an invoice paid in parts, one statement covering several payments), call again with mismatch_reason saying why.',
    },
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
  // A purchase category is stored on the item's own reading; an item whose
  // document's reading only stands in for display has none to hold it.
  INBOX_ITEM_NO_READING: {
    httpStatus: 409,
    message_sv: 'Posten har ingen egen tolkning än. Vänta tills den är läst, eller rätta fälten först.',
    message_en: 'The inbox item has no reading of its own yet. Wait for it to be read, or correct its fields first.',
  },
  // "Varje gång" stores the purchase category on the item's matched supplier
  // (suppliers.default_purchase_category); without one there is nobody to
  // hold the instruction.
  INBOX_ITEM_NO_SUPPLIER: {
    httpStatus: 409,
    message_sv: 'Posten är inte kopplad till någon leverantör. Koppla en leverantör först, så kan kategorin gälla varje gång.',
    message_en: 'The inbox item is not matched to a supplier. Match a supplier first, then the category can apply every time.',
    remediation: {
      description:
        'every_time stores the category on the item\'s matched supplier (matched_supplier_id). Match the item to a supplier (POST /inbox-items/{id}/match-supplier), or send the category without every_time to set it on this item only.',
    },
  },
  // A staged every_time is approved for the supplier its card named
  // (expected_supplier_id); the item has been matched to another one since.
  INBOX_ITEM_SUPPLIER_CHANGED: {
    httpStatus: 409,
    message_sv: 'Posten är kopplad till en annan leverantör än när förslaget gjordes. Inget har ändrats.',
    message_en: 'The inbox item is matched to another supplier than when the proposal was made. Nothing was changed.',
    remediation: {
      description:
        'details.matched_supplier_id is the supplier the item is matched to now. Read the item again and, if the category should still hold every time, stage it again for that supplier.',
      tool: 'gnubok_get_inbox_item',
    },
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
  // A deleted inbox item is put back from the copy its deletion kept
  // (lib/operations/inbox-restore.ts): once, and only while nothing else has
  // taken its document.
  INBOX_ITEM_RESTORE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Det finns ingen borttagen post att lägga tillbaka.',
    message_en: 'There is no deleted inbox item to put back.',
    remediation: {
      description:
        'The id is the inbox item\'s own, as GET /inbox-items/removed lists it. An item deleted before deleted items were kept, one that carried no document, and one whose document was deleted from the archive since have nothing to put back.',
    },
  },
  INBOX_ITEM_RESTORE_IN_INBOX: {
    httpStatus: 409,
    message_sv: 'Dokumentet ligger redan i inkorgen.',
    message_en: 'The document is already in the inbox.',
    remediation: {
      description:
        'The item was put back already, or its document has an inbox item again (the same file or mail arrived once more). Nothing was written. Read the inbox (GET /inbox-items); do not retry.',
    },
  },
  INBOX_ITEM_RESTORE_BOOKED: {
    httpStatus: 409,
    message_sv: 'Dokumentet sitter på en verifikation och kan inte läggas tillbaka i inkorgen.',
    message_en: 'The document is on a verifikat and cannot be put back in the inbox.',
    remediation: {
      description: 'details.journal_entry_id is the verifikat that holds the document. Nothing was written.',
    },
  },
  INBOX_ITEM_RESTORE_LINKED: {
    httpStatus: 409,
    message_sv:
      'Dokumentet är underlag till en leverantörsfaktura, ett utlägg eller en banktransaktion och kan inte läggas tillbaka i inkorgen.',
    message_en:
      'The document is the underlag of a supplier invoice, an expense claim or a bank transaction and cannot be put back in the inbox.',
    remediation: {
      description:
        'details.linked_to says which: supplier_invoice, expense_claim or bank_transaction. The document is already in use there. Nothing was written.',
    },
  },
  INBOX_ITEM_RESTORE_DUPLICATE: {
    httpStatus: 409,
    message_sv: 'En kopia av samma fil ligger redan i inkorgen eller är redan bokförd. Posten lades inte tillbaka.',
    message_en: 'A copy of the same file is already in the inbox or already booked. The item was not put back.',
  },
  // accounted#14: a second booking of the same underlag. Refused before
  // posting when the item already reads booked; when two calls race past
  // that read, the loser's verifikat is reversed (storno) before this answer.
  INBOX_ITEM_ALREADY_BOOKED: {
    httpStatus: 409,
    message_sv: 'Underlaget är redan bokfört. Ladda om för att se verifikationen.',
    message_en: 'The inbox item is already booked. Reload to see its verifikat.',
    remediation: {
      description:
        'Nothing new stays in the books: either nothing was posted, or the verifikat this call posted was reversed with a storno because another call booked the item first. details.journal_entry_id names the booking when known, else read the item (created_journal_entry_id). Do not retry.',
    },
  },
  // The Inkorg's "Registrera och koppla till betalningen" settles against the
  // bank row match on arrival proposed. Refused before anything is written
  // when that proposal no longer stands (the row was booked or claimed since,
  // or the item no longer reads the same).
  INBOX_BANK_MATCH_STALE: {
    httpStatus: 409,
    message_sv: 'Bankraden är inte längre förslaget för underlaget, till exempel för att den har bokförts sedan. Ladda om och välj bankraden själv.',
    message_en: 'The bank row is no longer the proposal for this document, for example because it was booked since. Reload and pick the bank row yourself.',
  },
  // The Inkorg's one click (POST /api/inkorg/items/:id/book): the booking
  // plan still asks something only a person can say (lib/operations/
  // inkorg-one-click.ts). Nothing was written; details.ask says what.
  INKORG_BOOKING_NEEDS_ANSWER: {
    httpStatus: 422,
    message_sv: 'Köpet kan inte bokföras med ett klick än. Välj vad som köptes eller var säljaren finns, eller bokför det i verifikatet.',
    message_en: 'The purchase cannot be booked in one click yet. Choose what was bought or where the seller is, or book it in the voucher editor.',
    remediation: {
      description:
        'details.ask names what is missing: category (send purchase_category), seller_country (send seller_country: se, eu or non_eu), or editor (the VAT, the amounts or the dates need a person: book it in the editor). Send the request again with the answer and the details.preview_token of the plan read with it.',
    },
  },
  // The Inkorg brings the receipt that came with an invoice onto the
  // invoice's booking. Refused when the two are not one purchase by the
  // pairing rule (lib/inkorg/pairs.ts): another arrival, other amounts, or a
  // receipt that fits more than one invoice.
  // The other half of the purchase (the invoice or the receipt this one came
  // with, lib/inkorg/pairs.ts) is booked already: booking this one too books
  // the purchase twice (reported 2026-10-15). The doors name the verifikat in
  // the message; this is the fallback for an envelope without one.
  INBOX_ITEM_PAIR_ALREADY_BOOKED: {
    httpStatus: 409,
    message_sv: 'Det andra underlaget från samma köp är redan bokfört. Lägg till det här underlaget på det verifikatet i stället, så bokförs köpet inte två gånger.',
    message_en: 'The other document from the same purchase is booked already. Add this document to that voucher instead, so the purchase is not booked twice.',
  },
  INBOX_COMPANION_NOT_PAIRED: {
    httpStatus: 409,
    message_sv: 'Kvittot hör inte ihop med fakturan, så det kopplades inte till bokföringen. Det ligger kvar i inkorgen.',
    message_en: 'The receipt does not belong with the invoice, so it was not linked to the booking. It stays in the inbox.',
  },
  // A company's own supplier portal (POST/PATCH/DELETE /api/inkorg/portals).
  INKORG_PORTAL_URL_INVALID: {
    httpStatus: 400,
    message_sv: 'Länken går inte att använda. Klistra in adressen till sidan med fakturorna, med https.',
    message_en: 'The link cannot be used. Paste the address of the page with the invoices, with https.',
  },
  INKORG_PORTAL_PURCHASE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Köpet kunde inte hittas.',
    message_en: 'The purchase was not found.',
  },
  // The bank row names nobody ("INTERNET BET 4"), or it is salary, tax or a
  // fee: no supplier, so no invoice behind a login.
  INKORG_PORTAL_NO_SUPPLIER: {
    httpStatus: 422,
    message_sv: 'Köpet har ingen leverantör som kan ha en portal.',
    message_en: 'This purchase has no supplier that could have a portal.',
  },
  INKORG_PORTAL_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Portalen finns inte längre. Ladda om sidan.',
    message_en: 'The portal no longer exists. Reload the page.',
  },
  // Book-direct on a foreign-currency underlag (crm#1146). The lines arrive as
  // bare numbers that are stored as SEK, so a receipt for 100 EUR used to post
  // as 100 kr. Refused only when a line carries the document's foreign total
  // as its kronor amount: kronor typed by hand are a real booking, with or
  // without a bank row. The route composes the sentence with the currency;
  // this is the fallback for an envelope without one.
  INBOX_BOOK_DIRECT_FX_FACE_AMOUNT: {
    httpStatus: 400,
    message_sv:
      'Beloppen är underlagets belopp i utländsk valuta, inte kronor. Ange beloppen i kronor, eller välj banktransaktionen som betalade underlaget. Är valutan fel rättar du den på underlaget.',
    message_en:
      "The amounts are the document's amounts in its foreign currency, not SEK. Enter the amounts in SEK, or pick the bank transaction that paid the document. If the currency is wrong, correct it on the document.",
    remediation: {
      description:
        'details.currency is the currency read from the document. A submitted line has the document total (extracted_data.totals.total) as its debit or credit amount, and journal lines are always SEK. Resubmit with amounts in SEK, or book the item against the bank transaction that paid it (transaction_id), whose SEK amount is then the figure to use. If the extracted currency is wrong, correct invoice.currency on the inbox item and retry.',
    },
    retryable: false,
    thrown_message_sv: true,
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
  // A partner delivery (POST /api/v1/.../inbox-items) whose external_ref was
  // already delivered with other content: filing the new file under the old
  // reference would hide it, replaying the old answer would lose it.
  INBOX_DELIVERY_REF_CONFLICT: {
    httpStatus: 409,
    message_sv: 'Referensen har redan använts för en annan fil i det här företaget.',
    message_en: 'This external_ref was already delivered with a different file for this company.',
    remediation: {
      description:
        'Send the same file to replay the first delivery, or give the new document an external_ref of its own.',
    },
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
  // Customer merge (lib/customers/merge-customers.ts, merge_customers RPC).
  CUSTOMER_MERGE_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Du har inte behörighet att slå ihop kunder i det här bolaget.',
    message_en: 'You do not have permission to merge customers in this company.',
  },
  CUSTOMER_MERGE_IDENTITY_CONFLICT: {
    httpStatus: 409,
    message_sv:
      'Kunderna har olika organisationsnummer, momsregistreringsnummer eller personnummer och är alltså olika kunder. Rätta numret på den kund som har fel först, om det är samma kund.',
    message_en:
      'The customers have different org numbers, VAT numbers or personal numbers, so they are different customers. If they are the same customer, correct the wrong number first.',
    remediation: {
      description:
        'details.customer_id is the merged card whose details.field (org_number, vat_number or personal_number) differs from the survivor\'s. Two cards that state different identity numbers are never merged; correct the wrong number with gnubok_update_customer first if they are one customer.',
      tool: 'gnubok_update_customer',
    },
  },
  CUSTOMER_MERGE_SURVIVOR_ARCHIVED: {
    httpStatus: 409,
    message_sv: 'Kunden som ska behållas är arkiverad. Välj en aktiv kund att behålla.',
    message_en: 'The customer to keep is archived. Choose an active customer to keep.',
  },
  CUSTOMER_MERGE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Sammanslagningen kunde inte hittas.',
    message_en: 'Customer merge not found.',
  },
  CUSTOMER_MERGE_ALREADY_UNDONE: {
    httpStatus: 409,
    message_sv: 'Sammanslagningen är redan ångrad.',
    message_en: 'The customer merge has already been undone.',
  },
  CUSTOMER_MERGE_UNDO_EXPIRED: {
    httpStatus: 409,
    message_sv: 'En sammanslagning kan bara ångras inom 30 dagar.',
    message_en: 'A customer merge can only be undone within 30 days.',
  },
  CUSTOMER_MERGE_UNDO_BLOCKED: {
    httpStatus: 409,
    message_sv:
      'Kunden som behölls har sedan slagits ihop med en annan kund. Ångra den sammanslagningen först.',
    message_en: 'The kept customer has since been merged into another customer. Undo that merge first.',
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
  CUSTOMER_ORG_NUMBER_ON_INDIVIDUAL: {
    httpStatus: 400,
    message_sv:
      'En privatperson har inget organisationsnummer. Lämna fältet tomt, ange personnumret som personnummer, eller välj kundtypen Svenskt företag.',
    message_en:
      'An individual customer has no org number. Leave org_number empty, pass the personnummer as personal_number, or choose the customer type Swedish business.',
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

/**
 * Why a supplier invoice was refused as SI_CREATE_INVALID_INPUT: the stable
 * details.reason every door sends, and the sentence each language shows for
 * it. The entry's one sentence was the answer to every refusal, so a customer
 * could not tell what to change (crm#1377, #96). A refusal without a listed
 * reason (a column constraint, an older client) keeps the entry's sentence.
 */
export const SI_CREATE_INVALID_INPUT_REASONS = {
  reverse_charge_kind_without_reverse_charge: {
    message_sv:
      'Varor eller tjänster väljs bara för en faktura med omvänd skattskyldighet. Slå på omvänd skattskyldighet, eller ta bort valet under Köpet avser.',
    message_en: 'reverse_charge_kind is only accepted with reverse charge: set reverse_charge, or omit reverse_charge_kind.',
  },
  reverse_charge_kind_not_eu_supplier: {
    message_sv:
      'Varor eller tjänster väljs bara för en leverantör i ett annat EU-land. Ändra leverantörens typ till EU-företag om den är det, annars ta bort valet under Köpet avser.',
    message_en:
      'reverse_charge_kind is only accepted for a supplier in another EU country (supplier_type eu_business): correct the supplier type, or omit reverse_charge_kind.',
  },
  inbox_item_requires_private_payment: {
    message_sv:
      'Ett underlag från inkorgen registreras här bara som ett utlägg. Välj vem som betalade privat, eller registrera fakturan från inkorgen.',
    message_en:
      'inbox_item_id is only accepted with paid_with_private_funds; register a company-paid inbox item with POST /inbox-items/{id}/convert.',
  },
  inbox_item_not_found: {
    message_sv: 'Underlaget i inkorgen hittades inte. Ladda om sidan och försök igen.',
    message_en: 'inbox_item_id is missing or belongs to another company.',
  },
  inbox_item_already_booked: {
    message_sv: 'Underlaget i inkorgen är redan bokfört. Ladda om sidan för att se fakturan eller verifikationen.',
    message_en: 'The inbox item is already booked: it has a supplier invoice or a verifikat.',
  },
  document_unavailable: {
    message_sv: 'Underlaget hittades inte eller sitter redan på en verifikation. Ladda upp fakturan igen och försök på nytt.',
    message_en: 'document_id is missing, belongs to another company, or is already linked to a verifikat.',
  },
  document_already_used: {
    message_sv: 'Underlaget hör redan till en annan leverantörsfaktura. Ladda upp rätt faktura som underlag.',
    message_en: 'document_id is already the underlag of another supplier invoice.',
  },
  accrual_with_private_payment: {
    message_sv:
      'Ett utlägg kan inte periodiseras, eftersom det bokförs i en enda verifikation när det registreras. Ta bort periodiseringen, eller välj Företaget som betalare.',
    message_en:
      'Periodisering (accrual_period_start/end) is not supported with paid_with_private_funds: an utlägg is booked in one verifikat at registration.',
  },
  accrual_requires_accrual_method: {
    message_sv:
      'Periodisering används bara med faktureringsmetoden, och företaget bokför med kontantmetoden. Ta bort periodiseringen från raderna.',
    message_en:
      'Periodisering (accrual_period_start/end) requires faktureringsmetoden (accounting_method accrual); this company uses kontantmetoden.',
  },
  vat_on_non_vat_registered: {
    message_sv: 'Företaget är inte momsregistrerat och kan inte dra av moms. Ange momssats 0 % och radernas belopp inklusive moms.',
    message_en:
      'The company is not VAT-registered, so supplier invoice lines cannot carry moms: send vat_rate 0 and the amount including VAT.',
  },
  expense_claim_lines_invalid: {
    message_sv: 'Utläggets rader kunde inte bokföras. Kontrollera konto och belopp på varje rad och försök igen.',
    message_en: 'The expense claim lines are invalid: details.detail names the rule.',
  },
  // The MCP inbox staging (gnubok_create_supplier_invoice_from_inbox): the
  // agent reads the thrown English, the Swedish is for the person it relays to.
  due_date_underivable: {
    message_sv:
      'Underlaget saknar förfallodatum och fakturadatumet kan inte läsas som ett datum. Ange fakturadatum och förfallodatum och försök igen.',
    message_en:
      'The underlag has no due date and its invoice date is not an ISO date, so no due date can be derived: pass invoice_date_override or due_date_override.',
  },
  total_missing: {
    message_sv: 'Underlaget saknar ett totalbelopp. Ange fakturans totalbelopp från underlaget och försök igen.',
    message_en: 'The underlag has no usable total: set totals.total from the underlag, then retry.',
  },
  invoice_date_missing: {
    message_sv: 'Underlaget saknar fakturadatum. Ange fakturadatumet från underlaget och försök igen.',
    message_en: 'No invoice date was read from the underlag: pass invoice_date_override from the underlag, then retry.',
  },
  invoice_number_missing: {
    message_sv: 'Underlaget saknar fakturanummer. Ange leverantörens fakturanummer från underlaget och försök igen.',
    message_en: 'No invoice number was read from the underlag: set invoice.invoiceNumber from the underlag, then retry.',
  },
  lines_missing: {
    message_sv: 'Underlaget saknar fakturarader. Lägg in raderna från underlaget och försök igen.',
    message_en: 'No line items were read from the underlag: set lineItems from the underlag, then retry.',
  },
  vat_treatment_unstated: {
    message_sv:
      'Underlaget visar ingen moms och leverantören är inte ett utländskt företag, så momsbehandlingen kan inte läsas från det. Ange om köpet är momsfritt eller har omvänd betalningsskyldighet.',
    message_en:
      'The underlag shows no VAT and the supplier is not typed EU or non-EU: state the VAT treatment (exempt or reverse_charge) from the underlag.',
  },
  limited_deduction_without_seller_vat: {
    message_sv:
      'Begränsat momsavdrag gäller bara avdragsgill moms som leverantören tagit ut, inte när företaget saknar momsregistrering eller köpet har omvänd skattskyldighet, är momsfritt eller är export.',
    message_en:
      'vat_deduction_share only applies to deductible Swedish moms the supplier charged: not for a company outside the VAT register, nor under reverse charge, exempt or export. Omit it.',
  },
  limited_deduction_line_without_vat: {
    message_sv: 'Begränsat momsavdrag kan bara anges på en fakturarad med svensk moms. Kontrollera radnumret och radens momssats.',
    message_en: 'vat_deduction_share names a line without Swedish moms, or a line the invoice does not have: lines are numbered as in items_preview.',
  },
} as const satisfies Record<string, { message_sv: string; message_en: string }>

export type SiCreateInvalidInputReason = keyof typeof SI_CREATE_INVALID_INPUT_REASONS

/** The sentences for a SI_CREATE_INVALID_INPUT refusal's details.reason, or null when it names none listed. */
export function siCreateInvalidInputMessages(details: unknown): { message_sv: string; message_en: string } | null {
  const reason = (details as { reason?: unknown } | null | undefined)?.reason
  if (typeof reason !== 'string' || !Object.hasOwn(SI_CREATE_INVALID_INPUT_REASONS, reason)) return null
  return SI_CREATE_INVALID_INPUT_REASONS[reason as SiCreateInvalidInputReason]
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
    message_en: 'Invalid combination of supplier invoice fields. details.reason names the rule.',
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
  // Feedback seq 983757: the inbox door staged lines incl. VAT as net and
  // credited 2440 with more than the invoice total.
  SI_CREATE_TOTALS_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Fakturaraderna inklusive moms stämmer inte med fakturans totalbelopp. Rätta raderna efter underlaget och försök igen.',
    message_en:
      'The invoice lines including VAT do not add up to the invoice total. Correct the lines from the underlag and try again.',
    remediation: {
      description:
        'Correct lineItems in extracted_data from the underlag: lineTotal is each line amount excluding Swedish VAT, with vatRate 25, 12, 6 or 0. VAT at a foreign rate is not deductible in Sweden and is part of the cost: give that line its amount including the foreign VAT with vatRate 0. Never lower totals.total below what the invoice bills. Then stage again.',
      tool: 'gnubok_set_inbox_extracted_data',
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
  // Upplupen kostnad (29xx) on a supplier invoice line: typed errors from
  // lib/bookkeeping/errors.ts, raised before the registration is posted.
  SI_ACCRUED_COST_PERIOD_INVALID: {
    httpStatus: 400,
    message_sv:
      'En upplupen kostnad (29xx) måste avse månader före fakturamånaden. Perioden fortsätter in i fakturans månad: dela raden i en del för månaderna före fakturamånaden (29xx) och en del för resten (17xx eller kostnadskontot).',
    message_en:
      'An accrued cost (29xx) must cover months before the invoice month. The period reaches the month of the invoice: split the line into the months before the invoice month (29xx) and the rest (17xx or the cost account).',
  },
  // A 17xx deferral of months that ended before the invoice month
  // (accounted#113): those months are an upplupen kostnad (2990, 2960).
  SI_PREPAID_COST_PERIOD_PAST: {
    httpStatus: 400,
    message_sv:
      'Perioden slutar före fakturamånaden, så kostnaden hör till månader som redan har passerat: den är en upplupen kostnad, inte en förutbetald. Välj 2990 (Övriga upplupna kostnader, 2960 för räntekostnader) som balanskonto, så bokförs varje månads kostnad i sin egen månad. På 17xx skulle hela beloppet bokföras på fakturadatumet.',
    message_en:
      'The period ends before the invoice month, so the cost belongs to months that are already over: it is an accrued cost, not a prepaid one. Choose 2990 (Övriga upplupna kostnader, 2960 for interest) as the balance account and each month books in its own month. On 17xx the whole amount would book on the invoice date.',
  },
  SI_ACCRUED_COST_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv:
      'En upplupen kostnad (29xx) bokförs sista dagen i varje månad i perioden, och minst en av månaderna kan inte ta emot verifikationer (låst, stängd, inom företagets låsdatum eller utan räkenskapsår). Kostnaden flyttas inte till en annan månad, så inget har bokförts. Lås upp perioden eller lägg upp räkenskapsåret, eller bokför raden utan periodisering.',
    message_en:
      'An accrued cost (29xx) books on the last day of each month in the period, and at least one of those months cannot take entries (locked, closed, behind the company lock date or without a fiscal year). The cost is never moved to another month, so nothing was booked. Unlock the period or create the fiscal year, or book the line without periodisering.',
    remediation: {
      description:
        'details.blocked lists each month-end date with its reason (company_lock_date_covers, period_locked_at_set, period_is_closed, no_fiscal_period, lookup_failed). Unlock a locked period (gnubok_unlock_period), create the missing fiscal year, or send the line without the accrual fields. Nothing was written.',
      tool: 'gnubok_unlock_period',
    },
  },
  SI_CREATE_SLP_INVALID_ACCOUNT: {
    httpStatus: 400,
    message_sv:
      'Särskild löneskatt kan bara läggas till på rader med pensionskonto 7410-7419 (t.ex. 7412 Premier för tjänstepensioner). Byt konto på raden eller ta bort löneskatten.',
    message_en:
      'Särskild löneskatt (payroll tax on pension costs) can only be added on lines booked to a pension account 7410-7419 (e.g. 7412 occupational pension premiums). Change the line account or remove the flag.',
  },
  // A received document's stated VAT per rate (vat_breakdown) that is not the
  // VAT of its lines: further from the VAT on the summed base than a seller's
  // per-line rounding can be, a rate the lines do not carry or leave out, or
  // a rate whose lines carry their own VAT (lib/vat/document-vat.ts, crm#1367).
  VAT_BREAKDOWN_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Momsen per momssats stämmer inte med raderna. Ange den moms dokumentet anger för varje momssats raderna har, eller utelämna vat_breakdown så räknas momsen på summan per momssats.',
    message_en:
      'The VAT per rate does not match the lines. State the VAT the document gives for every rate the lines carry, or omit vat_breakdown to compute the VAT on the summed base per rate.',
    remediation: {
      description:
        'details names the rate, the stated and computed VAT, the tolerance and the reason (outside_tolerance, rate_not_on_lines, rate_missing, rate_has_overrides, duplicate_rate, cannot_spread). Correct the figure or the lines; a line that needs its own VAT goes in items[].vat_amount instead.',
    },
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
  // crm#1243: a payment made another way beside a bank payment the bank will
  // still execute (lib/payments/orders/signed-payment.ts).
  SI_BANK_PAYMENT_UNDER_WAY: {
    httpStatus: 409,
    message_sv:
      'Fakturan har redan en betalning via banken som är signerad eller signeras just nu, och banken genomför den ändå. Har pengarna redan lämnat kontot: koppla bankraden till fakturan under Transaktioner. Har fakturan betalats på annat sätt eller ska krediteras: avbryt betalningen under Betalningar först.',
    message_en:
      'The invoice already has a bank payment that is signed or being signed, and the bank will still execute it. If the money has already left the account, match the bank row to the invoice under Transactions. If the invoice was paid another way or is to be credited, cancel that payment under Payments first.',
    remediation: {
      description:
        'details.payment_order_id is the open bank payment and details.requested_execution_date the day the bank pays it. Once the money has left, the bank refuses a cancel: match the bank row to the invoice (POST /api/transactions/{id}/match-supplier-invoice, with storno_existing on a row already booked as a verifikat), or wait for the status sync, which lifts this refusal when the bank reports the payment executed. Before that, leave the invoice alone and let that payment settle it when its debit is matched, or cancel the payment order first (POST /api/payments/orders/{id}/cancel; the bank must confirm) and then record the other payment, link the verifikat or credit the invoice.',
    },
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
  // accounted#58: a deferring company's credit of a supplier invoice that has
  // no verifikat books its registration first (the Bokför step). These two
  // refuse the credit when that booking cannot happen; nothing was written.
  SI_CREDIT_ORIGINAL_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv:
      'Leverantörsfakturan saknar verifikation och måste bokföras innan den krediteras, men dess fakturadatum ligger i en låst eller stängd period. Finns kostnaden redan i bokföringen, koppla fakturan till den verifikationen. Annars: lås upp perioden och försök igen.',
    message_en:
      'The supplier invoice has no voucher and must be booked before it is credited, but its invoice date is in a locked or closed period. If the cost is already in the books, link the invoice to that voucher. Otherwise unlock the period and try again.',
    remediation: {
      description:
        'Under faktureringsmetoden with deferred booking, crediting a supplier invoice that has no verifikat first books its registration on its own invoice date (the Bokför step, gnubok_book_supplier_invoice), then posts the credit. details.invoice_date and details.reason say which lock refused it. If the cost is already in the books (a migrated or imported verifikat), link the invoice to it (gnubok_link_supplier_invoice_to_voucher) and credit again. Otherwise unlock that period (gnubok_unlock_period, if it is locked and not closed) and retry. Nothing was written.',
      tool: 'gnubok_unlock_period',
    },
  },
  SI_CREDIT_ORIGINAL_BOOK_FAILED: {
    httpStatus: 400,
    message_sv:
      'Leverantörsfakturan saknar verifikation och kunde inte bokföras, så den har inte krediterats. Finns kostnaden redan i bokföringen, koppla fakturan till den verifikationen. Annars: öppna fakturan och välj Bokför för att se vad som hindrar.',
    message_en:
      'The supplier invoice has no voucher and could not be booked, so it was not credited. If the cost is already in the books, link the invoice to that voucher. Otherwise open the invoice and choose Book to see what stops it.',
    remediation: {
      description:
        "Under faktureringsmetoden with deferred booking, crediting a supplier invoice that has no verifikat first books its registration (the Bokför step, gnubok_book_supplier_invoice), then posts the credit. That booking was refused: details.original_booking_code is the Bokför step's own code (e.g. SI_BOOK_NO_FISCAL_PERIOD). If the cost is already in the books (a migrated or imported verifikat), link the invoice to it (gnubok_link_supplier_invoice_to_voucher) and credit again. Otherwise book the invoice first, fix what that refusal names, then credit it. Nothing was written.",
    },
  },
  // crm#1094: a credit reverses the original's rows, so rows that do not add
  // up to the invoice would take another amount off 2440 than it owes.
  SI_CREDIT_ROWS_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Fakturans rader summerar inte till fakturans belopp, så en kreditering från raderna skulle bokföra fel belopp på leverantörsskulder (2440). Ingenting har bokförts. Bokför kreditfakturan som en egen verifikation.',
    message_en:
      "The invoice's rows do not add up to its amount, so a credit built from them would book the wrong amount on accounts payable (2440). Nothing was booked. Book the credit note as a verifikat of its own.",
    remediation: {
      description:
        'details carries rows_payable_sek (what the rows would take off 244x) and invoice_payable_sek (the invoice total in SEK); the approval of a staged credit returns the same two under data. The stored rows differ from the invoice, or it has no rows at all (rows_payable_sek 0), typically on one imported from another system. Do not retry. Hand over to the user: book the credit note as its own verifikat, reversing what the invoice\'s own verifikat booked (debit 2440 by the invoice total, credit the cost accounts and 2641). An original that is still unpaid then stays open in the leverantörsreskontra: once that verifikat is posted, close the invoice against it with gnubok_link_supplier_invoice_to_voucher (its debit on 244x settles the invoice, which then shows as paid; no second verifikat is posted).',
    },
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
      'Företagets bankuppgifter för betalfilen är ofullständiga. Filen betalar från det primära bankkontot, kontot lönerna bokförs på: fyll i kontots IBAN (och BIC om det inte kan härledas) under Inställningar → Fakturor, Bankkonton för kundfakturor. Har företaget Swedbank behövs även SignerID och avtals-id (Corporate Pay) från Swedbank, och har det Nordea behövs Nordeas Signer ID och avtals-ID (CCM-avtalet).',
    message_en:
      'The company bank details the payment file needs are incomplete. The file pays from the primary bank account, the account salaries are booked on: enter that account\'s IBAN (and BIC if it cannot be derived) under Settings → Invoices, Bank accounts for customer invoices. A Swedbank company also needs the SignerID and Corporate Pay agreement id Swedbank assigned, and a Nordea company the Signer ID and CCM agreement id Nordea assigned.',
    remediation: {
      description:
        'details.missing names what is lacking. For iban and bic, details.account names the paying account (cash_account_id, name, ledger_account): fill in its IBAN or BIC, or make another bank account primary. org_number, swedbank_ids, nordea_signer_id, nordea_agreement_id and bankgiro are company settings.',
    },
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
  SI_DELETE_HAS_BANK_PAYMENT: {
    httpStatus: 409,
    message_sv:
      'Leverantörsfakturan har en betalning som skickats till banken och kan inte tas bort: betalningen är underlag för betalningsinstruktionen.',
    message_en:
      'The supplier invoice has a payment that was sent to the bank and cannot be deleted: the payment documents the payment instruction.',
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
  // ── Self-billing on the purchase side (självfaktura, crm#1367) ──
  SI_DELETE_SELF_BILLED: {
    httpStatus: 400,
    message_sv:
      'En utfärdad självfaktura kan inte tas bort: numret är taget ur er serie och säljaren kan ha fått dokumentet. Kreditera den i stället.',
    message_en:
      'An issued self-billing invoice cannot be deleted: its number is taken from the company series and the seller may have the document. Credit it instead.',
  },
  SI_SELF_BILL_AGREEMENT_MISSING: {
    httpStatus: 400,
    message_sv:
      'Det finns inget självfaktureringsavtal med leverantören. Lägg in avtalet på leverantörskortet eller ange det på fakturan.',
    message_en:
      'There is no self-billing agreement with this supplier (ML 2023:200 17 kap 15 §). Set self_billing_agreement_ref on the supplier or on the invoice.',
    remediation: {
      description: 'Set the agreement reference on the supplier (self_billing_agreement_ref) or pass it on the invoice.',
    },
  },
  SI_SELF_BILL_PARTY_INCOMPLETE: {
    httpStatus: 400,
    message_sv:
      'Självfakturan saknar uppgifter som måste stå på den: säljarens namn, adress och momsregistreringsnummer, eller ert företagsnamn, organisationsnummer och adress. Komplettera leverantörskortet eller företagsinställningarna.',
    message_en:
      'The self-billing invoice lacks a field it must print (ML 2023:200 17 kap 24 §): details.missing names the seller (supplier card) or buyer (company settings) fields to fill in.',
  },
  SI_SELF_BILL_UNSUPPORTED: {
    httpStatus: 400,
    message_sv:
      'Den här självfakturan kan inte utfärdas här: självfakturor görs i SEK med svensk moms, utan omvänd betalningsskyldighet, bifogat underlag eller privat betalning.',
    message_en:
      'This self-billing invoice cannot be issued: SEK only, standard Swedish VAT only, no reverse charge, no document_id, inbox_item_id or paid_with_private_funds; a self-billing credit note takes no number, document or inbox item of its own. details.reason names the cause.',
  },
  SI_SELF_BILL_IMMUTABLE: {
    httpStatus: 409,
    message_sv:
      'Numret, datumet, avtalet och parterna på en utfärdad självfaktura kan inte ändras. Kreditera den och utfärda en ny.',
    message_en:
      'The number, date, agreement and parties of an issued self-billing invoice cannot change. Credit it and issue a new one.',
  },
  SI_SELF_BILL_NUMBER_ASSIGNED: {
    httpStatus: 400,
    message_sv: 'En självfaktura får sitt nummer ur er serie och kan inte ges ett eget.',
    message_en: 'A self-billing invoice takes its number from the company series; do not supply one.',
  },
  SI_SELF_BILL_DOCUMENT_UNAVAILABLE: {
    httpStatus: 500,
    message_sv: 'Självfakturans dokument kunde inte skapas. Försök igen eller kontakta supporten.',
    message_en: 'The self-billing invoice document could not be rendered.',
    retryable: true,
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
  // A credit note rests at 'credited' like its original, so its own id once
  // passed for the original's: the preview restored the credit note as an
  // invoice to pay, a write supplier_invoices_credit_note_not_payable refuses.
  // The original is the way only while it is credited by this credit note:
  // most imported credit notes are linked to no original (credited_invoice_id
  // null, and uncredit finds a credit note only through that link), an
  // imported original often rests at 'paid', and a reversed credit note's
  // original may since carry a newer credit. Each case is said.
  SI_UNCREDIT_CREDIT_NOTE: {
    httpStatus: 400,
    message_sv:
      'En kreditering ångras på originalfakturan, inte på kreditfakturan. Är kreditfakturan kopplad till en krediterad originalfaktura och inte redan ångrad, gå till originalfakturan och välj "Ångra kreditering" där. Annars går krediteringen inte att ångra här.',
    message_en:
      'This id is a credit note; a credit is undone on its original invoice. Send the original\'s id from details.credited_invoice_id while this credit note is not reversed (details.credit_note_status). Otherwise its credit cannot be undone here: a null credited_invoice_id links no original, and a reversed credit note is already undone.',
    remediation: {
      description:
        'Call uncredit again with the original invoice id in details.credited_invoice_id. Not when details.credit_note_status is reversed: that credit is already undone, and uncredit on the original would undo a newer credit instead. When credited_invoice_id is null, ask the person what to do: uncredit finds a credit note only through that link, so calling it on an original picked by hand would restore that invoice and leave this credit note in place. An original that is not credited answers changed=false: nothing is left to undo.',
      tool: 'gnubok_uncredit_supplier_invoice',
    },
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
      'Raden räknas fram av lönekörningen och skrivs om vid varje beräkning. Ändra underlaget i stället: frånvaron, de arbetade timmarna, förmånen, den återkommande raden eller semesterdagarna på semesterraden. En engångsrad för övertid eller OB läggs som Övertid eller Övrigt.',
    message_en:
      'This payslip line is derived by the salary calculation and rewritten on every calculation. Change its source instead: the absence, the worked hours and premium rules, the benefit, the recurring line or the days on the vacation line (an amount on that line replaces the derived vacation pay). Put a one-off overtime or OB amount on item_type overtime or other.',
    remediation: {
      description:
        'Absence: gnubok_register_absence / gnubok_delete_absence. Hours: gnubok_set_worked_days. Förmåner: gnubok_update_employee_benefit. Recurring lines: gnubok_update_employee_recurring_line. A one-off amount: gnubok_add_payslip_line with item_type overtime or other. Then gnubok_calculate_salary_run.',
    },
    retryable: false,
  },
  // lib/salary/vacation-days-pay.ts (issue #85): a vacation line without an
  // amount whose days the law and the data cannot price (procentregeln
  // without a whole base year in Accounted, hourly pay on sammalöneregeln,
  // hourly förskott, vacation pay already paid as semesterersättning). The
  // thrower's sentences name each employee and the fix; details.issues
  // carries them per employee in both languages.
  SALARY_RUN_VACATION_PAY_UNDETERMINED: {
    httpStatus: 400,
    message_sv:
      'Semesterlönen för de uttagna semesterdagarna kan inte räknas fram. Ange beloppet på semesterraden eller ändra dagarnas kategori, och beräkna om.',
    message_en:
      'The pay for the vacation days taken cannot be calculated. Put the amount on the vacation line or change the days\' category, then calculate again.',
    remediation: {
      description:
        'Read details.issues (employee, message_en). Either put the amount on the vacation line yourself (gnubok_update_payslip_line with amount, or quantity and unit_price: a line with an amount is paid as entered and never re-derived), change the vacation_category (unpaid or advance) when the days are not paid days, or fix the employee (salary_type, vacation_rule) the message names. Then gnubok_calculate_salary_run. Never estimate a procentregeln base: ask the user for the semesterlön.',
      tool: 'gnubok_update_payslip_line',
    },
    retryable: false,
    thrown_message_sv: true,
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
  // Semesterlöneskuld remeasurement (lib/salary/vacation-liability-reconcile.ts).
  VACATION_LIABILITY_DATE_AHEAD: {
    httpStatus: 400,
    message_sv: 'Semesterlöneskulden kan bara stämmas av per ett datum som har passerat.',
    message_en: 'The vacation liability can only be reconciled as of a date that has passed.',
    retryable: false,
  },
  VACATION_LIABILITY_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv: 'Inget räkenskapsår täcker datumet. Lägg upp räkenskapsåret först.',
    message_en: 'No fiscal year covers the date. Create the fiscal year first.',
    retryable: false,
  },
  VACATION_LIABILITY_RECONCILE_FAILED: {
    httpStatus: 500,
    message_sv: 'Semesterlöneskulden kunde inte stämmas av. Försök igen.',
    message_en: 'The vacation liability could not be reconciled. Try again.',
    retryable: true,
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
  SALARY_RUN_NOT_CALCULATED: {
    httpStatus: 400,
    message_sv: 'Lönekörningen måste beräknas innan bokföring.',
    message_en: 'Salary run must be calculated before booking.',
    remediation: {
      description:
        'Calculate the run: gnubok_calculate_salary_run or POST /salary-runs/{id}/calculate. Only a draft calculates, so a run in review goes back first: gnubok_revert_salary_run or POST /salary-runs/{id}/revert.',
    },
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
  SALARY_RUN_APPROVE_FAILED: {
    httpStatus: 500,
    message_sv: 'Lönekörningen kunde inte godkännas.',
    message_en: 'Failed to approve salary run.',
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
  // Semesterlagen 16 § andra stycket 3-4 (lib/salary/employee-update-rules.ts):
  // a changed employment_degree moves a sammalöneregeln employee to
  // procentregeln unless a central kollektivavtal deviates (2 a §).
  EMPLOYEE_SAMMALONEREGELN_DEGREE_CHANGED: {
    httpStatus: 400,
    message_sv:
      'Sysselsättningsgraden ändras för en anställd med sammalöneregeln. Enligt semesterlagen 16 § andra stycket 3-4 beräknas semesterlönen då enligt procentregeln: byt semesterregel till procentregeln i samma ändring, eller bekräfta att ett centralt kollektivavtal tillåter sammalöneregeln (semesterlagen 2 a §).',
    message_en:
      'The employment degree changes for an employee on sammalöneregeln. Semesterlagen 16 § second paragraph points 3-4 then calculates holiday pay under procentregeln: set vacation_rule to procentregeln in the same update, or send sammaloneregeln_kollektivavtal_confirmed: true if a central kollektivavtal keeps sammalöneregeln (semesterlagen 2 a §).',
    remediation: {
      description:
        'Resend the same update with vacation_rule: "procentregeln", or with sammaloneregeln_kollektivavtal_confirmed: true when a central kollektivavtal applies. The confirmation is recorded in the audit log with who gave it.',
    },
  },
  // OB / overtime premium rules (shift_premium_rules, lib/salary/shift-premium-rules.ts).
  SHIFT_PREMIUM_RULE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Regeln för OB eller övertid kunde inte hittas.',
    message_en: 'Premium rule not found.',
  },
  SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'En eller flera valda anställda finns inte i företaget.',
    message_en: 'One or more selected employees do not belong to the company.',
  },
  SHIFT_PREMIUM_RULE_SCOPE_INVALID: {
    httpStatus: 400,
    message_sv: 'Välj antingen alla anställda eller minst en namngiven anställd.',
    message_en: 'Choose either all employees or at least one named employee.',
  },
  // The merged row after a PATCH would carry the fields of two amount forms,
  // or none: the DB CHECK refuses it too, this names it first.
  SHIFT_PREMIUM_RULE_FORM_INVALID: {
    httpStatus: 400,
    message_sv:
      'Ange exakt ett belopp som passar beräkningssättet: procent för procent av timlön, delare för månadslön delat med, kronor för kronor per timme.',
    message_en:
      'Send exactly the amount field of the chosen form: premium_percent for percent_of_hourly, monthly_divisor for monthly_divisor, sek_per_hour for sek_per_hour.',
  },
  // A monthly_divisor rule prices an hour from the månadslön; an hourly-paid
  // employee has none, so naming one is refused instead of paying 0 kr.
  SHIFT_PREMIUM_RULE_HOURLY_EMPLOYEE: {
    httpStatus: 400,
    message_sv:
      'Månadslön delat med gäller bara månadsavlönade. Välj procent av timlön eller kronor per timme för timavlönade.',
    message_en:
      'The monthly_divisor form applies to monthly-paid employees only. Use percent_of_hourly or sek_per_hour for hourly-paid employees.',
  },
  SHIFT_PREMIUM_RULE_VALIDITY_INVALID: {
    httpStatus: 400,
    message_sv: 'Slutdatumet kan inte ligga före startdatumet.',
    message_en: 'valid_to cannot be before valid_from.',
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
  // lib/salary/payout-date.ts paymentDateAheadRefusal (crm#1216): marking a
  // run paid or booking it before its payment date needs an explicit
  // confirmation at every door, since the salary verifikat credits the net
  // pay to the bank account on that date. Confirmed, it goes through.
  SALARY_RUN_PAYMENT_DATE_AHEAD_UNCONFIRMED: {
    httpStatus: 422,
    message_sv:
      'Lönens utbetalningsdag har inte kommit än. Nettolönen bokförs som utbetald från bankkontot på utbetalningsdagen, så markera körningen som betald och bokför den när lönen har gått ut. Är lönen redan utbetald, eller ligger betalningen klar i banken, bekräfta det och försök igen.',
    message_en:
      'The salary payment date (details.payment_date) has not come yet. The net pay is posted as paid out of the bank account on that date, so mark the run paid and book it once the salary has gone out. If it has already been paid, or the payment is scheduled in the bank, send confirm_payment_date_ahead: true.',
    remediation: {
      description:
        'Ask the user whether the salaries have already been paid or the payment file is scheduled in the bank. If so, call again with confirm_payment_date_ahead: true; otherwise wait until details.payment_date.',
    },
    retryable: false,
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
  // lib/salary/payslips/send.ts (crm#1658): a send to named employees names
  // one who is not on the run, so nothing was sent to anyone.
  SALARY_PAYSLIPS_EMPLOYEE_NOT_ON_RUN: {
    httpStatus: 400,
    message_sv: 'En eller flera av de valda anställda finns inte i lönekörningen. Inga lönebesked skickades.',
    message_en: 'One or more of the chosen employees are not on the salary run. No payslips were sent.',
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
  // gnubok_agi_submit stages only a run whose underlag has been generated (and
  // so reviewed); approval regenerates it from current data before posting.
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
  // Another live run is paid out in the same month: it holds the period's
  // declaration, or it has none yet and this one would leave its pay out
  // (crm#1768). details.other_runs, when present, lists them.
  AGI_PERIOD_CONFLICT: {
    httpStatus: 409,
    message_sv:
      'En annan lönekörning har också utbetalning i samma redovisningsperiod (utbetalningsmånad). Arbetsgivardeklarationen för en månad ska omfatta alla utbetalningar den månaden, och Accounted kan ännu inte slå ihop flera lönekörningar till en deklaration. Lämna in deklarationen för månaden med summan av körningarna i Skatteverkets e-tjänst.',
    message_en:
      "Another salary run is also paid out in the same reporting period (payout month). The employer declaration for a month must cover every payment made that month, and Accounted cannot yet combine several salary runs into one declaration. File the month's declaration with the sum of the runs in Skatteverket's e-service.",
    remediation: {
      description:
        "details.other_salary_run_id (and details.other_runs) name the other runs paid out in details.period. Do not generate or submit the AGI for one of them alone: it would declare only that run, and a second declaration for the month does not add to the first (an individuppgift with the same specifikationsnummer replaces the earlier one). Tell the user to file the month in Skatteverket's e-service with the runs' combined figures.",
    },
  },
  // The paying side of AGI_PERIOD_CONFLICT (crm#1768): an unfiled declaration
  // stored before the generator refused its month holds one run's totals, so
  // the tax payment file and the skattekonto payment named from it (or from
  // its due date) refuse it (lib/deadlines/agi-payable-declaration.ts).
  AGI_PAYMENT_PERIOD_CONFLICT: {
    httpStatus: 409,
    message_sv:
      'En annan lönekörning har också utbetalning i samma redovisningsperiod (utbetalningsmånad), och arbetsgivardeklarationen som Accounted har för månaden räknar bara med en av körningarna. Dess belopp betalas därför inte från Accounted. Lämna in deklarationen för månaden med summan av körningarna i Skatteverkets e-tjänst och betala det belopp den ger.',
    message_en:
      "Another salary run is also paid out in the same reporting period (payout month), and the employer declaration Accounted holds for the month covers only one of the runs. Its amount is therefore not paid from Accounted. File the month's declaration with the sum of the runs in Skatteverket's e-service and pay the amount it gives.",
    remediation: {
      description:
        "details.other_runs (first: details.other_salary_run_id) name the other live runs paid out in details.period. The stored declaration covers one run, so its total is not what the month owes: do not pay it from the tax payment file, a skattekonto payment with source agi, or source due_date for its due day (pay the momsdeklaration due that day with source vat_declaration). Tell the user to file the month in Skatteverket's e-service with the runs' combined figures; the amount that filing gives can then be paid as a skattekonto payment with an amount and no source.",
    },
  },
  // generateAgiDeclaration writes the period's declaration only if it still
  // holds what was read (salary run and status); two misses in a row answer
  // this instead of writing over whatever got there first (#58).
  AGI_GENERATION_CONFLICT: {
    httpStatus: 409,
    message_sv:
      'Arbetsgivardeklarationen för perioden ändrades medan den skapades, till exempel av en annan generering eller en inlämning. Ladda om och försök igen.',
    message_en:
      'The employer declaration for the period changed while it was being generated, for example by another generation or a submission. Reload and try again.',
    retryable: true,
  },
  // Fora's monthly file (lib/salary/fora): details.issues names each blocker.
  FORA_REPORT_INCOMPLETE: {
    httpStatus: 400,
    message_sv:
      'Fora-filen kan inte skapas ännu. Åtgärda det som står i listan (organisationsnummer, adress för samordningsnummer eller Fora-kod på de anställda) och försök igen.',
    message_en:
      'The Fora file cannot be created yet. Fix what details.issues lists (organisation number, an address for a samordningsnummer, or a Fora code on the employees) and try again.',
    retryable: false,
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
  // A deleted company's archive after its 18-month export window (terms 9.3,
  // lib/company/deleted-company-export). 410: the window does not reopen;
  // the records stay sealed until the BFL archiving period has run out.
  DELETED_COMPANY_EXPORT_CLOSED: {
    httpStatus: 410,
    message_sv: 'Tiden för att ladda ner arkivet för det raderade företaget har gått ut. Kontakta supporten om du behöver uppgifter ur bokföringen.',
    message_en: 'The window for downloading this deleted company\'s archive has closed (18 months after the deletion). The records are sealed; contact support for accounting records still under the BFL retention period.',
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
  // The voucher DELETE refuses these up front (lib/core/bookkeeping/voucher-
  // delete-guard.ts) with the same sentences get-error-message.ts gives the
  // triggers' own refusals (PH 212, crm#1438).
  JOURNAL_ENTRY_DELETE_SIE_BATCH_ENTRY: {
    httpStatus: 409,
    message_sv:
      'Verifikationen kommer från en SIE-import och kan inte raderas en och en. Ångra hela importen under Bokföring > Importera/Exportera > Importhistorik: alla verifikationer i importen makuleras då med storno, och filen kan importeras igen.',
    message_en:
      'This voucher was posted by an SIE import and cannot be deleted on its own. Undo the whole import under Import history: every voucher of the import is then reversed by storno, and the file can be imported again.',
    retryable: false,
    remediation: {
      description:
        'An SIE-imported verifikat leaves the ledger only with its whole import (retain_sie_batch_entry). Undo the import (gnubok_undo_sie_import, stages for approval; gnubok_sie_import_status shows its state), or correct this one verifikat by storno (gnubok_reverse_journal_entry). Never delete vouchers one by one to redo an import.',
      tool: 'gnubok_undo_sie_import',
      resource: '/import?mode=sie',
    },
  },
  JOURNAL_ENTRY_DELETE_SIE_UNDO_STORNO: {
    httpStatus: 409,
    message_sv:
      'Verifikationen makulerar en ångrad SIE-import och kan inte raderas: då blir importens verifikationer aktiva igen. Importera filen på nytt under Bokföring > Importera/Exportera, eller börja om med tomma verifikationsserier med Gör om migrering under Inställningar > Företaget > Företagsuppgifter > Riskzon.',
    message_en:
      'This voucher reverses an undone SIE import and cannot be deleted: the import\'s vouchers would become active again. Import the file again, or start over with empty voucher series via Redo migration under Settings > Company.',
    retryable: false,
    remediation: {
      description:
        'The storno belongs to an undone or replaced SIE import (retain_sie_undo_reversal). To bring the vouchers back, import the file again (gnubok_import_sie). To start the books over, the owner uses Redo migration (Gör om migrering) under Settings > Company in the app.',
      tool: 'gnubok_import_sie',
      resource: '/settings/company',
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
      'Företagets bankuppgifter för betalfilen saknas eller är ogiltiga. ISO 20022 (pain.001) betalar från bankkontot som nettolönen bokförs på och behöver kontots IBAN och BIC, för Swedbank även SignerID och avtals-id (Corporate Pay) och för Nordea Signer ID och avtals-ID (CCM-avtalet); Bankgirot LB behöver företagets bankgironummer. Fyll i dem under Inställningar → Fakturor.',
    message_en:
      'The company bank details the payment file needs are missing or invalid. ISO 20022 (pain.001) pays from the bank account the net pay is booked on and needs that account\'s IBAN and BIC, for Swedbank also the SignerID and Corporate Pay agreement id, and for Nordea the Signer ID and CCM agreement id; Bankgirot LB needs the company bankgiro number. Fill them in under Settings → Invoices.',
    remediation: {
      description:
        'details.problem names what is missing. For iban_missing and bic_missing, details.account names the paying account (cash_account_id, name, ledger_account): a booked run pays from the account its salary verifikat credits, any other run from the primary bank account. Fill in that account\'s IBAN or BIC, or (for a run not yet booked) make another bank account primary.',
    },
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
  SALARY_RUN_PAYMENT_FILE_NEW_VERSION_UNCONFIRMED: {
    httpStatus: 422,
    message_sv:
      'En ny version av betalfilen kräver en bekräftelse på att den tidigare filen inte har godkänts i banken. Två godkända filer betalar ut lönen två gånger.',
    message_en:
      'A new version of the payment file needs a confirmation that the earlier file was not approved at the bank. Two approved files pay the salaries twice.',
  },
  SALARY_RUN_PAYMENT_FILE_NEW_VERSION_UNSUPPORTED: {
    httpStatus: 422,
    message_sv: 'Bara en ISO 20022-fil (pain.001) kan få en ny version. Bankgirot LB-filen har inga meddelande-id.',
    message_en: 'Only an ISO 20022 file (pain.001) can get a new version. The Bankgirot LB file has no message ids.',
  },
  // A correction run pays only the difference against the run it corrects
  // (lib/salary/payment/payable.ts); with no positive difference there is no file.
  SALARY_RUN_PAYMENT_FILE_NOTHING_TO_PAY: {
    httpStatus: 422,
    message_sv:
      'Rättelsen ger ingen skillnad att betala ut jämfört med den tidigare körningen, så ingen betalfil behövs. details.correction.overpaid anger anställda som har fått för mycket.',
    message_en:
      'The correction leaves no difference to pay out compared with the earlier run, so no payment file is needed. details.correction.overpaid names employees who were paid too much.',
  },
  // Paying a salary run through the bank (lib/salary/payment/pay-via-bank.ts,
  // migration 20261027100000): one payment per employee, signed with BankID.
  SALARY_RUN_IN_BANK_PAYMENT: {
    httpStatus: 409,
    message_sv:
      'Lönen betalas via banken. Avbryt betalningarna under Betalningar först, annars betalas lönen ut två gånger.',
    message_en:
      'The salaries are being paid through the bank. Cancel those payments under Payments first, or the salaries are paid twice.',
  },
  SALARY_RUN_BANK_PAYMENT_NOT_READY: {
    httpStatus: 409,
    message_sv: 'Lönekörningen måste vara godkänd innan lönen kan betalas via banken.',
    message_en: 'The salary run must be approved before the salaries can be paid through the bank.',
  },
  SALARY_RUN_BANK_PAYMENT_CONFIRMATION_REQUIRED: {
    httpStatus: 409,
    message_sv:
      'Bekräfta att lönen inte redan har betalats ut, med betalfil eller i internetbanken. Annars betalas den ut två gånger.',
    message_en:
      'Confirm that the salaries have not already been paid, by payment file or in the online bank. Otherwise they are paid twice.',
  },
  SALARY_RUN_BANK_PAYMENT_NOTHING_TO_PAY: {
    httpStatus: 409,
    message_sv: 'Alla anställda i lönekörningen har redan en betalning via banken. Se Betalningar.',
    message_en: 'Every employee on the salary run already has a bank payment. See Payments.',
  },
  SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_MISSING: {
    httpStatus: 422,
    message_sv:
      'En eller flera anställda med nettoutbetalning saknar clearingnummer eller kontonummer. Komplettera bankuppgifterna under Anställda.',
    message_en:
      'One or more employees with a net payout lack a clearing number or account number. Complete their bank details under Employees.',
  },
  SALARY_RUN_BANK_PAYMENT_EMPLOYEE_BANK_INVALID: {
    httpStatus: 422,
    message_sv:
      'En eller flera anställda har bankuppgifter som banken inte kan betala till. details.employees anger vem och vad som behöver rättas.',
    message_en:
      'One or more employees have bank details the bank cannot pay to. details.employees names who and what to correct.',
    thrown_message_sv: true,
  },
  SALARY_RUN_BANK_PAYMENT_ALREADY_IN_PAYMENT: {
    httpStatus: 409,
    message_sv: 'Lönen förbereddes samtidigt i en annan flik. Öppna dialogen igen.',
    message_en: 'The salaries were prepared at the same time elsewhere. Open the dialog again.',
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
    remediation: {
      description:
        'details.found_columns lists the columns the file has. Pass `format` to force a bank format, or export the statement as CSV, Excel or camt.053 from the bank.',
    },
    // The route names the columns it found in the file.
    thrown_message_sv: true,
  },
  BANK_FILE_COLUMNS_UNRECOGNIZED: {
    httpStatus: 400,
    message_sv: 'Bankfilens kolumner kändes inte igen.',
    message_en: "The bank file's columns were not recognized.",
    remediation: {
      description:
        'details.found_columns lists the columns the file has, details.expected_columns what the format reads (a date column and an amount column). Export the statement again from the bank, or map the columns by hand with format=generic_csv in the app.',
    },
    // The message names the columns found and the ones expected.
    thrown_message_sv: true,
  },
  BANK_IMPORT_DUPLICATE_OTHER_COMPANY: {
    httpStatus: 409,
    message_sv: 'Den här filen har redan importerats för ett annat företag av samma användare.',
    message_en: 'This file has already been imported into another company by this user.',
  },
}

const COMPANY: Record<string, StructuredErrorEntry> = {
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
  // The approval view's own door (mcp-server/view-approval.ts): refused
  // whenever the call cannot be shown to be a person's click in the view.
  VIEW_APPROVAL_UNAVAILABLE: {
    httpStatus: 403,
    message_sv: 'Godkännandet kunde inte tas emot från granskningsrutan. Inget bokfördes.',
    message_en: "The approval could not be taken from the approval view. Nothing was booked.",
    retryable: false,
    remediation: {
      description: 'Only the approval view calls this tool. Approve with gnubok_approve_pending_operation, which records the approval as yours.',
    },
  },
}

// ─────────────────────────────────────────────────────────────────
// The user's own account (POST /api/account/password)
// ─────────────────────────────────────────────────────────────────

const ACCOUNT_SECURITY: Record<string, StructuredErrorEntry> = {
  // The password WAS written, and the auth server did not confirm the logout
  // of the user's other sessions that follows it (CASA 2.2.2). A 500 and
  // never retryable: the same password sent again is refused as unchanged,
  // so the way out is signing out everywhere, not another attempt.
  // details.passwordChanged tells a client so (lib/auth/password-change-result.ts).
  PASSWORD_CHANGED_REVOCATION_UNCONFIRMED: {
    httpStatus: 500,
    message_sv:
      'Lösenordet är sparat, men vi kunde inte bekräfta att dina andra enheter loggades ut. Logga ut från alla enheter och logga in igen med det nya lösenordet.',
    message_en:
      'The password was saved, but your other devices could not be confirmed signed out. Sign out of all devices and sign in again with the new password.',
    retryable: false,
    remediation: {
      description:
        'Do not send the same password again: it is already set (details.passwordChanged is true) and an unchanged password is refused. Sign the user out of all devices, then sign in with the new password.',
    },
  },
}

// ─────────────────────────────────────────────────────────────────
// Service accounts (lib/service-accounts, migration 20261016120000)
// ─────────────────────────────────────────────────────────────────

const SERVICE_ACCOUNT: Record<string, StructuredErrorEntry> = {
  // Answered at authentication for every key of the account: the key itself
  // is live, so this is a company decision, not an integrator mistake.
  SERVICE_ACCOUNT_SUSPENDED: {
    httpStatus: 403,
    message_sv:
      'Tjänstekontot är vilande: personen som ansvarar för det är inte längre ägare eller administratör i företaget. Nyckeln fungerar igen när en ägare återställer rollen, annars behövs ett nytt tjänstekonto med en annan ansvarig.',
    message_en:
      'The service account is suspended: its sponsor is no longer an owner or admin of the company. Its keys work again once the sponsor is an owner or admin again; otherwise create a new service account with another sponsor.',
    retryable: false,
    remediation: {
      description:
        'Ask a company owner to restore the sponsor role, or create a new service account with a current owner or admin as sponsor and mint a key for it.',
    },
  },
  SERVICE_ACCOUNT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Tjänstekontot finns inte i det här företaget.',
    message_en: 'No such service account in this company.',
    retryable: false,
  },
  SERVICE_ACCOUNT_KEY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Nyckeln hör inte till det här tjänstekontot.',
    message_en: 'No such key on this service account.',
    retryable: false,
  },
  SERVICE_ACCOUNT_REVOKED: {
    httpStatus: 409,
    message_sv: 'Tjänstekontot är återkallat och kan inte få nya nycklar.',
    message_en: 'The service account is revoked: it cannot get new keys.',
    retryable: false,
  },
  SERVICE_ACCOUNT_SPONSOR_INVALID: {
    httpStatus: 422,
    message_sv: 'Den ansvariga personen måste vara ägare eller administratör i företaget.',
    message_en: 'The sponsor must be an owner or admin member of the company.',
    retryable: false,
  },
  SERVICE_ACCOUNT_NAME_TAKEN: {
    httpStatus: 409,
    message_sv: 'Företaget har redan ett aktivt tjänstekonto med det namnet.',
    message_en: 'The company already has a live service account with this name.',
    retryable: false,
  },
  SERVICE_ACCOUNT_LIMIT: {
    httpStatus: 409,
    message_sv: 'Företaget har nått gränsen på 25 aktiva tjänstekonton. Återkalla ett som inte används.',
    message_en: 'The company has reached the limit of 25 live service accounts. Revoke one that is no longer used.',
    retryable: false,
  },
  SERVICE_ACCOUNT_KEY_LIMIT: {
    httpStatus: 409,
    message_sv: 'Tjänstekontot har redan 5 aktiva nycklar. Återkalla en innan du skapar en ny.',
    message_en: 'The service account already has 5 live keys. Revoke one before minting another.',
    retryable: false,
  },
  SERVICE_ACCOUNT_ADMIN_REQUIRED: {
    httpStatus: 403,
    message_sv: 'Endast ägare och administratörer kan hantera tjänstekonton.',
    message_en: 'Only owners and admins can manage service accounts.',
    retryable: false,
  },
  SERVICE_ACCOUNT_SCOPE_NOT_HELD: {
    httpStatus: 403,
    message_sv: 'En nyckel för ett tjänstekonto kan bara få behörigheter som den anropande nyckeln själv har.',
    message_en: 'A service-account key can only be given scopes the calling key holds itself.',
    retryable: false,
    remediation: {
      description: 'Drop the scopes listed in details.not_held, or call with a key that holds them.',
    },
  },
  SERVICE_ACCOUNT_KEY_NOT_PERMITTED: {
    httpStatus: 403,
    message_sv: 'En tjänstekontonyckel kan inte hantera tjänstekonton. Använd en nyckel som tillhör en person.',
    message_en: "A service account's key cannot manage service accounts. Use a key that belongs to a person.",
    retryable: false,
  },
}

// ─────────────────────────────────────────────────────────────────
// Agent identities (migration 20261029100000)
// ─────────────────────────────────────────────────────────────────

const AGENT_IDENTITY: Record<string, StructuredErrorEntry> = {
  // Answered at authentication for every key of a paused agent, on every
  // door (MCP, REST v1, /api/events). The key itself is live: only the
  // sponsor can lift it, so the message is written for the agent to relay.
  AGENT_PAUSED: {
    httpStatus: 403,
    message_sv:
      'Den här agenten är pausad i Accounted. Den som ansvarar för den kan återuppta den under Inställningar.',
    message_en:
      'This agent is paused in Accounted. The person responsible for it can resume it under Settings.',
    retryable: false,
    remediation: {
      description:
        'Stop and tell the user the agent is paused; do not retry or reconnect. The person responsible for the agent resumes it under Settings in Accounted.',
    },
  },
}

// ─────────────────────────────────────────────────────────────────
// The built-in assistant chat (lib/env/assistant-chat-switch.ts)
// ─────────────────────────────────────────────────────────────────

const ASSISTANT_CHAT: Record<string, StructuredErrorEntry> = {
  // POST /api/agent/invoke and POST /api/agent/ask while the installation
  // has the chat switched off (ASSISTANT_CHAT_ENABLED): no turn runs, and the
  // sentence says where the person's own assistant connects. 409 like the
  // other switched-off answers, and never 503: the chat console reads a 503
  // as "no AI backend configured". Every intent is refused.
  ASSISTANT_CHAT_OFF: {
    httpStatus: 409,
    message_sv: 'Chatten är avstängd. Koppla din egen assistent, till exempel Claude, under Agenter > Koppla en agent.',
    message_en: 'The chat is switched off. Connect your own assistant, for example Claude, under Agents > Connect an agent.',
    retryable: false,
  },
}

// ─────────────────────────────────────────────────────────────────
// Package switches (enable_package, disable_package; lib/suggestions)
// ─────────────────────────────────────────────────────────────────

const PACKAGE: Record<string, StructuredErrorEntry> = {
  PACKAGE_NOT_SWITCHABLE: {
    httpStatus: 400,
    message_sv: 'Den här delen av Accounted går inte att slå på eller stänga av.',
    message_en: 'This package cannot be switched on or off.',
    retryable: false,
  },
  PACKAGE_SWITCH_ADMIN_REQUIRED: {
    httpStatus: 403,
    message_sv: 'Endast ägare och administratörer kan slå på eller stänga av delar av Accounted.',
    message_en: 'Only owners and admins can switch packages on or off.',
    retryable: false,
  },
  PACKAGE_SWITCH_NEEDS_PERSON: {
    httpStatus: 403,
    message_sv: 'En person i företaget behöver godkänna det här, inte ett tjänstekonto.',
    message_en: 'A person in the company has to approve this, not a service account.',
    retryable: false,
  },
  PACKAGE_HAS_OPEN_OBLIGATIONS: {
    httpStatus: 409,
    message_sv: 'Paketet kan inte stängas av medan något är öppet där.',
    message_en: 'The package cannot be switched off while something is still open in it.',
    retryable: false,
    thrown_message_sv: true,
    remediation: {
      description: 'Settle what details.obligations names (pay the invoices, book the runs, end the connections), then switch the package off again.',
    },
  },
  // A start door of a package that is switched off or winding down
  // (lib/modules/package-doors.ts): the open work stays reachable, nothing
  // new starts. The doors pass the sentence that names the package
  // (lib/modules/package-gate.ts); this one is the fallback.
  PACKAGE_OFF: {
    httpStatus: 409,
    message_sv: 'Paketet är avstängt för företaget, så inget nytt kan startas där. Slå på det under Anpassa.',
    message_en: 'This package is switched off for the company, so no new work can start in it. Switch it on in Anpassa.',
    retryable: false,
    remediation: {
      description:
        'Ask an owner or admin to switch the package (details.package_id) on under Inställningar, Anpassa, or stage the switch with gnubok_enable_package for them to approve. Everything already open in the package (paying, booking, filing, matching) keeps working while it is off.',
      tool: 'gnubok_enable_package',
    },
  },
  PACKAGE_SWITCH_STAGE_ONLY: {
    httpStatus: 400,
    message_sv: 'Ett paket slås på eller av genom ett förslag som en ägare eller administratör godkänner.',
    message_en: 'A package switch is staged and then approved by an owner or admin: send it with ?stage=true.',
    retryable: false,
    remediation: {
      description:
        'Send the same request with ?stage=true, then approve the pending operation (POST /pending-operations/{id}/approve) or let an owner or admin approve it in Accounted.',
    },
  },
  PACKAGE_NOT_IN_PLAN: {
    httpStatus: 403,
    message_sv: 'Paketet ingår inte i företagets abonnemang.',
    message_en: 'The package is not included in the company plan.',
    retryable: false,
    remediation: { description: 'Upgrade the plan under Inställningar, Abonnemang, then switch the package on.' },
  },
  PACKAGE_NOT_IN_COUNTRY: {
    httpStatus: 400,
    message_sv: 'Paketet finns inte för företag i det här landet.',
    message_en: 'The package is not offered for companies in this country.',
    retryable: false,
  },
  PACKAGE_NOT_FOR_LEGAL_FORM: {
    httpStatus: 400,
    message_sv: 'Paketet är inte tillgängligt för företagets bolagsform.',
    message_en: 'The package is not offered for the company legal form.',
    retryable: false,
    remediation: {
      description:
        'For Lön in an enskild firma: set pays_salaries in the company tax profile (Inställningar, Skatt), then switch the package on.',
    },
  },
}

// ─────────────────────────────────────────────────────────────────
// Grants (create_grant, revoke_grant, the claim gate; lib/grants)
// ─────────────────────────────────────────────────────────────────

const GRANT: Record<string, StructuredErrorEntry> = {
  GRANT_ADMIN_REQUIRED: {
    httpStatus: 403,
    message_sv: 'Endast ägare och administratörer kan godkänna, återkalla eller pausa regler för automatisk bokföring.',
    message_en: 'Only owners and admins can approve, revoke or pause rules for automatic booking.',
    retryable: false,
  },
  GRANT_NEEDS_PERSON: {
    httpStatus: 403,
    message_sv:
      'Regler för automatisk bokföring godkänner en ägare eller administratör själv, under Förslag i Att göra i Accounted. En agent, en API-nyckel eller ett tjänstekonto kan inte godkänna dem.',
    message_en:
      'An owner or admin accepts rules for automatic booking themselves, under Suggestions in Att göra in Accounted. An agent, an API key or a service account cannot accept them.',
    retryable: false,
    remediation: {
      description: 'Tell the user the rule is waiting for them in Accounted, under Att göra (Förslag). Do not retry the approval with any key.',
    },
  },
  GRANTS_SWITCHED_OFF: {
    httpStatus: 409,
    message_sv: 'Regler för automatisk bokföring är avstängda i den här installationen, så regeln kan inte godkännas.',
    message_en: 'Rules for automatic booking are switched off on this installation, so the rule cannot be accepted.',
    retryable: false,
  },
  GRANT_INVALID: {
    httpStatus: 400,
    message_sv: 'Regeln för automatisk bokföring är ofullständig. Avvisa förslaget, så föreslås den på nytt.',
    message_en: 'The rule for automatic booking is incomplete. Reject the suggestion and it is proposed again.',
    retryable: false,
  },
  GRANT_UNKNOWN_COUNTERPARTY: {
    httpStatus: 400,
    message_sv: 'Banktexten pekar inte ut en motpart, så den kan inte bokföras automatiskt.',
    message_en: 'The bank text does not identify a counterparty, so it cannot be booked automatically.',
    retryable: false,
  },
  GRANT_UNKNOWN_SUPPLIER: {
    httpStatus: 400,
    message_sv: 'Leverantören i regeln finns inte i företaget, så dess fakturor kan inte bokföras automatiskt.',
    message_en: 'The supplier the rule names is not in the company, so its invoices cannot be booked automatically.',
    retryable: false,
  },
  GRANT_ACCOUNT_INACTIVE: {
    httpStatus: 409,
    message_sv: 'Kontot i regeln är inte aktivt i kontoplanen. Aktivera kontot eller avvisa förslaget.',
    message_en: 'The account in the rule is not active in the chart of accounts. Activate it or reject the suggestion.',
    retryable: false,
  },
  GRANT_CREDENTIAL_UNKNOWN: {
    httpStatus: 409,
    message_sv: 'API-nyckeln eller tjänstekontot som regeln gäller finns inte längre i företaget.',
    message_en: 'The API key or service account the rule names no longer exists in the company.',
    retryable: false,
  },
  GRANT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Regeln för automatisk bokföring hittades inte.',
    message_en: 'The rule for automatic booking was not found.',
    retryable: false,
  },
  GRANT_ALREADY_REVOKED: {
    httpStatus: 409,
    message_sv: 'Regeln för automatisk bokföring är redan återkallad.',
    message_en: 'The rule for automatic booking is already revoked.',
    retryable: false,
  },
  GRANT_NOT_APPLICABLE: {
    httpStatus: 403,
    message_sv: 'Den här åtgärden kan inte bokföras automatiskt enligt en regel. En person behöver godkänna den.',
    message_en: 'This operation cannot be booked automatically under a rule. A person has to approve it.',
    retryable: false,
  },
  GRANT_REVIEW_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Du har inte behörighet att markera automatiska bokföringar som granskade i det här företaget.',
    message_en: 'You are not allowed to mark automatic bookings as reviewed in this company.',
    retryable: false,
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
  // leverantörsregister.", code 2003275). Reconnecting as the same user
  // re-mints the same grant and meets the same refusal; Fortnox reads with
  // the rights of the user who connected, so connecting as a user who has
  // the right (for example the accounting firm) does help (crm#1014).
  PROVIDER_RESOURCE_FORBIDDEN: {
    httpStatus: 403,
    message_sv:
      'Leverantören nekade åtkomst till en del av uppgifterna, men anslutningen fungerar. Att återansluta med samma användare hjälper inte. Fortnox lämnar bara ut det som användaren som kopplade Fortnox själv får se: koppla om och logga in som en användare som har behörigheten, till exempel er redovisningsbyrå, eller ge användaren behörigheten en stund och koppla om. Saknar Fortnox-abonnemanget licensen för registret, aktivera den. I Bokio styrs det av rättigheterna på integrationstoken. Försök sedan igen.',
    message_en:
      'The provider refused access to part of the data, but the connection itself works. Reconnecting as the same user will not help. Fortnox only hands out what the user who connected Fortnox may see: reconnect and sign in as a user who has the permission, your accounting firm for example, or give the user the permission for a while and reconnect. If the Fortnox plan lacks the licence for that register, activate it. In Bokio the integration token\'s rights decide. Then try again.',
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
      'Verifikationen har ingen rad som betalar fakturan: en kredit på kundfordringar (151x), eller för en faktura som inte är bokförd under kontantmetoden en debet på 19xx eller på 2013 (kunden betalade till ägaren privat). Rätta bokföringen först, t.ex. via gnubok_correct_entry.',
    message_en:
      'The journal entry has no line that pays the invoice: a credit on accounts receivable (151x) or, for an invoice not yet booked under kontantmetoden, a debit on 19xx or on 2013 (the customer paid the owner privately). Correct the booking first, e.g. via gnubok_correct_entry.',
    remediation: {
      description:
        'Use gnubok_correct_entry to storno the existing voucher and re-book the receipt on the invoice\'s settlement side (Dr 1930 / Cr 1510 for a booked invoice; Dr 1930 or 2013 / Cr revenue and VAT for an unbooked kontantmetod invoice), then link the corrected voucher.',
      tool: 'gnubok_correct_entry',
    },
  },
  LINK_VOUCHER_NO_SALE: {
    httpStatus: 400,
    message_sv:
      'Verifikationen bokför varken försäljningen eller kundfordran för fakturan. En obokförd faktura under kontantmetoden betalas av den verifikation som bokför försäljningen: en kredit på ett intäktskonto (3xxx), på kundfordringar (151x) eller på ett konto som fakturans rader bokförs på. Ett eget uttag (debet 2013 mot kredit 19xx) eller en egen insättning (debet 19xx mot kredit 2018) är ingen betalning från kunden. Länka verifikationen som bokför försäljningen i stället.',
    message_en:
      'The journal entry books neither the sale nor the receivable of this invoice. Under kontantmetoden an invoice that was never booked is paid by the entry that books its sale: a credit on revenue (3xxx), on accounts receivable (151x) or on an account the invoice\'s lines post to. An owner withdrawal (debit 2013 against a credit on 19xx) or an owner deposit (debit 19xx against a credit on 2018) is not the customer\'s payment. Link the entry that books the sale instead.',
    remediation: {
      description:
        'Pick a voucher from gnubok_find_voucher_candidates_for_invoice: it offers only vouchers that book the sale or the receivable. A payment booked without its revenue is corrected with gnubok_correct_entry first.',
      tool: 'gnubok_find_voucher_candidates_for_invoice',
    },
  },
  LINK_VOUCHER_ALREADY_LINKED: {
    httpStatus: 409,
    message_sv: 'Verifikationen är redan länkad till den här fakturan.',
    message_en: 'This journal entry is already linked to this invoice.',
  },
  // Two shapes, told apart by details: without a stated share the voucher has
  // more left than the invoice needs (details.ar_credit); with one, the share
  // itself is more than the invoice has left (details.amount). A correct
  // verifikat is never split with a storno or a rättelse for this: the share
  // is stated on the link (crm#1434, migration 20261026007000).
  LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING: {
    httpStatus: 400,
    message_sv:
      'Beloppet är större än fakturans återstående belopp. Täcker verifikationen flera fakturor: länka bara den här fakturans del, högst det återstående beloppet. Resten av verifikationen ligger kvar.',
    message_en:
      'More than the invoice has left (details.remaining). Without amount, details.ar_credit is what the voucher has left (its 151x credit, or 19xx debit on kontantmetoden). If the voucher settles several invoices, call again with amount = this invoice\'s share, at most details.remaining: the rest stays on the voucher for its other invoices. Do not storno or correct a correct voucher to split it.',
    remediation: {
      description:
        'When the voucher settles several invoices, link again with amount set to this invoice\'s share (at most details.remaining).',
      tool: 'gnubok_link_invoice_to_voucher',
    },
  },
  LINK_VOUCHER_FULLY_ALLOCATED: {
    httpStatus: 409,
    message_sv:
      'Verifikationens belopp är redan kopplat till andra fakturor och har inget kvar. Välj en annan verifikation.',
    message_en:
      'The voucher\'s settlement amount (the 151x credit, or the 19xx debit on kontantmetoden) is already used by payment rows for other invoices; nothing is left to settle this one. Pick a different voucher.',
  },
  LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER: {
    httpStatus: 400,
    message_sv:
      'Beloppet är större än vad verifikationen har kvar. Andra fakturor är redan kopplade till den. Ange ett lägre belopp eller välj en annan verifikation.',
    message_en:
      'amount is more than the voucher has left (details.available): details.already_linked of its settlement side (details.ar_credit, or details.bank_debit on kontantmetoden) is used by payment rows for other invoices. Lower amount to at most details.available, or pick a different voucher.',
  },
  LINK_VOUCHER_AMOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Beloppet måste vara större än noll.',
    message_en: 'amount must be a positive amount in the invoice\'s currency, at least 0.01.',
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
// Register an already-booked customer invoice (no new JE, crm#1094)
// ─────────────────────────────────────────────────────────────────

const INVOICE_REGISTER_BOOKED: Record<string, StructuredErrorEntry> = {
  INVOICE_REGISTER_CASH_METHOD: {
    httpStatus: 409,
    message_sv:
      'Företaget bokför enligt kontantmetoden: en obetald fakturas försäljning och moms bokförs först när den betalas, så den kan inte kopplas till en verifikation. Än så länge kan öppna fakturor bara registreras på det här sättet under faktureringsmetoden.',
    message_en:
      'The company uses kontantmetoden: an unpaid invoice\'s revenue and VAT are booked when it is paid, so it cannot be linked to a verifikat. For now open invoices can be registered this way under faktureringsmetoden only.',
    remediation: {
      description: 'Do not register open invoices for this company; tell the user that the kundreskontra cannot be imported under kontantmetoden yet.',
    },
  },
  INVOICE_REGISTER_NUMBER_TAKEN: {
    httpStatus: 409,
    message_sv: 'Fakturanumret finns redan i kundreskontran som en annan faktura eller redan kopplad till en verifikation. En faktura i reskontran utan verifikation kopplas bara när kund, valuta och belopp är desamma.',
    message_en: 'That invoice number is already in the invoice register as another invoice, or already linked to a verifikat. A registered invoice without a verifikat is linked only when customer, currency and total are the same.',
    remediation: {
      description: 'Read the invoice named in details.invoice_id with gnubok_get_invoice. If it is this invoice without a verifikat, register again with its customer_id, currency and total. Never book its sale again: it is already in the books.',
      tool: 'gnubok_get_invoice',
    },
  },
  INVOICE_REGISTER_NUMBER_IN_SERIES: {
    httpStatus: 409,
    message_sv:
      'Fakturanumret ligger i den nummerserie Accounted själv delar ut och serien har inte passerat det än, så en senare faktura skulle få samma nummer. Ställ först in nästa fakturanummer efter den gamla seriens sista nummer, eller ett prefix för Accounteds serie, under Inställningar, Fakturor.',
    message_en:
      'The invoice number is in the series Accounted issues and the series has not passed it yet, so a later invoice would get the same number. Set next_invoice_number past the old series (or an invoice_prefix) first.',
    remediation: {
      description: 'Set next_invoice_number past the last number of the old series, or an invoice_prefix for Accounted\'s own series, then register the invoice again.',
      tool: 'gnubok_update_company_settings',
    },
  },
  INVOICE_REGISTER_VOUCHER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikationen kunde inte hittas i bolaget.',
    message_en: 'Journal entry not found in this company.',
  },
  INVOICE_REGISTER_VOUCHER_NOT_POSTED: {
    httpStatus: 409,
    message_sv: 'Verifikationen är inte bokförd eller har makulerats med storno. Fakturan kan bara registreras mot en bokförd verifikation.',
    message_en: 'The journal entry is not posted (or has been reversed). An invoice can only be registered against a posted verifikat.',
  },
  INVOICE_REGISTER_OPENING_BALANCE: {
    httpStatus: 400,
    message_sv:
      'Verifikationen är en ingående balans, inte fakturans egen verifikation. Importera SIE-filen för året då fakturan bokfördes (äldsta året först) och registrera fakturan mot den verifikationen.',
    message_en:
      'The journal entry is an opening balance, not the invoice\'s own verifikat. Import the SIE file of the year the invoice was booked in (oldest year first), then register the invoice against that verifikat.',
    remediation: {
      description: 'Import the SIE file of the year the invoice was booked in, oldest year first, then find the invoice\'s verifikat (accounts ["1510"], text = the invoice number) and register against it.',
      tool: 'gnubok_query_journal',
    },
  },
  INVOICE_REGISTER_VOUCHER_TAKEN: {
    httpStatus: 409,
    message_sv: 'Verifikationen är redan bokföringen av en annan kundfaktura.',
    message_en: 'The journal entry already books another customer invoice.',
  },
  INVOICE_REGISTER_VOUCHER_UNSUPPORTED: {
    httpStatus: 400,
    message_sv:
      'Fakturan kan inte registreras på det här sättet än: verifikationen blandar försäljning som en kreditfaktura inte kan vända i samma momsrutor (flera momssatser, en del utan moms, momsfri försäljning eller försäljning till utlandet eller med omvänd betalningsskyldighet bredvid moms eller bredvid varandra), eller bokför varuförsäljning till utlandet, vinstmarginalbeskattning, vilande moms eller ROT/RUT-avdrag. Fakturan står kvar utanför kundreskontran och dess belopp blir en skillnad mot 1510.',
    message_en:
      'This invoice cannot be registered this way yet: its verifikat mixes sales a kreditfaktura cannot reverse into the same momsdeklaration boxes (several VAT rates, an untaxed part, momsfri or zero-rated sales next to VAT or next to each other), or books goods sold abroad, vinstmarginalbeskattning (VMB), vilande moms or a ROT/RUT deduction. It stays outside the kundreskontra, and its amount is a difference against 1510.',
    remediation: {
      description: 'Leave this invoice out of the register and tell the user why (message_en names what the verifikat books) and that its amount stays a difference between the kundreskontra and 1510.',
    },
  },
  INVOICE_REGISTER_VOUCHER_NOT_SALE: {
    httpStatus: 400,
    message_sv:
      'Verifikationen är inte en kundfakturaverifikation: den ska debitera kundfordringar (151x) och kreditera försäljning och eventuell utgående moms.',
    message_en:
      'The journal entry is not a customer invoice verifikat: it must debit accounts receivable (151x) and credit revenue and any output VAT.',
  },
  INVOICE_REGISTER_AMOUNT_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Verifikationen bokför ett annat belopp på kundfordringar (151x) än fakturans totalbelopp. Välj fakturans egen verifikation; en samlingsverifikation för flera fakturor kan inte kopplas till en av dem.',
    message_en:
      'The journal entry books a different amount on accounts receivable (151x) than the invoice total. Pick the invoice\'s own verifikat; one covering several invoices cannot be linked to one of them.',
  },
  INVOICE_REGISTER_FOREIGN_CURRENCY: {
    httpStatus: 400,
    message_sv:
      'Fakturans valuta stämmer inte med verifikationen. En faktura i utländsk valuta registreras mot en verifikation som bokför kundfordran (151x) i samma valuta med beloppet i valutan, och kursen hämtas därifrån. En verifikation i kronor anger varken fakturans belopp i valutan eller kursen.',
    message_en:
      'The invoice\'s currency does not match its verifikat. A foreign-currency invoice registers against a verifikat that books the receivable (151x) in that currency with the amount in it, and the rate is read from there. A verifikat in kronor only states neither the invoice\'s own amount nor its rate.',
    remediation: {
      description: 'Pass currency as the verifikat\'s 151x line states it, with total and remaining_amount in that currency. A verifikat booked in kronor only cannot take a foreign-currency invoice: leave it out of the register and tell the user its amount stays a difference between the kundreskontra and 1510.',
    },
  },
}

// ─────────────────────────────────────────────────────────────────
// Register an already-booked SUPPLIER invoice (no new JE, crm#1094)
// ─────────────────────────────────────────────────────────────────

const SI_REGISTER_BOOKED: Record<string, StructuredErrorEntry> = {
  SI_REGISTER_CASH_METHOD: {
    httpStatus: 409,
    message_sv:
      'Företaget bokför enligt kontantmetoden: en obetald leverantörsfakturas kostnad och moms bokförs först när den betalas, så den kan inte kopplas till en verifikation. Än så länge kan öppna leverantörsfakturor bara registreras på det här sättet under faktureringsmetoden.',
    message_en:
      'The company uses kontantmetoden: an unpaid supplier invoice\'s cost and VAT are booked when it is paid, so it cannot be linked to a verifikat. For now open supplier invoices can be registered this way under faktureringsmetoden only.',
    remediation: {
      description: 'Do not register open supplier invoices for this company; tell the user that the leverantörsreskontra cannot be imported under kontantmetoden yet.',
    },
  },
  SI_REGISTER_FOREIGN_CURRENCY: {
    httpStatus: 400,
    message_sv: 'Leverantörsfakturan är i utländsk valuta. Än så länge kan bara fakturor i SEK registreras på det här sättet.',
    message_en: 'The supplier invoice is in a foreign currency. Only SEK invoices can be registered this way for now.',
    remediation: {
      description: 'Leave this invoice out of the register and tell the user that invoices in other currencies cannot be registered yet.',
    },
  },
  SI_REGISTER_NUMBER_TAKEN: {
    httpStatus: 409,
    message_sv: 'Leverantörens fakturanummer finns redan i leverantörsreskontran för den här leverantören. En faktura kan bara registreras en gång.',
    message_en: 'That supplier invoice number is already in the leverantörsreskontra for this supplier; an invoice can be registered once.',
  },
  SI_REGISTER_NUMBER_REUSED: {
    httpStatus: 409,
    message_sv:
      'Leverantören har redan en faktura med samma nummer och ett annat fakturadatum, ett nummer som leverantören återanvänder. Ett sådant nummer sparas som fakturans betalningsreferens, men den här fakturan har en egen betalningsreferens och kan inte spara båda. Fakturan står kvar utanför leverantörsreskontran och dess belopp blir en skillnad mot 2440.',
    message_en:
      'This supplier already has an invoice with the same number and another invoice date: a number the supplier reuses. Such a number is kept as the invoice\'s payment reference, but this invoice has a payment reference of its own and cannot keep both. It stays outside the leverantörsreskontra, and its amount is a difference against 2440.',
    remediation: {
      description: 'Leave this invoice out of the register and tell the user that the supplier reuses its invoice number while this invoice carries its own payment reference, so its amount stays a difference between the leverantörsreskontra and 2440.',
    },
  },
  SI_REGISTER_ARRIVAL_NUMBER_TAKEN: {
    httpStatus: 409,
    message_sv: 'Ankomstnumret används redan av en annan leverantörsfaktura. Utelämna ankomstnumret så får fakturan nästa nummer i Accounteds serie.',
    message_en: 'That ankomstnummer is already used by another supplier invoice. Leave arrival_number out to give the invoice the next number in Accounted\'s series.',
  },
  SI_REGISTER_ARRIVAL_NUMBER_IN_SERIES: {
    httpStatus: 409,
    message_sv:
      'Ankomstnumret ligger inte under Accounteds egen serie, så det skulle hamna i den serien, som då fortsätter efter det numret. Ställ först in Startnummer för leverantörsfakturor efter den gamla seriens sista nummer under Inställningar, Fakturor, eller utelämna ankomstnumret.',
    message_en:
      'The ankomstnummer is not below Accounted\'s own series, so it would sit in that series, which would then continue after it. Set next_arrival_number past the old series first, or leave arrival_number out.',
    remediation: {
      description: 'Set next_arrival_number past the last ankomstnummer of the old series, then register the invoice again; or leave arrival_number out to draw the next number in Accounted\'s series.',
      tool: 'gnubok_update_company_settings',
    },
  },
  SI_REGISTER_VOUCHER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikationen kunde inte hittas i bolaget.',
    message_en: 'Journal entry not found in this company.',
  },
  SI_REGISTER_VOUCHER_NOT_POSTED: {
    httpStatus: 409,
    message_sv: 'Verifikationen är inte bokförd eller har makulerats med storno. Leverantörsfakturan kan bara registreras mot en bokförd verifikation.',
    message_en: 'The journal entry is not posted (or has been reversed). A supplier invoice can only be registered against a posted verifikat.',
  },
  SI_REGISTER_OPENING_BALANCE: {
    httpStatus: 400,
    message_sv:
      'Verifikationen är en ingående balans, inte leverantörsfakturans egen verifikation. Importera SIE-filen för året då fakturan bokfördes (äldsta året först) och registrera fakturan mot den verifikationen.',
    message_en:
      'The journal entry is an opening balance, not the supplier invoice\'s own verifikat. Import the SIE file of the year the invoice was booked in (oldest year first), then register the invoice against that verifikat.',
    remediation: {
      description: 'Import the SIE file of the year the invoice was booked in, oldest year first, then find the invoice\'s verifikat (accounts ["2440"], text = the supplier\'s invoice number) and register against it.',
      tool: 'gnubok_query_journal',
    },
  },
  SI_REGISTER_VOUCHER_TAKEN: {
    httpStatus: 409,
    message_sv: 'Verifikationen är redan bokföringen av en annan leverantörsfaktura.',
    message_en: 'The journal entry already books another supplier invoice.',
  },
  SI_REGISTER_VOUCHER_NOT_PURCHASE: {
    httpStatus: 400,
    message_sv:
      'Verifikationen är inte en leverantörsfakturaverifikation: den ska kreditera leverantörsskulder (244x) och debitera kostnad och eventuell ingående moms.',
    message_en:
      'The journal entry is not a supplier invoice verifikat: it must credit accounts payable (244x) and debit the cost and any input VAT.',
  },
  SI_REGISTER_AMOUNT_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Verifikationen bokför ett annat belopp på leverantörsskulder (244x) än fakturans totalbelopp. Välj fakturans egen verifikation; en samlingsverifikation för flera fakturor kan inte kopplas till en av dem.',
    message_en:
      'The journal entry books a different amount on accounts payable (244x) than the invoice total. Pick the invoice\'s own verifikat; one covering several invoices cannot be linked to one of them.',
  },
  SI_REGISTER_VOUCHER_UNSUPPORTED: {
    httpStatus: 400,
    message_sv:
      'Leverantörsfakturan kan inte registreras på det här sättet än: verifikationen bokför annan moms än ingående moms och köparens egen moms vid omvänd betalningsskyldighet eller import, till exempel utgående moms på en försäljning eller momsredovisningskontot 2650. Fakturan står kvar utanför leverantörsreskontran och dess belopp blir en skillnad mot 2440.',
    message_en:
      'This supplier invoice cannot be registered this way yet: its verifikat books VAT other than input VAT and the buyer\'s own VAT on a reverse charge or import, such as output VAT on a sale or the VAT settlement account 2650. It stays outside the leverantörsreskontra, and its amount is a difference against 2440.',
    remediation: {
      description: 'Leave this invoice out of the register and tell the user why (message_en names the account) and that its amount stays a difference between the leverantörsreskontra and 2440.',
    },
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
  // NO_BANK_CREDIT and CUTOFF_ALREADY_POSTED only arise on the kontantmetod
  // side (19xx credit): see supplier_invoice_settlement_side, migration
  // 20260921190300. FULLY_ALLOCATED arises on both sides since 20261011153000.
  LINK_SI_VOUCHER_NO_BANK_CREDIT: {
    httpStatus: 400,
    message_sv:
      'Verifikationen krediterar inget kassa- eller bankkonto (19xx) och bokför inte heller ett köp som ägaren betalat privat (kredit 2018 eller 2893), så den kan inte vara betalningen av fakturan. Välj verifikationen där köpet betalades.',
    message_en:
      'The journal entry does not credit a cash or bank account (19xx), nor does it book a purchase the owner paid privately (Dr cost / Cr 2018 or 2893), so it cannot be the payment of this invoice. On kontantmetoden the payment verifikat is the one that paid the purchase (Dr cost, Dr 2641 / Cr 19xx, or Cr 2018 / 2893 when the owner paid with private money).',
  },
  LINK_SI_VOUCHER_FULLY_ALLOCATED: {
    httpStatus: 409,
    message_sv:
      'Verifikationens belopp är redan kopplat till andra leverantörsfakturor och har inget kvar. Välj en annan verifikation.',
    message_en:
      'The voucher\'s settlement amount (the 244x debit, or the 19xx credit on kontantmetoden) is already used by payment rows for other supplier invoices; nothing is left to settle this one. Pick a different voucher.',
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
  // Two shapes, told apart by details: without a stated share the voucher has
  // more left than the invoice needs (details.ap_debit / details.bank_credit);
  // with one, the share itself is more than the invoice has left
  // (details.amount). A correct verifikat is never split with a storno for
  // this: the share is stated on the link (GitHub issue 3490).
  LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING: {
    httpStatus: 400,
    message_sv:
      'Beloppet är större än leverantörsfakturans återstående belopp. Betalar verifikationen flera skulder: länka bara den här fakturans del, högst det återstående beloppet. Resten av verifikationen ligger kvar.',
    message_en:
      'More than the supplier invoice has left (details.remaining). Without amount, details.ap_debit (244x debit) or details.bank_credit (19xx credit, kontantmetoden) is what the voucher has left. If the voucher pays several debts, call again with amount = this invoice\'s share, at most details.remaining: the rest stays on the voucher for other invoices or for a debt with no invoice here. Do not storno a correct voucher to split it.',
    remediation: {
      description:
        'When the voucher pays several debts, link again with amount set to this invoice\'s share (at most details.remaining).',
      tool: 'gnubok_link_supplier_invoice_to_voucher',
    },
  },
  LINK_SI_VOUCHER_AMOUNT_EXCEEDS_VOUCHER: {
    httpStatus: 400,
    message_sv:
      'Beloppet är större än vad verifikationen har kvar. Andra leverantörsfakturor är redan kopplade till den. Ange ett lägre belopp eller välj en annan verifikation.',
    message_en:
      'amount is more than the voucher has left (details.available): details.already_linked of its settlement side (details.ap_debit, or details.bank_credit on kontantmetoden) is used by payment rows for other supplier invoices. Lower amount to at most details.available, or pick a different voucher.',
  },
  LINK_SI_VOUCHER_AMOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Beloppet måste vara större än noll.',
    message_en: 'amount must be a positive amount in the invoice\'s currency, at least 0.01.',
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
// Unlink a SUPPLIER invoice from a linked verifikat (the undo of the link
// above; unlink_supplier_invoice_from_voucher, migration 20261112100000)
// ─────────────────────────────────────────────────────────────────

const UNLINK_SI_VOUCHER: Record<string, StructuredErrorEntry> = {
  UNLINK_SI_VOUCHER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Betalningsraden kunde inte hittas på leverantörsfakturan.',
    message_en: 'The payment row was not found on this supplier invoice.',
  },
  // details.reason: bank_transaction (booked from a bank row) or no_voucher.
  UNLINK_SI_VOUCHER_NOT_A_LINK: {
    httpStatus: 409,
    message_sv:
      'Den här betalningen är inte en koppling till en befintlig verifikation och kan inte kopplas bort. En betalning som bokförts från en banktransaktion ångras från transaktionen.',
    message_en:
      'This payment is not a link to an existing voucher and cannot be unlinked. A payment booked from a bank transaction is undone from the transaction.',
  },
  UNLINK_SI_VOUCHER_PAYMENT_VOUCHER: {
    httpStatus: 409,
    message_sv:
      'Verifikationen är en betalningsverifikation som bokfördes när betalningen registrerades, och kan inte kopplas bort. Makulera verifikationen i stället, då blir fakturan obetald igen.',
    message_en:
      'The voucher is a payment voucher posted when the payment was registered and cannot be unlinked. Reverse the voucher instead; that makes the invoice unpaid again.',
  },
  UNLINK_SI_VOUCHER_SETOFF: {
    httpStatus: 409,
    message_sv:
      'Betalningen är en kvittning mot en kundfaktura och kan inte kopplas bort. Makulera kvittningens verifikation i stället, då får båda fakturorna tillbaka beloppet.',
    message_en:
      'This payment is a set-off against a customer invoice and cannot be unlinked. Reverse the set-off voucher instead; both invoices then get the amount back.',
  },
  UNLINK_SI_VOUCHER_SETTLEMENT_EVIDENCE: {
    httpStatus: 409,
    message_sv:
      'Raden är ett underlag för en betalning som redan var registrerad på fakturan, inte en koppling som gjorde fakturan betald. Den kan inte kopplas bort här.',
    message_en:
      'This row is evidence for a payment the invoice already carried, not a link that made the invoice paid. It cannot be unlinked here.',
  },
  UNLINK_SI_VOUCHER_FOREIGN_CURRENCY: {
    httpStatus: 409,
    message_sv:
      'Fakturan är i utländsk valuta. Kopplingen kan ha bokfört en verifikation för kursdifferensen, och den ångras inte av att kopplingen tas bort. Kopplingen kan därför inte tas bort här. Kontakta supporten så hjälper vi dig.',
    message_en:
      'The invoice is in a foreign currency. The link may have posted a voucher for the exchange difference, which removing the link does not undo, so it cannot be removed here. Contact support for help.',
  },
  UNLINK_SI_VOUCHER_INVOICE_NOT_SETTLED: {
    httpStatus: 409,
    message_sv:
      'Leverantörsfakturan är inte längre betald eller delbetald (den kan ha krediterats). Kopplingen kan inte tas bort i det läget.',
    message_en:
      'The supplier invoice is no longer paid or partially paid (it may have been credited). The link cannot be removed in that state.',
  },
  UNLINK_SI_VOUCHER_CUTOFF_ALREADY_POSTED: {
    httpStatus: 409,
    message_sv:
      'Bokslutets periodisering enligt kontantmetoden är redan bokförd för ett år som omfattar både fakturan och betalningen, och den räknade fakturan som betald. Rätta periodiseringen först (storno), ta sedan bort kopplingen och bokför periodiseringen igen.',
    message_en:
      'A posted kontantmetod year-end cut-off covers both the invoice and the payment and counted this invoice as paid. Correct the cut-off first (storno), then remove the link and post the cut-off again.',
  },
  UNLINK_SI_VOUCHER_DB_ERROR: {
    httpStatus: 500,
    message_sv: 'Databasfel när kopplingen skulle tas bort. Ingenting ändrades. Försök igen.',
    message_en: 'Database error while removing the link. Nothing was changed. Please retry.',
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
  BATCH_FEE_INVALID: {
    httpStatus: 400,
    message_sv: 'En avgiftsrad är ogiltig. Högst 5 rader, var och en med konto och ett belopp över noll i hela ören.',
    message_en: 'A fee row is invalid. At most 5 rows, each with an account and an amount above zero in whole öre.',
  },
  BATCH_FEE_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv:
      'En avgift bokförs på ett aktivt kostnadskonto i klass 6, till exempel 6570 Bankkostnader. Aktivera kontot i kontoplanen eller välj ett annat.',
    message_en:
      'A fee is booked on an active class 6 cost account, for example 6570 Bankkostnader. Activate the account in the chart of accounts or choose another.',
  },
  BATCH_FEE_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Avgifterna måste vara mindre än fakturorna de reglerar.',
    message_en: 'The fees must be smaller than the invoices they settle.',
  },
  BATCH_DEBT_INVALID: {
    httpStatus: 400,
    message_sv:
      'En rad för tidigare leverantörsskuld är ogiltig. Högst 5 extra rader tillsammans med avgiftsraderna, var och en med konto och ett belopp över noll i hela ören.',
    message_en:
      'A row for an earlier supplier debt is invalid. At most 5 extra rows together with the fee rows, each with an account and an amount above zero in whole öre.',
  },
  BATCH_DEBT_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv:
      'En tidigare leverantörsskuld bokförs på ett aktivt konto för leverantörsskulder, 2440 till 2449. Aktivera kontot i kontoplanen eller välj ett annat.',
    message_en:
      'An earlier supplier debt is booked on an active supplier debt account, 2440 to 2449. Activate the account in the chart of accounts or choose another.',
  },
  BATCH_DEBT_SUPPLIER_ONLY: {
    httpStatus: 400,
    message_sv: 'En tidigare leverantörsskuld kan bara bokas på en utbetalning till leverantörer, inte på en inbetalning.',
    message_en: 'An earlier supplier debt can only be booked on a payment to suppliers, not on an incoming payment.',
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
      'Företaget använder kontantmetoden och minst en av fakturorna är inte bokförd än: intäkt eller kostnad och moms bokförs vid betalningen. En samlingsmatchning bokför det för kundfakturor i kronor som betalas i sin helhet, alla på en gång, och för en enda leverantörsfaktura som betalas med hela transaktionen. Flera leverantörsfakturor, delbetalningar, fakturor i utländsk valuta och en blandning med redan bokförda fakturor går inte: matcha fakturan direkt mot transaktionen om den ensam motsvarar beloppet, annars markera varje faktura som betald och koppla sedan transaktionen till verifikaten.',
    message_en:
      'The company uses the cash method and at least one of the invoices is not booked yet: revenue or cost and VAT are booked at payment. A batch match books that for SEK customer invoices paid in full, all of them at once, and for a single supplier invoice paid by the whole transaction. Several supplier invoices, partial payments, foreign-currency invoices and a mix with booked invoices are not supported: match the invoice directly to the transaction if it alone covers the amount; otherwise mark each invoice as paid and then link the transaction to those vouchers.',
  },
  BATCH_CASH_LINES_INVALID: {
    httpStatus: 400,
    message_sv:
      'Intäkts- och momsraderna för en obokförd faktura under kontantmetoden kunde inte bokföras: kontrollera att kontona är aktiva i kontoplanen och att fakturan betalas i sin helhet.',
    message_en:
      'The revenue and VAT lines for an unbooked cash-method invoice could not be booked: check that the accounts are active in the chart of accounts and that the invoice is paid in full.',
  },
  BATCH_CASH_LINES_MIXED: {
    httpStatus: 400,
    message_sv:
      'Under kontantmetoden kan en samlingsmatchning inte blanda obokförda och redan bokförda fakturor. Dela upp dem i två fördelningar.',
    message_en:
      'Under the cash method a batch match cannot mix unbooked and already booked invoices. Split them into two allocations.',
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
  BATCH_FOREIGN_CURRENCY: {
    httpStatus: 400,
    message_sv:
      'Samlingsbetalning stödjer bara bankrader i SEK. Matcha en bankrad i utländsk valuta mot en faktura i taget, så att beloppet räknas om till kronor med rätt växelkurs.',
    message_en:
      'A batch allocation takes SEK bank rows only. Match a foreign-currency bank row to one invoice at a time, so the amount is converted to kronor at the correct exchange rate.',
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
      'Alla transaktioner i en ny samlingsverifikation måste ha samma datum: BFL 5 kap 6 § tredje stycket tillåter en gemensam verifikation bara för likartade affärshändelser samma dag. Dela upp bokföringen per dag, eller koppla raderna till den verifikation som redan bokför dem (till exempel Stripes månadsfaktura för avgifterna).',
    message_en:
      'All transactions in a new samlingsverifikat must share the same date: BFL 5 kap 6 § tredje stycket allows a gemensam verifikation only for likartade affärshändelser on the same day. Split the batch per day, or link the rows to the verifikat that already books them (for example Stripe\'s monthly invoice for the fees).',
    retryable: false,
    remediation: {
      description:
        'This is a legal limit, not a technical one: a monthly samlingsverifikat over several days is not an option under BFL 5 kap 6 §. Group the tx_ids by date and call gnubok_bulk_book_transactions once per date (and per direction). Rows that one document covers, such as a samlingsfaktura (BFNAR 2013:2 p. 6.1: at most one month, e.g. Stripe\'s monthly fee invoice), may be of several dates: book the document as its own verifikat, then link the rows with existing_journal_entry_id.',
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
        'This is a legal limit, not a technical one: an inflow and an outflow are not likartade affärshändelser under BFL 5 kap 6 §. Call gnubok_bulk_book_transactions once for the income rows and once for the expense rows (a new samlingsverifikat still on one date).',
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
  // One code covers both never-connected and expired: splitting it would
  // ripple through every consumer, and the declaration-status path already
  // differentiates in its message (DECISIONS.md 2026-08-25). The copy is
  // agent-directive on purpose: only a person can run the BankID flow, so
  // the agent must hand the task to the user instead of retrying.
  SKATTEVERKET_NOT_CONNECTED: {
    httpStatus: 401,
    message_sv:
      'Anslutningen till Skatteverket saknas eller har gått ut. Om företaget varit anslutet tidigare är detta normalt: Skatteverkets personliga inloggning räcker i ungefär tio timmar. Be användaren ansluta (igen) med BankID under Inställningar → Skatteverket.',
    message_en:
      'The Skatteverket connection is missing or has expired. If the company was connected before this is expected: Skatteverket personal sessions last about ten hours. Tell the user to connect (or reconnect) with BankID under Inställningar → Skatteverket in Accounted. Only a person can do this; do not retry until they confirm they have reconnected.',
    remediation: {
      description:
        'A person must connect (or reconnect) to Skatteverket with BankID: call gnubok_connect_skatteverket for the connect_url and give it to the user, or they open Inställningar → Skatteverket. Personal Skatteverket sessions expire after about ten hours by SKV design, so an expired session is normal, not a fault. Do not retry until the user confirms they have reconnected.',
      tool: 'gnubok_connect_skatteverket',
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
  // The skattekonto's ledger account (lib/skatteverket/skattekonto-account.ts):
  // 1630 for every form, 2012 (eget kapital, BAS K1) also for an enskild firma.
  SKATTEKONTO_ACCOUNT_NOT_ALLOWED: {
    httpStatus: 400,
    message_sv:
      'Skattekontot kan föras på 1630 Avräkning för skatter och avgifter, och i en enskild firma också på 2012 i eget kapital. Andra konton går inte.',
    message_en:
      'The skattekonto can run on 1630 Avräkning för skatter och avgifter, and in an enskild firma also on 2012 in equity. No other account is allowed.',
    retryable: false,
  },
  // A transfer verifikat between the two skattekonto accounts was asked for,
  // but the account the company no longer uses holds no balance.
  SKATTEKONTO_TRANSFER_NOTHING_TO_MOVE: {
    httpStatus: 409,
    message_sv: 'Det finns inget saldo kvar på det tidigare skattekontokontot att föra över.',
    message_en: 'The account the skattekonto ran on before holds no balance to transfer.',
    retryable: false,
  },
  // A skattekonto row whose event a live verifikat already carries on the
  // skattekonto account (1630, or 2012 for an enskild firma that runs it
  // there; typically imported by SIE from the previous system): booking it
  // would record the event twice. The thrown Swedish text names the
  // verifikat and the account.
  SKATTEKONTO_BOOK_LEDGER_TWIN_EXISTS: {
    httpStatus: 409,
    message_sv:
      'Händelsen finns redan i bokföringen: ett verifikat innehåller den redan på skattekontots konto. Koppla raden till verifikatet i stället för att bokföra den en gång till.',
    message_en:
      'The event is already in the ledger: a live verifikat carries it on the skattekonto account. Link the row to that verifikat instead of booking it a second time.',
    retryable: false,
    remediation: {
      description:
        'Link the row to the verifikat the message names with gnubok_reconcile_match (account_key "skattekonto", pairs [{ external_ids: [row id, plus any other open rows the verifikat carries with it], journal_entry_ids: [verifikat id] }]). Book it anyway (allow_duplicate / allow_duplicate_ids, with the reason the user gives in duplicate_reason) only when the user confirms the event really happened twice.',
      tool: 'gnubok_reconcile_match',
    },
    thrown_message_sv: true,
  },
  // Skattekonto rows no single verifikat carries, but that unlinked verifikat
  // on the skattekonto account already hold in aggregate (one summarised
  // year-end or month-end verifikat, crm#1043): booking them would record the
  // events twice. The thrown Swedish text names the verifikat, the account and
  // the date they cover through.
  SKATTEKONTO_BOOK_LEDGER_COVER_EXISTS: {
    httpStatus: 409,
    message_sv:
      'Händelsen ser redan ut att vara bokförd: verifikat på skattekontots konto som inte är kopplade till någon händelse täcker den redan. Koppla händelserna till verifikatet i stället för att bokföra dem en gång till.',
    message_en:
      'The event already appears to be booked: verifikat on the skattekonto account that no Skatteverket row is linked to already cover it. Link the rows to that verifikat instead of booking them a second time.',
    retryable: false,
    remediation: {
      description:
        'Rows one verifikat holds exactly are already proposed: link them with gnubok_reconcile_match use_proposals: true, dry_run first. Link the other covered rows (covered_by_ledger in gnubok_list_reconciliation_items, account_key "skattekonto") to the unlinked verifikat with gnubok_reconcile_match, at most 50 rows per pair, with allow_remainder: true when the rows do not sum to the verifikat: the rest stays on it as its remainder. Book anyway (allow_duplicate / allow_duplicate_ids, with the reason the user gives in duplicate_reason) only when the user confirms the event is really missing from the ledger.',
      tool: 'gnubok_reconcile_match',
    },
    thrown_message_sv: true,
  },
  // A skattekonto row whose event a bank verifikat without any line on the
  // skattekonto account already books (PH 171): a previous system that paid
  // the tax straight from the bank to the tax accounts, or a bank line booked
  // as 1930 against 2510. Booking it would record the event twice, and there
  // is no skattekonto line to link. The thrown Swedish text names the
  // verifikat and the account it books.
  SKATTEKONTO_BOOK_LEDGER_DIRECT_EXISTS: {
    httpStatus: 409,
    message_sv:
      'Händelsen finns redan i bokföringen utan skattekontot: ett verifikat bokför den redan direkt mot banken. Låt raden vara obokförd (ignorera den) i stället för att bokföra den en gång till.',
    message_en:
      'The event is already in the ledger without the skattekonto: a verifikat books it straight from the bank. Leave the row unbooked (ignore it) instead of booking it a second time.',
    retryable: false,
    remediation: {
      description:
        'Ignore the row with gnubok_ignore_transaction (transaction_id = the row id), together with the other rows of the month the same verifikat holds, or have the user correct the verifikat to go via the skattekonto account and then link the row. Book anyway (allow_duplicate / allow_duplicate_ids, with the reason the user gives in duplicate_reason) only when the user confirms the event is really missing from the ledger.',
      tool: 'gnubok_ignore_transaction',
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
  // The ombud connection (deep link, Verifiera) on an org number several live
  // companies claim goes only to the one proven with BankID (ombudClaimStanding
  // in the skatteverket extension's connection-store).
  ORG_NUMBER_CONTESTED: {
    httpStatus: 409,
    message_sv:
      'Organisationsnumret används av fler än ett företag. Anslut det här företaget till Skatteverket med BankID under Inställningar → Skatteverket och försök sedan igen. Den som ansluter måste få företräda företaget hos Skatteverket.',
    message_en:
      'The organisation number is used by more than one company. Connect this company to Skatteverket with BankID under Settings → Skatteverket, then try again. The person connecting must be allowed to represent the company at Skatteverket.',
  },
  // Two or more claimants are proven: the connection follows neither.
  ORG_NUMBER_PROVEN_TWICE: {
    httpStatus: 409,
    message_sv:
      'Organisationsnumret är bekräftat med BankID i fler än ett företag, och ombudsanslutningen kan bara gälla ett av dem. Arkivera de andra företagen med samma organisationsnummer, eller be den som administrerar dem att göra det, och försök sedan igen.',
    message_en:
      'The organisation number is confirmed with BankID in more than one company, and the ombud connection can only apply to one of them. Archive the other companies with the same organisation number, or ask whoever manages them to, then try again.',
  },
  // Skatteverket's Ombudshantering could not be reached when the appoint
  // button asked it for the deep link: a 502/503/504, no answer within the
  // timeout, or no connection. Its own text (status, operation, body) is for
  // the log: passed on to the page it read "Något gick fel. Försök igen."
  // (2026-11-14, 13 tries in two hours while the service answered 503).
  SKATTEVERKET_OMBUD_UNAVAILABLE: {
    httpStatus: 503,
    message_sv: 'Skatteverkets ombudstjänst är inte tillgänglig just nu. Försök igen om en stund.',
    message_en: "Skatteverket's ombud service is unavailable right now. Try again in a while.",
    retryable: true,
  },
  // A Skatteverket request named a redovisare other than the active company's
  // own: a stale page after a company switch, or a crafted URL.
  SKV_REDOVISARE_NOT_COMPANY: {
    httpStatus: 403,
    message_sv:
      'Organisationsnumret hör inte till företaget du arbetar i. Ladda om sidan och försök igen.',
    message_en:
      'The organisation number does not belong to the company you are working in. Reload the page and try again.',
  },
  SKATTEVERKET_RATE_LIMITED: {
    httpStatus: 429,
    message_sv: 'För många förfrågningar mot Skatteverket. Vänta en stund och försök igen.',
    message_en: 'Skatteverket rate limit exceeded.',
    retryable: true,
  },
  // No answer from Skatteverket at all: the call's timeout ran out, or no
  // connection; on an approval, also Skatteverket's own 502, 503 or 504. It
  // says nothing about the request or the company's connection, so the same
  // call can be made again later. As the platform's own error it reached
  // agents as UNKNOWN_ERROR, "The operation was aborted due to timeout" (12
  // calls in five minutes on 2026-11-05). The one answer every Skatteverket
  // door gives (skvUnavailableAnswer in the skatteverket extension's
  // lib/api-client.ts).
  SKATTEVERKET_UNAVAILABLE: {
    httpStatus: 503,
    message_sv: 'Skatteverket svarade inte i tid. Försök igen om en stund.',
    message_en:
      'Skatteverket did not answer: no reply within the time limit, or no connection. Try the same call again in a few minutes.',
    retryable: true,
    remediation: {
      description:
        "The arguments and the company's Skatteverket connection are not the problem: do not ask the user to reconnect.",
    },
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
  BOLAGSVERKET_K3_FILING_CLOSED: {
    httpStatus: 409,
    message_sv:
      'Digital inlämning av K3-årsredovisningar är inte öppnad. Den låsta versionen finns kvar och kan lämnas in när K3-inlämningen öppnas.',
    message_en:
      'Connected filing of K3 annual reports is not open. The locked version is kept and can be filed once K3 filing opens.',
    retryable: false,
  },
  BOLAGSVERKET_RB_NO_ARSREDOVISNING: {
    httpStatus: 409,
    message_sv:
      'Revisionsberättelsen kan lämnas in först när årsredovisningen har laddats upp till Bolagsverket med en revisionsberättelse som kompletteras.',
    message_en:
      'The audit report can be filed only after the annual report was uploaded to Bolagsverket as one whose audit report follows separately.',
    retryable: false,
  },
  BOLAGSVERKET_RB_ARELLE_FAILED: {
    httpStatus: 409,
    message_sv:
      'Arelle hittade blockerande fel i revisionsberättelsen. Revisorn behöver rätta filen och lämna en ny innan den kan lämnas in.',
    message_en:
      'Arelle found blocking errors in the audit report. The auditor needs to correct the file and provide a new one before it can be filed.',
    retryable: false,
  },
  BOLAGSVERKET_RB_INVALID_FILE: {
    httpStatus: 400,
    message_sv:
      'Filen är inte en revisionsberättelse i iXBRL-format (XHTML med Bolagsverkets taxonomi för revisionsberättelse, högst 5 MB).',
    message_en:
      'The file is not an audit report in iXBRL (XHTML referencing the Bolagsverket audit report taxonomy, at most 5 MB).',
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
  // K2/K3 framework per räkenskapsår (BFNAR 2012:4), lib/company/accounting-framework-change.ts.
  ACCOUNTING_FRAMEWORK_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Endast företagets ägare eller administratör kan byta regelverk.',
    message_en: 'Only an owner or admin of the company can change its accounting framework.',
    retryable: false,
  },
  ACCOUNTING_FRAMEWORK_FORM_UNSUPPORTED: {
    httpStatus: 400,
    message_sv:
      'K3 (BFNAR 2012:1) kan inte väljas för den här företagsformen: en ekonomisk förening upprättar årsredovisningen enligt K2 och övriga företagsformer upprättar årsbokslut.',
    message_en: 'K3 (BFNAR 2012:1) is not offered for this legal form.',
    retryable: false,
  },
  ACCOUNTING_FRAMEWORK_K2_NOT_ALLOWED: {
    httpStatus: 400,
    message_sv:
      'En bostadsrättsförening får inte tillämpa K2 för räkenskapsår som inleds efter 2025-12-31; den ska tillämpa K3 (BFNAR 2016:10 punkt 1.1 A e, BFNAR 2025:2).',
    message_en:
      'A bostadsrättsförening may not apply K2 for fiscal years starting after 2025-12-31; it applies K3 (BFNAR 2016:10 point 1.1 A e, BFNAR 2025:2).',
    retryable: false,
  },
  ACCOUNTING_FRAMEWORK_PERIOD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsåret kunde inte hittas.',
    message_en: 'The fiscal year was not found for this company.',
    retryable: false,
  },
  ACCOUNTING_FRAMEWORK_PERIOD_CLOSED: {
    httpStatus: 409,
    message_sv:
      'Regelverket kan inte bytas för ett räkenskapsår som är stängt, låst eller vars bokföring är låst till och med årets sista dag.',
    message_en:
      'The framework cannot change for a fiscal year that is closed, locked, or whose bookkeeping is locked through its last day.',
    retryable: false,
  },
  ACCOUNTING_FRAMEWORK_REPORT_LOCKED: {
    httpStatus: 409,
    message_sv:
      'Regelverket kan inte bytas: årets årsredovisning är redan låst för underskrift, undertecknad eller inlämnad.',
    message_en:
      'The framework cannot change: the year\'s annual report version is already locked for signing, signed or filed.',
    retryable: false,
  },
  ACCOUNTING_FRAMEWORK_PREVIOUS_YEAR_UNKNOWN: {
    httpStatus: 400,
    message_sv:
      'Ange enligt vilket regelverk föregående årsredovisning upprättades. Accounted har inget säkert underlag för det, och ett byte från K3 till K2 ska motiveras i not (BFNAR 2012:4 punkt 3).',
    message_en:
      'State the framework the previous annual report was prepared under (previous_year_framework: k2, k3 or none): Accounted holds no reliable record of it, and a switch from K3 to K2 is explained in a note (BFNAR 2012:4 point 3).',
    retryable: false,
  },
  ACCOUNTING_FRAMEWORK_REASON_REQUIRED: {
    httpStatus: 400,
    message_sv:
      'Ange skälen till bytet från K3 till K2. De lämnas i not i årsredovisningen (BFNAR 2012:4 punkt 3).',
    message_en:
      'State the reasons for switching from K3 to K2 (change_reason); they are disclosed in a note (BFNAR 2012:4 point 3).',
    retryable: false,
  },
  ACCOUNTING_FRAMEWORK_PREVIOUS_K2_UNKNOWN: {
    httpStatus: 400,
    message_sv:
      'Ange om företaget tidigare har tillämpat K2. Då krävs särskilda skäl för att byta från K3 till K2 (BFNAR 2012:4 punkt 2).',
    message_en:
      'State whether the company applied K2 before (previously_applied_k2): a switch from K3 to K2 then needs special reasons (BFNAR 2012:4 point 2).',
    retryable: false,
  },
  ACCOUNTING_FRAMEWORK_SPECIAL_REASONS_REQUIRED: {
    httpStatus: 400,
    message_sv:
      'Företaget har tillämpat K2 tidigare, så bytet från K3 till K2 kräver särskilda skäl. Skatteskäl är inte särskilda skäl (BFNAR 2012:4 punkt 2).',
    message_en:
      'The company applied K2 before: switching from K3 to K2 needs special reasons, confirmed with special_reasons_confirmed. Tax reasons are not special reasons (BFNAR 2012:4 point 2).',
    retryable: false,
  },
  // Förenklat årsbokslut (BFNAR 2010:1), lib/bokslut/forenklat-arsbokslut.
  FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM: {
    httpStatus: 400,
    message_sv: 'Förenklat årsbokslut enligt BFNAR 2010:1 upprättas här bara för en ideell förening.',
    message_en: 'The förenklat årsbokslut (BFNAR 2010:1) is prepared here only for an ideell förening.',
    retryable: false,
  },
  FORENKLAT_ARSBOKSLUT_BLOCKED: {
    httpStatus: 422,
    message_sv:
      'Det förenklade årsbokslutet kan inte skapas förrän bokföringen är rättad och föreningens villkor är bekräftade. Orsaken står bland årsbokslutets kontroller.',
    message_en:
      'The förenklat årsbokslut is refused until the books are corrected and the eligibility is confirmed. details.reason and the report blockers name the cause.',
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
      'Avyttringen kan inte bokföras eftersom avskrivningar eller en nedskrivning redan finns för samma eller en senare period. Återför den felaktiga posten med storno först.',
    message_en:
      'The disposal cannot be posted because depreciation or a write-down already exists for the same or a later period. Reverse the incorrect entry first.',
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
      'Redan avskrivet belopp är ogiltigt: det måste vara mellan 0 och anskaffningsvärdet minus restvärdet och ha ett datum som inte är senare än i dag eller före anskaffningsdatumet. För en tillgång med komponenter ska det stämma med summan av komponenternas belopp.',
    message_en:
      'The opening accumulated depreciation is invalid: it must be between 0 and the acquisition cost less the residual value and carry a date that is not after today or before the acquisition date. For an asset with components it must agree with the sum of the components\' amounts.',
  },
  ASSET_COMPONENTS_CHANGED: {
    httpStatus: 409,
    message_sv:
      'Tillgångens komponenter har ändrats sedan avskrivningen beräknades. Beräkna förslaget på nytt innan du bokför.',
    message_en:
      'The asset\'s components changed after the depreciation was calculated. Recalculate the proposal before posting.',
  },
  ASSET_COMPONENT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Komponenten kunde inte hittas.',
    message_en: 'Component not found.',
  },
  ASSET_COMPONENT_NOT_ACTIVE: {
    httpStatus: 409,
    message_sv: 'Komponenten är redan utbytt och finns inte längre i balansräkningen.',
    message_en: 'The component has already been replaced and is no longer on the balance sheet.',
  },
  ASSET_LAST_COMPONENT: {
    httpStatus: 409,
    message_sv:
      'Den sista komponenten kan inte tas bort utan att ersättas: då lämnar hela tillgången balansräkningen. Använd avyttring i stället.',
    message_en:
      'The last component cannot leave without a replacement: the whole asset would then leave the balance sheet. Dispose of the asset instead.',
  },
  ASSET_COMPONENT_STATE_CHANGED: {
    httpStatus: 409,
    message_sv: 'Komponentens avskrivningar har ändrats sedan utbytet beräknades. Beräkna utbytet på nytt.',
    message_en: 'The component\'s depreciation changed after the replacement was calculated. Calculate it again.',
  },
  ASSET_COMPONENT_REVERSAL_BLOCKED: {
    httpStatus: 409,
    message_sv:
      'Komponentutbytet kan inte återföras: avskrivning för utbytesåret eller ett senare år är redan bokförd utan den utbytta komponenten. Återför den avskrivningen med storno först.',
    message_en:
      'The component replacement cannot be reversed: depreciation for the replacement year or a later year is already posted without the replaced component. Reverse that depreciation first.',
  },
  ASSET_COMPONENT_REPLACEMENT_BLOCKED: {
    httpStatus: 409,
    message_sv:
      'Komponenten kan inte bytas ut nu: avskrivningen för ett tidigare år måste bokföras först, årets eller ett senare års avskrivning är redan bokförd (byt då ut per balansdagen, eller återför avskrivningen med storno först), eller så har komponenten en nedskrivning kvar (återför den först).',
    message_en:
      'The component cannot be replaced now: an earlier year\'s depreciation must be posted first, this or a later year\'s depreciation is already posted (replace as of the balance sheet date, or reverse the depreciation first), or a write-down is outstanding on the component (reverse it first).',
  },
  ASSET_COMPONENT_IMPAIRED: {
    httpStatus: 409,
    message_sv: 'Komponenten har en nedskrivning kvar och kan inte bytas ut. Återför nedskrivningen först.',
    message_en: 'A write-down is outstanding on the component, so it cannot be replaced. Reverse the write-down first.',
  },
  ASSET_VALUE_ADJUSTMENT_BLOCKED: {
    httpStatus: 409,
    // AssetValueAdjustmentBlockedError names the reason in Swedish.
    thrown_message_sv: true,
    message_sv:
      'Nedskrivningen kan inte bokföras: kontrollera räkenskapsåret, att årets avskrivning är bokförd och att återvinningsvärdet ger en nedskrivning eller återföring.',
    message_en:
      'The write-down cannot be posted: check the fiscal year, that the year\'s depreciation is posted, and that the recoverable amount gives a write-down or a reversal (a goodwill write-down is never reversed).',
  },
  ASSET_VALUE_ADJUSTMENT_REVERSAL_BLOCKED: {
    httpStatus: 409,
    message_sv:
      'Nedskrivningen kan inte återföras med storno: en senare avskrivning, nedskrivning eller avyttring bygger på det nedskrivna värdet. Återför den först.',
    message_en:
      'The write-down cannot be reversed: a later depreciation, write-down or disposal is based on the written-down value. Reverse that first.',
  },
  DEFERRED_TAX_ALREADY_POSTED: {
    httpStatus: 409,
    message_sv:
      'Uppskjuten skatt är redan bokförd för räkenskapsåret. Återför den verifikationen med storno innan en ny beräkning bokförs.',
    message_en:
      'Deferred tax is already posted for the fiscal year. Reverse that voucher before posting a new calculation.',
  },
  K3_TRANSITION_BLOCKED: {
    httpStatus: 409,
    // K3TransitionBlockedError names the reason in Swedish.
    thrown_message_sv: true,
    message_sv:
      'Övergången till K3 kan inte genomföras: kontrollera att räkenskapsåret är öppet och upprättas enligt K3 och att övergången inte redan är bokförd.',
    message_en:
      'The transition to K3 cannot proceed: check that the fiscal year is open and reported under K3 and that the transition is not already posted.',
  },
  INVALID_K3_TRANSITION: {
    httpStatus: 400,
    // K3TransitionInvalidError names the rule in Swedish.
    thrown_message_sv: true,
    message_sv: 'Övergångsjusteringarna är ogiltiga (K3 punkt 35.11).',
    message_en: 'The transition adjustments are invalid (K3 35.11).',
  },
  DEFERRED_TAX_NOT_APPLICABLE: {
    httpStatus: 422,
    message_sv: 'Uppskjuten skatt redovisas bara när räkenskapsåret upprättas enligt K3 (BFNAR 2012:1 kap. 29).',
    message_en: 'Deferred tax is recognised only when the fiscal year is reported under K3 (BFNAR 2012:1 chapter 29).',
  },
  DEVELOPMENT_MODEL_REFUSED: {
    httpStatus: 422,
    // DevelopmentModelRefusedError names the reason in Swedish.
    thrown_message_sv: true,
    message_sv:
      'Modellen för internt upparbetade immateriella tillgångar kan inte ändras här: den väljs enligt K3, och ett byte bort från aktiveringsmodellen med aktiverade tillgångar är ett byte av redovisningsprincip.',
    message_en:
      'The model for internally generated intangible assets cannot be changed here: it is chosen under K3, and leaving the capitalisation model with capitalised assets is a change of accounting policy.',
  },
  OWN_DEVELOPMENT_ACCOUNT: {
    httpStatus: 400,
    // AssetOwnDevelopmentAccountError says what to do in Swedish.
    thrown_message_sv: true,
    message_sv: 'Bara en tillgång på konto 1010-1019 kan markeras som eget utvecklingsarbete.',
    message_en: 'Only an asset on account 1010-1019 can be marked as own development.',
  },
  OWN_DEVELOPMENT_NOT_CAPITALISED: {
    httpStatus: 422,
    // AssetOwnDevelopmentRefusedError names the reason in Swedish.
    thrown_message_sv: true,
    message_sv:
      'Eget utvecklingsarbete kan inte tas upp som tillgång: det kräver K3 och att aktiveringsmodellen är vald (K3 punkt 18.7).',
    message_en:
      'Own development expenditure cannot be capitalised: it needs K3 and the capitalisation model chosen (K3 18.7).',
  },
  INVALID_TAX_PLAN: {
    httpStatus: 400,
    // AssetTaxPlanInvalidError names the rule in Swedish.
    thrown_message_sv: true,
    message_sv: 'Den skattemässiga avskrivningsplanen är ogiltig (IL 19 och 20 kap.).',
    message_en: 'The tax depreciation plan is invalid (Income Tax Act chapters 19 and 20).',
  },
  TAX_PLAN_USED_BY_CLOSED_YEAR: {
    httpStatus: 409,
    // AssetTaxPlanLockedError says why in Swedish.
    thrown_message_sv: true,
    message_sv: 'Den skattemässiga avskrivningsplanen har använts för ett stängt eller låst räkenskapsår och kan inte ändras.',
    message_en: 'The tax depreciation plan was used by a closed or locked fiscal year and cannot be changed.',
  },
  INVALID_LAND_ASSET: {
    httpStatus: 400,
    message_sv:
      'Bara mark har 0 månaders nyttjandeperiod, och mark skrivs inte av: den har inget restvärde, inget redan avskrivet belopp, inget startdatum för avskrivning och inga komponenter. Annan tillgång behöver en nyttjandeperiod på minst 1 månad.',
    message_en:
      'Only land has a useful life of 0 months, and land is not depreciated: it has no salvage value, opening depreciation, depreciation start date or components. Any other asset needs a useful life of at least 1 month.',
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
    // AssetComponentsInvalidError names the failed rule in Swedish.
    thrown_message_sv: true,
    message_sv:
      'Komponentuppdelningen är ogiltig: komponenternas anskaffningsvärden måste summera till tillgångens anskaffningsvärde, och varje komponent behöver namn, anskaffningsvärde, nyttjandeperiod (tom för mark) och giltiga datum.',
    message_en:
      'The component breakdown is invalid: component costs must sum to the acquisition cost of the asset, and each component needs a name, a cost, a useful life (empty for land) and valid dates.',
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
  FINANCE_LEASE_DISABLED: {
    httpStatus: 503,
    message_sv: 'Finansiell leasing finns inte här ännu.',
    message_en: 'Finance leases are not available here yet.',
  },
  FINANCE_LEASE_NOT_ENABLED: {
    httpStatus: 409,
    message_sv: 'Välj först att finansiella leasingavtal redovisas som tillgång och skuld (K3 20.5).',
    message_en: 'First choose to report finance leases as an asset and a liability (K3 20.5).',
  },
  FINANCE_LEASE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Leasingavtalet hittades inte.',
    message_en: 'The lease was not found.',
  },
  FINANCE_LEASE_NO_PERIOD: {
    httpStatus: 404,
    message_sv: 'Räkenskapsåret hittades inte.',
    message_en: 'The financial year was not found.',
  },
  FINANCE_LEASE_YEAR_ALREADY_POSTED: {
    httpStatus: 409,
    message_sv: 'Leasingavtalen är redan bokförda för det här räkenskapsåret.',
    message_en: 'The leases are already booked for this financial year.',
  },
  FINANCE_LEASE_START_NOT_BOOKED: {
    httpStatus: 409,
    message_sv: 'Ett leasingavtal började ett tidigare räkenskapsår och dess start är inte bokförd. Bokför det året först.',
    message_en: 'A lease began in an earlier financial year and its start is not booked. Book that year first.',
  },
}

// Year-end stock count (inventeringslista, LIV 1955:257): lib/bokslut/stock-count
const STOCK_COUNT: Record<string, StructuredErrorEntry> = {
  STOCK_COUNT_DISABLED: {
    httpStatus: 404,
    message_sv: 'Inventering av varulager finns inte här ännu.',
    message_en: 'The stock count is not available here yet.',
  },
  STOCK_COUNT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Inventeringen hittades inte.',
    message_en: 'The stock count was not found.',
  },
  STOCK_COUNT_NO_PERIOD: {
    httpStatus: 404,
    message_sv: 'Räkenskapsåret hittades inte.',
    message_en: 'The financial year was not found.',
  },
  STOCK_COUNT_ROLL_FORWARD_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Inventeringen gjordes en annan dag än balansdagen. Beskriv hur lagret räknats fram till balansdagen.',
    message_en: 'The stock was counted on another day than the balance sheet date. Describe how the count was rolled forward to it.',
  },
  STOCK_COUNT_LOCKED: {
    httpStatus: 409,
    message_sv: 'Inventeringslistan är signerad och kan inte ändras.',
    message_en: 'The stock count is signed and cannot be changed.',
  },
  STOCK_COUNT_SIGNING_PENDING: {
    httpStatus: 409,
    message_sv: 'Inventeringslistan väntar på BankID-signering. Avbryt signeringen för att ändra den.',
    message_en: 'The stock count is waiting for a BankID signature. Cancel the signing to change it.',
  },
  STOCK_COUNT_EMPTY: {
    httpStatus: 400,
    message_sv: 'Inventeringslistan har inga rader.',
    message_en: 'The stock count has no rows.',
  },
  STOCK_COUNT_NOT_SIGNED: {
    httpStatus: 409,
    message_sv: 'Inventeringslistan ska signeras innan lagerförändringen bokförs.',
    message_en: 'The stock count must be signed before the change in stock is booked.',
  },
  STOCK_COUNT_ALREADY_BOOKED: {
    httpStatus: 409,
    message_sv: 'Lagerförändringen är redan bokförd för det här räkenskapsåret.',
    message_en: 'The change in stock is already booked for this financial year.',
  },
  STOCK_COUNT_ARTICLE_NOT_FOUND: {
    httpStatus: 400,
    message_sv: 'En artikel på inventeringslistan finns inte i artikelregistret.',
    message_en: 'An article on the stock count is not in the article register.',
  },
  STOCK_COUNT_FILE_INVALID: {
    httpStatus: 400,
    message_sv: 'Den signerade kopian kunde inte sparas: kontrollera filtypen och storleken.',
    message_en: 'The signed copy could not be saved: check the file type and size.',
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
    message_sv: 'Bokföringsmetoden kan inte bytas mitt i ett räkenskapsår som har bokförda verifikationer, utom som en rättelse med angivet skäl.',
    message_en: 'The accounting method cannot change in the middle of a fiscal year that has posted vouchers: it governs the whole year. Change it before the next fiscal year, or, if the setting was wrong from the start, send accounting_method_correction_reason to record the change as a correction.',
  },
  ACCOUNTING_METHOD_CHANGE_OPEN_INVOICES: {
    httpStatus: 409,
    message_sv: 'Bokföringsmetoden kan inte bytas medan obetalda fakturor saknar egen verifikation.',
    message_en: 'The accounting method cannot change while open customer or supplier invoices have no verifikat of their own: after the switch their payment would book the sale or purchase twice, or never. Book them, or link them to the verifikat that booked them, first.',
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

// Budgets (accounted#134): planning data per resultatkonto, month and
// dimension. The database answers these codes from upsert_budget_lines.
const BUDGET: Record<string, StructuredErrorEntry> = {
  BUDGET_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Budgeten hittades inte.',
    message_en: 'Budget not found.',
    remediation: { description: 'List the budgets (GET /budgets) and use a budget_id from the answer.' },
  },
  BUDGET_NAME_TAKEN: {
    httpStatus: 409,
    message_sv: 'Det finns redan en budget med det namnet för räkenskapsåret.',
    message_en: 'The fiscal year already has a budget with that name.',
  },
  BUDGET_ARCHIVED: {
    httpStatus: 409,
    message_sv: 'Budgeten är arkiverad och kan inte ändras. Återställ den först.',
    message_en: 'The budget is archived and cannot be changed. Restore it first.',
    remediation: { description: 'PATCH the budget with archived=false, then retry.' },
  },
  BUDGET_ACCOUNT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kontot finns inte i kontoplanen. Lägg till det i kontoplanen innan du budgeterar på det.',
    message_en: 'The account is not in the chart of accounts. Add it before budgeting on it.',
    remediation: {
      description: 'details.account_numbers lists the accounts missing from the chart; create them (POST /accounts) or leave them out.',
    },
  },
  BUDGET_MONTH_OUTSIDE_YEAR: {
    httpStatus: 400,
    message_sv: 'Budgeten har en månad utanför räkenskapsåret.',
    message_en: 'A budget month lies outside the fiscal year.',
    remediation: {
      description: 'details.months lists the months outside details.period_start..period_end; use months of the fiscal year the budget belongs to (YYYY-MM).',
    },
  },
  BUDGET_LINES_DUPLICATE: {
    httpStatus: 400,
    message_sv: 'Samma konto, månad och dimension förekommer flera gånger i samma sparning.',
    message_en: 'The same account, month and dimension tag appear more than once in one save.',
  },
  BUDGET_SOURCE_YEAR_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Det finns inget föregående räkenskapsår att hämta utfall från.',
    message_en: 'There is no previous fiscal year to read actuals from.',
    remediation: { description: 'Name the year to read with source_fiscal_period_id, or spread evenly (method even).' },
  },
  BUDGET_NONE_FOR_YEAR: {
    httpStatus: 404,
    message_sv: 'Räkenskapsåret har ingen standardbudget. Välj en budget eller markera en som standard.',
    message_en: 'The fiscal year has no default budget. Name a budget or make one the default.',
    remediation: { description: 'Send budget_id, or PATCH a budget of the year with is_default true.' },
  },
  BUDGET_OTHER_FISCAL_YEAR: {
    httpStatus: 400,
    message_sv: 'Budgeten hör till ett annat räkenskapsår än rapporten. Välj en budget för det valda året.',
    message_en: 'The budget belongs to another fiscal year than the report. Pick a budget of the chosen year.',
    remediation: { description: 'List the budgets of the report\'s fiscal year (GET /budgets?fiscal_period_id=...) and send one of those.' },
  },
  BUDGET_IMPORT_UNSUPPORTED_FILE: {
    httpStatus: 400,
    message_sv: 'Filtypen stöds inte. Läs in en SIE-fil eller ett kalkylark (Excel, CSV eller ODS).',
    message_en: 'Unsupported file type. Import a SIE file or a spreadsheet (Excel, CSV or ODS).',
  },
  BUDGET_IMPORT_FILE_TOO_LARGE: {
    httpStatus: 413,
    message_sv: 'Filen är för stor för en budget (högst 10 MB).',
    message_en: 'The file is too large for a budget (10 MB at most).',
  },
  BUDGET_IMPORT_UNREADABLE: {
    httpStatus: 400,
    message_sv: 'Filen kunde inte läsas. Kontrollera att den är en hel SIE-fil eller ett kalkylark.',
    message_en: 'The file could not be read. Check that it is a complete SIE file or spreadsheet.',
  },
  BUDGET_IMPORT_NO_BUDGET_IN_FILE: {
    httpStatus: 400,
    message_sv: 'SIE-filen innehåller ingen budget (#PBUDGET). Exportera den med budget i källprogrammet, eller läs in budgeten som kalkylark.',
    message_en: 'The SIE file holds no budget (#PBUDGET). Export it with the budget from the source program, or import the budget as a spreadsheet.',
  },
  BUDGET_IMPORT_LAYOUT_UNKNOWN: {
    httpStatus: 400,
    message_sv: 'Kalkylarkets kolumner känns inte igen. Använd kolumnerna konto, månad och belopp (och gärna dim och kod), eller konto och en kolumn per månad.',
    message_en: 'The spreadsheet columns are not recognised. Use the columns konto, månad and belopp (optionally dim and kod), or konto and one column per month.',
    remediation: {
      description: 'Long layout: a header row with konto, månad (YYYY-MM) and belopp, optionally dim and kod. Wide layout: konto and one column per month headed 2027-01 or jan.',
    },
  },
  BUDGET_IMPORT_NOTHING_TO_IMPORT: {
    httpStatus: 400,
    message_sv: 'Filen gav inga budgetbelopp för budgetens räkenskapsår. Förhandsgranskningen visar vilka rader som hoppades över och varför.',
    message_en: 'The file gave no budget amounts for the budget\'s fiscal year. The preview shows which rows were skipped and why.',
    remediation: { description: 'details.skipped lists the accounts, objects and months that were left out; run with dry_run to see it.' },
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
  WEBSHOP_ORDER_COUNTRY_UNKNOWN: {
    httpStatus: 422,
    message_sv:
      'Ordern saknar leveransland, och butiken har valt konton för försäljning utanför Sverige, så massbokföringen kan inte avgöra vilka konton som gäller. Bokför ordern enskilt och granska raderna. Saknar alla ordrar land delar butiken inte adresser med appen: kontrollera Shopify-panelen under Inställningar > Kopplingar > Shopify.',
    message_en:
      'The order has no destination country and the store has chosen accounts for sales outside Sweden, so bulk booking cannot tell which accounts apply. Book the order individually and review the lines. If every order lacks a country, the store does not share addresses with the app: check the Shopify panel under Settings > Connections > Shopify.',
  },
  WEBSHOP_ORDER_COUNTRY_NOT_ROUTED: {
    httpStatus: 422,
    message_sv:
      'Ordern skickas till ett land utanför Sverige som saknar kontoval för sin momssats, så massbokföringen skulle bokföra den som svensk försäljning. Välj konton för landet under Inställningar > Kopplingar > Shopify, eller bokför ordern enskilt.',
    message_en:
      'The order ships to a country outside Sweden that has no account choice for its VAT rate, so bulk booking would book it as a Swedish sale. Choose accounts for the country under Settings > Connections > Shopify, or book the order individually.',
  },
  WEBSHOP_COUNTRY_RULES_INVALID: {
    httpStatus: 400,
    message_sv:
      'Kontovalet per land kunde inte sparas: minst en rad har ett konto som inte passar landet eller saknas i kontoplanen. Se raderna som är markerade.',
    message_en:
      'The accounts per country could not be saved: at least one row has an account that does not fit the country or is missing from the chart of accounts. See the marked rows.',
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
  WEBSHOP_DAY_EMPTY: {
    httpStatus: 400,
    message_sv: 'Det finns inga obokförda, betalda ordrar med det betalsättet den dagen: inget att bokföra.',
    message_en: 'There are no unbooked, paid orders with that payment method on that day: nothing to book.',
  },
  WEBSHOP_DAY_NOTHING_BOOKABLE: {
    httpStatus: 422,
    message_sv: 'Ingen av dagens ordrar kan bokföras automatiskt. Se skälet för varje order och bokför dem en och en.',
    message_en: 'None of the day\'s orders can be booked automatically. See the reason for each order and book them one by one.',
  },
  WEBSHOP_DAY_CHANGED: {
    httpStatus: 409,
    message_sv: 'Dagens ordrar har ändrats sedan förslaget skapades (en order har bokförts, markerats eller ändrats). Inget bokfördes; skapa ett nytt förslag för dagen.',
    message_en: 'The day\'s orders changed since the proposal was made (an order was booked, marked or changed). Nothing was booked; make a new proposal for the day.',
  },
  WEBSHOP_DAY_TOO_MANY_ROWS: {
    httpStatus: 422,
    message_sv: 'Dagen har fler ordrar än vad som kan bokföras på ett verifikat. Kontakta supporten.',
    message_en: 'The day has more orders than one journal entry can book. Contact support.',
  },
  WEBSHOP_DAY_BOOKING_FAILED: {
    httpStatus: 500,
    message_sv: 'Dagen kunde inte bokföras. Inget verifikat skapades och inga ordrar markerades.',
    message_en: 'The day could not be booked. No journal entry was created and no orders were marked.',
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
  WEBSHOP_ORDER_READ_FAILED: {
    httpStatus: 500,
    message_sv: 'Ordrarna kunde inte läsas. Försök igen.',
    message_en: 'The orders could not be read. Try again.',
    retryable: true,
  },
  OSS_UNDERLAG_FAILED: {
    httpStatus: 500,
    message_sv: 'Underlaget till OSS-deklarationen kunde inte tas fram. Försök igen.',
    message_en: 'The OSS declaration underlag could not be built. Try again.',
    retryable: true,
  },
  WEBSHOP_ORDER_BOOKING_FAILED: {
    httpStatus: 500,
    message_sv: 'Ordern kunde inte bokföras. Inget verifikat skapades.',
    message_en: 'The order could not be booked. No journal entry was created.',
  },
  WEBSHOP_ORDER_NOT_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Ordern är inte bokförd än. Orderunderlaget bifogas verifikatet när ordern bokförs.',
    message_en:
      'The order is not booked yet. The order underlag is attached to the journal entry when the order is booked.',
  },
  WEBSHOP_ORDER_UNDERLAG_FAILED: {
    httpStatus: 500,
    message_sv: 'Orderunderlaget kunde inte skapas. Försök igen om en stund.',
    message_en: 'The order underlag could not be created. Try again shortly.',
    retryable: true,
  },
  // transaction_id on webshop-orders.book (checkOrderBankRow): the named bank
  // row is not this order's payment. Refused before anything is posted.
  WEBSHOP_ORDER_TRANSACTION_AMOUNT_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Banktransaktionens belopp är inte orderns belopp i transaktionens valuta, så den kan inte kopplas till orderns verifikat. Inget bokfördes. Välj transaktionen som betalade ordern, eller bokför ordern utan transaktion.',
    message_en:
      "The bank transaction's amount is not the order's amount in the transaction's currency, so it cannot be linked to the order's voucher. Nothing was booked. Pick the transaction that paid the order, or book the order without one.",
  },
  WEBSHOP_ORDER_TRANSACTION_ACCOUNT_MISMATCH: {
    httpStatus: 409,
    message_sv:
      'Raderna bokför inte transaktionens belopp på dess bankkonto, så transaktionen kan inte kopplas till orderns verifikat. Inget bokfördes. Bokför betalningen med transaktionens belopp på transaktionens bankkonto.',
    message_en:
      "The lines do not book the transaction's amount on its bank account, so it cannot be linked to the order's voucher. Nothing was booked. Book the payment on the transaction's account (details.account_number).",
  },
  KUSTOM_SETTLEMENT_NO_FILE: {
    httpStatus: 400,
    message_sv: 'Ingen fil bifogad. Välj Kustoms settlement-rapport (CSV) och försök igen.',
    message_en: 'No file attached. Choose the Kustom settlement report (CSV) and try again.',
  },
  KUSTOM_SETTLEMENT_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Filen är för stor. Maxstorlek är 10 MB.',
    message_en: 'File exceeds the 10 MB size limit.',
  },
  KUSTOM_SETTLEMENT_NOT_RECOGNIZED: {
    httpStatus: 400,
    message_sv:
      'Filen känns inte igen som en settlement-rapport från Kustom. Ladda ner rapporten för utbetalningen som CSV i Kustoms portal och försök igen.',
    message_en:
      'The file was not recognised as a Kustom settlement report. Download the payout report as CSV in the Kustom portal and try again.',
  },
  KUSTOM_SETTLEMENT_NO_CONSUMER_VAT: {
    httpStatus: 400,
    message_sv:
      'Rapporten saknar momsen per order. Kryssa i kundmomsen i rapportinställningarna i Kustoms portal, ladda ner rapporten igen och läs in den.',
    message_en:
      'The report has no VAT per order. Turn on consumer VAT in the report settings of the Kustom portal, download the report again and upload it.',
  },
  KUSTOM_SETTLEMENT_AMOUNT_FORMAT: {
    httpStatus: 400,
    message_sv:
      'Beloppen i rapporten går inte att läsa. Välj belopp med decimaler (till exempel 100.00) i rapportinställningarna i Kustoms portal och ladda ner rapporten igen.',
    message_en:
      'The amounts in the report cannot be read. Choose decimal amounts (for example 100.00) in the report settings of the Kustom portal and download the report again.',
  },
  KUSTOM_SETTLEMENT_DATE_FORMAT: {
    httpStatus: 400,
    message_sv:
      'Datumen i rapporten går inte att läsa. Välj datum med klockslag (Kustoms standard, till exempel 2026-11-18T09:00:00.000Z) i rapportinställningarna i Kustoms portal och ladda ner rapporten igen. Utan klockslag går det inte att avgöra vilken svensk dag ett köp gjordes.',
    message_en:
      "The dates in the report cannot be read. Choose dates with the time (Kustom's default, for example 2026-11-18T09:00:00.000Z) in the report settings of the Kustom portal and download the report again. Without the time, the Swedish day of a sale cannot be told.",
  },
  KUSTOM_SETTLEMENT_ID_COLUMNS_MISSING: {
    httpStatus: 400,
    message_sv:
      'Rapporten saknar kolumnen capture_id eller refund_id, som håller isär köp och returer. Lägg till dem i rapportinställningarna i Kustoms portal och ladda ner rapporten igen.',
    message_en:
      'The report lacks the capture_id or refund_id column, which tells sales and returns apart. Add them in the report settings of the Kustom portal and download the report again.',
  },
  KUSTOM_SETTLEMENT_DUPLICATE_ROW: {
    httpStatus: 400,
    message_sv:
      'Samma köp eller retur står två gånger i rapporten, så den går inte att läsa in säkert. Ladda ner rapporten igen från Kustom.',
    message_en:
      'The same sale or return appears twice in the report, so it cannot be uploaded safely. Download the report again from Kustom.',
  },
  KUSTOM_SETTLEMENT_TOTALS_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Raderna i rapporten summerar inte till rapportens totaler, så filen verkar avkortad eller ändrad. Ladda ner rapporten igen från Kustom.',
    message_en:
      'The rows of the report do not add up to its totals, so the file looks cut or edited. Download the report again from Kustom.',
  },
  KUSTOM_SETTLEMENT_CUT_SHORT: {
    httpStatus: 400,
    message_sv: 'Filen tar slut mitt i en rad, så den verkar avkortad. Ladda ner rapporten igen från Kustom.',
    message_en: 'The file ends in the middle of a row, so it looks cut short. Download the report again from Kustom.',
  },
  KUSTOM_SETTLEMENT_TOO_MANY_ROWS: {
    httpStatus: 400,
    message_sv:
      'Rapporten har fler än 10 000 köp och returer, mer än en uppladdning läser in. Ladda ner rapporten för en utbetalning i taget från Kustom.',
    message_en:
      'The report holds more than 10,000 sales and returns, more than one upload reads. Download the report for one payout at a time from Kustom.',
  },
  KUSTOM_SETTLEMENT_IMPORT_FAILED: {
    httpStatus: 500,
    message_sv: 'Det gick inte att spara alla ordrar från rapporten. Försök igen: ordrar som redan sparats läses inte in två gånger.',
    message_en: 'Not every order from the report could be saved. Try again: orders already saved are not imported twice.',
    retryable: true,
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

// Link refusals of the account-keyed reconciliation surface
// (lib/reconciliation/actions.ts) that are not amounts or shapes. A skipped
// pair carries the bank engine's own Swedish sentence; this entry is what the
// envelope says when the code is the whole answer (a committed
// reconciliation_match whose every pair was refused).
const RECONCILIATION_LINK: Record<string, StructuredErrorEntry> = {
  // The bank-anchor guard (PT409 BANK_ANCHOR_*) refused the link write. Was
  // UNKNOWN with "Försök igen", and the retry failed the same way every time
  // (agent feedback seq 853921, 877706).
  BANK_ANCHOR_REFUSED: {
    httpStatus: 409,
    message_sv:
      'Kopplingen nekades: en verifikation bokför inte beloppet på bankkontot åt samma håll som transaktionen (vid en delning: som sin del av den), eller så har transaktionens bankkonto ändrats. Kontrollera verifikationen och bankkontot innan du försöker igen.',
    message_en:
      'The database refused the bank link: a voucher does not book the amount on the bank ledger in the direction of the transaction (in a 1:N split: of its own slice), or the bank account of the transaction changed. Check the vouchers and the bank account; retrying the same request will not succeed.',
  },
  // Koppla bort on a row that has no link (a skattekonto row or a bank row).
  RECONCILIATION_NOT_LINKED: {
    httpStatus: 409,
    message_sv: 'Transaktionen är inte kopplad till något verifikat.',
    message_en: 'The row is not linked to any verifikat, so there is nothing to unlink.',
  },
  // Koppla bort on a bank row whose verifikat was booked from the row itself
  // (categorize, match-invoice, a direct booking): the verifikat is the row's
  // booking, not a link, and BFL 5 kap 5 § corrects it by storno. Was a bare
  // Error answered 500 INTERNAL_ERROR (PH 194).
  RECONCILIATION_UNLINK_IS_BOOKING: {
    httpStatus: 409,
    message_sv:
      'Transaktionen är bokförd med verifikatet, inte bara kopplad till det, så kopplingen kan inte tas bort. Återför verifikatet med storno i stället, så kommer transaktionen tillbaka till Att bokföra.',
    message_en:
      'The bank row was booked with this verifikat (categorize, match-invoice or a direct booking), so the verifikat is its booking, not a link. Reverse the verifikat (POST /journal-entries/{id}/reverse) instead; the row then returns to the to-book list. Retrying the unlink will not succeed.',
    remediation: {
      description:
        'Reverse the row\'s verifikat (storno) instead of unlinking it; the reversal releases the row back to the to-book list.',
      tool: 'gnubok_reverse_journal_entry',
    },
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
  // The settings service composes the message with the series' highest
  // number; this is the fallback.
  SETTINGS_INVOICE_NUMBER_IN_SERIES: {
    httpStatus: 400,
    message_sv:
      'Nästa fakturanummer finns redan eller ligger under ett nummer som redan finns i nummerserien. Ange ett nummer efter det högsta, eller ett nytt prefix för en ny nummerserie.',
    message_en:
      'next_invoice_number is already used or lies under a number the series already has. Choose a number past the highest one (details.first_allowed), or a new invoice_prefix.',
    thrown_message_sv: true,
  },
  SETTINGS_SHARE_CAPITAL_PAIR: {
    httpStatus: 400,
    message_sv: 'Aktiekapital och antal aktier måste anges tillsammans. Fyll i båda fälten eller lämna båda tomma.',
    message_en: 'aktiekapital and antal_aktier are set (or cleared) together.',
  },
  // The company's own org number (lib/company/org-number-rule.ts): writable
  // while no valid one is stored, fixed once one is.
  SETTINGS_ORG_NUMBER_LOCKED: {
    httpStatus: 409,
    message_sv: 'Företaget har redan ett giltigt organisationsnummer, och det kan inte ändras.',
    message_en: 'The company already has a valid org_number; it cannot be changed.',
  },
  SETTINGS_ORG_NUMBER_INVALID: {
    httpStatus: 400,
    message_sv: 'Organisationsnumret är inte giltigt. Ange det med 10 siffror (NNNNNN-NNNN) och kontrollera att alla siffror stämmer.',
    message_en: 'org_number is not a valid Swedish organisationsnummer: 10 digits (or 12 with the century) and a correct check digit.',
  },
  SETTINGS_ORG_NUMBER_PERSONNUMMER_REQUIRED: {
    httpStatus: 400,
    message_sv: 'En enskild firmas organisationsnummer är ägarens personnummer. Ange personnumret (ÅÅMMDD-NNNN).',
    message_en: 'An enskild firma\'s org_number is the owner\'s personnummer (YYMMDD-NNNN).',
  },
  SETTINGS_ORG_NUMBER_LEGAL_ENTITY_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Numret är inget organisationsnummer för ett företag eller en förening. Ange organisationsnumret (NNNNNN-NNNN), inte ett personnummer.',
    message_en: 'org_number must be the legal person\'s organisationsnummer (third digit 2 or higher), not a personnummer.',
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
  // A booking path could not read the company's accounting method
  // (lib/company/accounting-method.ts). It refuses instead of guessing
  // faktureringsmetoden: a kontantmetod invoice's payment would then book no
  // revenue and no moms (accounted#58).
  SETTINGS_ACCOUNTING_METHOD_UNREADABLE: {
    httpStatus: 503,
    message_sv: 'Företagets bokföringsmetod kunde inte läsas, så inget bokfördes. Försök igen om en stund.',
    message_en: 'The company\'s accounting method could not be read, so nothing was booked or previewed. Retry the same request after a short backoff.',
    retryable: true,
  },
  SETTINGS_ACCOUNTING_METHOD_MISSING: {
    httpStatus: 409,
    message_sv: 'Företagets bokföringsmetod saknas i inställningarna, så inget bokfördes. Välj bokföringsmetod under Inställningar → Bokföring.',
    message_en: 'The company has no readable accounting method (company_settings.accounting_method), so nothing was booked or previewed. Set it under Inställningar → Bokföring (Settings → Bookkeeping), then retry.',
    remediation: { description: 'Set the company\'s accounting method (accrual or cash) in the company settings, then retry.' },
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
  // 20261006121004: bank_line slices against the row's direction that do not
  // add up to the row (a lone opposite-sign slice, one sibling of a mixed
  // split removed or moved away).
  BANK_ANCHOR_SPLIT_UNBALANCED: {
    httpStatus: 409,
    message_sv:
      'Transaktionen är fördelad på verifikationer i båda riktningar, och delarna blir inte tillsammans transaktionens belopp. Koppla bort transaktionen och fördela hela beloppet igen.',
    message_en:
      'The bank row is split over vouchers in both directions and the slices do not add up to its amount. Unlink the row and split the whole amount again.',
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
  // 20261113133511 (guard_bank_row_single_booking, #205): the verifikat names
  // a bank row another posted verifikat already books. Usually the same row
  // booked twice at once (a double click, two tabs), and the reload shows the
  // other booking. Rarely that verifikat was booked from the row and never
  // linked to it, so the row still reads open: the way on is the one the
  // gate's named refusal gives. Nothing was posted and no voucher number was
  // used. The database detail names the other verifikat.
  BANK_ROW_ALREADY_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Transaktionen är redan bokförd på en annan verifikation, så ingenting bokfördes. Ladda om sidan. Står transaktionen ändå kvar som obokförd är verifikationen bokförd från den men aldrig kopplad till den: koppla den under Avstämning, Matcha manuellt, eller återför den (storno).',
    message_en:
      'The bank transaction is already booked on another voucher, so nothing was booked. Reload the page. If the transaction still reads unbooked, that voucher was booked from it but never linked to it: link it under Avstämning, Matcha manuellt, or reverse it (storno).',
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
  // 20261012161600: generate_invoice_number found a higher number in the
  // company's own series, so the next one would fill a hole in it or restart
  // it (ML 17 kap 24 § p. 2). Nothing was used up. lib/invoices/
  // ensure-invoice-number.ts composes the message with the numbers; this one
  // is the fallback for an envelope without them.
  INVOICE_NUMBER_SERIES_BEHIND: {
    httpStatus: 409,
    message_sv:
      'Det finns redan fakturor med högre nummer i nummerserien. Ställ in Nästa fakturanummer efter det högsta numret under Inställningar > Fakturor, eller lägg till ett prefix för en ny nummerserie.',
    message_en:
      'The invoice series already has a higher number, so the next invoice would land inside or under the series. Set next_invoice_number past the highest number (details.first_allowed), or an invoice_prefix for a new series, then retry.',
    thrown_message_sv: true,
    remediation: {
      description:
        'Ställ in nästa fakturanummer på details.first_allowed eller högre, eller ett nytt fakturaprefix, och försök igen.',
      tool: 'gnubok_update_company_settings',
    },
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
// Collections and delivery (lib/collections, lib/invoices/distribution).
// The thrower composes the message with the provider's name from the Connect
// catalogue (lib/collections/errors.ts collectionsErrorMessage), so these are
// thrown_message_sv and message_sv is the neutral fallback ("inkassobolaget").
// lib/collections/__tests__/errors.test.ts keeps each fallback equal to its
// template there. Connector codes that already carry Peppol wording above
// (CONNECTOR_UNREACHABLE and friends) are answered under COLLECTIONS_* aliases.
// ─────────────────────────────────────────────────────────────────

const COLLECTIONS: Record<string, StructuredErrorEntry> = {
  COLLECTIONS_DISABLED: {
    httpStatus: 503,
    message_sv: 'Inkasso är inte tillgängligt just nu.',
    message_en: 'Debt collection is not available right now.',
  },
  COLLECTIONS_CAPABILITY_BLOCKED: {
    httpStatus: 403,
    message_sv: 'Påminnelser och inkasso ingår i betalplanen. Uppgradera för att fortsätta.',
    message_en: 'Reminders and debt collection are part of the paid plan. Upgrade to continue.',
  },
  COLLECTIONS_NOT_ACTIVE: {
    httpStatus: 409,
    message_sv: 'Aktivera inkasso och utskick först.',
    message_en: 'Activate debt collection and delivery first.',
  },
  COLLECTIONS_UNAVAILABLE: {
    httpStatus: 503,
    message_sv: 'Kopplingen till inkassobolaget är inte konfigurerad i den här miljön.',
    message_en: 'The connection to the collection agency is not configured in this environment.',
    thrown_message_sv: true,
  },
  COLLECTIONS_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Ärendet finns inte hos inkassobolaget.',
    message_en: 'The collection agency has no such case.',
    thrown_message_sv: true,
  },
  COLLECTIONS_CONNECTOR_UNREACHABLE: {
    httpStatus: 502,
    message_sv: 'Kunde inte nå inkassobolaget just nu. Försök igen om en stund.',
    message_en: 'Could not reach the collection agency right now. Try again shortly.',
    retryable: true,
    thrown_message_sv: true,
  },
  COLLECTIONS_CONNECTOR_PROTOCOL_ERROR: {
    httpStatus: 502,
    message_sv: 'Svaret från inkassobolaget kunde inte tolkas. Kontakta support om felet kvarstår.',
    message_en: 'The answer from the collection agency could not be read. Contact support if the problem persists.',
    thrown_message_sv: true,
  },
  COLLECTIONS_CONNECTOR_SCOPE_MISSING: {
    httpStatus: 403,
    message_sv: 'Kopplingsnyckeln saknar behörighet för inkasso och utskick. Kontakta support.',
    message_en: 'The connector key lacks permission for debt collection and delivery. Contact support.',
  },
  COLLECTIONS_CONNECTOR_RATE_LIMITED: {
    httpStatus: 429,
    message_sv: 'För många anrop till inkassobolaget på kort tid. Vänta en stund och försök igen.',
    message_en: 'Too many calls to the collection agency in a short time. Wait a moment and try again.',
    retryable: true,
    thrown_message_sv: true,
  },
  COLLECTIONS_CONNECTOR_ERROR: {
    httpStatus: 502,
    message_sv: 'Inkassobolaget svarade med ett fel. Försök igen om en stund.',
    message_en: 'The collection agency answered with an error. Try again shortly.',
    thrown_message_sv: true,
  },
  COLLECTIONS_CONNECTION_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Företaget har ingen koppling för påminnelser och inkasso.',
    message_en: 'The company has no connection for reminders and debt collection.',
  },
  COLLECTIONS_CONNECTION_EXISTS: {
    httpStatus: 409,
    message_sv: 'Företaget har redan en koppling för påminnelser och inkasso.',
    message_en: 'The company already has a connection for reminders and debt collection.',
  },
  COLLECTIONS_CONNECTION_STEP: {
    httpStatus: 409,
    message_sv: 'Aktiveringen är inte i det steget längre. Ladda om sidan.',
    message_en: 'The activation is no longer at that step. Reload the page.',
  },
  COLLECTIONS_DISCONNECT_BLOCKED: {
    httpStatus: 409,
    message_sv: 'Kopplingen kan inte avslutas medan det finns öppna ärenden eller obokförda inbetalningar och avräkningar.',
    message_en: 'The connection cannot be ended while there are open cases or unbooked payments and settlements.',
  },
  COLLECTIONS_PROVIDER_UNAVAILABLE: {
    httpStatus: 503,
    message_sv: 'Villkoren för inkasso kunde inte hämtas just nu. Försök igen om en stund.',
    message_en: 'The terms for debt collection could not be fetched right now. Try again shortly.',
    retryable: true,
  },
  COLLECTIONS_TERMS_CHANGED: {
    httpStatus: 409,
    message_sv: 'Inkassobolaget har en nyare version av villkoren. Läs och godkänn den för att fortsätta.',
    message_en: 'The collection agency has a newer version of its terms. Read and accept it to continue.',
    thrown_message_sv: true,
  },
  COLLECTIONS_PAYOUT_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Välj ett bankkonto med bankgiro, plusgiro eller kontonummer för utbetalningarna.',
    message_en: 'Choose a bank account with a bankgiro, plusgiro or account number for the payouts.',
  },
  COLLECTIONS_ORG_NUMBER_MISSING: {
    httpStatus: 400,
    message_sv: 'Lägg till företagets organisationsnummer under Företag först.',
    message_en: 'Add the company\'s organisation number under Company first.',
  },
  COLLECTIONS_APPLICATION_NOT_RECEIVED: {
    httpStatus: 409,
    message_sv: 'Ansökan gick inte igenom hos inkassobolaget. Skicka den igen.',
    message_en: 'The application did not go through at the collection agency. Send it again.',
    thrown_message_sv: true,
  },
  COLLECTION_NOT_ELIGIBLE: {
    httpStatus: 409,
    message_sv: 'Fakturan uppfyller inte kraven för att skickas till inkasso.',
    message_en: 'The invoice does not meet the requirements for debt collection.',
  },
  COLLECTION_REMAINING_CHANGED: {
    httpStatus: 409,
    message_sv: 'Fakturans kvarvarande belopp har ändrats. Öppna dialogen igen.',
    message_en: 'The invoice\'s remaining amount has changed. Open the dialog again.',
  },
  COLLECTION_BANK_CANDIDATES: {
    httpStatus: 409,
    message_sv: 'Det finns inbetalningar som kan vara betalning av fakturan.',
    message_en: 'There are incoming payments that may be payment of the invoice.',
  },
  COLLECTION_BANK_STALE: {
    httpStatus: 409,
    message_sv: 'Banken har inte synkats det senaste dygnet.',
    message_en: 'The bank has not been synced in the last 24 hours.',
  },
  COLLECTION_ATTESTATION_REQUIRED: {
    httpStatus: 409,
    message_sv: 'Bekräfta kontrollerna i dialogen innan fakturan skickas.',
    message_en: 'Confirm the checks in the dialog before the invoice is sent.',
  },
  COLLECTION_ATTESTATION_WEB_ONLY: {
    httpStatus: 403,
    message_sv: 'Det här måste godkännas av en person i Accounted.',
    message_en: 'This must be approved by a person in Accounted.',
  },
  COLLECTION_CASE_EXISTS: {
    httpStatus: 409,
    message_sv: 'Fakturan har redan ett ärende.',
    message_en: 'The invoice already has a case.',
  },
  COLLECTION_SETTLEMENT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Avräkningen från inkassobolaget hittades inte.',
    message_en: 'The settlement from the collection agency was not found.',
  },
  COLLECTION_SETTLEMENT_NOT_BOOKABLE: {
    httpStatus: 409,
    message_sv: 'Avräkningen kan inte bokföras: inkassobolaget har markerat den som ogiltig, eller så har den redan hanterats.',
    message_en: 'The settlement cannot be booked: the collection agency marked it as not valid, or it has already been handled.',
  },
  COLLECTION_SETTLEMENT_BUSY: {
    httpStatus: 409,
    message_sv: 'Avräkningen bokförs just nu. Vänta en stund och ladda om sidan.',
    message_en: 'The settlement is being booked right now. Wait a moment and reload the page.',
  },
  COLLECTION_SETTLEMENT_NOT_POSSIBLE_DUPLICATE: {
    httpStatus: 409,
    message_sv: 'Avräkningen väntar inte på besked om en möjlig dubblett. Ladda om sidan.',
    message_en: 'The settlement is not waiting for an answer about a possible duplicate. Reload the page.',
  },
  COLLECTION_SETTLEMENT_DOCUMENT_PENDING: {
    httpStatus: 409,
    message_sv: 'Inkassobolaget har inte tagit fram avräkningens underlag än. Försök igen senare.',
    message_en: 'The collection agency has not produced the settlement document yet. Try again later.',
  },
  COLLECTED_PAYMENT_CHANGED: {
    httpStatus: 409,
    message_sv: 'Inbetalningen har ändrats sedan bokföringen förbereddes. Förbered den igen.',
    message_en: 'The payment changed after the booking was staged. Stage it again.',
    remediation: {
      description: 'Read the payment again with gnubok_list_collection_settlements and stage a new booking.',
      tool: 'gnubok_list_collection_settlements',
    },
  },
  COLLECTION_SETTLEMENT_CHANGED: {
    httpStatus: 409,
    message_sv: 'Avräkningen har ändrats sedan bokföringen förbereddes. Förbered den igen.',
    message_en: 'The settlement changed after the booking was staged. Stage it again.',
    remediation: {
      description: 'Read the payout again with gnubok_list_collection_settlements (settlement_id) and stage a new booking with its current lines.',
      tool: 'gnubok_list_collection_settlements',
    },
  },
  COLLECTION_SETTLEMENT_NEEDS_PERSON: {
    httpStatus: 409,
    message_sv: 'Avräkningen kan inte bokföras som den är. Välj konto för raderna som saknar ett, eller låt en person titta på den under Avräkningar.',
    message_en: 'The settlement cannot be booked as it is. Choose an account for the lines that have none, or leave it to a person under Settlements.',
    remediation: {
      description:
        'details.reason and details.issues say what is missing. Pass lines with an account for each line that needs_account or needs_vat_account (read them with gnubok_list_collection_settlements and settlement_id); anything else is for a person in Avräkningar.',
      tool: 'gnubok_list_collection_settlements',
    },
  },
  COLLECTION_SETTLEMENT_POSSIBLE_DUPLICATE: {
    httpStatus: 409,
    message_sv: 'Utbetalningen kan redan vara bokförd för hand. En person svarar på det under Avräkningar.',
    message_en: 'The payout may already be booked by hand. A person answers that under Settlements.',
  },
  COLLECTION_SETTLEMENT_LINE_INVALID: {
    httpStatus: 400,
    message_sv: 'Kontot kan inte användas för den här raden i avräkningen.',
    message_en: 'The account cannot be used for this settlement line.',
  },
  COLLECTED_PAYMENT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Inbetalningen till inkassobolaget hittades inte.',
    message_en: 'The payment to the collection agency was not found.',
  },
  COLLECTED_PAYMENT_IGNORED: {
    httpStatus: 409,
    message_sv: 'Inbetalningen är markerad som hanterad och bokförs inte.',
    message_en: 'The payment is marked as handled and is not booked.',
  },
  COLLECTED_PAYMENT_BUSY: {
    httpStatus: 409,
    message_sv: 'Inbetalningen bokförs just nu. Vänta en stund och ladda om sidan.',
    message_en: 'The payment is being booked right now. Wait a moment and reload the page.',
  },
  COLLECTED_PAYMENT_NOT_BOOKED: {
    httpStatus: 409,
    message_sv: 'Inbetalningen är inte bokförd. Bokför den i stället för att bokföra om den.',
    message_en: 'The payment is not booked. Book it instead of rebooking it.',
  },
  COLLECTED_PAYMENT_SETTLED: {
    httpStatus: 409,
    message_sv: 'Inbetalningen ingår i en bokförd utbetalning från inkassobolaget. Makulera utbetalningens verifikation först, sedan kan inbetalningen bokföras om.',
    message_en: 'The payment is part of a booked payout from the collection agency. Reverse the payout voucher first, then the payment can be rebooked.',
  },
  COLLECTED_PAYMENT_VOUCHER_NOT_POSTED: {
    httpStatus: 409,
    message_sv: 'Inbetalningens verifikation är inte bokförd och kan inte bokföras om.',
    message_en: 'The payment\'s voucher is not posted and cannot be rebooked.',
  },
  COLLECTION_FORWARD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Rapporteringen till inkassobolaget hittades inte för den här fakturan.',
    message_en: 'The report to the collection agency was not found for this invoice.',
  },
  COLLECTION_FORWARD_NOT_ACTIONABLE: {
    httpStatus: 409,
    message_sv: 'Rapporteringen behöver inte åtgärdas längre. Ladda om sidan.',
    message_en: 'The report no longer needs any action. Reload the page.',
  },
  COLLECTION_BATCH_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Inkassoomgången hittades inte.',
    message_en: 'The collections batch was not found.',
  },
  COLLECTION_BATCH_NOT_PENDING: {
    httpStatus: 409,
    message_sv: 'Omgången är redan avgjord. Ladda om sidan.',
    message_en: 'The batch has already been decided. Reload the page.',
  },
  COLLECTION_BATCH_EMPTY: {
    httpStatus: 400,
    message_sv: 'Minst en faktura måste vara kvar. Avvisa omgången om inget ska skickas.',
    message_en: 'At least one invoice must remain. Reject the batch if nothing should be sent.',
  },
  COLLECTION_BATCH_ADMIN_ONLY: {
    httpStatus: 403,
    message_sv: 'Bara företagets ägare eller en administratör kan godkänna omgången.',
    message_en: 'Only the company owner or an administrator can approve the batch.',
  },
  REMINDER_BATCH_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Påminnelseomgången hittades inte.',
    message_en: 'The reminder batch was not found.',
  },
  REMINDERS_AUTOMATIC_NOT_YET: {
    httpStatus: 409,
    message_sv: 'Automatiska påminnelser kan slås på när de tre senaste omgångarna godkänts utan ändringar.',
    message_en: 'Automatic reminders can be turned on once the last three batches were approved without changes.',
  },
  REMINDERS_UNAVAILABLE: {
    httpStatus: 409,
    message_sv: 'Påminnelser kan inte skickas ännu.',
    message_en: 'Reminders cannot be sent yet.',
  },
  REMINDER_NO_INVOICE_TO_PREVIEW: {
    httpStatus: 404,
    message_sv: 'Det finns ingen faktura att visa påminnelsen med ännu.',
    message_en: 'There is no invoice to show the reminder with yet.',
  },
  REMINDERS_OFF: {
    httpStatus: 409,
    message_sv: 'Påminnelser är avstängda, så omgången kan inte skickas. Slå på dem igen för att skicka nästa omgång.',
    message_en: 'Reminders are turned off, so the batch cannot be sent. Turn them on again to send the next batch.',
  },
  COLLECTION_POSSIBLE_PAYMENT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Den möjliga betalningen hittades inte för den här fakturan.',
    message_en: 'The possible payment was not found for this invoice.',
  },
  COLLECTION_POSSIBLE_PAYMENT_NOT_ACTIONABLE: {
    httpStatus: 409,
    message_sv: 'Den möjliga betalningen är redan hanterad. Ladda om sidan.',
    message_en: 'The possible payment has already been handled. Reload the page.',
  },
  COLLECTION_CASE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Fakturan har inget öppet ärende hos inkassobolaget.',
    message_en: 'The invoice has no open case at the collection agency.',
    thrown_message_sv: true,
  },
  COLLECTION_ACTION_MESSAGE_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Skriv kort vad det gäller, minst tio tecken.',
    message_en: 'Describe it briefly, at least ten characters.',
  },
  COLLECTION_START_STEP_UNAVAILABLE: {
    httpStatus: 409,
    message_sv: 'Inkassobolaget kan inte börja med det steget.',
    message_en: 'The collection agency cannot start with that step.',
    thrown_message_sv: true,
  },
  COLLECTION_REMINDER_FEE_NOT_AGREED: {
    httpStatus: 409,
    message_sv: 'En påminnelse från inkassobolaget kostar kunden en påminnelseavgift, och den får bara tas ut om den var avtalad när fakturan ställdes ut. Börja med inkassokrav, eller ange i inkassoinställningarna från vilket datum avgiften står i dina villkor.',
    message_en: 'A reminder from the collection agency costs the customer a reminder fee, which may only be charged if it was agreed when the invoice was issued. Start with a collection notice, or set in the collection settings the date your terms have included the fee.',
    thrown_message_sv: true,
  },
  COLLECTION_PAYMENT_HISTORY_UNSUPPORTED: {
    httpStatus: 409,
    message_sv: 'Fakturans betalningar kan inte rapporteras till inkassobolaget. Kontrollera betalningarna på fakturan.',
    message_en: 'The invoice\'s payments cannot be reported to the collection agency. Check the payments on the invoice.',
    thrown_message_sv: true,
  },
  COLLECTION_DOCUMENT_UNAVAILABLE: {
    httpStatus: 409,
    message_sv: 'Fakturans PDF kunde inte tas fram. Försök igen om en stund.',
    message_en: 'The invoice PDF could not be produced. Try again shortly.',
  },
  COLLECTION_DOCUMENT_TOO_LARGE: {
    httpStatus: 413,
    message_sv: 'Fakturans PDF är för stor för att skickas till inkassobolaget.',
    message_en: 'The invoice PDF is too large to send to the collection agency.',
    thrown_message_sv: true,
  },
  COLLECTION_REGISTER_PAYMENT: {
    httpStatus: 409,
    message_sv: 'Bokför betalningen på fakturan. Den rapporteras till inkassobolaget och ärendet avslutas när hela beloppet är betalt.',
    message_en: 'Record the payment on the invoice. It is reported to the collection agency and the case closes when the whole amount is paid.',
    thrown_message_sv: true,
  },
  COLLECTION_START_VIA_HANDOVER: {
    httpStatus: 409,
    message_sv: 'Starta ärendet från fakturan med Skicka till inkasso, så att samma kontroller som vid en överlämning görs först.',
    message_en: 'Start the case from the invoice with Send to debt collection, so the same checks as a handover run first.',
  },
  COLLECTION_WITHDRAW_FEE_UNACKNOWLEDGED: {
    httpStatus: 409,
    message_sv: 'Inkassobolaget kan ta ut en avgift för återkallelsen enligt sina villkor. Bekräfta det innan ärendet återkallas.',
    message_en: 'The collection agency may charge a fee for the withdrawal under its terms. Confirm this before the case is withdrawn.',
    thrown_message_sv: true,
  },
  COLLECTION_PAUSE_UNTIL_INVALID: {
    httpStatus: 400,
    message_sv: 'Välj ett datum efter i dag och högst 14 dagar fram, eller pausa utan datum.',
    message_en: 'Choose a date after today and at most 14 days ahead, or pause without a date.',
  },
  COLLECTION_PAYMENT_NOT_REPORTED: {
    httpStatus: 409,
    message_sv: 'En betalning på fakturan är inte rapporterad till inkassobolaget än. Försök igen när den är rapporterad.',
    message_en: 'A payment on the invoice has not been reported to the collection agency yet. Try again once it is reported.',
    thrown_message_sv: true,
  },
  COLLECTION_DOCUMENT_CHANGED: {
    httpStatus: 409,
    message_sv: 'Den arkiverade PDF:en stämmer inte med den som skickades. Kontakta support.',
    message_en: 'The archived PDF does not match the one that was sent. Contact support.',
  },
  CONNECTOR_UPSTREAM_DISABLED: {
    httpStatus: 503,
    message_sv: 'Tjänsten är tillfälligt avstängd.',
    message_en: 'The service is temporarily switched off.',
  },
  CONNECTOR_IDEMPOTENCY_IN_FLIGHT: {
    httpStatus: 409,
    message_sv: 'Förfrågan behandlas redan. Försök igen om en stund.',
    message_en: 'The request is already being processed. Try again shortly.',
    retryable: true,
  },
  CONNECTOR_IDEMPOTENCY_MISMATCH: {
    httpStatus: 409,
    message_sv: 'En tidigare förfrågan med samma nyckel innehöll andra uppgifter, så inget skickades. Kontakta support.',
    message_en: 'An earlier request with the same key carried different data, so nothing was sent. Contact support.',
  },
  CONNECTOR_CONTRACT_VERSION_UNSUPPORTED: {
    httpStatus: 502,
    message_sv: 'Den här versionen av Accounted är för gammal för kopplingstjänsten. Uppdatera installationen.',
    message_en: 'This version of Accounted is too old for the connector service. Update the installation.',
  },
  CONNECTOR_CONNECTION_NOT_OWNED: {
    httpStatus: 403,
    message_sv: 'Kopplingen till inkassobolaget hör inte till det här företaget. Kontakta support.',
    message_en: 'The connection to the collection agency does not belong to this company. Contact support.',
    thrown_message_sv: true,
  },
  CONNECTOR_COLLECTIONS_NOT_ONBOARDED: {
    httpStatus: 409,
    message_sv: 'Företaget är inte anslutet till inkassobolaget ännu.',
    message_en: 'The company is not connected to the collection agency yet.',
    thrown_message_sv: true,
  },
  CONNECTOR_COLLECTIONS_NOT_APPROVED: {
    httpStatus: 409,
    message_sv: 'Inkassobolaget har inte godkänt företaget ännu.',
    message_en: 'The collection agency has not approved the company yet.',
    thrown_message_sv: true,
  },
  CONNECTOR_COLLECTIONS_CASE_NOT_OWNED: {
    httpStatus: 404,
    message_sv: 'Ärendet hör inte till det här företaget hos inkassobolaget.',
    message_en: 'The case does not belong to this company at the collection agency.',
    thrown_message_sv: true,
  },
  CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE: {
    httpStatus: 409,
    message_sv: 'Det går inte att göra det i ärendets nuvarande läge.',
    message_en: 'That is not possible in the case\'s current state.',
  },
  CONNECTOR_COLLECTIONS_DEBTOR_INVALID: {
    httpStatus: 422,
    message_sv: 'Inkassobolaget godtog inte kunduppgifterna. Kontrollera adress och person- eller organisationsnummer.',
    message_en: 'The collection agency did not accept the customer details. Check the address and the personal identity or organisation number.',
    thrown_message_sv: true,
  },
  CONNECTOR_COLLECTIONS_DUPLICATE_CASE: {
    httpStatus: 409,
    message_sv: 'Inkassobolaget har redan ett öppet ärende för fakturan.',
    message_en: 'The collection agency already has an open case for the invoice.',
    thrown_message_sv: true,
  },
  CONNECTOR_COLLECTIONS_AMOUNT_INVALID: {
    httpStatus: 422,
    message_sv: 'Inkassobolaget godtog inte beloppet.',
    message_en: 'The collection agency did not accept the amount.',
    thrown_message_sv: true,
  },
  CONNECTOR_DELIVERY_METHOD_UNAVAILABLE: {
    httpStatus: 422,
    message_sv: 'Utskickssättet är inte tillgängligt för den här kunden.',
    message_en: 'The delivery method is not available for this customer.',
  },
  CONNECTOR_DELIVERY_DOCUMENT_REJECTED: {
    httpStatus: 422,
    message_sv: 'Inkassobolaget godtog inte fakturans PDF.',
    message_en: 'The collection agency did not accept the invoice PDF.',
    thrown_message_sv: true,
  },
}

// ─────────────────────────────────────────────────────────────────
// Combined registry
// ─────────────────────────────────────────────────────────────────

// Payment orders: paying supplier invoices from the company's own account
// through a bank API (src/lib/payments/orders/*), shared by the dashboard,
// v1 and MCP.
const PAYMENT_ORDERS: Record<string, StructuredErrorEntry> = {
  PAYMENTS_UNAVAILABLE: {
    httpStatus: 403,
    message_sv: 'Betalningar via banken är inte aktiverade för det här företaget.',
    message_en: 'Paying through the bank is not enabled for this company.',
  },
  PAYMENT_ORDERS_EMPTY_SELECTION: {
    httpStatus: 400,
    message_sv: 'Välj minst en faktura eller betalning.',
    message_en: 'Select at least one invoice or payment.',
  },
  PAYMENT_ORDER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Betalningen hittades inte.',
    message_en: 'The payment was not found.',
  },
  // Changed supplier bank details (lib/payments/payee-alerts.ts).
  SUPPLIER_PAYEE_NOTHING_TO_DECIDE: {
    httpStatus: 409,
    message_sv: 'Fakturan anger inga nya bankuppgifter att godkänna eller neka.',
    message_en: 'The invoice states no new bank details to approve or reject.',
  },
  SUPPLIER_PAYEE_DECISION_FAILED: {
    httpStatus: 500,
    message_sv: 'Beslutet om bankuppgifterna kunde inte sparas. Försök igen.',
    message_en: 'The decision on the bank details could not be saved. Try again.',
  },
  PAYMENT_ORDERS_INELIGIBLE: {
    httpStatus: 409,
    message_sv: 'En eller flera fakturor kan inte betalas via banken just nu.',
    message_en: 'One or more invoices cannot be paid through the bank right now.',
  },
  PAYMENT_ORDERS_ALREADY_IN_PAYMENT: {
    httpStatus: 409,
    message_sv: 'En eller flera fakturor har redan en pågående betalning.',
    message_en: 'One or more invoices already have a payment in progress.',
  },
  PAYMENT_ORDERS_IN_PAYMENT_FILE: {
    httpStatus: 409,
    message_sv: 'En eller flera fakturor ligger i en betalfil. Makulera betalfilen först om de ska betalas via banken.',
    message_en: 'One or more invoices are in a payment file. Cancel the file first to pay them through the bank.',
  },
  PAYMENT_ORDERS_AMOUNT_EXCEEDS_REMAINING: {
    httpStatus: 409,
    message_sv: 'Beloppet är högre än det som återstår att betala på fakturan.',
    message_en: 'The amount is higher than what remains to be paid on the invoice.',
  },
  PAYMENT_ORDERS_CURRENCY_MISMATCH: {
    httpStatus: 409,
    message_sv: 'Betalningen måste göras i fakturans valuta.',
    message_en: 'The payment must be made in the invoice currency.',
  },
  PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE: {
    httpStatus: 400,
    message_sv: 'Det valda kontot kan inte användas för betalningar via banken. Välj ett svenskt kronkonto med IBAN.',
    message_en: 'The selected account cannot be used for bank payments. Choose a Swedish krona account with an IBAN.',
  },
  PAYMENT_ORDERS_PAYEE_CONFIRMATION_REQUIRED: {
    httpStatus: 409,
    message_sv: 'Kontot har inte bekräftats för leverantören än, eller skiljer sig från kontot på leverantörskortet. Kontrollera kontot och bekräfta det för varje faktura innan du godkänner.',
    message_en: 'The account has not been confirmed for the supplier yet, or differs from the one on the supplier card. Check it and confirm it for each invoice before approving.',
  },
  PAYMENT_ORDERS_PAYEE_MISMATCH: {
    httpStatus: 409,
    message_sv: 'Kontot stämmer inte med det som fakturan eller leverantörskortet anger. Förbered betalningen igen.',
    message_en: 'The account does not match the one the invoice or the supplier card states. Prepare the payment again.',
  },
  PAYMENT_ORDERS_IDEMPOTENCY_MISMATCH: {
    httpStatus: 409,
    message_sv: 'Samma referens har redan använts för en annan faktura. Förbered betalningen igen.',
    message_en: 'The same reference was already used for another invoice. Prepare the payment again.',
  },
  // Paying the skattekonto through the bank (lib/payments/orders/prepare-skattekonto.ts).
  SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT: {
    httpStatus: 409,
    message_sv: 'En betalning till Skatteverket väntar redan under Betalningar.',
    message_en: 'A payment to Skatteverket is already waiting under Payments.',
  },
  // A draft whose day has passed moves to the next banking day when it is
  // approved or signed; that day already has an open skattekonto payment (crm#1485).
  SKATTEKONTO_PAYMENT_DAY_TAKEN: {
    httpStatus: 409,
    message_sv: 'Dagen för betalningen har passerat, och nästa bankdag har redan en betalning till skattekontot. Avbryt den här betalningen under Betalningar och förbered den igen: då läggs beloppet ihop med den som redan finns, eller så väljer du en annan dag.',
    message_en: 'The payment day has passed, and the next banking day already has a payment to the tax account. Cancel this payment under Payments and prepare it again: the amount is then added to the one already there, or you pick another day.',
    remediation: {
      description:
        'details.requested_execution_date is the day the order would move to; details.existing_payment_order_id (when known) holds it. Cancel this order and prepare the skattekonto payment again: an unsigned order on that day takes the amount as an addition.',
    },
  },
  SKATTEKONTO_PAYMENT_NOTHING_DUE: {
    httpStatus: 409,
    message_sv: 'Det finns inget att betala in till Skatteverket just nu. Ange ett belopp om du vill betala in ändå.',
    message_en: 'Nothing needs paying in to Skatteverket right now. Enter an amount to pay in anyway.',
  },
  SKATTEKONTO_PAYMENT_OCR_MISSING: {
    httpStatus: 409,
    message_sv: 'OCR-numret till skattekontot saknas. Lägg in företagets organisationsnummer eller koppla Skatteverket så hämtas det.',
    message_en: 'The OCR number for the tax account is missing. Add the company\'s organisation number or connect Skatteverket to fetch it.',
  },
  // A skattekonto payment named from an AGI (source agi) for a month without one.
  SKATTEKONTO_PAYMENT_AGI_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Det finns ingen arbetsgivardeklaration för månaden. Skapa den under Lön först.',
    message_en: 'There is no employer declaration (AGI) for the month. Create it under Payroll first.',
    remediation: {
      description:
        'month is the redovisningsperiod (the month the pay went out). Generate the AGI from the salary run, or pay a free amount without a source.',
    },
  },
  PAYMENT_ORDERS_MIXED_CURRENCY: {
    httpStatus: 400,
    message_sv: 'Betalningar i olika valutor signeras var för sig.',
    message_en: 'Payments in different currencies are signed separately.',
  },
  PAYMENT_ORDERS_OUTCOME_UNKNOWN: {
    httpStatus: 502,
    message_sv: 'Vi vet inte om banken tog emot betalningen. Den ligger kvar som pågående tills dragningen syns på kontot eller tills du bekräftar att den aldrig nådde banken.',
    message_en: 'We do not know whether the bank received the payment. It stays in progress until the debit shows on the account or you confirm it never reached the bank.',
  },
  PAYMENT_CANCEL_CONFIRMATION_REQUIRED: {
    httpStatus: 409,
    message_sv: 'Betalningen kan ha nått banken. Kontrollera i internetbanken och bekräfta om den finns där eller har betalats.',
    message_en: 'The payment may have reached the bank. Check the online bank and confirm whether it is there or was paid.',
  },
  PAYMENT_ORDER_CREATE_IN_PROGRESS: {
    httpStatus: 409,
    message_sv: 'En betalning skickas till banken just nu. Vänta några minuter och försök igen.',
    message_en: 'A payment is being sent to the bank right now. Wait a few minutes and try again.',
  },
  PAYMENT_CANCEL_NEEDS_SIGNING: {
    httpStatus: 409,
    message_sv: 'Banken vill att makuleringen signeras. Makulera betalningen i internetbanken.',
    message_en: 'The bank wants the cancellation signed. Cancel the payment in the online bank.',
  },
  PAYMENT_CANCEL_TOO_LATE: {
    httpStatus: 409,
    message_sv: 'Betalningen är redan genomförd eller för nära betaldagen för att makuleras.',
    message_en: 'The payment has already been made or is too close to its payment date to cancel.',
  },
  // The bank refused the cancel of a payment it holds unsigned (crm#1282):
  // nothing was paid, so "too late" would be wrong. Some banks (Danske) never
  // take the cancel: details.releasable says a person may release it here.
  PAYMENT_CANCEL_UNSIGNED_REFUSED: {
    httpStatus: 409,
    message_sv: 'Betalningen är inte signerad hos banken och betalas inte utan signering. Banken nekade ändå makuleringen, oftast för att en signering med BankID har startats och inte löpt ut än. Försök igen om en halvtimme: nekar banken då också kan du släppa betalningen här.',
    message_en: 'The payment is not signed at the bank and will not be paid without a signature. The bank still refused the cancellation, usually because a BankID signing was started and has not expired yet. Try again in half an hour: if the bank still refuses, you can release the payment here.',
    remediation: {
      description:
        'Nothing was paid: the bank holds the payment unsigned (provider_status RCVD or PDNG) and refused the cancel. The order is unchanged. With details.releasable false, retry the cancel in half an hour. With details.releasable true, a person can release it in Accounted (Betalningar, Släpp betalningen): the order is cancelled there, and the bank keeps an unsigned payment it never executes.',
    },
  },
  // The bank did not confirm the cancel of a payment it reports unsigned in a
  // status read right after, and no signature of it finished here (crm#1699).
  // Banks have so far cancelled or rejected every such payment within
  // minutes; the 15-minute status sync applies their answer.
  PAYMENT_CANCEL_PENDING_UNSIGNED: {
    httpStatus: 409,
    message_sv: 'Banken har inte bekräftat makuleringen än. Betalningen är inte signerad hos banken och betalas inte utan signering. Betalningens status hämtas från banken var 15:e minut och ordern följer med när banken har makulerat den. Står den kvar efter det, makulera igen.',
    message_en: 'The bank has not confirmed the cancellation yet. The payment is not signed at the bank and will not be paid without a signature. The payment\'s status is read from the bank every 15 minutes and the order follows once the bank has cancelled it. If it is still there after that, cancel again.',
    remediation: {
      description:
        'Nothing was paid: the bank reports the payment unsigned (details.provider_status, RCVD or PDNG) and has not confirmed the cancel. The order is unchanged. Do not prepare a new payment of the invoice meanwhile: the status sync (every 15 minutes) applies the bank\'s cancel or rejection and frees the invoice. Read the order again after it; if it is still open, call the cancel again.',
    },
  },
  PAYMENT_CANCEL_NOT_CONFIRMED: {
    httpStatus: 502,
    message_sv: 'Banken bekräftade inte makuleringen. Kontrollera betalningen i internetbanken.',
    message_en: 'The bank did not confirm the cancellation. Check the payment in the online bank.',
  },
  PAYMENT_ORDER_AT_BANK: {
    httpStatus: 409,
    message_sv: 'Banken har betalningen. Makulera den i stället, så att banken bekräftar makuleringen.',
    message_en: 'The bank has the payment. Cancel it instead, so the bank confirms the cancellation.',
  },
  PAYMENT_ORDER_NOT_RESOLVABLE: {
    httpStatus: 409,
    message_sv: 'Betalningen kan inte avgöras på det sättet i sitt nuvarande läge. Ladda om sidan.',
    message_en: 'The payment cannot be resolved that way in its current state. Reload the page.',
  },
  PAYMENT_ORDER_PAYMENT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Hittade ingen sådan betalning på fakturan.',
    message_en: 'No such payment was found on the invoice.',
  },
  PAYMENT_ORDER_PAYMENT_MISMATCH: {
    httpStatus: 409,
    message_sv: 'Betalningen på fakturan har ett annat belopp eller hör redan till en annan bankbetalning.',
    message_en: 'The payment on the invoice has another amount or already belongs to another bank payment.',
  },
  PAYMENT_ORDERS_WRONG_STATUS: {
    httpStatus: 409,
    message_sv: 'En eller flera betalningar har ändrats under tiden. Ladda om och försök igen.',
    message_en: 'One or more payments changed in the meantime. Reload and try again.',
  },
  PAYMENT_ORDERS_MIXED_ACCOUNTS: {
    httpStatus: 400,
    message_sv: 'Betalningar från olika konton signeras var för sig.',
    message_en: 'Payments from different accounts are signed separately.',
  },
  PAYMENT_SIGNER_PERSONAL_NUMBER_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Ange personnumret för den som signerar med BankID.',
    message_en: 'Enter the personal identity number of the person signing with BankID.',
  },
  // Same cause and way out as BANK_CONSENT_ORG_NUMBER_MISSING, for a payment.
  PAYMENT_ORG_NUMBER_MISSING: {
    httpStatus: 400,
    message_sv: 'Företagets organisationsnummer saknas eller är ogiltigt, och banken behöver det för betalningen. Fyll i det under Inställningar, Företaget, Företagsuppgifter och försök igen.',
    message_en: 'The company\'s organisation number is missing or invalid, and the bank needs it for the payment. Fill it in under Settings, Company, Company details and try again.',
  },
  PAYMENT_COMPANY_VERIFICATION_REQUIRED: {
    httpStatus: 409,
    message_sv: 'Företaget behöver verifieras hos betalningsleverantören innan första betalningen.',
    message_en: 'The company needs to be verified with the payment provider before its first payment.',
  },
  PAYMENT_SIGNING_NOT_ACTIVE: {
    httpStatus: 409,
    message_sv: 'Signeringen är inte aktiv längre. Ladda om sidan för att se var betalningarna står.',
    message_en: 'The signing is no longer active. Reload the page to see where the payments stand.',
  },
  PAYMENT_SIGNING_NOTHING_TO_SIGN: {
    httpStatus: 409,
    message_sv: 'Det finns inga betalningar kvar att signera i den här signeringen.',
    message_en: 'There are no payments left to sign in this signing.',
  },
  // The bank waits for another signatory (startSecondSignature in
  // lib/payments/orders/signing.ts): the number given is the one the first
  // signature was made with.
  PAYMENT_SECOND_SIGNER_SAME_PERSON: {
    httpStatus: 409,
    message_sv: 'Banken väntar på en annan firmatecknare än den som redan har signerat. Ange den andra firmatecknarens personnummer.',
    message_en: 'The bank waits for another signatory than the one who already signed. Enter the other signatory\'s personal identity number.',
  },
  // A signing link for the second signature (lib/payments/orders/signing-links.ts)
  // at a bank that takes that signature in its online bank, not through the API.
  PAYMENT_SECOND_SIGNATURE_IN_ONLINE_BANK: {
    httpStatus: 409,
    message_sv: 'Banken tar emot den andra signeringen i sin internetbank. Den andra firmatecknaren signerar där före betalningsdagen.',
    message_en: 'The bank takes the second signature in its online bank. The other signatory signs there before the payment date.',
  },
  PAYMENT_SIGNING_BASKET_UNSUPPORTED: {
    httpStatus: 409,
    message_sv: 'Banken kan inte signera flera betalningar med ett BankID. Signera en betalning i taget.',
    message_en: 'The bank cannot sign several payments with one BankID. Sign one payment at a time.',
  },
  PAYMENT_SIGNING_BASKET_TOO_LARGE: {
    httpStatus: 409,
    message_sv: 'Banken tar emot färre betalningar per signering. Dela upp betalningarna i mindre omgångar.',
    message_en: 'The bank takes fewer payments per signing. Split the payments into smaller rounds.',
  },
  // The monthly cap on bank payments (lib/payments/allowance.ts). The thrower
  // composes the Swedish text with the numbers and the month; details carry
  // { period, used, included, cap, extra_offered, billed, unit_price_ore,
  // remaining, requested } for the screen.
  BANK_PAYMENTS_ALLOWANCE_EXCEEDED: {
    httpStatus: 409,
    message_sv: 'Månadens bankbetalningar som ingår är använda. Välj färre betalningar, eller begär fler under Inställningar, Kopplingar, Betalningar via banken.',
    message_en: 'The bank payments included this month are used up. Choose fewer payments, or ask for more under Settings, Connections, Bank payments.',
    remediation: {
      description:
        'Sign at most details.remaining payments this month (details.used of details.included are used in details.period). When details.extra_offered is true and details.billed false, more cost details.unit_price_ore öre each once Accounted opens the charge: a person asks for more under Settings, Connections, Bank payments; an agent cannot open it. Otherwise ask for more there too. Payment files are not capped.',
    },
    thrown_message_sv: true,
  },
  // A paid action at its month's included amount while the charge is not open
  // for the company (lib/usage/gate.ts). The thrower composes the Swedish
  // text; details carry { kind, period, used, included, requested, unit_price_ore }.
  USAGE_LIMIT_REACHED: {
    httpStatus: 409,
    message_sv: 'Det som ingår är använt. Fler kostar en avgift per styck. Begär fler under Inställningar, Abonnemang, Användning, så öppnar vi.',
    message_en: 'The included amount is used up. More cost a fee each. Ask for more under Settings, Billing, Usage, and we open it.',
    remediation: {
      description:
        'More than details.included of details.kind costs details.unit_price_ore öre each, and the charge is not open for this company. A person asks for more under Settings, Billing, Usage (POST /api/billing/usage/requests); Accounted opens the charge by hand. An agent cannot open it: tell the person, then retry once it is open.',
    },
    thrown_message_sv: true,
  },
  // Use above the included amount for a company nobody pays for (trial, free period).
  USAGE_SUBSCRIPTION_REQUIRED: {
    httpStatus: 409,
    message_sv: 'Det som ingår är använt. Fler kräver ett abonnemang. Starta det under Inställningar, Abonnemang.',
    message_en: 'The included amount is used up. More need a subscription. Start one under Settings, Billing.',
    remediation: {
      description:
        'The company has no active subscription of its own and no byrå agreement (a trial or a free period), so nothing above details.included of details.kind can be opened or billed. A person starts a subscription under Settings, Billing; an agent cannot.',
    },
    thrown_message_sv: true,
  },
  // Begär fler (lib/usage/requests.ts).
  USAGE_REQUEST_OPEN: {
    httpStatus: 409,
    message_sv: 'Ni har redan en förfrågan om den här tjänsten som vi inte har svarat på. Vi hör av oss så snart vi kan.',
    message_en: 'You already have a request for this service that we have not answered yet. We will get back to you as soon as we can.',
  },
  USAGE_REQUEST_NOT_SENT: {
    httpStatus: 503,
    message_sv: 'Förfrågan kunde inte skickas just nu. Försök igen om en stund.',
    message_en: 'The request could not be sent right now. Try again in a moment.',
    retryable: true,
  },
  BANK_PAYMENTS_ALLOWANCE_REQUEST_OPEN: {
    httpStatus: 409,
    message_sv: 'Ni har redan en förfrågan om fler betalningar som vi inte har svarat på. Vi hör av oss så snart vi kan.',
    message_en: 'You already have a request for more payments that we have not answered yet. We will get back to you as soon as we can.',
  },
  BANK_PAYMENTS_ALLOWANCE_REQUEST_NOT_SENT: {
    httpStatus: 503,
    message_sv: 'Förfrågan kunde inte skickas just nu. Försök igen om en stund.',
    message_en: 'The request could not be sent right now. Try again in a moment.',
    retryable: true,
  },
  // Bank payment packs on the subscription (lib/stripe/payment-packs.ts, issue #132).
  PAYMENT_PACKS_NOT_OFFERED: {
    httpStatus: 409,
    message_sv: 'Fler betalningar går inte att köpa här. Begär fler under Inställningar, Kopplingar, Betalningar via banken.',
    message_en: 'More payments cannot be bought here. Ask for more under Settings, Connections, Bank payments.',
  },
  PAYMENT_PACKS_SUBSCRIPTION_NOT_ACTIVE: {
    httpStatus: 409,
    message_sv: 'Fler betalningar köps på ett aktivt abonnemang. Under en provperiod, eller när abonnemanget är uppsagt eller obetalt, begär ni fler i stället.',
    message_en: 'More payments are bought on an active subscription. During a trial, or when the subscription is cancelled or unpaid, ask for more instead.',
  },
  PAYMENT_PACKS_PLAN_CHANGE_PENDING: {
    httpStatus: 409,
    message_sv: 'Abonnemanget har en planändring som väntar. Köp fler betalningar när den har gått igenom.',
    message_en: 'The subscription has a plan change waiting. Buy more payments once it has taken effect.',
  },
  PAYMENT_PACKS_PLAN_INTERVAL: {
    httpStatus: 409,
    message_sv: 'Abonnemanget debiteras med ett annat intervall än paketen, så fler betalningar går inte att köpa på det än. Begär fler under Inställningar, Kopplingar, Betalningar via banken.',
    message_en: 'The subscription is billed on another interval than the packs, so more payments cannot be bought on it yet. Ask for more under Settings, Connections, Bank payments.',
  },
  PAYMENT_PACKS_PAYMENT_FAILED: {
    httpStatus: 402,
    message_sv: 'Kortet kunde inte debiteras, så inga betalningar lades till. Byt kort under Abonnemang och försök igen.',
    message_en: 'The card could not be charged, so no payments were added. Change card under Subscription and try again.',
  },
  PAYMENT_SIGNING_REDIRECT_UNSUPPORTED: {
    httpStatus: 409,
    message_sv: 'Banken kräver signering på sin egen webbsida, vilket inte stöds här ännu. Betala fakturorna med en betalfil i stället.',
    message_en: 'The bank requires signing on its own website, which is not supported here yet. Pay the invoices with a payment file instead.',
  },
  // A 4xx, as BANK_PROVIDER_REFUSED: the bank answers the same refusal on
  // every try (one that may pass on a retry is PAYMENT_PROVIDER_UNAVAILABLE).
  // As a 502 it was logged at error and counted as an outage.
  PAYMENT_PROVIDER_REFUSED: {
    httpStatus: 422,
    message_sv: 'Banken tog inte emot betalningen. Kontrollera uppgifterna och försök igen.',
    message_en: 'The bank did not accept the payment. Check the details and try again.',
  },
  PAYMENT_PROVIDER_UNAVAILABLE: {
    httpStatus: 503,
    message_sv: 'Banken svarar inte just nu. Försök igen om en stund.',
    message_en: 'The bank is not responding right now. Try again in a moment.',
    retryable: true,
  },
}

// Reading a bank with BankID through Open Payments (lib/bank-feed): the
// consent flow, the account selection and the first import.
const OPEN_BANKING: Record<string, StructuredErrorEntry> = {
  OPEN_BANKING_NOT_AVAILABLE: {
    httpStatus: 403,
    message_sv: 'Att koppla banken med BankID via Open Payments är inte aktiverat för det här företaget.',
    message_en: 'Connecting a bank with BankID through Open Payments is not enabled for this company.',
  },
  BANK_CONNECTION_IN_PROGRESS: {
    httpStatus: 409,
    message_sv: 'Företaget har redan en bankkoppling eller ett påbörjat försök. Ta bort den under Inställningar, Kopplingar för att koppla en annan bank, eller vänta en kvart och försök igen.',
    message_en: 'The company already has a bank connection or an attempt in progress. Remove it under Settings, Connections to connect another bank, or wait a quarter of an hour and try again.',
  },
  BANK_CONSENT_PERSONAL_NUMBER_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Ange personnumret för den som loggar in med BankID.',
    message_en: 'Enter the personal identity number of the person logging in with BankID.',
  },
  // No stored organisationsnummer reads as one (lib/company/org-number.ts).
  // The field is editable exactly then (lib/company/org-number-rule.ts:
  // writable while no valid number is stored), so the text names it.
  BANK_CONSENT_ORG_NUMBER_MISSING: {
    httpStatus: 400,
    message_sv: 'Företagets organisationsnummer saknas eller är ogiltigt, och banken behöver det för kopplingen. Fyll i det under Inställningar, Företaget, Företagsuppgifter och försök igen.',
    message_en: 'The company\'s organisation number is missing or invalid, and the bank needs it for the connection. Fill it in under Settings, Company, Company details and try again.',
  },
  BANK_CONSENT_UNKNOWN_BANK: {
    httpStatus: 400,
    message_sv: 'Banken finns inte i listan över banker som kan kopplas.',
    message_en: 'The bank is not in the list of banks that can be connected.',
  },
  BANK_CONSENT_REDIRECT_UNSUPPORTED: {
    httpStatus: 409,
    message_sv: 'Banken vill att du signerar på sin egen sida. Starta om och välj att signera på bankens sida.',
    message_en: 'The bank wants you to sign on its own page. Start again and choose to sign on the bank\'s page.',
  },
  BANK_CONSENT_CHANGED: {
    httpStatus: 409,
    message_sv: 'Bankkopplingen ändrades under tiden. Börja om kopplingen.',
    message_en: 'The bank connection changed in the meantime. Start the connection again.',
  },
  BANK_CONSENT_NOT_READY: {
    httpStatus: 409,
    message_sv: 'BankID-signeringen är inte klar ännu. Slutför den innan kontona väljs.',
    message_en: 'The BankID signing is not finished yet. Complete it before picking accounts.',
  },
  BANK_CONSENT_OVER: {
    httpStatus: 409,
    message_sv: 'Samtycket till banken har löpt ut. Koppla banken igen med BankID för att fortsätta synka.',
    message_en: 'The consent to the bank is over. Connect the bank again with BankID to keep syncing.',
  },
  BANK_CONSENT_SIGNING_FAILED: {
    httpStatus: 409,
    message_sv: 'BankID-signeringen kunde inte slutföras. Försök igen.',
    message_en: 'The BankID signing could not be completed. Try again.',
    thrown_message_sv: true,
  },
  BANK_CONSENT_ACTOR_DENIED: {
    httpStatus: 403,
    message_sv: 'Du har inte behörighet att koppla banken för det här företaget.',
    message_en: 'You are not allowed to connect a bank for this company.',
  },
  BANK_CONSENT_INPUT_INVALID: {
    httpStatus: 502,
    message_sv: 'Bankens svar kunde inte läsas. Försök igen.',
    message_en: 'The bank\'s answer could not be read. Try again.',
  },
  BANK_SUPERSEDE_ACTOR_DENIED: {
    httpStatus: 403,
    message_sv: 'Du har inte behörighet att ersätta bankkopplingen för det här företaget.',
    message_en: 'You are not allowed to replace the bank connection for this company.',
  },
  BANK_SUPERSEDE_SCOPE_AMBIGUOUS: {
    httpStatus: 409,
    message_sv: 'Den gamla bankkopplingen har två olika historiker för samma konto. Kontakta supporten innan kopplingen byts.',
    message_en: 'The old bank connection holds two different histories for the same account. Contact support before switching.',
  },
  // A 4xx: the refusal is what the bank answers on every try (a retryable
  // failure is BANK_PROVIDER_UNAVAILABLE). As a 5xx the consent poll asked
  // again for 10 polls and then said the bank did not answer.
  BANK_PROVIDER_REFUSED: {
    httpStatus: 422,
    message_sv: 'Banken tog inte emot begäran. Kontrollera uppgifterna och försök igen.',
    message_en: 'The bank did not accept the request. Check the details and try again.',
  },
  BANK_PROVIDER_UNAVAILABLE: {
    httpStatus: 503,
    message_sv: 'Banken svarar inte just nu. Försök igen om en stund.',
    message_en: 'The bank is not responding right now. Try again in a moment.',
    retryable: true,
  },
}

// ─────────────────────────────────────────────────────────────────
// Kundförlust (lib/customer-loss). Befarad reserve, konstaterad write-off
// and recovery on a customer invoice; behind CUSTOMER_LOSS_ENABLED.
// ─────────────────────────────────────────────────────────────────

const CUSTOMER_LOSS: Record<string, StructuredErrorEntry> = {
  CUSTOMER_LOSS_DISABLED: {
    httpStatus: 503,
    message_sv: 'Kundförlust kan inte bokföras här just nu.',
    message_en: 'Customer losses cannot be booked here right now.',
  },
  CUSTOMER_LOSS_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Du har inte behörighet att bokföra kundförluster i det här företaget.',
    message_en: 'You are not allowed to book customer losses in this company.',
  },
  CUSTOMER_LOSS_INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Fakturan hittades inte.',
    message_en: 'Invoice not found.',
  },
  CUSTOMER_LOSS_INVOICE_NOT_OPEN: {
    httpStatus: 409,
    message_sv: 'Kundförlust kan bara bokföras på en skickad faktura som inte är betald eller krediterad.',
    message_en: 'A customer loss can only be booked on a sent invoice that is neither paid nor credited.',
  },
  CUSTOMER_LOSS_CURRENCY_UNSUPPORTED: {
    httpStatus: 422,
    message_sv: 'Kundförlust kan bara bokföras här för fakturor i kronor.',
    message_en: 'A customer loss can only be booked here for invoices in Swedish kronor.',
  },
  CUSTOMER_LOSS_DEDUCTION_UNSUPPORTED: {
    httpStatus: 422,
    message_sv: 'Kundförlust kan inte bokföras här för en faktura med ROT-, RUT- eller grön teknik-avdrag. Bokför den manuellt med din redovisningskonsult.',
    message_en: 'A customer loss cannot be booked here for an invoice with a ROT, RUT or green technology deduction. Book it manually with your accountant.',
  },
  CUSTOMER_LOSS_INVOICE_NOT_BOOKED: {
    httpStatus: 409,
    message_sv: 'Fakturan är inte bokförd än. Bokför fakturan innan du bokför en kundförlust.',
    message_en: 'The invoice is not booked yet. Book the invoice before booking a customer loss.',
  },
  CUSTOMER_LOSS_DOUBTFUL_NOT_BOOKED: {
    httpStatus: 409,
    message_sv: 'Fakturan är inte bokförd som fordran (kontantmetoden), så en befarad kundförlust påverkar inte bokföringen. Bokför en konstaterad kundförlust när förlusten är visad.',
    message_en: 'The invoice is not booked as a receivable (cash method), so a doubtful loss does not affect the books. Book a confirmed loss once the loss is shown.',
  },
  CUSTOMER_LOSS_LEDGER_MISMATCH: {
    httpStatus: 409,
    message_sv: 'Fakturans kvarvarande belopp stämmer inte med verifikationen i bokföringen. Kontrollera fakturans betalningar innan du bokför en kundförlust.',
    message_en: 'The invoice\'s remaining amount does not match its voucher. Check the invoice\'s payments before booking a customer loss.',
  },
  CUSTOMER_LOSS_ALREADY_RESERVED: {
    httpStatus: 409,
    message_sv: 'En befarad kundförlust är redan bokförd för hela det obetalda beloppet.',
    message_en: 'A doubtful loss is already booked for the whole unpaid amount.',
  },
  CUSTOMER_LOSS_EVIDENCE_REQUIRED: {
    httpStatus: 400,
    message_sv: 'En konstaterad kundförlust kräver underlag, till exempel konkursbesked eller beslut från Kronofogden.',
    message_en: 'A confirmed customer loss needs evidence, for example a bankruptcy notice or a decision from the Enforcement Authority.',
  },
  CUSTOMER_LOSS_EVIDENCE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Underlaget hittades inte.',
    message_en: 'The evidence document was not found.',
  },
  CUSTOMER_LOSS_NOT_WRITTEN_OFF: {
    httpStatus: 409,
    message_sv: 'Fakturan är inte bokförd som konstaterad kundförlust.',
    message_en: 'The invoice is not booked as a confirmed customer loss.',
  },
  CUSTOMER_LOSS_RECOVERY_EXCEEDS: {
    httpStatus: 422,
    message_sv: 'Beloppet är större än det som skrevs av som kundförlust.',
    message_en: 'The amount is larger than what was written off as a customer loss.',
  },
  CUSTOMER_LOSS_RECOVERY_CASE_OPEN: {
    httpStatus: 409,
    message_sv: 'Fakturan har ett öppet inkassoärende. Avsluta eller återkalla ärendet först, så att inkassobolaget inte kräver kunden på det som redan är betalt. Bokför sedan betalningen som återvunnen kundförlust.',
    message_en: 'The invoice has an open collection case. Close or withdraw the case first, so the collection agency does not pursue the customer for what is already paid. Then book the payment as a recovered loss.',
  },
  CUSTOMER_LOSS_RECOVERY_NOT_BOOKED: {
    httpStatus: 409,
    message_sv: 'Fakturan bokfördes aldrig som fordran (kontantmetoden). Bokför betalningen som en vanlig försäljning.',
    message_en: 'The invoice was never booked as a receivable (cash method). Book the payment as an ordinary sale.',
  },
  CUSTOMER_LOSS_NO_FISCAL_PERIOD: {
    httpStatus: 422,
    message_sv: 'Det finns inget öppet räkenskapsår för datumet.',
    message_en: 'There is no open fiscal year for the date.',
  },
  CUSTOMER_LOSS_RACE: {
    httpStatus: 409,
    message_sv: 'Kundförlusten bokförs redan. Uppdatera sidan och försök igen.',
    message_en: 'The customer loss is already being booked. Refresh the page and try again.',
    retryable: true,
  },
  CUSTOMER_LOSS_ANNUL_NOT_LATEST: {
    httpStatus: 409,
    message_sv: 'Det finns ett senare kundförlustbeslut på fakturan. Återför det först.',
    message_en: 'The invoice has a later customer loss decision. Reverse that one first.',
  },
  CUSTOMER_LOSS_VOUCHER_LOCKED: {
    httpStatus: 409,
    message_sv: 'En kundförlustverifikation rättas inte. Återför verifikationen (storno) och bokför kundförlusten på nytt.',
    message_en: 'A customer loss voucher is not corrected in place. Reverse it and book the customer loss again.',
  },
  CUSTOMER_LOSS_RECORD_FAILED: {
    httpStatus: 500,
    message_sv: 'Kundförlusten kunde inte registreras på fakturan, så verifikationen återfördes direkt. Försök igen eller kontakta support.',
    message_en: 'The customer loss could not be recorded on the invoice, so its voucher was reversed at once. Try again or contact support.',
  },
}

// Kvittning: a customer invoice set off against a supplier invoice of the
// same counterparty (lib/invoices/counterparty-setoff, migration
// 20261022130100). book_counterparty_setoff answers the same codes.
const SETOFF: Record<string, StructuredErrorEntry> = {
  SETOFF_DISABLED: {
    httpStatus: 503,
    message_sv: 'Kvittning kan inte bokföras här just nu.',
    message_en: 'Set-offs cannot be booked here right now.',
  },
  SETOFF_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Du har inte behörighet att bokföra kvittningar i det här företaget.',
    message_en: 'You are not allowed to book set-offs in this company.',
  },
  SETOFF_INVALID_REQUEST: {
    httpStatus: 400,
    message_sv: 'Kvittningen saknar en kundfaktura eller leverantörsfaktura, eller anteckningen är för lång.',
    message_en: 'The set-off lacks a customer invoice or supplier invoice, or the note is too long.',
  },
  SETOFF_INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kundfakturan hittades inte.',
    message_en: 'The customer invoice was not found.',
  },
  SETOFF_SUPPLIER_INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Leverantörsfakturan hittades inte.',
    message_en: 'The supplier invoice was not found.',
  },
  SETOFF_PARTY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Motparten hittades inte. Kortet saknar organisationsnummer eller är inte kopplat till en motpart.',
    message_en: 'The counterparty was not found. The card has no organisation number or is not linked to a counterparty.',
  },
  SETOFF_INVOICE_NOT_ELIGIBLE: {
    httpStatus: 422,
    message_sv: 'Bara en vanlig kundfaktura kan kvittas, inte en kreditfaktura, proformafaktura eller offert.',
    message_en: 'Only an ordinary customer invoice can be set off, not a credit note, proforma invoice or quote.',
  },
  SETOFF_SUPPLIER_INVOICE_NOT_ELIGIBLE: {
    httpStatus: 422,
    message_sv: 'En kreditfaktura från leverantören kan inte kvittas. Den kvittas mot sin egen faktura.',
    message_en: 'A supplier credit note cannot be set off. It settles its own invoice.',
  },
  SETOFF_INVOICE_NOT_OPEN: {
    httpStatus: 409,
    message_sv: 'Kundfakturan är inte öppen: den måste vara skickad och inte betald, krediterad eller avskriven.',
    message_en: 'The customer invoice is not open: it must be sent and not paid, credited or written off.',
  },
  SETOFF_SUPPLIER_INVOICE_NOT_OPEN: {
    httpStatus: 409,
    message_sv: 'Leverantörsfakturan är inte öppen: den måste vara registrerad och inte betald, krediterad eller återförd.',
    message_en: 'The supplier invoice is not open: it must be registered and not paid, credited or reversed.',
  },
  SETOFF_CURRENCY_UNSUPPORTED: {
    httpStatus: 422,
    message_sv: 'Kvittning görs här bara för fakturor i kronor.',
    message_en: 'Set-offs are only booked here for invoices in Swedish kronor.',
  },
  SETOFF_DEDUCTION_UNSUPPORTED: {
    httpStatus: 422,
    message_sv: 'En faktura med ROT-, RUT- eller grön teknik-avdrag kan inte kvittas här. Bokför kvittningen manuellt.',
    message_en: 'An invoice with a ROT, RUT or green technology deduction cannot be set off here. Book the set-off by hand.',
  },
  SETOFF_INVOICE_NOT_BOOKED: {
    httpStatus: 422,
    message_sv: 'Fakturan är inte bokförd än, så det finns ingen fordran eller skuld att kvitta. Bokför fakturan först och kvitta sedan. Med kontantmetoden bokförs fakturan först vid betalning och kan inte kvittas här.',
    message_en: 'The invoice has no booking voucher yet, so there is no receivable or payable to set off. Book the invoice first, then set it off. Under the cash method an invoice is booked only at payment and cannot be set off here.',
    remediation: {
      description: 'Book the invoice the details name (side customer: gnubok_book_invoice, side supplier: gnubok_book_supplier_invoice), then retry the set-off.',
    },
  },
  SETOFF_NO_PARTY: {
    httpStatus: 422,
    message_sv: 'Kund- eller leverantörskortet är inte kopplat till en motpart. Lägg till organisationsnumret eller slå ihop motparterna under Motparter.',
    message_en: 'The customer or supplier card is not linked to a counterparty. Add the organisation number or merge the counterparties under Counterparties.',
  },
  SETOFF_PARTY_MISMATCH: {
    httpStatus: 422,
    message_sv: 'Fakturorna tillhör inte samma motpart. Bara fordringar och skulder mellan samma parter kan kvittas.',
    message_en: 'The invoices do not belong to the same counterparty. Only claims and debts between the same parties can be set off.',
  },
  SETOFF_COLLECTION_OPEN: {
    httpStatus: 409,
    message_sv: 'Kundfakturan ligger hos inkasso. Kvitta den inte förrän ärendet är avslutat.',
    message_en: 'The customer invoice is with the collections provider. Do not set it off until the case is closed.',
  },
  SETOFF_PAYMENT_IN_FLIGHT: {
    httpStatus: 409,
    message_sv: 'Leverantörsfakturan har en betalning på väg (inlagd i banken, i en betalfil eller en betalningsorder). Ta bort betalningen först, annars betalas hela beloppet.',
    message_en: 'The supplier invoice has a payment on its way (entered at the bank, in a payment file or a payment order). Remove that payment first, or the full amount is paid.',
  },
  SETOFF_INVALID_AMOUNT: {
    httpStatus: 400,
    message_sv: 'Beloppet måste vara större än noll och anges i hela ören.',
    message_en: 'The amount must be above zero and given in whole öre.',
  },
  SETOFF_AMOUNT_EXCEEDS_REMAINING: {
    httpStatus: 422,
    message_sv: 'Beloppet är större än det som återstår på någon av fakturorna.',
    message_en: 'The amount is larger than what remains on one of the invoices.',
  },
  SETOFF_DATE_INVALID: {
    httpStatus: 400,
    message_sv: 'Kvittningsdagen kan inte ligga i framtiden eller före någon av fakturornas datum.',
    message_en: 'The set-off date cannot be in the future or before either invoice date.',
  },
  SETOFF_NO_FISCAL_PERIOD: {
    httpStatus: 422,
    message_sv: 'Det finns inget räkenskapsår för kvittningsdagen. Skapa räkenskapsåret först.',
    message_en: 'There is no fiscal year for the set-off date. Create the fiscal year first.',
  },
  SETOFF_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv: 'Perioden för kvittningsdagen är stängd eller låst. Välj en dag i en öppen period.',
    message_en: 'The period of the set-off date is closed or locked. Pick a date in an open period.',
  },
  SETOFF_LEDGER_MISMATCH: {
    httpStatus: 409,
    message_sv: 'Fakturans verifikat bokför ingen kundfordran respektive leverantörsskuld, så kvittningen kan inte bokas här. Kontrollera verifikatet eller bokför kvittningen manuellt.',
    message_en: 'The invoice voucher books no receivable or payable, so the set-off cannot be booked here. Check the voucher or book the set-off by hand.',
  },
  SETOFF_RACE: {
    httpStatus: 409,
    message_sv: 'Kvittningen bokförs redan. Uppdatera sidan och försök igen.',
    message_en: 'The set-off is already being booked. Refresh the page and try again.',
    retryable: true,
  },
  SETOFF_BOOKING_FAILED: {
    httpStatus: 500,
    message_sv: 'Kvittningen kunde inte bokföras. Ingenting har ändrats. Försök igen eller kontakta support.',
    message_en: 'The set-off could not be booked. Nothing was changed. Try again or contact support.',
    retryable: true,
  },
  SETOFF_REVERSAL_BLOCKED: {
    httpStatus: 409,
    message_sv: 'En av fakturorna i kvittningen har krediterats eller skrivits av sedan dess, så kvittningen kan inte återföras.',
    message_en: 'One of the set-off invoices has been credited or written off since, so the set-off cannot be reversed.',
  },
  SETOFF_VOUCHER_LOCKED: {
    httpStatus: 409,
    message_sv: 'En kvittningsverifikation rättas inte. Återför verifikationen (storno) och bokför kvittningen på nytt.',
    message_en: 'A set-off voucher is not corrected in place. Reverse it and book the set-off again.',
  },
  SETOFF_DELETE_BLOCKED: {
    httpStatus: 409,
    message_sv: 'En kvittning tas aldrig bort. Återför kvittningsverifikationen (storno) i stället.',
    message_en: 'A set-off is never deleted. Reverse the set-off voucher instead.',
  },
}

// The payment signing link (lib/payments/orders/signing-links.ts): a basket
// of approved bank payments a firmatecknare signs at /betala/<token>.
const PAYMENT_SIGNING_LINKS: Record<string, StructuredErrorEntry> = {
  PAYMENT_SIGNING_LINK_ALREADY_OPEN: {
    httpStatus: 409,
    message_sv: 'En eller flera av betalningarna väntar redan på signering via en annan länk. Avbryt den länken först.',
    message_en: 'One or more of the payments already wait for a signature through another link. Cancel that link first.',
  },
  PAYMENT_SIGNING_LINK_ORDERS_CHANGED: {
    httpStatus: 409,
    message_sv: 'Betalningarna har ändrats sedan länken skickades, så inget signerades. Be den som skickade länken om en ny.',
    message_en: 'The payments changed after the link was sent, so nothing was signed. Ask the sender for a new link.',
  },
  PAYMENT_SIGNING_LINK_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Signeringslänken finns inte.',
    message_en: 'The signing link does not exist.',
  },
  PAYMENT_SIGNING_LINK_NOT_OPEN: {
    httpStatus: 409,
    message_sv: 'Länken har redan använts för att signera betalningarna och kan inte avbrytas.',
    message_en: 'The link was already used to sign the payments and cannot be cancelled.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Bolaget capital events: dividends, KU31, tillskott, emissions (lib/bolaget/capital)
// ─────────────────────────────────────────────────────────────────

const BOLAGET_CAPITAL: Record<string, StructuredErrorEntry> = {
  DIVIDEND_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Utdelningen finns inte.',
    message_en: 'The dividend does not exist.',
  },
  DIVIDEND_STATUS_INVALID: {
    httpStatus: 409,
    message_sv: 'Utdelningen har fel status för det här steget: ett beslut bokförs en gång och betalas ut efter att det bokförts.',
    message_en: 'The dividend has the wrong status for this step: a decision is booked once and paid after it is booked.',
  },
  DIVIDEND_NO_HOLDERS: {
    httpStatus: 409,
    message_sv: 'Aktieboken har inga ägare den dag som avgör vem som får utdelningen. För in aktierna under Aktiebok först.',
    message_en: 'The share register has no holders on the day that decides who receives the dividend. Enter the shares first.',
  },
  DIVIDEND_EXCEEDS_FREE_EQUITY: {
    httpStatus: 409,
    message_sv: 'Utdelningen överstiger det fria egna kapitalet i den senaste balansräkningen med avdrag för senare värdeöverföringar och kan inte bokföras (17 kap. 3 § ABL).',
    message_en: 'The dividend exceeds the free equity on the last balance sheet less later value transfers and cannot be booked (ABL 17:3).',
  },
  DIVIDEND_PAYOUT_ENTRY_INVALID: {
    httpStatus: 409,
    message_sv: 'Verifikatet är inte bokfört eller debiterar inte 2898 Outtagen vinstutdelning.',
    message_en: 'The voucher is not posted or does not debit 2898.',
  },
  DIVIDEND_RECIPIENTS_MISMATCH: {
    httpStatus: 409,
    message_sv: 'Mottagarnas belopp stämmer inte med utbetalningen på 2898.',
    message_en: 'The recipients\' amounts do not add up to the payout on 2898.',
    thrown_message_sv: true,
  },
  DIVIDEND_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Verifikatet bokfördes men utdelningen kunde inte markeras. Kontakta supporten med verifikatets nummer.',
    message_en: 'The voucher was posted but the dividend could not be marked. Contact support with the voucher number.',
  },
  DIVIDEND_APPEND_ONLY: {
    httpStatus: 409,
    message_sv: 'En utdelning tas aldrig bort; ett beslut som inte bokförts kan avbrytas.',
    message_en: 'A dividend is never deleted; a decision not yet booked can be cancelled.',
  },
  DIVIDEND_FROZEN: {
    httpStatus: 409,
    message_sv: 'En bokförd utdelning och dess fördelning ändras inte. Rätta verifikatet med en rättelse.',
    message_en: 'A booked dividend and its split do not change. Correct the voucher instead.',
  },
  KU31_NOT_READY: {
    httpStatus: 409,
    message_sv: 'Kontrolluppgiften KU31 kan inte skapas ännu.',
    message_en: 'The KU31 file cannot be made yet.',
    thrown_message_sv: true,
  },
  CAPITAL_NO_OPEN_PERIOD: {
    httpStatus: 409,
    message_sv: 'Det finns inget öppet räkenskapsår för datumet. Lägg upp räkenskapsåret eller välj ett annat datum.',
    message_en: 'No open fiscal year covers the date. Add the fiscal year or choose another date.',
    thrown_message_sv: true,
  },
  CONTRIBUTION_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Aktieägartillskottet finns inte eller är inte bokfört.',
    message_en: 'The shareholder contribution does not exist or is not booked.',
  },
  CONTRIBUTION_NOT_CONDITIONAL: {
    httpStatus: 409,
    message_sv: 'Bara ett villkorat aktieägartillskott kan återbetalas.',
    message_en: 'Only a conditional shareholder contribution can be repaid.',
  },
  CONTRIBUTION_REPAYMENT_EXCEEDS: {
    httpStatus: 409,
    message_sv: 'Återbetalningen är större än det som återstår av tillskottet.',
    message_en: 'The repayment is larger than what is left of the contribution.',
    thrown_message_sv: true,
  },
  CONTRIBUTION_RECORD_FAILED: {
    httpStatus: 500,
    message_sv: 'Verifikatet bokfördes men tillskottet kunde inte registreras. Kontakta supporten med verifikatets nummer.',
    message_en: 'The voucher was posted but the contribution could not be recorded. Contact support with the voucher number.',
  },
  CONTRIBUTION_APPEND_ONLY: {
    httpStatus: 409,
    message_sv: 'Ett aktieägartillskott tas aldrig bort.',
    message_en: 'A shareholder contribution is never deleted.',
  },
  CONTRIBUTION_FROZEN: {
    httpStatus: 409,
    message_sv: 'Ett bokfört aktieägartillskott ändras inte. Rätta verifikatet med en rättelse.',
    message_en: 'A booked shareholder contribution does not change. Correct the voucher instead.',
  },
  CAPITAL_CHANGE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kapitaländringen finns inte.',
    message_en: 'The capital change does not exist.',
  },
  CAPITAL_CHANGE_STATUS_INVALID: {
    httpStatus: 409,
    message_sv: 'Kapitaländringen har fel status för det här steget.',
    message_en: 'The capital change has the wrong status for this step.',
    thrown_message_sv: true,
  },
  CAPITAL_CHANGE_NOT_PAID: {
    httpStatus: 409,
    message_sv: 'Bokför inbetalningen av nyemissionen innan registreringen: aktierna ska vara fullt betalda (13 kap. 28 § ABL).',
    message_en: 'Book the payment of the new issue before its registration: the shares must be fully paid (ABL 13:28).',
  },
  CAPITAL_CHANGE_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Verifikatet bokfördes men kapitaländringen kunde inte markeras. Kontakta supporten med verifikatets nummer.',
    message_en: 'The voucher was posted but the capital change could not be marked. Contact support with the voucher number.',
  },
  CAPITAL_CHANGE_APPEND_ONLY: {
    httpStatus: 409,
    message_sv: 'En kapitaländring tas aldrig bort.',
    message_en: 'A capital change is never deleted.',
  },
  CAPITAL_CHANGE_FROZEN: {
    httpStatus: 409,
    message_sv: 'En bokförd eller registrerad kapitaländring ändras inte.',
    message_en: 'A booked or registered capital change does not change.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Bolaget owner tax: K10 underlag, owner loans, KU20 (lib/bolaget/owner-tax)
// ─────────────────────────────────────────────────────────────────

const BOLAGET_OWNER_TAX: Record<string, StructuredErrorEntry> = {
  K10_YEAR_UNSUPPORTED: {
    httpStatus: 409,
    message_sv: 'K10-underlaget finns inte för det inkomståret.',
    message_en: 'There is no K10 underlag for that income year.',
    thrown_message_sv: true,
  },
  K10_OWNER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Personen ägde inga aktier vid årets ingång och fick ingen utdelning under året.',
    message_en: 'The person held no shares at the start of the year and received no dividend in it.',
  },
  OWNER_LOAN_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Lånet finns inte i registret över ägarlån.',
    message_en: 'The loan is not in the owner loan register.',
  },
  OWNER_LOAN_STATUS_INVALID: {
    httpStatus: 409,
    message_sv: 'Ett makulerat lån ändras inte.',
    message_en: 'A cancelled loan does not change.',
  },
  OWNER_LOAN_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Välj ett konto som passar lånet: 1360-1368 eller 1680-1689 när bolaget lånar ut, 2390-2399 eller 2890-2899 när bolaget lånar.',
    message_en: 'Pick an account that fits the loan: 1360-1368 or 1680-1689 when the company lends, 2390-2399 or 2890-2899 when it borrows.',
  },
  OWNER_LOAN_RELATED_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Ange vilken aktieägare, styrelseledamot eller VD den närstående eller det kontrollerade bolaget hör till (en annan person än motparten).',
    message_en: 'Name the shareholder, board member or VD the related person or controlled company belongs to (another person than the counterparty).',
  },
  OWNER_LOAN_OUTSTANDING_INVALID: {
    httpStatus: 400,
    message_sv: 'Det utestående beloppet kan inte vara negativt eller större än lånebeloppet.',
    message_en: 'The outstanding amount cannot be negative or larger than the principal.',
  },
  OWNER_LOAN_APPEND_ONLY: {
    httpStatus: 409,
    message_sv: 'Ett lån tas aldrig bort: markera det som återbetalt eller makulerat.',
    message_en: 'A loan is never deleted: mark it repaid or cancelled.',
  },
  KU20_NOT_READY: {
    httpStatus: 409,
    message_sv: 'Kontrolluppgiften KU20 kan inte skapas ännu.',
    message_en: 'The KU20 file cannot be made yet.',
    thrown_message_sv: true,
  },
}

// ─────────────────────────────────────────────────────────────────
// Bolaget meetings: stämmor, styrelsemöten, minutes (lib/bolaget/meetings)
// ─────────────────────────────────────────────────────────────────

const BOLAGET_MEETINGS: Record<string, StructuredErrorEntry> = {
  CORPORATE_MEETING_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Mötet finns inte.',
    message_en: 'The meeting was not found.',
  },
  CORPORATE_DECISION_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Beslutet finns inte på mötet.',
    message_en: 'The decision was not found on the meeting.',
  },
  CORPORATE_MEETING_LOCKED: {
    httpStatus: 409,
    message_sv: 'Protokollet är signerat och kan inte ändras eller tas bort.',
    message_en: 'The minutes are signed and cannot be changed or deleted.',
  },
  CORPORATE_MEETING_NOT_HELD: {
    httpStatus: 409,
    message_sv: 'Markera mötet som hållet innan protokollet signeras.',
    message_en: 'Mark the meeting as held before the minutes are signed.',
  },
  CORPORATE_MEETING_NOT_DRAFT: {
    httpStatus: 409,
    message_sv: 'Bara ett utkast kan tas bort. Ett hållet möte och dess protokoll sparas.',
    message_en: 'Only a draft can be deleted. A held meeting and its minutes are kept.',
  },
  CORPORATE_MEETING_ALREADY_HELD: {
    httpStatus: 409,
    message_sv: 'Mötet är redan markerat som hållet.',
    message_en: 'The meeting is already marked as held.',
  },
  CORPORATE_MEETING_IN_FUTURE: {
    httpStatus: 409,
    message_sv: 'Ett möte kan inte markeras som hållet före mötesdagen.',
    message_en: 'A meeting cannot be marked as held before its date.',
  },
  CORPORATE_MEETING_FISCAL_PERIOD_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Ange räkenskapsåret som årsstämman gäller.',
    message_en: 'Give the fiscal year the annual general meeting is for.',
  },
  CORPORATE_MEETING_FISCAL_PERIOD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsåret finns inte i bolaget.',
    message_en: 'The fiscal year was not found in the company.',
  },
  CORPORATE_DECISION_PAYLOAD_INVALID: {
    httpStatus: 400,
    message_sv: 'Beslutets uppgifter är inte giltiga.',
    message_en: 'The terms of the decision are not valid.',
    thrown_message_sv: true,
  },
  CORPORATE_MEETING_SIGNING_PENDING: {
    httpStatus: 409,
    message_sv: 'Protokollet är ute för signering. Avbryt signeringen för att ändra det.',
    message_en: 'The minutes are out for signing. Cancel the signing to change them.',
  },
  CORPORATE_MEETING_SIGNERS_MISSING: {
    httpStatus: 409,
    message_sv: 'Protokollet har ingen som ska skriva under. Ange ordförande, protokollförare och justerare.',
    message_en: 'The minutes have no signers. Name the chair, the secretary and the adjusters.',
  },
  CORPORATE_MEETING_FILE_INVALID: {
    httpStatus: 400,
    message_sv: 'Filen kan inte arkiveras. Ladda upp en PDF eller en bild.',
    message_en: 'The file cannot be archived. Upload a PDF or an image.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Bolaget registers: aktiebok, roles, verkliga huvudmän (lib/bolaget)
// ─────────────────────────────────────────────────────────────────

const BOLAGET: Record<string, StructuredErrorEntry> = {
  BOLAGET_DISABLED: {
    httpStatus: 404,
    message_sv: 'Bolagets register finns inte här ännu.',
    message_en: 'The company registers are not available here yet.',
  },
  BOLAGET_NOT_FOR_LEGAL_FORM: {
    httpStatus: 409,
    message_sv: 'Aktiebok, styrelse och verkliga huvudmän förs här för aktiebolag.',
    message_en: 'The share register, the board and the beneficial owners are kept here for an aktiebolag only.',
  },
  BOLAGET_PARTY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Personen eller företaget finns inte i bolagets register.',
    message_en: 'The person or company is not in the company\'s registers.',
  },
  BOLAGET_PARTY_INVALID: {
    httpStatus: 400,
    message_sv: 'Ange en befintlig person eller ett namn.',
    message_en: 'Name an existing party or give a name.',
    thrown_message_sv: true,
  },
  BOLAGET_PERSONNUMMER_IN_APP_ONLY: {
    httpStatus: 400,
    message_sv: 'Ett personnummer registreras bara i Accounted, under Aktiebok, aldrig i ett anrop.',
    message_en: 'A personnummer is entered in Accounted only (Aktiebok), never through the API or an agent.',
  },
  BOLAGET_PERSONNUMMER_INVALID: {
    httpStatus: 400,
    message_sv: 'Personnumret är inte giltigt. Ange tolv siffror (ÅÅÅÅMMDDNNNN).',
    message_en: 'The personnummer is not valid. Give twelve digits (YYYYMMDDNNNN).',
  },
  BOLAGET_PERSONNUMMER_TAKEN: {
    httpStatus: 409,
    message_sv: 'Personnumret finns redan på en annan person i bolagets register.',
    message_en: 'The personnummer is already on another person in the company\'s registers.',
  },
  BOLAGET_DATES_INVALID: {
    httpStatus: 400,
    message_sv: 'Kontrollera datumen: slutdatum kan inte vara före startdatum och en anteckning kan inte dateras framåt i tiden.',
    message_en: 'Check the dates: an end cannot precede the start, and an entry cannot be dated in the future.',
    thrown_message_sv: true,
  },
  SHARE_REGISTER_RANGE_TAKEN: {
    httpStatus: 409,
    message_sv: 'Aktienumren finns redan i aktieboken. Nya aktier får nästa lediga nummer. Har en införd anteckning fel nummer rättas den först.',
    message_en: 'The share numbers are already held. New shares take the next free numbers. When an entry holds the numbers by mistake, that entry is voided first.',
    remediation: {
      description: 'For new shares, omit the range and send share_count. When an entry holds these numbers by mistake, void it with kind rattelse, and send this entry again once the rattelse is in the register.',
      tool: 'gnubok_register_share_event',
    },
    thrown_message_sv: true,
  },
  SHARE_REGISTER_NOT_HELD: {
    httpStatus: 409,
    message_sv: 'Aktierna ägs inte av den angivna ägaren det datumet.',
    message_en: 'The shares are not held by the named holder on that date.',
    thrown_message_sv: true,
  },
  SHARE_REGISTER_RANGE_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Ange aktienummer (från och till) eller ett antal aktier som ägaren har i en följd.',
    message_en: 'Give the share numbers (from and to) or a number of shares the holder has in one block.',
  },
  SHARE_REGISTER_RATIO_MISALIGNED: {
    httpStatus: 409,
    message_sv: 'Sammanläggningen går inte jämnt ut för alla innehav. Varje innehav måste vara delbart med kvoten.',
    message_en: 'The consolidation does not divide every holding evenly.',
    thrown_message_sv: true,
  },
  SHARE_REGISTER_NOTE_INVALID: {
    httpStatus: 409,
    message_sv: 'Anteckningen stämmer inte med aktieboken.',
    message_en: 'The note does not match the share register.',
    thrown_message_sv: true,
  },
  SHARE_REGISTER_CORRECTION_INVALID: {
    httpStatus: 409,
    message_sv: 'En rättelse gäller en tidigare anteckning som inte redan är rättad och inte själv är en rättelse.',
    message_en: 'A correction voids one earlier entry that is not already corrected and is not itself a correction.',
    thrown_message_sv: true,
  },
  SHARE_REGISTER_APPEND_ONLY: {
    httpStatus: 409,
    message_sv: 'Aktieboken kan inte ändras i efterhand. Rätta med en ny anteckning.',
    message_en: 'The share register cannot be changed afterwards. Correct it with a new entry.',
  },
  SHARE_REGISTER_STALE: {
    httpStatus: 409,
    message_sv: 'Aktieboken har fått en ny anteckning sedan du förhandsgranskade. Förhandsgranska igen, så visas läget som det är nu.',
    message_en: 'The share register has a new entry since your preview. Preview again to see it as it stands now.',
  },
  SHARE_REGISTER_SETUP_COMPLETE: {
    httpStatus: 409,
    message_sv: 'Aktieboken är redan upplagd och i bruk. Ett ingående innehav förs bara in medan aktieboken läggs upp: för in en överlåtelse eller en emission i stället.',
    message_en: 'The share register is already set up and in use. An opening holding is entered only while the register is set up: enter a transfer or an issue instead.',
    thrown_message_sv: true,
  },
  SHARE_REGISTER_HOLDER_ADMIN_ONLY: {
    httpStatus: 403,
    message_sv: 'Bara företagets ägare eller en administratör kan ändra namn eller organisationsnummer på någon som står i aktieboken.',
    message_en: 'Only the company\'s owner or an administrator can change the name or the organisation number of somebody the share register names.',
  },
  SHARE_REGISTER_EMPTY: {
    httpStatus: 409,
    message_sv: 'Aktieboken har inga aktier än. För in aktierna först.',
    message_en: 'The share register holds no shares yet. Enter the shares first.',
  },
  SHARE_REGISTER_AVSTAMNINGSBOLAG: {
    httpStatus: 409,
    message_sv: 'Bolaget är ett avstämningsbolag: aktieboken förs av den centrala värdepappersförvararen.',
    message_en: 'The company is an avstämningsbolag: the central securities depository keeps the share register.',
  },
  SHARE_CLASS_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Aktieslaget finns inte.',
    message_en: 'The share class does not exist.',
  },
  SHARE_CLASS_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Ange vilket aktieslag det gäller: bolaget har flera.',
    message_en: 'Name the share class: the company has several.',
  },
  SHARE_CLASS_DUPLICATE: {
    httpStatus: 409,
    message_sv: 'Det finns redan ett aktieslag med den beteckningen.',
    message_en: 'A share class with that code already exists.',
  },
  COMPANY_ROLE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Rollen finns inte.',
    message_en: 'The role does not exist.',
  },
  COMPANY_ROLE_DUPLICATE: {
    httpStatus: 409,
    message_sv: 'Personen har redan den rollen.',
    message_en: 'The person already holds that role.',
  },
  COMPANY_ROLE_ALREADY_ENDED: {
    httpStatus: 409,
    message_sv: 'Rollen är redan avslutad.',
    message_en: 'The role has already ended.',
  },
  COMPANY_ROLE_APPEND_ONLY: {
    httpStatus: 409,
    message_sv: 'En roll avslutas, den ändras eller tas inte bort.',
    message_en: 'A role is ended, never changed or deleted.',
  },
  BENEFICIAL_OWNER_INVALID: {
    httpStatus: 400,
    message_sv: 'Ange minst en verklig huvudman, eller ingen när slutsatsen är att det saknas verklig huvudman.',
    message_en: 'Name at least one beneficial owner, or none when the conclusion is that there is none.',
    thrown_message_sv: true,
  },
  BENEFICIAL_OWNER_APPEND_ONLY: {
    httpStatus: 409,
    message_sv: 'En utredning av verkliga huvudmän sparas som den gjordes. Gör en ny utredning.',
    message_en: 'A beneficial owner assessment is kept as made. Record a new one.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Commitments and holdings (lib/commitments, Bolaget rollout)
// ─────────────────────────────────────────────────────────────────

const COMMITMENTS: Record<string, StructuredErrorEntry> = {
  COMMITMENTS_UNAVAILABLE: {
    httpStatus: 404,
    message_sv: 'Avtal och åtaganden finns inte här ännu.',
    message_en: 'Agreements and commitments are not available here yet.',
  },
  COMMITMENTS_REFERENCE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Det som anges (motpart, dokument eller avtal) finns inte i företaget.',
    message_en: 'The referenced party, document or agreement does not exist in this company.',
  },
  AGREEMENT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Avtalet hittades inte.',
    message_en: 'The agreement was not found.',
  },
  AGREEMENT_DERIVED: {
    httpStatus: 409,
    message_sv: 'Avtalet är läst ur ett dokument i arkivet och ändras där, inte här.',
    message_en: 'The agreement was read from an archived document and is changed there, not here.',
  },
  SECURITY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Säkerheten eller eventualförpliktelsen hittades inte.',
    message_en: 'The security or contingent liability was not found.',
  },
  GROUP_LINK_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Koncernkopplingen hittades inte.',
    message_en: 'The group link was not found.',
  },
  GROUP_LINKS_NOT_FOR_LEGAL_FORM: {
    httpStatus: 409,
    message_sv: 'Koncernstruktur registreras bara för företag som upprättar årsredovisning.',
    message_en: 'A group structure is registered only for companies that prepare an annual report.',
  },
  GROUP_LINK_COMPANY_NOT_IN_TEAM: {
    httpStatus: 409,
    message_sv: 'Det kopplade företaget måste vara ett annat företag i samma team.',
    message_en: 'The linked company must be another company in the same team.',
  },
  ASSET_IDENTIFICATION_INVALID: {
    httpStatus: 400,
    message_sv: 'Fastighetsbeteckning och taxeringsvärde hör till byggnader, registreringsnummer och bilförmån till fordon.',
    message_en: 'Property designation and tax value belong to buildings, registration number and car benefit to vehicles.',
  },
}

// ─────────────────────────────────────────────────────────────────
// BankID document signing (lib/signing)
// ─────────────────────────────────────────────────────────────────

const SIGNING: Record<string, StructuredErrorEntry> = {
  SIGNING_UNAVAILABLE: {
    httpStatus: 403,
    message_sv: 'Signering med BankID är inte tillgänglig här.',
    message_en: 'Signing with BankID is not available here.',
  },
  SIGNING_CAPABILITY_BLOCKED: {
    httpStatus: 403,
    message_sv: 'Signering med BankID ingår i betalplanen. Uppgradera för att skicka dokument för signering.',
    message_en: 'Signing with BankID is part of the paid plan. Upgrade to send documents for signing.',
  },
  SIGNING_DOCUMENT_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Dokumentet finns inte i arkivet.',
    message_en: 'The document is not in the archive.',
  },
  SIGNING_DOCUMENT_UNSUPPORTED: {
    httpStatus: 422,
    message_sv: 'Dokumentet kan inte signeras: det måste vara den senaste versionen av en PDF på högst 10 MB, utan lösenordsskydd.',
    message_en: 'The document cannot be signed: it must be the latest version of a PDF of at most 10 MB, without password protection.',
  },
  SIGNING_DOCUMENT_CHANGED: {
    httpStatus: 409,
    message_sv: 'Den lagrade filen stämmer inte med dokumentets kontrollsumma, så den kan inte signeras.',
    message_en: 'The stored file does not match the document\'s checksum, so it cannot be signed.',
  },
  SIGNING_DOCUMENT_IN_USE: {
    httpStatus: 409,
    message_sv: 'Dokumentet ingår i en signering. Avbryt signeringen först; ett signerat dokument sparas och kan inte tas bort.',
    message_en: 'The document is part of a signing. Cancel the signing first; a signed document is kept and cannot be deleted.',
  },
  SIGNING_SIGNERS_INVALID: {
    httpStatus: 400,
    message_sv: 'Kontrollera undertecknarna: högst 5 på ett dokument, varje person ska ha ett namn, ingen får finnas med två gånger, och ett personnummer måste vara giltigt.',
    message_en: 'Check the signers: at most 5 on a document, each needs a name, nobody may appear twice, and a personnummer must be valid.',
  },
  SIGNING_REQUEST_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Signeringen finns inte.',
    message_en: 'The signing request does not exist.',
  },
  SIGNING_REQUEST_CLOSED: {
    httpStatus: 409,
    message_sv: 'Signeringen är inte längre öppen: den är klar, avböjd, avbruten eller har gått ut.',
    message_en: 'The signing request is no longer open: it is completed, declined, cancelled or expired.',
  },
  SIGNING_SIGNER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Undertecknaren finns inte i signeringen.',
    message_en: 'The signer is not part of the signing request.',
  },
  SIGNING_SIGNER_NOT_PENDING: {
    httpStatus: 409,
    message_sv: 'Undertecknaren har redan signerat eller avböjt.',
    message_en: 'The signer has already signed or declined.',
  },
  SIGNING_NOT_SIGNER: {
    httpStatus: 403,
    message_sv: 'Den här signeringen väntar på någon annan.',
    message_en: 'This signature is waiting for someone else.',
  },
  SIGNING_SIGNER_MISMATCH: {
    httpStatus: 403,
    message_sv: 'Signaturen gjordes med ett annat BankID än det som signeringen gäller, så den sparades inte.',
    message_en: 'The signature was made with a different BankID than the one the signing is for, so it was not saved.',
  },
  SIGNING_SESSION_MISMATCH: {
    httpStatus: 409,
    message_sv: 'BankID-signeringen startades om, så den här kan inte längre sparas. Signera i den senaste.',
    message_en: 'The BankID signing was restarted. Sign in the latest one.',
  },
  SIGNING_SESSION_CONSUMED: {
    httpStatus: 409,
    message_sv: 'Den här BankID-signeringen är redan använd.',
    message_en: 'This BankID signing has already been used.',
  },
  SIGNING_SESSION_ACTIVE: {
    httpStatus: 409,
    message_sv: 'Undertecknaren håller på att signera just nu. Försök igen om en stund.',
    message_en: 'The signer is signing right now. Try again in a moment.',
  },
  SIGNING_SUBJECT_CHANGED: {
    httpStatus: 409,
    message_sv: 'Det som signeras har ändrats sedan signeringen skickades, så inget sparades.',
    message_en: 'What is being signed changed after the signing was sent, so nothing was saved.',
  },
  SIGNING_EVIDENCE_INCOMPLETE: {
    httpStatus: 502,
    message_sv: 'BankID svarade utan en fullständig signatur. Signera igen.',
    message_en: 'BankID answered without a complete signature. Sign again.',
  },
  SIGNING_SIGNATURE_UNBOUND: {
    httpStatus: 502,
    message_sv: 'BankID-signaturen gällde inte det här dokumentet, så den sparades inte. Signera igen.',
    message_en: 'The BankID signature was not for this document, so it was not saved. Sign again.',
  },
  SIGNING_PROVIDER_ERROR: {
    httpStatus: 502,
    message_sv: 'BankID-tjänsten svarade inte som väntat. Försök igen om en stund.',
    message_en: 'The BankID service did not answer as expected. Try again in a moment.',
    retryable: true,
  },
  SIGNING_RATE_LIMITED: {
    httpStatus: 429,
    message_sv: 'För många BankID-försök på kort tid. Vänta en stund och försök igen.',
    message_en: 'Too many BankID attempts in a short time. Wait a moment and try again.',
    retryable: true,
  },
  SIGNING_REMIND_TOO_SOON: {
    httpStatus: 429,
    message_sv: 'Undertecknaren fick ett mejl om signeringen nyligen. En påminnelse kan skickas en gång per dygn.',
    message_en: 'The signer got a mail about the signing recently. A reminder can be sent once a day.',
  },
  SIGNING_REMIND_NO_EMAIL: {
    httpStatus: 409,
    message_sv: 'Undertecknaren har ingen e-postadress, så någon påminnelse kan inte skickas.',
    message_en: 'The signer has no email address, so no reminder can be sent.',
  },
  SIGNING_REQUEST_ALREADY_OPEN: {
    httpStatus: 409,
    message_sv: 'Årsredovisningen väntar redan på underskrifter i en annan signering. Avbryt den först.',
    message_en: 'The annual report already waits for signatures in another signing request. Cancel that one first.',
  },
  SIGNING_NAME_MISMATCH: {
    httpStatus: 409,
    message_sv: 'Namnet i ditt BankID stämmer inte med namnet i årsredovisningen, så underskriften sparades inte. Den som skickade signeringen behöver rätta namnet och låsa en ny version.',
    message_en: 'The name in your BankID does not match the name in the annual report, so the signature was not saved. The sender needs to correct the name and lock a new version.',
  },
  ARSREDOVISNING_PATECKNING_BEFORE_BOARD: {
    httpStatus: 409,
    message_sv:
      'Revisorns påteckning registreras när hela styrelsen har skrivit under den här versionen: påteckningen hänvisar till revisionsberättelsen om den undertecknade årsredovisningen.',
    message_en:
      "The auditor's endorsement is recorded once the whole board has signed this version: it refers to the audit report on the signed annual report.",
  },
  ARSREDOVISNING_PATECKNING_MEDIUM_MIXED: {
    httpStatus: 409,
    message_sv:
      'Revisorns påteckning görs på samma sätt som styrelsens underskrifter: elektroniskt (avancerad e-signatur) om styrelsen skrev under elektroniskt, på papper om styrelsen skrev under på papper. En årsredovisning är antingen på papper eller elektronisk (ÅRL 2 kap. 5 och 7 §§).',
    message_en:
      "The auditor's endorsement is made the same way as the board's signatures: electronically (advanced e-signature) when the board signed electronically, on paper when it signed on paper. An annual report is either on paper or electronic (ÅRL 2:5 and 2:7).",
  },
  ARSREDOVISNING_PATECKNING_OPINION_MISSING: {
    httpStatus: 409,
    message_sv:
      'Ange vad revisionsberättelsen säger (revisorns uttalande) innan revisorns påteckning registreras: uttalandet låses med påteckningen.',
    message_en:
      "State what the audit report says (the auditor's opinion) before the auditor's endorsement is recorded: the opinion is locked with the endorsement.",
  },
  ARSREDOVISNING_SIGNING_TRACK_MIXED: {
    httpStatus: 409,
    message_sv: 'Årsredovisningen skrivs antingen under med BankID i Accounted eller på annat sätt, inte båda. Den här versionen har redan underskrifter på det andra sättet.',
    message_en: 'The annual report is signed either with BankID in Accounted or another way, not both. This version already has signatures the other way.',
  },
  SIGNING_METHOD_RESERVED: {
    httpStatus: 422,
    message_sv: 'Metoden BankID kan inte registreras för hand: den sätts bara när styrelsen skriver under med BankID i Accounted. En BankID-underskrift i en annan tjänst registreras som avancerad e-signatur.',
    message_en: 'The BankID method cannot be recorded by hand: it is set only when the board signs with BankID in Accounted. A BankID signature made in another service is recorded as an advanced e-signature.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Pending operations: the v1 REST approval door and the stage mode
// ─────────────────────────────────────────────────────────────────

const PENDING_OPERATIONS: Record<string, StructuredErrorEntry> = {
  PENDING_OPERATION_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Åtgärden som väntar på godkännande hittades inte.',
    message_en: 'Pending operation not found in this company.',
    remediation: {
      description: "List the company's pending operations with GET /pending-operations and use a pending_operation_id from it.",
    },
  },
  // Approving or rejecting an operation that is no longer pending. The
  // atomic claim in commitPendingOperation is what makes a second approval
  // land here instead of committing again.
  PENDING_OPERATION_NOT_PENDING: {
    httpStatus: 409,
    message_sv: 'Åtgärden är redan hanterad och kan inte godkännas eller avvisas igen.',
    message_en: 'The pending operation is already resolved or being committed: it cannot be approved or rejected again. Nothing was done.',
    remediation: {
      description:
        'Read details.pending_operation. task_state completed: it was committed and result holds the outcome. failed or cancelled: it was not committed. working with status committing: another approval is running it, so poll GET /pending-operations/{id}. Do not stage it again to retry.',
    },
  },
  // A cron or system actor reached the approval dispatcher: only a person,
  // or a key a person holds, approves.
  PENDING_OPERATION_SYSTEM_APPROVAL_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'En schemalagd körning eller systemet kan inte godkänna ett förslag. Det väntar kvar på en person.',
    message_en: 'A scheduled run or the system cannot approve a pending operation. It stays pending for a person.',
    retryable: false,
    remediation: {
      description:
        'Nothing was committed and the operation stays pending. Do not retry from a scheduled job; a person approves it in Accounted, under Att godkänna.',
    },
  },
  PENDING_OPERATION_CONFIRMATION_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Åtgärden går inte att ångra (BFL 5 kap. 5 §): bekräfta godkännandet uttryckligen.',
    message_en:
      'The operation is risk_level high and cannot be undone (BFL 5 kap. 5 §): approve it with confirmed=true once a person has acknowledged that.',
    remediation: {
      description:
        'Show the preview and its irreversibility to the person approving, then repeat the approve with the body {"confirmed": true} and a new Idempotency-Key.',
    },
  },
  // The approval was accepted and the commit ran, but refused or failed
  // without a more specific registered code.
  PENDING_OPERATION_COMMIT_FAILED: {
    httpStatus: 422,
    message_sv: 'Åtgärden godkändes men kunde inte genomföras.',
    message_en: 'The approval was accepted but the commit refused or failed.',
    remediation: {
      description:
        'details.reason says why and details.pending_operation where it landed: status pending means nothing was consumed and it can be approved again once the cause is fixed; rejected or failed_partial means it is resolved (failed_partial posted result.posted_ids first: correct that with a storno).',
    },
  },
  STAGE_NOT_SUPPORTED: {
    httpStatus: 400,
    message_sv: 'Den här åtgärden kan inte läggas fram för godkännande.',
    message_en:
      'This endpoint does not stage: stage=true is accepted only on the writes that stage for approval (x-stage-supported in the OpenAPI spec).',
    remediation: {
      description:
        'Send the request without stage=true to commit it directly, or stage through an endpoint that lists the stage query parameter.',
    },
  },
  // A direct v1 commit of a write only a person may approve in the app
  // (lib/operations/v1.ts needsPersonApproval): it is staged instead.
  STAGE_REQUIRED: {
    httpStatus: 400,
    message_sv: 'Den här åtgärden måste godkännas av en person i Accounted. Lägg fram den för godkännande i stället.',
    message_en:
      'This write is approved only by a person in Accounted: send it with stage=true to stage it for that approval. Nothing was done.',
    remediation: {
      description:
        'Send the same request with ?stage=true. It answers 202 with the pending operation; a person approves it in Accounted (Att göra), never a key or an agent.',
    },
  },
  // A commit sent with a preview token whose dry run, recomputed at commit
  // time, no longer fingerprints the same (lib/operations/preview-token.ts).
  // Nothing was written; details carry the fresh preview and its token.
  PREVIEW_STALE: {
    httpStatus: 409,
    message_sv: 'Förhandsgranskningen stämmer inte längre: något har ändrats sedan den togs fram. Inget sparades.',
    message_en:
      'The preview no longer holds: something changed after it was computed (a period lock, an account, a rate, another write). Nothing was written.',
    remediation: {
      description:
        'Show the person details.preview, what the write would do now. If they confirm it, send the same request again with details.preview_token in place of the old token.',
    },
  },
}

// ─────────────────────────────────────────────────────────────────
// Autogiro (src/lib/invoices/autogiro)
// ─────────────────────────────────────────────────────────────────

const AUTOGIRO: Record<string, StructuredErrorEntry> = {
  AUTOGIRO_NOT_ENABLED: {
    httpStatus: 403,
    message_sv: 'Autogiro är inte påslaget för det här bolaget ännu. Hör av dig till oss så öppnar vi det.',
    message_en: 'Autogiro is not enabled for this company yet.',
  },
  AUTOGIRO_SETTINGS_MISSING: {
    httpStatus: 400,
    message_sv: 'Fyll i Kundnummer och bankgiro för autogiroavtalet först (Fakturor > Autogiro).',
    message_en: 'Enter the Autogiro agreement (Bankgirot customer number and bankgiro) first.',
  },
  AUTOGIRO_SETTINGS_INVALID: {
    httpStatus: 400,
    message_sv: 'Kundnumret ska vara högst 6 siffror och bankgironumret ett giltigt bankgiro (7 eller 8 siffror).',
    message_en: 'The customer number must be at most 6 digits and the bankgiro a valid bankgiro number (7 or 8 digits).',
  },
  AUTOGIRO_PAYER_NUMBER_INVALID: {
    httpStatus: 400,
    message_sv: 'Betalarnumret ska vara 1-16 siffror.',
    message_en: 'The payer number must be 1-16 digits.',
  },
  AUTOGIRO_PAYER_NUMBER_TAKEN: {
    httpStatus: 409,
    message_sv: 'Betalarnumret har redan ett aktivt medgivande hos en annan kund.',
    message_en: 'The payer number already has an active mandate for another customer.',
  },
  AUTOGIRO_CUSTOMER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kunden finns inte i bolaget.',
    message_en: 'The customer was not found in this company.',
  },
  AUTOGIRO_CUSTOMER_HAS_MANDATE: {
    httpStatus: 409,
    message_sv: 'Kunden har redan ett aktivt autogiromedgivande. Makulera det först.',
    message_en: 'The customer already has an active Autogiro mandate. Cancel it first.',
  },
  AUTOGIRO_MANDATE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Medgivandet finns inte.',
    message_en: 'The mandate was not found.',
  },
  AUTOGIRO_MANDATE_NOT_ACTIVE: {
    httpStatus: 409,
    message_sv: 'Medgivandet är redan makulerat eller avvisat.',
    message_en: 'The mandate is already cancelled or rejected.',
  },
  AUTOGIRO_NOTHING_TO_DEBIT: {
    httpStatus: 400,
    message_sv: 'Ingen av fakturorna kan dras nu. Se orsaken på varje rad.',
    message_en: 'None of the invoices can be debited now. See the reason on each row.',
  },
  AUTOGIRO_DEBIT_ALREADY_LIVE: {
    httpStatus: 409,
    message_sv: 'En av fakturorna ligger redan i en betalningsfil. Ladda om sidan.',
    message_en: 'One of the invoices is already in a payment file. Reload the page.',
  },
  AUTOGIRO_FILE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Filen finns inte.',
    message_en: 'The file was not found.',
  },
  AUTOGIRO_FILE_NOT_STORED: {
    httpStatus: 409,
    message_sv: 'Filen innehåller personuppgifter och sparas inte. Den gick bara att ladda ner när den skapades.',
    message_en: 'The file holds personal data and is not stored; it could only be downloaded when it was made.',
  },
  AUTOGIRO_FILE_ALREADY_REPORTED: {
    httpStatus: 409,
    message_sv: 'Bankgirot har redan rapporterat betalningar i filen, så den kan inte återkallas här. Makulera i Autogiro Online.',
    message_en: 'Bankgirot has already reported on payments in this file, so it cannot be withdrawn here.',
  },
  AUTOGIRO_REPORT_UNKNOWN: {
    httpStatus: 400,
    message_sv: 'Filen är ingen autogirorapport som Accounted läser (betalningsspecifikation, avvisade betalningar, medgivandeavisering, medgivanden via internetbanken eller utdrag ur medgivanderegistret).',
    message_en: 'The file is not an Autogiro report Accounted reads.',
  },
  AUTOGIRO_REPORT_OLD_LAYOUT: {
    httpStatus: 400,
    message_sv: 'Filen är i Bankgirots gamla layout. Be banken att byta autogiroavtalet till ny layout, så läses rapporterna här.',
    message_en: 'The file uses Bankgirot\'s old layout. Ask the bank to switch the Autogiro agreement to the new layout.',
  },
  AUTOGIRO_REPORT_WRONG_BANKGIRO: {
    httpStatus: 400,
    message_sv: 'Filen gäller ett annat bankgiro än bolagets autogiroavtal.',
    message_en: 'The file is for another bankgiro than the company\'s Autogiro agreement.',
  },
  AUTOGIRO_REPORT_HAS_ERRORS: {
    httpStatus: 400,
    message_sv: 'Filen har fel och läses inte in. Ladda ner den på nytt från banken.',
    message_en: 'The file has errors and is not read. Download it again from the bank.',
  },
  AUTOGIRO_REPORT_ALREADY_IMPORTED: {
    httpStatus: 409,
    message_sv: 'Den här rapporten är redan inläst.',
    message_en: 'This report has already been read.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Underskottsregistret (IL 40 kap., lib/bokslut/loss-carryforward)
// ─────────────────────────────────────────────────────────────────

const LOSS_CARRYFORWARD: Record<string, StructuredErrorEntry> = {
  LOSS_CARRYFORWARD_UNAVAILABLE: {
    httpStatus: 403,
    message_sv: 'Underskottsregistret är inte tillgängligt här.',
    message_en: 'The loss carry-forward register is not available here.',
  },
  LOSS_CARRYFORWARD_FORM_UNSUPPORTED: {
    httpStatus: 400,
    message_sv: 'Underskottsregistret gäller företag som lämnar inkomstdeklaration 2.',
    message_en: 'The loss carry-forward register is for companies that file income tax return 2 (INK2).',
  },
  LOSS_CARRYFORWARD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Året finns inte i underskottsregistret.',
    message_en: 'The year is not in the loss carry-forward register.',
  },
  LOSS_CARRYFORWARD_LINK_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Dokumentet eller skattebeskedet hittades inte hos företaget.',
    message_en: 'The document or tax assessment notice was not found for the company.',
  },
  LOSS_CARRYFORWARD_CHANGE_OUTSIDE_YEAR: {
    httpStatus: 422,
    message_sv: 'Ägarförändringen ska ligga inom räkenskapsåret.',
    message_en: 'The ownership change must fall inside the fiscal year.',
  },
  LOSS_CARRYFORWARD_BLOCK_END_BEFORE_CHANGE: {
    httpStatus: 422,
    message_sv: 'Koncernbidragsspärrens sista år kan inte ligga före året för ägarförändringen.',
    message_en: 'The last year of the group contribution block cannot be before the year of the ownership change.',
  },
  LOSS_CARRYFORWARD_REDUCTIONS_EXCEED: {
    httpStatus: 422,
    message_sv: 'Punkt 4.14 b och 4.14 c kan tillsammans inte vara större än underskottet från föregående år (4.14 a).',
    message_en: 'Fields 4.14 b and 4.14 c together cannot exceed the deficit brought forward (4.14 a).',
  },
}

// ─────────────────────────────────────────────────────────────────
// Liquidity forecast and its rows (lib/forecast, accounted#136)
// ─────────────────────────────────────────────────────────────────

const CASH_FORECAST: Record<string, StructuredErrorEntry> = {
  CASH_FORECAST_FAILED: {
    httpStatus: 500,
    message_sv: 'Likviditetsprognosen kunde inte tas fram. Försök igen.',
    message_en: 'The liquidity forecast could not be built. Try again.',
    retryable: true,
  },
  CASH_FORECAST_ROWS_READ_FAILED: {
    httpStatus: 500,
    message_sv: 'Prognosraderna kunde inte läsas. Försök igen.',
    message_en: 'The forecast rows could not be read. Try again.',
    retryable: true,
  },
  CASH_FORECAST_ROWS_WRITE_FAILED: {
    httpStatus: 500,
    message_sv: 'Prognosraderna kunde inte sparas. Försök igen.',
    message_en: 'The forecast rows could not be saved. Try again.',
    retryable: true,
  },
  CASH_FORECAST_ROWS_CONFLICT: {
    httpStatus: 409,
    message_sv: 'En annan skrivning lade till samma prognosrad samtidigt. Skicka samma rader igen.',
    message_en: 'Another write added the same forecast row at the same time. Send the same rows again.',
    retryable: true,
  },
  CASH_FORECAST_ROW_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Prognosraden hittades inte.',
    message_en: 'The forecast row was not found.',
    remediation: { description: 'List the rows with GET /cash-forecast-rows (gnubok_list_cash_forecast_rows).', tool: 'gnubok_list_cash_forecast_rows' },
  },
  CASH_FORECAST_ROW_NOT_OPEN: {
    httpStatus: 409,
    message_sv: 'Prognosraden är inte öppen längre: den är redan realiserad eller ersatt.',
    message_en: 'The forecast row is no longer open: it is already realised or superseded.',
  },
  CASH_FORECAST_ROW_REFERENCE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'En faktura, leverantörsfaktura eller dimension som raden pekar på finns inte i företaget.',
    message_en: 'An invoice, supplier invoice or dimension value the row points at does not exist in the company.',
  },
}

// ─────────────────────────────────────────────────────────────────
// The support assistant (lib/agent/support, POST /api/support/ask)
// ─────────────────────────────────────────────────────────────────

const SUPPORT_ASSISTANT: Record<string, StructuredErrorEntry> = {
  // Each sentence ends in the way on: the support dialog keeps its form to a
  // person whatever the assistant answers, and shows these verbatim.
  // The company is not in SUPPORT_ASSISTANT_COMPANY_IDS. 409 like the other
  // switched-off answers.
  SUPPORT_ASSISTANT_OFF: {
    httpStatus: 409,
    message_sv: 'AI-assistenten i supporten är inte påslagen för det här företaget. Skriv till supporten i stället.',
    message_en: 'The AI assistant in support is not switched on for this company. Write to support instead.',
    retryable: false,
  },
  // No AI backend on the installation at all.
  SUPPORT_ASSISTANT_UNCONFIGURED: {
    httpStatus: 503,
    message_sv: 'AI-assistenten är inte konfigurerad på den här installationen. Skriv till supporten i stället.',
    message_en: 'The AI assistant is not configured on this installation. Write to support instead.',
    retryable: false,
  },
  // The company switched AI off under Datadelning och AI: the AI layer
  // refuses the call, and the route says why.
  SUPPORT_ASSISTANT_AI_SWITCHED_OFF: {
    httpStatus: 409,
    message_sv: 'AI är avstängt för det här företaget under Inställningar > Datadelning och AI. Skriv till supporten i stället.',
    message_en: 'AI is switched off for this company under Settings > Data sharing and AI. Write to support instead.',
    retryable: false,
  },
  // The per-user question limit (lib/agent/support/rate-limit.ts). The
  // sentence for the day limit is passed by the route.
  SUPPORT_ASSISTANT_RATE_LIMITED: {
    httpStatus: 429,
    message_sv: 'För många frågor till AI-assistenten just nu. Vänta en stund och försök igen, eller skriv till supporten.',
    message_en: 'Too many questions to the AI assistant right now. Wait a moment and try again, or write to support.',
    retryable: true,
  },
  // The conversation id is not one of this user's support conversations in
  // this company. 404 for a missing one and for someone else's alike.
  SUPPORT_ASSISTANT_CONVERSATION_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Konversationen hittades inte. Ställ frågan igen.',
    message_en: 'Conversation not found. Ask the question again.',
    retryable: false,
  },
}

// ─────────────────────────────────────────────────────────────────
// The question list (company_questions, lib/questions)
// ─────────────────────────────────────────────────────────────────

const COMPANY_QUESTIONS: Record<string, StructuredErrorEntry> = {
  // The company is not in COMPANY_QUESTIONS_COMPANY_IDS. 409 like the other
  // switched-off answers.
  COMPANY_QUESTIONS_OFF: {
    httpStatus: 409,
    message_sv: 'Frågelistan är inte påslagen för det här företaget.',
    message_en: 'The question list is not switched on for this company.',
    retryable: false,
  },
  // Either limit: the open questions a company holds at once, or the
  // questions filed for it in 24 hours. The thrown text says which.
  COMPANY_QUESTION_LIMIT_REACHED: {
    httpStatus: 409,
    message_sv: 'Gränsen för frågor till företaget är nådd: högst 5 öppna samtidigt och högst 3 nya per dygn.',
    message_en: 'The limit for questions to the company is reached: at most 5 open at once and at most 3 new in 24 hours.',
    retryable: false,
  },
  // A question resting on the same records exists, whatever its status. The
  // thrown text names it.
  COMPANY_QUESTION_ALREADY_ASKED: {
    httpStatus: 409,
    message_sv: 'Den här frågan är redan ställd till företaget.',
    message_en: 'This question has already been put to the company.',
    retryable: false,
  },
  COMPANY_QUESTION_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Frågan hittades inte.',
    message_en: 'The question was not found.',
    retryable: false,
  },
  COMPANY_QUESTION_ALREADY_ENDED: {
    httpStatus: 409,
    message_sv: 'Frågan är redan besvarad eller stängd.',
    message_en: 'The question is already answered or closed.',
    retryable: false,
  },
  // Undo in the app: the question is open, somebody else ended it, it was
  // ended through another door, or more than ten minutes ago. The thrown text
  // says which.
  COMPANY_QUESTION_UNDO_REFUSED: {
    httpStatus: 409,
    message_sv: 'Svaret kan inte ångras längre.',
    message_en: 'The answer can no longer be undone.',
    retryable: false,
  },
  // Linking a staged operation to a question that is open, or closed with a
  // reason other than settled. The thrown text says how the question stands.
  COMPANY_QUESTION_NOT_ANSWERED: {
    httpStatus: 409,
    message_sv: 'Frågan är varken besvarad eller löst av bokföringen, så inget förslag kan kopplas till den.',
    message_en: 'The question is neither answered nor closed as settled, so no operation can be linked to it.',
    retryable: false,
  },
  // The question already holds the most staged operations one question takes.
  COMPANY_QUESTION_OPERATION_LIMIT: {
    httpStatus: 409,
    message_sv: 'Frågan har redan fem kopplade förslag, vilket är gränsen.',
    message_en: 'The question already has five linked operations, which is the limit.',
    retryable: false,
  },
}

// ─────────────────────────────────────────────────────────────────
// Company formation, "Starta aktiebolag" (company_formations, lib/formation)
// ─────────────────────────────────────────────────────────────────

const COMPANY_FORMATION: Record<string, StructuredErrorEntry> = {
  FORMATION_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Bolagsbildningen hittades inte.',
    message_en: 'The company formation was not found.',
    retryable: false,
  },
  // The company is already set up from the formation, or it was cancelled.
  FORMATION_LOCKED: {
    httpStatus: 409,
    message_sv: 'Bolaget är redan uppsatt, så svaren kan inte längre ändras här.',
    message_en: 'The company is already set up, so the answers can no longer change here.',
    retryable: false,
  },
  FORMATION_ALREADY_SET_UP: {
    httpStatus: 409,
    message_sv: 'Bolaget är redan uppsatt i Accounted.',
    message_en: 'The company is already set up in Accounted.',
    retryable: false,
  },
  // The answers still break a rule verksamt.se applies; the thrown text names it.
  FORMATION_INCOMPLETE: {
    httpStatus: 422,
    message_sv: 'Några svar saknas eller behöver ändras innan dokumenten kan skapas.',
    message_en: 'Some answers are missing or need a change before the documents can be made.',
    retryable: false,
  },
  FORMATION_DOCUMENT_UNAVAILABLE: {
    httpStatus: 404,
    message_sv: 'Det dokumentet finns inte för det här bolaget.',
    message_en: 'That document does not exist for this company.',
    retryable: false,
  },
  // The organisation number is already a company in Accounted.
  FORMATION_ORG_NUMBER_TAKEN: {
    httpStatus: 409,
    message_sv: 'Organisationsnumret finns redan som företag i Accounted.',
    message_en: 'The organisation number is already a company in Accounted.',
    retryable: false,
  },
  // The organisation number is not an aktiebolag registered after the formation started.
  FORMATION_ORG_NUMBER_MISMATCH: {
    httpStatus: 422,
    message_sv: 'Organisationsnumret hör inte till ett nyregistrerat aktiebolag.',
    message_en: 'The organisation number does not belong to a newly registered aktiebolag.',
    retryable: false,
  },
  FORMATION_DEED_DATE_INVALID: {
    httpStatus: 400,
    message_sv: 'Ange dagen ni skrev under stiftelseurkunden. Den kan inte ligga i framtiden.',
    message_en: 'Give the day you signed the founding deed. It cannot be in the future.',
    retryable: false,
  },
  FORMATION_SETUP_FAILED: {
    httpStatus: 500,
    message_sv: 'Uppsättningen stannade på vägen. Försök igen, det som redan är gjort görs inte om.',
    message_en: 'The setup stopped part way. Try again; what is already done is not redone.',
    retryable: true,
  },
}

const REGISTRY: Record<string, StructuredErrorEntry> = {
  ...GENERIC,
  ...DB_CONFLICTS,
  ...BOOKKEEPING,
  ...TRANSACTIONS,
  ...MATCH_INVOICE,
  ...LINK_TX_JE,
  ...LINK_INVOICE_VOUCHER,
  ...INVOICE_REGISTER_BOOKED,
  ...SI_REGISTER_BOOKED,
  ...LINK_SI_VOUCHER,
  ...UNLINK_SI_VOUCHER,
  ...MATCH_BATCH,
  ...BULK_BOOK,
  ...MATCH_SI,
  ...INVOICE,
  ...SUPPLIER_INVOICE,
  ...PERIOD,
  ...YEAR_END,
  ...FX,
  ...REPORT,
  ...MEASURE,
  ...UNEXPLAINED,
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
  ...REGISTER_IMPORT_UNDO,
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
  ...ACCOUNT_SECURITY,
  ...SERVICE_ACCOUNT,
  ...AGENT_IDENTITY,
  ...ASSISTANT_CHAT,
  ...PACKAGE,
  ...GRANT,
  ...PROVIDER,
  ...SKATTEVERKET,
  ...BOLAGSVERKET,
  ...ASSETS,
  ...DIMENSION,
  ...BUDGET,
  ...COMPANY_SETTINGS,
  ...WEBSHOP_ORDERS,
  ...POS_SALES,
  ...RECONCILIATION_SIGNOFF,
  ...RECONCILIATION_LINK,
  ...NODE_SYSTEM,
  ...PAYMENT_ORDERS,
  ...COLLECTIONS,
  ...OPEN_BANKING,
  ...CUSTOMER_LOSS,
  ...SETOFF,
  ...PAYMENT_SIGNING_LINKS,
  ...SIGNING,
  ...COMMITMENTS,
  ...PENDING_OPERATIONS,
  ...AUTOGIRO,
  ...BOLAGET_MEETINGS,
  ...BOLAGET,
  ...BOLAGET_CAPITAL,
  ...BOLAGET_OWNER_TAX,
  ...LOSS_CARRYFORWARD,
  ...STOCK_COUNT,
  ...CASH_FORECAST,
  ...SUPPORT_ASSISTANT,
  ...COMPANY_QUESTIONS,
  ...COMPANY_FORMATION,
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
