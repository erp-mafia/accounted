'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  buildInvoiceCopyInitial,
  canCopyInvoice,
  type InvoiceCopyInitial,
  type InvoiceCopySource,
} from '@/lib/invoices/copy-invoice'
import InvoiceEditor from '@/components/invoices/InvoiceEditor'
import { InvoiceEditorShellSkeleton } from '@/components/invoices/editor/InvoiceEditorShellSkeleton'
import type { InvoiceDocumentType } from '@/types'

interface Props {
  /** Copy from this invoice (the detail page's "Kopiera"). */
  copyFromId: string | null
  /** A received självfaktura ("Självfaktura" in the list's split button). */
  selfBilled: boolean
  /** Preselected document type ("Ny offert", "Ny proformafaktura"). */
  documentType: InvoiceDocumentType | null
}

/**
 * /invoices/new: the one-screen editor for a new document, empty or copied
 * from another invoice. It replaced the list's "Ny faktura" dialog; the copy
 * source is loaded here before the editor mounts with it.
 */
export default function NewInvoiceEditor({ copyFromId, selfBilled, documentType }: Props) {
  const t = useTranslations('invoice_editor')
  const { company } = useCompany()
  const supabase = useMemo(() => createClient(), [])
  const [copyLoad, setCopyLoad] = useState<{
    sourceId: string | null
    initial: InvoiceCopyInitial | null
    failed: boolean
  }>({ sourceId: null, initial: null, failed: false })

  useEffect(() => {
    if (!copyFromId) return
    if (!company?.id) return

    let cancelled = false

    const loadCopySource = async () => {
      const { data, error } = await supabase
        .from('invoices')
        .select('*')
        .eq('id', copyFromId)
        .eq('company_id', company.id)
        .single()

      let items: Record<string, unknown>[] = []
      if (!error && data) {
        try {
          // invoice_items has NO company_id column: it is scoped through its
          // parent invoice. Filtering on it made PostgREST answer 42703, which
          // fetchAllRows rethrows, so the copy flow hit the "kunde inte
          // laddas" panel for EVERY company. Tenancy is unaffected: the
          // invoices lookup above already pins copyFromId to this company, and
          // the invoice_items RLS policy joins back to the parent invoice.
          items = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
            supabase
              .from('invoice_items')
              .select('*')
              .eq('invoice_id', copyFromId)
              .order('id', { ascending: true })
              .range(from, to),
          )
        } catch {
          if (!cancelled) setCopyLoad({ sourceId: copyFromId, initial: null, failed: true })
          return
        }
      }

      if (cancelled) return
      const source = data ? { ...data, items } : null
      if (error || !source || !canCopyInvoice(source)) {
        setCopyLoad({ sourceId: copyFromId, initial: null, failed: true })
        return
      }
      setCopyLoad({
        sourceId: copyFromId,
        initial: buildInvoiceCopyInitial(source as InvoiceCopySource),
        failed: false,
      })
    }

    void loadCopySource()

    return () => {
      cancelled = true
    }
  }, [company?.id, copyFromId, supabase])

  if (copyFromId) {
    const copyInitial = copyLoad.sourceId === copyFromId ? copyLoad.initial : null
    const copyLoadFailed = copyLoad.sourceId === copyFromId && copyLoad.failed
    if (copyLoadFailed) {
      return (
        <div className="space-y-2 px-4 py-12 text-center md:px-6">
          <p className="text-[15px]">{t('copy_load_failed_title')}</p>
          <p className="text-[13px] text-muted-foreground">{t('copy_load_failed_description')}</p>
          <Link href="/invoices" className="text-[13px] underline underline-offset-4">
            {t('back')}
          </Link>
        </div>
      )
    }
    if (!copyInitial) return <InvoiceEditorShellSkeleton />
    return <InvoiceEditor key={copyFromId} mode="copy" initial={copyInitial} />
  }

  return (
    <InvoiceEditor
      mode="create"
      initialSelfBilled={selfBilled}
      initialDocumentType={documentType ?? undefined}
    />
  )
}
