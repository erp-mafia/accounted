import { defineAgentIntent } from './types'
import { SONNET_MODEL, EFFORT_STANDARD } from '@/lib/agent/composer/client'
import {
  renderClarificationLines,
  summariseClarifications,
} from '@/lib/agent-context/chat-clarifications'
import { findUnderlagCandidates } from '@/lib/agent-context/underlag-candidates'
import type { InboxChannelContext } from '@/types'

// transaction.categorization: "Fråga om denna transaktion" on a transaction
// row.
//
// Declarative atom mode: loads VAT + invoice compliance + accounting
// compliance upfront, plus the company's vertical and modifier atoms. That's
// the loadout needed to confidently propose a BAS account for a typical
// expense or income line.
//
// Tool scope intentionally narrow: the agent should resolve the
// categorization at the row in question, not wander.
//
// Plan refs: §8 (intent system, V1 #1), §8 ("gather information first,
// propose second": encoded in the prompt template below).

interface TransactionCategorizationArgs {
  transaction_id: string
}

interface CapturedTransaction {
  transaction: {
    id: string
    date: string | null
    description: string | null
    amount: number | null
    currency: string | null
    counterparty_name: string | null
  } | null
  // Each linked receipt/invoice in a flattened "what we already know" shape.
  // Empty when the user has not attached anything yet.
  underlag: {
    kind: 'receipt' | 'invoice_inbox'
    document_id: string | null
    merchant_name: string | null
    receipt_date: string | null
    total_amount: number | null
    vat_amount: number | null
    currency: string | null
    is_restaurant: boolean | null
    is_systembolaget: boolean | null
    // Raw extracted fields from the upload pipeline: passed verbatim so the
    // agent can paraphrase context-specific signals (line items, dates,
    // payment reference) without us pre-modeling every field.
    raw_extraction: Record<string, unknown> | null
    /**
     * Answers the user already gave about THIS underlag in another channel
     * (today: the WhatsApp intake conversation). Verified human input, not
     * OCR guesswork, so it outranks anything read off the image.
     *
     * Without it the assistant asked for participant names the user had
     * typed into WhatsApp minutes earlier, which is the worst thing a
     * system that already holds the answer can do.
     */
    chat_answers: InboxChannelContext | null
    /**
     * `linked` = tied to this transaction by a human or an explicit flow.
     * `candidate` = scored as probably the same economic event but NOT linked.
     *
     * Candidates exist because WhatsApp intake writes neither
     * matched_transaction_id nor transactions.document_id, so a chat-captured
     * receipt reaches neither the matched query nor the document backfill and
     * the assistant reports "UNDERLAG: saknas" about a receipt we hold.
     */
    match: 'linked' | 'candidate'
    /** Only set for candidates: 0-1 from the shared receipt matcher. */
    confidence?: number
    /** Only set for candidates: Swedish reasons the match scored. */
    match_reasons?: string[]
    /** Set for inbox-sourced underlag so the agent can propose the match. */
    inbox_item_id?: string | null
  }[]
}

export const transactionCategorization = defineAgentIntent<
  TransactionCategorizationArgs,
  CapturedTransaction
