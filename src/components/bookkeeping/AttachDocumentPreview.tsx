'use client'

import { useTranslations } from 'next-intl'
import { ArrowDownIcon, ExclamationTriangleIcon } from '@/components/icons'
import { formatCurrency, formatDate } from '@/lib/utils'
import { isUuid } from '@/lib/invariants/uuid'
import { DocumentViewButton } from './DocumentViewButton'
import DocumentViewerPane from './DocumentViewerPane'

interface AttachDocumentPreviewProps {
  data: Record<string, unknown>
  params: Record<string, unknown>
  /**
   * The Granskning drawer: the document renders inside the review instead of
   * behind a button that opens a new tab, so the pairing can be judged in
   * place (crm#1003). Confirm dialogs and the chat card stay compact.
   */
  detail?: boolean
}

/**
 * Two-card preview for `attach_document_to_transaction` operations. Renders
 * the transaction and the document side by side so the reviewer can confirm
 * the pairing without cross-referencing IDs.
 */
export function AttachDocumentPreview({ data, params, detail = false }: AttachDocumentPreviewProps) {
  const txDescription = (data.transaction_description as string) || '-'
  const txAmount = data.transaction_amount as number | undefined
  const txCurrency = (data.transaction_currency as string) || 'SEK'
  const txDate = data.transaction_date as string | undefined

  const docFileName = (data.document_file_name as string) || '-'
  const docVendor = data.document_vendor_name as string | undefined
  const docAmount = data.document_amount as number | undefined
  const docCurrency = (data.document_currency as string) || txCurrency
  const docInvoiceDate = data.document_invoice_date as string | undefined

  const t = useTranslations('pending')
  const willOverwrite = data.will_overwrite_existing === true
  // The pinned document stays underlag (its inbox item is matched to the
  // row): this one is added beside it, nothing is replaced (crm#1479).
  const addsToExisting = !willOverwrite && data.adds_to_existing === true
  const existingDocName = data.existing_document_file_name as string | undefined
  // Fail safe: if the staging tool didn't explicitly assert the existing doc
  // is NOT räkenskapsinformation (i.e. `=== false`), treat overwrite as a
  // BFL 7 kap event. A missing/undefined flag must not silently downgrade
  // the destructive warning.
  const existingIsAccounting =
    willOverwrite && data.existing_document_is_rakenskapsinformation !== false

  const documentId = isUuid(params.document_id) ? params.document_id : null
  const docMimeType = typeof data.document_mime_type === 'string' ? data.document_mime_type : null

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <PreviewCard label="Transaktion">
          <Row label="Datum" value={txDate ? formatDate(txDate) : '-'} tabular />
          <Row label="Beskrivning" value={txDescription} />
          <Row
            label="Belopp"
            value={typeof txAmount === 'number' ? formatCurrency(txAmount, txCurrency) : '-'}
            tabular
          />
        </PreviewCard>

        <PreviewCard label="Dokument">
          <Row label="Fil" value={docFileName} />
          {docVendor && <Row label="Leverantör" value={docVendor} />}
          {docInvoiceDate && <Row label="Fakturadatum" value={formatDate(docInvoiceDate)} tabular />}
          {typeof docAmount === 'number' && (
            <Row label="Belopp" value={formatCurrency(docAmount, docCurrency)} tabular />
          )}
          {documentId && !detail && (
            <div className="pt-1">
              <DocumentViewButton documentId={documentId} />
            </div>
          )}
        </PreviewCard>
      </div>

      {documentId && detail && (
        <DocumentViewerPane
          documentId={documentId}
          mime={docMimeType}
          fileName={docFileName === '-' ? null : docFileName}
          className="h-[56vh]"
        />
      )}

      <div className="flex items-center justify-center text-xs text-muted-foreground">
        <ArrowDownIcon className="h-3.5 w-3.5 mr-1" />
        kopplas till transaktionen
      </div>

      {willOverwrite && existingIsAccounting && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Ersätter räkenskapsinformation</p>
            <p className="mt-1 text-xs">
              Befintligt dokument{existingDocName ? ` (${existingDocName})` : ''} är markerat som
              räkenskapsinformation enligt BFL 7 kap. Att ersätta det här gör det tidigare
              verifikationsunderlaget otillgängligt: bekräfta att du har originalet sparat innan
              du godkänner.
            </p>
          </div>
        </div>
      )}
      {addsToExisting && (
        <div className="rounded-lg border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
          {existingDocName
            ? t('attach_adds_to_existing', { file: existingDocName })
            : t('attach_adds_to_existing_unnamed')}
        </div>
      )}
      {willOverwrite && !existingIsAccounting && (
        <div className="rounded-lg border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
          Ersätter befintligt dokument{existingDocName ? `: ${existingDocName}` : ''}.
        </div>
      )}
    </div>
  )
}

function PreviewCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-3 space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  )
}

function Row({ label, value, tabular }: { label: string; value: string; tabular?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className={`text-sm ${tabular ? 'tabular-nums' : ''} text-right truncate`}>{value}</span>
    </div>
  )
}
