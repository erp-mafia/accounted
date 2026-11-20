'use client'

import { useEffect, useState, use } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useToast } from '@/components/ui/use-toast'
import { LoadError, NotFoundState } from '@/components/ui/empty-state'
import InvoiceEditor, { type InvoiceForEdit } from '@/components/invoices/InvoiceEditor'
import { isEditableInvoiceDraft } from '@/lib/invoices/is-editable-draft'
import type { InvoiceItem } from '@/types'
import { useViewerRedirect } from '@/components/ui/viewer-lock'
import { InvoiceEditorShellSkeleton } from '@/components/invoices/editor/InvoiceEditorShellSkeleton'

/**
 * Edit an existing DRAFT invoice. Loads the invoice + items, guards that it is
 * still an editable draft (no committed verifikat, not sent, not self-billed),
 * then hands it to the shared <InvoiceEditor> in edit mode: the same
 * one-screen layout as /invoices/new (full-bleed, MainContainer). The PATCH
 * route enforces the same guard server-side; this just avoids opening a dead
 * form.
 */
export default function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const supabase = createClient()
  const t = useTranslations('invoice_detail')
  const tCommon = useTranslations('common')
  const canWrite = useViewerRedirect(`/invoices/${id}`)

  const [invoice, setInvoice] = useState<InvoiceForEdit | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // The read failed: the page says so with "Försök igen" (bumps reloadKey).
  const [loadFailed, setLoadFailed] = useState(false)
  // No invoice under this id: not a failure to retry.
  const [notFound, setNotFound] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('invoices')
        .select('*, customer:customers(*), items:invoice_items(*)')
        .eq('id', id)
        .single()

      if (cancelled) return

      if (error || !data) {
        // .single() answers PGRST116 when no row matched.
        if ((!error && !data) || error?.code === 'PGRST116') setNotFound(true)
        else setLoadFailed(true)
        return
      }

      // Only drafts (no committed verifikat, not sent, not a received
      // self-billing document) may be edited: shared predicate, the same one
      // the PATCH route enforces server-side.
      const editable = isEditableInvoiceDraft(data)
      if (!editable) {
        toast({
          title: t('edit_not_allowed_title'),
          description: t('edit_not_allowed_description'),
          variant: 'destructive',
        })
        router.replace(`/invoices/${id}`)
        return
      }

      // The editor's field array expects items in display order.
      if (Array.isArray(data.items)) {
        data.items.sort((a: InvoiceItem, b: InvoiceItem) => a.sort_order - b.sort_order)
      }

      setInvoice(data as InvoiceForEdit)
      setIsLoading(false)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reloadKey])

  // A read-only member gets the invoice, never its edit form.
  if (!canWrite) return null

  if (notFound) {
    return (
      <div className="px-4 pt-4 md:px-6">
        <NotFoundState title={t('not_found')} backHref="/invoices" backLabel={tCommon('back_to_list')} />
      </div>
    )
  }

  if (loadFailed) {
    // Full-bleed route: the editor owns its padding, so the state brings the gutter.
    return (
      <div className="px-4 pt-4 md:px-6">
        <LoadError
          title={t('load_failed_title')}
          onRetry={() => {
            setLoadFailed(false)
            setReloadKey((key) => key + 1)
          }}
        />
      </div>
    )
  }

  if (isLoading || !invoice) {
    return <InvoiceEditorShellSkeleton />
  }

  return <InvoiceEditor mode="edit" initial={invoice} />
}
