'use client'

import { useEffect, useState, use } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useToast } from '@/components/ui/use-toast'
import { Loader2 } from 'lucide-react'
import InvoiceEditor, { type InvoiceForEdit } from '@/components/invoices/InvoiceEditor'
import { isEditableInvoiceDraft } from '@/lib/invoices/is-editable-draft'
import type { InvoiceItem } from '@/types'

/**
 * Edit an existing DRAFT invoice. Loads the invoice + items, guards that it is
 * still an editable draft (no committed verifikat, not sent, not self-billed),
 * then hands it to the shared <InvoiceEditor> in edit mode. The PATCH route
 * enforces the same guard server-side; this just avoids opening a dead form.
 */
export default function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const supabase = createClient()
  const t = useTranslations('invoice_detail')

  const [invoice, setInvoice] = useState<InvoiceForEdit | null>(null)
  const [isLoading, setIsLoading] = useState(true)

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
        toast({
          title: t('load_failed_title'),
          description: t('load_failed_description'),
          variant: 'destructive',
        })
        router.replace('/invoices')
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
  }, [id])

  if (isLoading || !invoice) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return <InvoiceEditor mode="edit" initial={invoice} />
}
