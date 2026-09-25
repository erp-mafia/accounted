import { Document, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DocumentUploadSource } from '@/types'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

const log = createLogger('skattekonto-underlag')
const BATCH_SIZE = 25
const LOOKUP_CHUNK = 100

interface SkattekontoRow {
  id: string
  journal_entry_id: string
  transaktionsidentitet: number | null
  transaktionsdatum: string
  transaktionstext: string
  belopp_skatteverket: number
  imported_at: string
}

interface EntryRow {
  id: string
  status: string
  voucher_series: string | null
  voucher_number: number | null
  fiscal_period_id: string
}

interface FiscalPeriodRow {
  id: string
  is_closed: boolean
  locked_at: string | null
}

interface DocumentRow {
  journal_entry_id: string
  file_name: string
  upload_source: DocumentUploadSource | null
}

export interface SkattekontoUnderlagModel {
  companyName: string
  orgNumber: string | null
  voucher: string
  accountedRowId: string
  transactionDate: string
  transactionText: string
  amount: number
  transactionIdentity: number
  firstImportedAt: string
}

/** A distinct filename per API row and voucher makes retries and relinks traceable. */
export function skattekontoUnderlagFilename(rowId: string, journalEntryId: string): string {
  return `Skattekonto_API_${rowId}_${journalEntryId}.pdf`
}

/** Preserve the API transaction identity and voucher context in a stable PDF model. */
export function buildSkattekontoUnderlagModel(
  row: SkattekontoRow,
  entry: EntryRow,
  company: { company_name: string | null; org_number: string | null },
): SkattekontoUnderlagModel {
  if (row.transaktionsidentitet === null || entry.voucher_number === null) {
    throw new Error('A booked API transaction and numbered voucher are required')
  }
  return {
    companyName: company.company_name ?? 'Företagsnamn saknas',
    orgNumber: company.org_number,
    voucher: `${entry.voucher_series ?? 'A'}${entry.voucher_number}`,
    accountedRowId: row.id,
    transactionDate: row.transaktionsdatum,
    transactionText: row.transaktionstext,
    amount: Math.round(Number(row.belopp_skatteverket) * 100) / 100,
    transactionIdentity: row.transaktionsidentitet,
    firstImportedAt: row.imported_at,
  }
}

/** Format SEK amounts using a minus glyph supported by the PDF font. */
function formatSek(amount: number): string {
  // Helvetica cannot render the Unicode minus emitted by sv-SE.
  return `${new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(amount)
    .replaceAll(String.fromCharCode(0x2212), '-')} kr`
}

/** Render an Accounted source summary with deterministic dates for archive retries. */
export function SkattekontoUnderlagPdf({ model }: { model: SkattekontoUnderlagModel }) {
  // Build styles only when rendering. Routes that mock react-pdf without
  // StyleSheet can import the sync module without creating a PDF.
  const styles = StyleSheet.create({
    page: { padding: 48, fontSize: 10, fontFamily: 'Helvetica' },
    title: { fontSize: 18, marginBottom: 8 },
    subtitle: { fontSize: 9, color: '#555', marginBottom: 24 },
    label: { fontSize: 8, color: '#555', marginTop: 12 },
    value: { fontSize: 10, marginTop: 3 },
    footer: { fontSize: 8, color: '#555', marginTop: 32 },
  })
  return (
    <Document
      creationDate={new Date(model.firstImportedAt)}
      modificationDate={new Date(model.firstImportedAt)}
    >
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Skattekontohändelse</Text>
        <Text style={styles.subtitle}>
          Sammanställning av uppgifter hämtade via Skatteverkets API. Detta är inte ett av Skatteverket utfärdat kontoutdrag.
        </Text>
        <View>
          <Text style={styles.label}>Företag</Text>
          <Text style={styles.value}>{model.companyName}{model.orgNumber ? `, org.nr ${model.orgNumber}` : ''}</Text>
          <Text style={styles.label}>Verifikation</Text>
          <Text style={styles.value}>{model.voucher}</Text>
          <Text style={styles.label}>Transaktionsdatum</Text>
          <Text style={styles.value}>{model.transactionDate}</Text>
          <Text style={styles.label}>Skatteverkets transaktionstext</Text>
          <Text style={styles.value}>{model.transactionText}</Text>
          <Text style={styles.label}>Belopp på skattekontot</Text>
          <Text style={styles.value}>{formatSek(model.amount)}</Text>
          <Text style={styles.label}>Skatteverkets transaktions-id</Text>
          <Text style={styles.value}>{String(model.transactionIdentity)}</Text>
          <Text style={styles.label}>Accounteds händelse-id</Text>
          <Text style={styles.value}>{model.accountedRowId}</Text>
          <Text style={styles.label}>Först registrerad i Accounted</Text>
          <Text style={styles.value}>{model.firstImportedAt}</Text>
        </View>
        <Text style={styles.footer}>
          Källa: synkad SKV-transaktion. Accounted lagrar arkiveringstid och kontrollsumma separat.
        </Text>
      </Page>
    </Document>
  )
}