>({
  id: 'transaction.categorization',
  buttonLabel: 'Fråga om denna transaktion',
  sheetTitle: 'Hjälp med transaktion',

  atoms: {
    mode: 'declarative',
    horizontal: ['swedish-vat', 'swedish-invoice-compliance', 'swedish-accounting-compliance'],
    includeCompanyVertical: true,
    includeCompanyModifiers: true,
  },

  tools: [
    'gnubok_categorize_transaction',
    'gnubok_query_journal',
    'gnubok_match_transaction_to_invoice',
    'gnubok_get_document_content',
    'gnubok_load_skill',
    'gnubok_search_tools',
    'gnubok_remember_fact',
    'gnubok_forget_fact',
  ],

  model: SONNET_MODEL,

  // Reason before proposing: read underlag + history and work out the VAT
  // treatment in the thinking channel, so the visible reply is one short
  // motivation, not a play-by-play of each tool call.
  thinking: { effort: EFFORT_STANDARD },

  capture: async ({ transaction_id }, { supabase, companyId }) => {
    const { data: tx } = await supabase
      .from('transactions')
      .select(
        // merchant_name / amount_sek / exchange_rate feed the candidate scorer
        // (currency-aware amount comparison + merchant similarity).
        'id, date, description, merchant_name, amount, currency, amount_sek, exchange_rate, document_id, journal_entry_id',
      )
      .eq('id', transaction_id)
      .eq('company_id', companyId)
      .single()

    // Pull every underlag we can find for this transaction in parallel:
    //   1. receipts.matched_transaction_id  → receipt-scan extracted fields
    //   2. invoice_inbox_items.matched_transaction_id → inbox extension
    //   3. document_attachments.extracted_data via the transaction's own
    //      document_id and (when posted) any docs linked to the journal
    //      entry: populated by the document-extraction extension on
    //      upload.
    const journalEntryId = (tx?.journal_entry_id as string | null) ?? null
    const directDocumentId = (tx?.document_id as string | null) ?? null

    const [
      { data: receipts },
      { data: inboxItems },
      { data: directDoc },
      { data: entryDocs },
    ] = await Promise.all([
      supabase
        .from('receipts')
        .select(
          'document_id, merchant_name, receipt_date, total_amount, vat_amount, currency, is_restaurant, is_systembolaget, raw_extraction',
        )
        .eq('company_id', companyId)
        .eq('matched_transaction_id', transaction_id),
      supabase
        .from('invoice_inbox_items')
        .select('document_id, extracted_data, channel_context')
        .eq('company_id', companyId)
        .eq('matched_transaction_id', transaction_id),
      directDocumentId
        ? supabase
            .from('document_attachments')
            .select('id, file_name, mime_type, extracted_data, extraction_model')
            .eq('id', directDocumentId)
            .eq('company_id', companyId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      journalEntryId
        ? supabase
            .from('document_attachments')
            .select('id, file_name, mime_type, extracted_data, extraction_model')
            .eq('journal_entry_id', journalEntryId)
            .eq('company_id', companyId)
            .eq('is_current_version', true)
        : Promise.resolve({ data: [] }),
    ])

    const underlag: CapturedTransaction['underlag'] = []
    for (const r of (receipts ?? []) as {
      document_id: string | null
      merchant_name: string | null
      receipt_date: string | null
      total_amount: number | null
      vat_amount: number | null
      currency: string | null
      is_restaurant: boolean | null
      is_systembolaget: boolean | null
      raw_extraction: Record<string, unknown> | null
    }[]) {
      underlag.push({
        kind: 'receipt',
        document_id: r.document_id,
        merchant_name: r.merchant_name,
        receipt_date: r.receipt_date,
        total_amount: r.total_amount,
        vat_amount: r.vat_amount,
        currency: r.currency,
        is_restaurant: r.is_restaurant,
        is_systembolaget: r.is_systembolaget,
        raw_extraction: r.raw_extraction,
        chat_answers: null,
        match: 'linked',
      })
    }
    for (const it of (inboxItems ?? []) as {
      document_id: string | null
      extracted_data: Record<string, unknown> | null
      channel_context: InboxChannelContext | null
    }[]) {
      const ex = it.extracted_data ?? {}
      const supplier = (ex.supplier as { name?: string | null } | undefined) ?? null
      const invoice = (ex.invoice as { invoiceDate?: string | null; currency?: string | null } | undefined) ?? null
      const totals = (ex.totals as { total?: number | null; vatAmount?: number | null } | undefined) ?? null
      underlag.push({
        kind: 'invoice_inbox',
        document_id: it.document_id,
        merchant_name: supplier?.name ?? null,
        receipt_date: invoice?.invoiceDate ?? null,
        total_amount: totals?.total ?? null,
        vat_amount: totals?.vatAmount ?? null,
        currency: invoice?.currency ?? null,
        is_restaurant: null,
        is_systembolaget: null,
        raw_extraction: ex,
        chat_answers: it.channel_context ?? null,
        match: 'linked',
      })
    }

    // document_attachments.extracted_data: populated by the
    // document-extraction extension for any upload path (booking dialog,
    // quick review, journal entry, etc.). Dedupe by document_id against
    // rows we already collected above.
    const seenDocIds = new Set(underlag.map((u) => u.document_id).filter(Boolean))
    const docCandidates: {
      id: string | null
      extracted_data: Record<string, unknown> | null
    }[] = []
    if (directDoc && (directDoc as { id?: string }).id) {
      docCandidates.push({
        id: ((directDoc as { id: string }).id) ?? null,
        extracted_data:
          ((directDoc as { extracted_data: Record<string, unknown> | null }).extracted_data) ?? null,
      })
    }
    for (const d of (entryDocs ?? []) as {
      id: string
      extracted_data: Record<string, unknown> | null
    }[]) {
      docCandidates.push({ id: d.id, extracted_data: d.extracted_data ?? null })
    }
    for (const d of docCandidates) {
      if (!d.id || seenDocIds.has(d.id)) continue
      const ex = d.extracted_data
      if (!ex) {
        // Attached but extraction hasn't run (or failed): surface as
        // "underlag attached, extraction pending" so the prompt can
        // suggest calling gnubok_get_document_content directly.
        underlag.push({
          kind: 'receipt',
          document_id: d.id,
          merchant_name: null,
          receipt_date: null,
          total_amount: null,
          vat_amount: null,
          currency: null,
          is_restaurant: null,
          is_systembolaget: null,
          raw_extraction: null,
          chat_answers: null,
          match: 'linked',
        })
        continue
      }
      const supplier = (ex.supplier as { name?: string | null } | undefined) ?? null
      const invoice = (ex.invoice as { invoiceDate?: string | null; currency?: string | null } | undefined) ?? null
      const totals = (ex.totals as { total?: number | null; vatAmount?: number | null } | undefined) ?? null
      underlag.push({
        kind: 'receipt',
        document_id: d.id,
        merchant_name: supplier?.name ?? null,
        receipt_date: invoice?.invoiceDate ?? null,
        total_amount: totals?.total ?? null,
        vat_amount: totals?.vatAmount ?? null,
        currency: invoice?.currency ?? null,
        is_restaurant: null,
        is_systembolaget: null,
        raw_extraction: ex,
        chat_answers: null,
        match: 'linked',
      })
    }

    // Chat answers live on the inbox item, but an underlag can reach this
    // point through the document paths above (the transaction's own
    // document_id, or a doc anchored to the journal entry) without the
    // inbox row ever being matched to the transaction. Backfill by
    // document_id so the answers are found either way.
    const missingContextDocIds = underlag
      .filter((u) => u.chat_answers == null && u.document_id != null)
      .map((u) => u.document_id as string)
    if (missingContextDocIds.length > 0) {
      const { data: byDoc } = await supabase
        .from('invoice_inbox_items')
        .select('document_id, channel_context')
        .eq('company_id', companyId)
        .in('document_id', missingContextDocIds)
        .not('channel_context', 'is', null)
      for (const row of (byDoc ?? []) as {
        document_id: string | null
        channel_context: InboxChannelContext | null
      }[]) {
        for (const u of underlag) {
          if (u.document_id === row.document_id && u.chat_answers == null) {
            u.chat_answers = row.channel_context ?? null
          }
        }
      }
    }

    // Still nothing. That is the ordinary state for a receipt captured in
    // WhatsApp: intake writes neither invoice_inbox_items.matched_transaction_id
    // nor transactions.document_id (both are set only when a human matches in
    // the picker), so the item reaches neither the matched query nor the
    // backfill above, and the user is told "UNDERLAG: saknas" about a receipt
    // we are holding. Score the unmatched items and offer the strongest for a
    // human to confirm.
    if (underlag.length === 0 && tx) {
      const candidates = await findUnderlagCandidates(supabase, companyId, {
        id: tx.id as string,
        date: (tx.date as string | null) ?? null,
        description: (tx.description as string | null) ?? null,
        merchant_name: (tx.merchant_name as string | null) ?? null,
        amount: tx.amount as number | null,
        currency: (tx.currency as string | null) ?? null,
        amount_sek: (tx.amount_sek as number | null) ?? null,
        exchange_rate: (tx.exchange_rate as number | null) ?? null,
      })
      for (const c of candidates) {
        underlag.push({
          kind: 'invoice_inbox',
          match: 'candidate',
          confidence: c.confidence,
          match_reasons: c.matchReasons,
          inbox_item_id: c.inbox_item_id,
          chat_answers: c.channelContext,
          document_id: c.document_id,
          merchant_name: c.merchant_name,
          receipt_date: c.receipt_date,
          total_amount: c.total_amount,
          vat_amount: c.vat_amount,
          currency: c.currency,
          is_restaurant: null,
          is_systembolaget: null,
          raw_extraction: null,
        })
      }
    }

    return {
      transaction: tx
        ? {
            id: tx.id,
            date: (tx.date as string | null) ?? null,
            description: (tx.description as string | null) ?? null,
            amount: tx.amount as number | null,
            currency: tx.currency as string | null,
            counterparty_name: null,
          }
        : null,
      underlag,
    }
  },

  promptTemplate: ({ captured, profileSummary }) => {
    if (!captured.transaction) {
      return [
        'Användaren öppnade hjälpfönstret från en transaktionsrad, men transaktionen kunde inte hittas.',
        'Be om mer information och försök hjälpa till på generell nivå.',
      ].join(' ')
    }

    const tx = captured.transaction
    const lines: string[] = []
    if (profileSummary) lines.push(`Företagets profil: ${profileSummary}`, '')

    lines.push('Hjälp användaren med denna transaktion:')
    lines.push(`- transaction_id: ${tx.id}`)
    lines.push(`- Datum: ${tx.date ?? 'okänt'}`)
    lines.push(`- Beskrivning: ${tx.description ?? '(saknas)'}`)
    lines.push(
      `- Belopp: ${tx.amount != null ? `${tx.amount.toLocaleString('sv-SE')} ${tx.currency ?? 'SEK'}` : '(okänt)'}`,
    )
    lines.push('')

    if (captured.underlag.length === 0) {
      // No underlag yet. The chat sheet no longer accepts file uploads:
      // documents live in Dokumentinkorgen. Direct the user there. The
      // user must then match the inbox item to this transaction (or to
      // any transaction) before booking can use the underlag.
      lines.push('UNDERLAG: saknas.')
      lines.push('')
      lines.push('BFL 7 kap kräver ett underlag för varje affärshändelse. Innan du föreslår bokföring:')
      lines.push('1. Säg till användaren att vi behöver underlaget (kvitto eller faktura).')
      lines.push('2. Beskriv KORT hur de får in det:')
      lines.push('     • **Gå till Dokumentinkorgen** (i sidomenyn) och dra in PDF:en eller bilden där. AI:n läser dokumentet automatiskt.')
      lines.push('     • Alternativt: vidarebefordra fakturan/kvittot via e-post till företagets inbox-adress: det landar i samma inkorg.')
      lines.push('     • När underlaget är i inkorgen klickar de "Matcha mot transaktion" och väljer denna transaktion. Då dyker det upp här som UNDERLAG på nästa fråga.')
      lines.push('3. Om användaren ändå är säker på vad det är (t.ex. en återkommande mjukvaruprenumeration), erbjud att bokföra utan underlag mot en uttrycklig notering, och förklara att underlaget måste bifogas TILL VERIFIKATIONEN i efterhand (öppna verifikationen i Bokföring och ladda upp där). Skicka INTE användaren tillbaka till Dokumentinkorgen efter att en verifikation skapats: inkorgen är för dokument som inte ännu är kopplade till en bokföring.')
      lines.push('')
      lines.push('Skicka ALDRIG användaren till chatten för att ladda upp filen: den vägen är borttagen.')
    } else {
      // Underlag IS attached: read the extracted metadata and use it
      // directly. Don't ask the user for things the extraction already nailed.
      const linkedCount = captured.underlag.filter((u) => u.match === 'linked').length
      const candidateCount = captured.underlag.length - linkedCount
      lines.push(
        linkedCount > 0
          ? `UNDERLAG: ${linkedCount} st bifogat. Extraherade fält:`
          : `UNDERLAG: inget är kopplat till transaktionen, men ${candidateCount} st i Dokumentinkorgen liknar den starkt (TROLIGT UNDERLAG, ej bekräftat). Extraherade fält:`,
      )
      // Set when at least one underlag actually contributed a clarification
      // line, which is what the guidance paragraph below refers to.
      let renderedClarifications = false
      for (const u of captured.underlag) {
        const parts: string[] = []
        if (u.match === 'candidate') {
          parts.push(`TROLIGT UNDERLAG (${Math.round((u.confidence ?? 0) * 100)}% säkerhet)`)
          if (u.match_reasons?.length) parts.push(u.match_reasons.join(' + '))
          if (u.inbox_item_id) parts.push(`inbox_item_id=${u.inbox_item_id}`)
        }
        if (u.document_id) parts.push(`document_id=${u.document_id}`)
        if (u.merchant_name) parts.push(`leverantör=${u.merchant_name}`)
        if (u.receipt_date) parts.push(`datum=${u.receipt_date}`)
        if (u.total_amount != null) {
          parts.push(`total=${u.total_amount.toLocaleString('sv-SE')} ${u.currency ?? 'SEK'}`)
        }
        if (u.vat_amount != null) {
          parts.push(`moms=${u.vat_amount.toLocaleString('sv-SE')} ${u.currency ?? 'SEK'}`)
        }
        if (u.is_restaurant) parts.push('restaurang=ja')
        if (u.is_systembolaget) parts.push('systembolaget=ja')
        lines.push(`  • ${u.kind}: ${parts.join(', ') || '(ingen extraherad data: läs underlaget med gnubok_get_document_content)'}`)

        // Answers the user already typed in another channel. Own indented
        // block so it reads as human input, not one more OCR field.
        //
        // Rendered from the structured summary rather than off the raw blob: a
        // WhatsApp "nej" stores an EMPTY representation (participants: [],
        // purpose: null, denied: true), so branching on `!rep.purpose` here
        // read a settled denial as a half answer and told the agent to ask for
        // the purpose of a meal the user had just said was not representation.
        // The summary also flattens the free text and drops the caption.
        const clarifications = summariseClarifications(u.chat_answers)
        const clarificationLines = clarifications ? renderClarificationLines(clarifications) : []
        if (clarificationLines.length > 0) renderedClarifications = true
        for (const line of clarificationLines) {
          lines.push(`    - ${line}`)
        }
      }
      lines.push('')
      lines.push('VIKTIGT: extraktionen ovan är det vi REDAN VET. Återupprepa inte frågor som "vilken leverantör är det?" eller "vad var beloppet?": det står ovan. Använd uppgifterna direkt och föreslå kategori + moms-behandling.')
      // Conditional: an unconditional line is prompt bloat on the common
      // transaction that has no chat history. Gated on what was actually
      // RENDERED, not on chat_answers being present: a context holding only a
      // caption (or only an already-answered question) summarises to nothing,
      // and this paragraph would then point at marked rows the prompt does not
      // contain. Same failure as an instruction keyed to a marker the renderer
      // never emits.
      if (renderedClarifications) {
        lines.push('Rader märkta "uppgivna av användaren" kommer från en tidigare konversation om samma underlag (t.ex. WhatsApp när kvittot skickades in). Det är MÄNSKLIGT bekräftade uppgifter och väger tyngre än vad du själv läser ut ur bilden. Fråga ALDRIG om något som redan står där; behöver du komplettera, fråga bara om den del som faktiskt saknas. Står det "OBESVARAD FRÅGA": ställ exakt den frågan och ingen annan. När du stagear: ta med deltagare och syfte i notes så de följer med till verifikationen.')
      }
      if (candidateCount > 0) {
        lines.push('TROLIGT UNDERLAG är INTE kopplat ännu: en människa måste bekräfta kopplingen. Fråga kort om det är rätt underlag (nämn leverantör, datum, belopp) och be användaren koppla det i Dokumentinkorgen via "Matcha mot transaktion". Bokför inte mot ett troligt underlag som användaren inte bekräftat, men använd gärna dess uppgifter för att föreslå kategori under tiden.')
      }
    }
    lines.push('')
    lines.push('Arbetssätt: hämta information via verktygsanrop FÖRST (tyst: statusraderna visar att du söker, och ditt resonemang sker i tankekanalen), föreslå sedan. Skriv din förklaring EN gång efteråt, inte i flera block runt anropen.')
    lines.push('- Atomerna i systemprompten (swedish-vat, swedish-accounting-compliance, swedish-invoice-compliance + företagets vertikal/modifier-atomer) är din primärkälla: citera BFL / ML 2023:200 / BFNAR / BAS därifrån i din korta motivering. (Disciplinen kring satser och gränser, ladda-före-svar, styrs av systemprompten.)')
    lines.push('- KOLLA HUR MOTPARTEN BOKFÖRTS FÖRUT innan du föreslår kategori. Anropa gnubok_query_journal({ text: "<motpartens namn>", limit: 5 }): använd det renaste namn-signalen du har (underlagets leverantörsnamn när det finns, annars ett kort utdrag ur transaktionsbeskrivningen utan adress/stad-cruft, t.ex. "Linear" inte "LINEAR.APP*HQ STOCKHOLM"). Granska de returnerade raderna: vilka BAS-konton användes, vilken momsbehandling, samma summor i samma härad? Om det finns ett tydligt mönster: följ det om inte underlaget motsäger det. "Så har du gjort förut" är ett starkare argument än vad du själv tycker borde gälla. Om query_journal returnerar 0 träffar är motparten ny: grunda förslaget på atomerna (nämn att den är ny bara om det är relevant, i din korta motivering: skriv ingen separat rad om sökresultatet).')
    lines.push('- Om underlaget inte är extraherat tillräckligt djupt (t.ex. saknar momsbelopp), läs PDF/bilden med gnubok_get_document_content(document_id=…) och fyll i luckorna.')
    lines.push('- Om något i underlaget är oklart eller motsägelsefullt (t.ex. moms saknas men säljaren är svensk, eller belopp inte stämmer med transaktionen), FRÅGA användaren först innan du stagear.')
    lines.push('- STÄLL en kort följdfråga (2-3 alternativ) när kategorin beror på syfte som inte syns på kvittot: restaurang/café, Systembolaget, detaljhandel (ICA/Clas Ohlson/Apoteket), resor, drivmedel, gåvor. Hellre en fråga än en felaktig bokning. Spara användarens svar via gnubok_remember_fact så du inte behöver fråga igen nästa gång liknande motpart dyker upp.')
    lines.push('- REPRESENTATION (måltid): fånga ANTAL deltagare, vilka (namn + företag) och syftet innan du bokför: antalet styr momsavdraget (tak per person på underlaget). Använd kvittots FAKTISKA momssats, gissa aldrig. Fråga "Hur många var ni, och vilka?" om det inte framgår. När du har uppgifterna: (1) anropa gnubok_remember_fact med content som beskriver deltagare + syfte; (2) stagea med notes="X deltagare: [namn + företag]. Syfte: [text]." så det landar i verifikationen. Saknas uppgifterna medges inget momsavdrag: säg det.')
    lines.push(`- När du är säker, staga via gnubok_categorize_transaction med transaction_id=${tx.id} (ALDRIG document_id). Välj kategori från enum-listan i verktygets schema.`)
    lines.push('- Förklara dina val kort på svenska: använd kategori-namn (t.ex. "Mjukvara/IT-tjänster", "Tele & internet"), ALDRIG ett BAS-kontonummer. Verktyget mappar kategori → konto, och godkännandekortet visar det faktiska BAS-kontot.')
    lines.push('- Berätta INTE för användaren att du "stagear nu", att operationen är "stagead", att de ska "godkänna i appen", eller upprepa siffror som ändå visas i godkännandekortet (kategori, BAS-konto, momsbelopp). Kortet renderas direkt under ditt svar och säger allt det. Avsluta i stället med en mening eller två om VARFÖR du valde som du valde, och stanna där.')
    lines.push('- Upprepa INTE underlag-uppmaningen efter stagning. Om du redan har bett användaren ladda upp via Dokumentinkorgen (i pre-stage-meddelandet) räcker det: påminn inte igen efter Godkänn-kortet. Och om underlag saknas och bokningen ändå stagas: säg att det ska bifogas till VERIFIKATIONEN (öppna den i Bokföring), inte till Dokumentinkorgen. Inkorgen är för dokument som inte ännu hör till en verifikation.')
    lines.push('')
    lines.push('Svara på svenska och var direkt: ditt första svar är det första användaren ser.')
    return lines.join('\n')
  },
})
