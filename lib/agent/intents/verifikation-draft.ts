import { defineAgentIntent } from './types'
import { SONNET_MODEL, EFFORT_STANDARD } from '@/lib/agent/composer/client'
import { renderAgentGroundRules } from './shared-rules'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'

// verifikation.draft: "Fråga om denna verifikation" on the journal entry
// creation/draft surfaces (Bokföring → "Skapa med assistent", the Ny
// verifikat-dialog, and a draft verifikat's own page).
//
// Helps the user construct a balanced verifikation end to end: read the
// underlag (kvitto/faktura) the user often can't see themselves and pull the
// figures from it, pick the right BAS accounts, handle VAT splits, and detect
// when a transaction should instead be matched to an invoice or supplier
// invoice (rather than booked from scratch). Reads any in-progress draft state
// + linked underlag passed via intent_args.

interface VerifikationDraftArgs {
  // Optional id when the user is editing an existing draft. null for /new.
  journal_entry_id?: string | null
  // Optional starter description from the form, so the agent can suggest
  // counterparty templates without round-tripping.
  description?: string | null
}

interface CapturedVerifikationDraft {
  entry: {
    id: string
    entry_date: string | null
    description: string | null
    status: string | null
  } | null
  current_lines: {
    account_number: string | null
    debit_amount: number | null
    credit_amount: number | null
    description: string | null
  }[]
  // Lock state for the entry's date, resolved through the canonical
  // resolvePeriodStatusForDate (company-wide bookkeeping_locked_through +
  // the covering fiscal_period's is_closed/locked_at): the same two layers the
  // DB triggers enforce. `'unknown'` means the lookup failed and the agent must
  // fail closed rather than treat the period as open.
  period_status: {
    period_id: string | null
    status: 'open' | 'locked' | 'closed' | 'unknown' | null
    lock_date: string | null
  } | null
  description_hint: string | null
  // Underlag already linked to the entry (when editing a draft). Flattened
  // from document_attachments.extracted_data the same way
  // transaction.categorization does, so the agent can read the figures
  // without a round-trip. Empty for a brand-new verifikation: there the
  // agent discovers underlag via gnubok_list_inbox_items.
  underlag: {
    document_id: string | null
    file_name: string | null
    merchant_name: string | null
    receipt_date: string | null
    total_amount: number | null
    vat_amount: number | null
    currency: string | null
    raw_extraction: Record<string, unknown> | null
  }[]
}

export const verifikationDraft = defineAgentIntent<
  VerifikationDraftArgs,
  CapturedVerifikationDraft