/**
 * Archive a snapshot of linked SKV API transactions on posted vouchers.
 * The source table is a mutable sync mirror, so a live reference alone is not
 * retained evidence. Existing user-supplied documents win; generated files
 * are added once per linked SKV row so a multi-row voucher stays complete.
 * Failures are logged and retried on the next sync, never changing the ledger.
 */
export async function archiveLinkedSkattekontoUnderlag(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<{ archived: number; failed: number }> {
  const rows = await fetchAllRows<SkattekontoRow>(({ from, to }) =>
    supabase.from('skattekonto_transactions')
      .select('id, journal_entry_id, transaktionsidentitet, transaktionsdatum, transaktionstext, belopp_skatteverket, imported_at')
      .eq('company_id', companyId)
      .eq('source', 'api')
      .eq('status', 'booked')
      .not('journal_entry_id', 'is', null)
      .not('transaktionsidentitet', 'is', null)
      .order('id')
      .range(from, to),
  )
  if (rows.length === 0) return { archived: 0, failed: 0 }

  const ids = [...new Set(rows.map(row => row.journal_entry_id))]
  const entries = new Map<string, EntryRow>()
  const periods = new Map<string, FiscalPeriodRow>()
  const documents = new Map<string, DocumentRow[]>()
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + LOOKUP_CHUNK)
    const [entryResult, attachedDocuments] = await Promise.all([
      supabase.from('journal_entries')
        .select('id, status, voucher_series, voucher_number, fiscal_period_id')
        .eq('company_id', companyId).in('id', chunk),
      fetchAllRows<DocumentRow>(({ from, to }) => supabase.from('document_attachments')
        .select('journal_entry_id, file_name, upload_source')
        .eq('company_id', companyId).eq('is_current_version', true)
        .in('journal_entry_id', chunk).order('id').range(from, to)),
    ])
    if (entryResult.error) throw entryResult.error
    for (const entry of (entryResult.data ?? []) as EntryRow[]) entries.set(entry.id, entry)
    for (const doc of attachedDocuments) {
      const attached = documents.get(doc.journal_entry_id) ?? []
      attached.push(doc)
      documents.set(doc.journal_entry_id, attached)
    }
  }
  const periodIds = [...new Set([...entries.values()].map(entry => entry.fiscal_period_id))]
  for (let i = 0; i < periodIds.length; i += LOOKUP_CHUNK) {
    const { data, error } = await supabase.from('fiscal_periods')
      .select('id, is_closed, locked_at').eq('company_id', companyId)
      .in('id', periodIds.slice(i, i + LOOKUP_CHUNK))
    if (error) throw error
    for (const period of (data ?? []) as FiscalPeriodRow[]) periods.set(period.id, period)
  }

  const candidates = rows.filter(row => {
    const entry = entries.get(row.journal_entry_id)
    if (entry?.status !== 'posted' || entry.voucher_number === null) return false
    const period = periods.get(entry.fiscal_period_id)
    if (!period || period.is_closed || period.locked_at !== null) return false
    const attached = documents.get(row.journal_entry_id) ?? []
    if (attached.some(doc => doc.upload_source !== 'system')) return false
    return !attached.some(doc => doc.file_name === skattekontoUnderlagFilename(row.id, row.journal_entry_id))
  }).slice(0, BATCH_SIZE)
  if (candidates.length === 0) return { archived: 0, failed: 0 }

  const { data: company, error: companyError } = await supabase.from('company_settings')
    .select('company_name, org_number').eq('company_id', companyId).maybeSingle()
  if (companyError) throw companyError

  let archived = 0
  let failed = 0
  for (const row of candidates) {
    try {
      const model = buildSkattekontoUnderlagModel(
        row,
        entries.get(row.journal_entry_id)!,
        (company as { company_name: string | null; org_number: string | null } | null) ?? {
          company_name: null, org_number: null,
        },
      )
      const pdf = await renderToBuffer(SkattekontoUnderlagPdf({ model }))
      await uploadDocument(supabase, userId, companyId, {
        name: skattekontoUnderlagFilename(row.id, row.journal_entry_id),
        buffer: new Uint8Array(pdf).buffer as ArrayBuffer,
        type: 'application/pdf',
      }, {
        upload_source: 'system',
        journal_entry_id: row.journal_entry_id,
        idempotency_key: `skattekonto-underlag:${row.id}:${row.journal_entry_id}`,
        extractionOwner: 'none',
      })
      archived++
    } catch (error) {
      failed++
      log.error('failed to archive skattekonto underlag', error, {
        companyId, rowId: row.id, journalEntryId: row.journal_entry_id,
      })
    }
  }
  return { archived, failed }
}
