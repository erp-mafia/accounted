'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DataListEmpty } from '@/components/ui/data-list'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, FileInput, Lock } from 'lucide-react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/page-header'
import NewSupplierInvoiceDialog from '@/components/supplier-invoices/NewSupplierInvoiceDialog'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import type { SupplierInvoice } from '@/types'

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  registered: 'secondary',
  approved: 'default',
  paid: 'success',
  partially_paid: 'warning',
  overdue: 'destructive',
  disputed: 'warning',
  credited: 'secondary',
  reversed: 'secondary',
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  registered: 'status_registered',
  approved: 'status_approved',
  paid: 'status_paid',
  partially_paid: 'status_partially_paid',
  overdue: 'status_overdue',
  disputed: 'status_disputed',
  credited: 'status_credited',
  reversed: 'status_reversed',
}

export default function SupplierInvoicesPage() {
  const t = useTranslations('supplier_invoices')
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [invoices, setInvoices] = useState<(SupplierInvoice & { supplier?: { id: string; name: string } })[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('all')
  const [approvingId, setApprovingId] = useState<string | null>(null)

  // The "Registrera leverantörsfaktura" modal is driven by the URL (?new=1,
  // optionally with inbox_item_id for the invoice-inbox conversion flow) so
  // every entry point (the header button, the empty state, the command
  // palette, and the legacy /supplier-invoices/new redirect) opens the same
  // dialog, and the browser back button closes it.
  const showNewInvoice = searchParams.has('new')
  const inboxItemId = searchParams.get('inbox_item_id')
  const closeNewInvoice = () => router.replace('/supplier-invoices', { scroll: false })
  const openNewInvoice = () => router.push('/supplier-invoices?new=1', { scroll: false })

  async function fetchInvoices() {
    setIsLoading(true)
    const res = await fetch('/api/supplier-invoices?status=all')
    const { data } = await res.json()
    setInvoices(data || [])
    setIsLoading(false)
  }

  useEffect(() => {
    fetchInvoices()
  }, [])

  // Mirrors the old standalone page's post-create navigation: inbox
  // conversions land back in the inbox, a created invoice opens its detail
  // page, and flows that end here (e.g. private expense) close the modal and
  // refresh the list in place.
  const handleCreated = (invoiceId?: string) => {
    if (inboxItemId) {
      router.push('/e/general/invoice-inbox')
      return
    }
    if (invoiceId) {
      router.push(`/supplier-invoices/${invoiceId}`)
      return
    }
    closeNewInvoice()
    fetchInvoices()
  }

  // "Att betala" is the full payment queue: registered invoices are already
  // booked as debt (2440), so they belong here too. Approval stays the gate
  // for paying, not for visibility; unapproved rows get an inline approve.
  const filteredInvoices = invoices.filter((inv) => {
    switch (activeTab) {
      case 'registered': return inv.status === 'registered'
      case 'approved': return inv.status === 'approved'
      case 'to_pay': return inv.status === 'registered' || inv.status === 'approved' || inv.status === 'overdue'
      case 'paid': return inv.status === 'paid'
      default: return true
    }
  })

  async function handleApprove(id: string) {
    setApprovingId(id)
    try {
      const res = await fetch(`/api/supplier-invoices/${id}/approve`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) {
        toast({ title: t('approve_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
        // Re-sync from the server: an operator about to pay must see the
        // invoice's true approval state, not an optimistic guess.
        fetchInvoices()
      } else {
        toast({ title: t('approved_title'), description: t('approved_description') })
        setInvoices((prev) => prev.map((inv) => (inv.id === id ? { ...inv, status: 'approved' as const } : inv)))
      }
    } catch {
      toast({ title: t('approve_failed_title'), description: getErrorMessage(null, { context: 'supplier_invoice' }), variant: 'destructive' })
      fetchInvoices()
    } finally {
      setApprovingId(null)
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        action={
          canWrite ? (
            <Button onClick={openNewInvoice}>
              <Plus className="mr-2 h-4 w-4" />
              {t('register_invoice')}
            </Button>
          ) : (
            <Button
              disabled
              title={t('viewer_disabled_tooltip')}
            >
              <Lock className="mr-2 h-4 w-4" />
              {t('register_invoice')}
            </Button>
          )
        }
      />

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all">{t('tab_all')}</TabsTrigger>
          <TabsTrigger value="registered">{t('tab_registered')}</TabsTrigger>
          <TabsTrigger value="approved">{t('tab_approved')}</TabsTrigger>
          <TabsTrigger value="to_pay">{t('tab_to_pay')}</TabsTrigger>
          <TabsTrigger value="paid">{t('tab_paid')}</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab}>
          <Card>
            <CardContent className="p-0">
            {isLoading ? (
              <div>
                <div className="p-3 border-b border-border">
                  <Skeleton className="h-4 w-full" />
                </div>
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex items-center gap-4 p-3 border-b border-border last:border-0">
                    <Skeleton className="h-4 w-12" />
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-20  ml-auto" />
                    <Skeleton className="h-5 w-16" />
                  </div>
                ))}
              </div>
            ) : filteredInvoices.length === 0 ? (
              <DataListEmpty
                icon={<FileInput className="h-6 w-6" />}
                title={t('empty_title')}
                description={
                  activeTab === 'all'
                    ? t('empty_description_all')
                    : t('empty_description_category')
                }
                action={
                  activeTab === 'all' && canWrite ? (
                    <Button onClick={openNewInvoice}>{t('register_invoice')}</Button>
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('th_arrival')}</TableHead>
                    <TableHead>{t('th_supplier')}</TableHead>
                    <TableHead>{t('th_invoice_number')}</TableHead>
                    <TableHead>{t('th_invoice_date')}</TableHead>
                    <TableHead>{t('th_due_date')}</TableHead>
                    <TableHead className="text-right">{t('th_amount')}</TableHead>
                    <TableHead className="text-right">{t('th_remaining')}</TableHead>
                    <TableHead>{t('th_status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredInvoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="tabular-nums">{inv.arrival_number}</TableCell>
                      <TableCell>
                        <Link href={`/suppliers/${inv.supplier_id}`} className="hover:underline">
                          {inv.supplier?.name || '-'}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link href={`/supplier-invoices/${inv.id}`} className="text-primary hover:underline">
                          {inv.supplier_invoice_number}
                        </Link>
                      </TableCell>
                      <TableCell className="tabular-nums">{formatDate(inv.invoice_date)}</TableCell>
                      <TableCell className="tabular-nums">{formatDate(inv.due_date)}</TableCell>
                      {/* Belopp rounds like the detail page when the invoice's
                          öresavrundning flag is on; "kvar att betala" stays
                          öre-exact (it is the actual outstanding debt). */}
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(getDisplayTotal(
                          { total: inv.total, currency: inv.currency, ore_rounding: inv.ore_rounding },
                          { ore_rounding: false },
                        ).displayed, inv.currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(inv.remaining_amount, inv.currency)}</TableCell>
                      <TableCell>
                        {activeTab === 'to_pay' && inv.status === 'registered' ? (
                          <div className="flex items-center gap-2">
                            <Badge variant="warning" className="whitespace-nowrap">{t('not_approved')}</Badge>
                            {!inv.is_credit_note && canWrite && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                onClick={() => handleApprove(inv.id)}
                                disabled={approvingId !== null}
                              >
                                {t('approve')}
                              </Button>
                            )}
                          </div>
                        ) : (
                          <Badge variant={STATUS_VARIANTS[inv.status] || 'secondary'}>
                            {STATUS_LABEL_KEYS[inv.status] ? t(STATUS_LABEL_KEYS[inv.status]) : inv.status}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <NewSupplierInvoiceDialog
        open={showNewInvoice}
        onOpenChange={(open) => {
          if (!open) closeNewInvoice()
        }}
        inboxItemId={inboxItemId}
        onCreated={handleCreated}
      />
    </div>
  )
}