>({
  id: 'verifikation.draft',
  buttonLabel: 'Fråga om denna verifikation',
  sheetTitle: 'Hjälp med verifikation',

  atoms: {
    mode: 'declarative',
    horizontal: ['swedish-accounting-compliance', 'swedish-vat'],
    includeCompanyVertical: true,
    includeCompanyModifiers: true,
  },

  tools: [
    'gnubok_get_trial_balance',
    'gnubok_query_journal',
    'gnubok_create_voucher',
    // Underlag reading: the ground rules (shared-rules.ts) already instruct
    // the agent to look in the inbox and read the underlag before proposing a
    // booking; these are the tools that make those instructions callable.
    'gnubok_get_document_content',
    'gnubok_list_inbox_items',
    'gnubok_list_unmatched_documents',
    'gnubok_get_inbox_item',
    'gnubok_load_skill',
    'gnubok_search_tools',
    'gnubok_remember_fact',
    'gnubok_forget_fact',
  ],

  model: SONNET_MODEL,

  // Work out the entry (accounts, VAT, balance) in the thinking channel, so the
  // visible reply lands once: after the voucher is staged: instead of an
  // analysis before the tool call and a near-identical answer after it. The
  // always-on prompt promises "resonemang sker i tankekanalen"; without this
  // that channel doesn't exist and the reasoning spills into the visible reply.
  thinking: { effort: EFFORT_STANDARD },

  capture: async ({ journal_entry_id, description }, { supabase, companyId }) => {
    let entry: CapturedVerifikationDraft['entry'] = null
    let lines: CapturedVerifikationDraft['current_lines'] = []
    let periodStatus: CapturedVerifikationDraft['period_status'] = null
    const underlag: CapturedVerifikationDraft['underlag'] = []

    if (journal_entry_id) {
      const { data: e } = await supabase
        .from('journal_entries')
        .select('id, entry_date, description, status')
        .eq('id', journal_entry_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (e) {
        entry = {
          id: (e as { id: string }).id,
          entry_date: ((e as { entry_date?: string | null }).entry_date) ?? null,
          description: ((e as { description?: string | null }).description) ?? null,
          status: ((e as { status?: string | null }).status) ?? null,
        }
        // The per-line free text lives in `line_description`; there is no
        // `description` column on journal_entry_lines. Asking for one made
        // PostgREST reject the whole select, so every entry looked like it had
        // zero rader and the agent reasoned about the verifikation from nothing.
        const { data: rows } = await supabase
          .from('journal_entry_lines')
          .select('account_number, debit_amount, credit_amount, line_description')
          .eq('journal_entry_id', journal_entry_id)
          .order('id', { ascending: true })
        lines = ((rows ?? []) as {
          account_number: string | null
          debit_amount: number | null
          credit_amount: number | null
          line_description: string | null
        }[]).map((r) => ({
          account_number: r.account_number ?? null,
          debit_amount: r.debit_amount ?? null,
          credit_amount: r.credit_amount ?? null,
          description: r.line_description ?? null,
        }))
        const entryDate = entry?.entry_date ?? null
        if (entryDate) {
          // fiscal_periods has no `status`/`locked_through` columns: lock state
          // is company_settings.bookkeeping_locked_through plus the period's
          // is_closed/locked_at. Go through resolvePeriodStatusForDate so this
          // surface reads the exact same source of truth as the DB triggers,
          // the MCP server and the v1 REST period gate.
          try {
            const resolved = await resolvePeriodStatusForDate(supabase, companyId, entryDate)
            // A soft lookup failure surfaces as { status: 'locked',
            // lookup_failed: true }: the right fail-closed verdict for a write
            // gate, but the wrong words for a human. Rendering it as a real
            // lock produces "lås upp perioden under Räkenskapsår" advice for a
            // lock that may not exist, so map it to the 'unknown' wording
            // instead (bokslut-step handles its equivalent the same way).
            periodStatus = resolved.lookup_failed
              ? { period_id: null, status: 'unknown', lock_date: null }
              : {
                  period_id: resolved.period_id,
                  status: resolved.status,
                  lock_date: resolved.lock_date,
                }
          } catch {
            // Fail closed: an unreadable period must never be presented as open.
            periodStatus = { period_id: null, status: 'unknown', lock_date: null }
          }
        }

        // Underlag already linked to this draft: surface the extracted fields
        // so the agent suggests accounts from what's on the kvitto without
        // re-asking. Mirrors transaction.categorization's document_attachments
        // read (same table, same extracted_data shape).
        const { data: docs } = await supabase
          .from('document_attachments')
          .select('id, file_name, extracted_data')
          .eq('journal_entry_id', journal_entry_id)
          .eq('company_id', companyId)
          .eq('is_current_version', true)
        for (const d of (docs ?? []) as {
          id: string
          file_name: string | null
          extracted_data: Record<string, unknown> | null
        }[]) {
          const ex = d.extracted_data ?? null
          const supplier = (ex?.supplier as { name?: string | null } | undefined) ?? null
          const invoice = (ex?.invoice as { invoiceDate?: string | null; currency?: string | null } | undefined) ?? null
          const totals = (ex?.totals as { total?: number | null; vatAmount?: number | null } | undefined) ?? null
          underlag.push({
            document_id: d.id,
            file_name: d.file_name,
            merchant_name: supplier?.name ?? null,
            receipt_date: invoice?.invoiceDate ?? null,
            total_amount: totals?.total ?? null,
            vat_amount: totals?.vatAmount ?? null,
            currency: invoice?.currency ?? null,
            raw_extraction: ex,
          })
        }
      }
    }

    return {
      entry,
      current_lines: lines,
      period_status: periodStatus,
      description_hint: description ?? null,
      underlag,
    }
  },

  promptTemplate: ({ captured, profileSummary }) => {
    const lines: string[] = []
    if (profileSummary) lines.push(`Företagets profil: ${profileSummary}`, '')

    lines.push('Användaren skapar eller redigerar en verifikation.')
    if (captured.entry) {
      lines.push(
        `Verifikation: ${captured.entry.id} (${captured.entry.entry_date ?? '?'}, status ${captured.entry.status ?? '?'})`,
      )
      if (captured.entry.description) lines.push(`Beskrivning: ${captured.entry.description}`)
    } else if (captured.description_hint) {
      lines.push(`Användarens beskrivning än så länge: "${captured.description_hint}"`)
    } else {
      lines.push('Ny verifikation, inga rader än.')
    }
    lines.push('')
    lines.push(renderAgentGroundRules())
    lines.push('')

    if (captured.current_lines.length > 0) {
      lines.push('')
      lines.push('Befintliga rader:')
      let debits = 0
      let credits = 0
      for (const r of captured.current_lines) {
        const d = r.debit_amount ?? 0
        const c = r.credit_amount ?? 0
        debits += d
        credits += c
        const dStr = d > 0 ? d.toLocaleString('sv-SE') : ''
        const cStr = c > 0 ? c.toLocaleString('sv-SE') : ''
        lines.push(`  ${r.account_number ?? '????'}  ${dStr.padStart(12)}  ${cStr.padStart(12)}  ${r.description ?? ''}`)
      }
      lines.push(`  SUMMA          ${debits.toLocaleString('sv-SE').padStart(12)}  ${credits.toLocaleString('sv-SE').padStart(12)}`)
      if (Math.abs(debits - credits) > 0.005) {
        lines.push(`  ⚠ Diff: ${(debits - credits).toLocaleString('sv-SE')}: debet ≠ kredit`)
      }
    }

    if (captured.underlag.length > 0) {
      lines.push('')
      lines.push(`UNDERLAG kopplat till verifikationen: ${captured.underlag.length} st. Extraherade fält:`)
      for (const u of captured.underlag) {
        const parts: string[] = []
        if (u.document_id) parts.push(`document_id=${u.document_id}`)
        if (u.merchant_name) parts.push(`leverantör=${u.merchant_name}`)
        if (u.receipt_date) parts.push(`datum=${u.receipt_date}`)
        if (u.total_amount != null) {
          parts.push(`total=${u.total_amount.toLocaleString('sv-SE')} ${u.currency ?? 'SEK'}`)
        }
        if (u.vat_amount != null) {
          parts.push(`moms=${u.vat_amount.toLocaleString('sv-SE')} ${u.currency ?? 'SEK'}`)
        }
        lines.push(
          `  • ${parts.join(', ') || `${u.file_name ?? 'underlag'} (ingen extraherad data: läs med gnubok_get_document_content)`}`,
        )
      }
      lines.push('')
      lines.push('Extraktionen ovan är det vi REDAN VET: fråga inte om leverantör/belopp som står där. Räcker den inte (t.ex. saknar momsbelopp), läs underlaget med gnubok_get_document_content(document_id=…).')
    }

    if (captured.period_status) {
      const periodState = captured.period_status.status
      lines.push('')
      lines.push(
        `Period: ${captured.period_status.period_id ?? '?'} (status ${periodState ?? '?'}${
          captured.period_status.lock_date ? `, lås: ${captured.period_status.lock_date}` : ''
        })`,
      )
      if (periodState === 'closed') {
        lines.push('PERIODEN ÄR STÄNGD: ingenting får bokföras på detta datum, och en stängd period kan inte låsas upp. Vägled användaren att flytta verifikationsdatumet till en öppen period.')
      } else if (periodState === 'locked') {
        lines.push('PERIODEN ÄR LÅST: ett utkast kan inte bokföras här. Vägled användaren att ändra verifikationsdatumet till en öppen period (utkast redigeras fritt), eller att låsa upp perioden under Bokföring → Räkenskapsår om datumet måste stå kvar.')
      } else if (periodState === 'unknown') {
        // Fail closed: the lock lookup failed, so we cannot claim the period is
        // open. Posting into a locked period is blocked by DB triggers anyway;
        // the agent must not promise the user that it will go through.
        lines.push('PERIODLÅSET KUNDE INTE LÄSAS: utgå INTE från att perioden är öppen. Be användaren kontrollera periodlåset under Bokföring → Räkenskapsår innan något bokförs på detta datum.')
      } else if (periodState === 'open' && captured.period_status.period_id === null) {
        lines.push('INGET RÄKENSKAPSÅR TÄCKER DATUMET: periodlåset gick inte att avgöra. Kontrollera att verifikationsdatumet ligger inom ett upplagt räkenskapsår innan du föreslår bokföring.')
      }
      if (
        captured.entry?.status === 'posted' &&
        (periodState === 'locked' || periodState === 'closed' || periodState === 'unknown')
      ) {
        // BFL 5 kap 5 §: inline rättelse is only legal in an open, unlocked
        // period. Past a lock/close, storno is the only sanctioned path.
        lines.push('Verifikationen är dessutom redan BOKFÖRD och perioden är inte bevisligen öppen: enligt BFL 5 kap 5 § är storno (omföring i en öppen period) då enda tillåtna rättelsevägen. Föreslå aldrig att rader, belopp eller datum skrivs om i det bokförda verifikatet.')
      }
    }
    lines.push('')
    lines.push('Arbetssätt:')
    lines.push('1. UNDERLAG FÖRST. Saknas underlaget i sammanhanget ovan: leta i Dokumentinkorgen med gnubok_list_inbox_items (och gnubok_list_unmatched_documents). Läs det relevanta underlaget med gnubok_get_inbox_item / gnubok_get_document_content och dra fram datum, belopp, moms och motpart INNAN du föreslår konton. Användaren ser ofta inte underlagets innehåll själv: det är just det du hjälper till med.')
    lines.push('2. Föreslå rätt BAS-konton utifrån underlaget och beskrivningen. Syns en motpart: kolla historiken med gnubok_query_journal({ text: "<motpartens namn>", limit: 5 }) och följ tidigare mönster.')
    lines.push('3. Säkerställ att debet = kredit. Förklara varje rad kort (i kategori-/kontonamn, inte kontonummer).')
    lines.push('4. Är detta egentligen en kund-/leverantörsfaktura eller en bankrad? Be användaren matcha den istället: direktbokning skapar dubbletter.')
    lines.push('5. Skapa verifikationen:')
    lines.push('   • NY verifikation (inget utkast visas ovan): staga via gnubok_create_voucher när allt stämmer. Ligger underlaget i Dokumentinkorgen: skicka med inbox_item_id så kvittot kopplas till verifikationen automatiskt vid godkännande.')
    lines.push('   • BEFINTLIGT utkast (visas ovan): föreslå konton/moms och kontrollera balansen så att användaren kan färdigställa utkastet i formuläret. Staga INTE en ny verifikation för ett utkast som redan finns: det skapar en dubblett.')
    lines.push('')
    lines.push('Svara på svenska, kort och konkret.')
    return lines.join('\n')
  },
})
