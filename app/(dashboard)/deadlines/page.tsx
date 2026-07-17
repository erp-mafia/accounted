'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { DeadlineList } from '@/components/deadlines/DeadlineList'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AlertTriangle, ArrowRight, CalendarClock, Loader2 } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import { formatCurrency } from '@/lib/utils'
import type { Deadline } from '@/types'

const supabase = createClient()

export default function DeadlinesPage() {
  const { company } = useCompany()
  const companyId = company?.id
  const t = useTranslations('deadlines')
  const [deadlines, setDeadlines] = useState<Deadline[]>([])
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([])
  const [overdueInvoices, setOverdueInvoices] = useState<{ count: number; total: number }>({ count: 0, total: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const [isGenerating, setIsGenerating] = useState(false)
  const { toast } = useToast()

  const fetchData = useCallback(async () => {
    if (!companyId) return
    setIsLoading(true)

    try {
      const today = new Date().toISOString().split('T')[0]

      // fetchAllRows: PostgREST silently caps plain selects at 1000 rows,
      // which would truncate the deadline list and undercount overdue
      // invoices for large companies. The secondary .order('id') gives the
      // stable total order paging requires.
      const [deadlineRows, customerRows, overdueRows] = await Promise.all([
        fetchAllRows<Deadline>(({ from, to }) =>
          supabase
            .from('deadlines')
            .select('*, customer:customers(name)')
            .eq('company_id', companyId)
            .is('dismissed_at', null)
            .order('due_date', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
        ),
        fetchAllRows<{ id: string; name: string }>(({ from, to }) =>
          supabase
            .from('customers')
            .select('id, name')
            .eq('company_id', companyId)
            .order('name', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
        ),
        fetchAllRows<{ total_sek: number | null; total: number | null }>(({ from, to }) =>
          supabase
            .from('invoices')
            .select('total_sek, total')
            .eq('company_id', companyId)
            .in('status', ['sent', 'unpaid'])
            .lt('due_date', today)
            .order('id', { ascending: true })
            .range(from, to),
        ),
      ])

      const overdueTotal = overdueRows.reduce(
        (sum, inv) => sum + (inv.total_sek || inv.total || 0),
        0
      )

      setDeadlines(deadlineRows)
      setCustomers(customerRows)
      setOverdueInvoices({ count: overdueRows.length, total: overdueTotal })
    } catch {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }, [companyId, toast, t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleGenerateSystemDeadlines = async () => {
    setIsGenerating(true)
    try {
      const response = await fetch('/api/tax-deadlines/generate', { method: 'POST' })
      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || t('generate_failed_description'))
      }

      if ((result.created ?? 0) === 0) {
        // Nothing was generated: the tax settings are genuinely incomplete.
        // Point the user to fill them in (the banner's settings link stays visible).
        toast({
          title: t('generate_none_title'),
          description: t('generate_none_description'),
        })
        return
      }

      toast({
        title: t('generate_success_title'),
        description: t('generate_success_description', { count: result.created }),
      })
      fetchData()
    } catch (error) {
      toast({
        title: t('generate_failed_title'),
        description: error instanceof Error ? error.message : t('retry'),
        variant: 'destructive',
      })
    } finally {
      setIsGenerating(false)
    }
  }

  const handleDeadlineCreate = async (
    data: Omit<Deadline, 'id' | 'user_id' | 'company_id' | 'created_at' | 'updated_at'>
  ) => {
    try {
      const response = await fetch('/api/deadlines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const result = await response.json()
        throw new Error(result.error || 'Failed to create deadline')
      }

      toast({
        title: t('created_title'),
        description: t('created_description'),
      })

      fetchData()
    } catch (error) {
      toast({
        title: t('create_failed_title'),
        description: error instanceof Error ? error.message : t('retry'),
        variant: 'destructive',
      })
      throw error
    }
  }

  const handleDeadlineToggle = async (deadline: Deadline) => {
    const wasCompleted = deadline.is_completed
    const newCompleted = !wasCompleted

    try {
      const response = await fetch(`/api/deadlines/${deadline.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_completed: newCompleted }),
      })

      if (!response.ok) {
        const result = await response.json()
        throw new Error(result.error || 'Failed to toggle deadline')
      }

      fetchData()

      if (newCompleted) {
        toast({
          title: t('marked_done', { title: deadline.title }),
          action: (
            <ToastAction altText={t('undo')} onClick={async () => {
              try {
                await fetch(`/api/deadlines/${deadline.id}/complete`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ is_completed: false }),
                })
              } catch {
                toast({
                  title: t('undo_failed'),
                  variant: 'destructive',
                })
              }
            }}>
              {t('undo')}
            </ToastAction>
          ),
        })
      } else {
        toast({ title: t('marked_not_done', { title: deadline.title }) })
      }
    } catch (error) {
      toast({
        title: t('toggle_failed_title'),
        description: error instanceof Error ? error.message : t('retry'),
        variant: 'destructive',
      })
    }
  }

  const handleDeadlineEdit = async (deadline: Deadline) => {
    try {
      const response = await fetch(`/api/deadlines/${deadline.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deadline),
      })

      if (!response.ok) {
        const result = await response.json()
        throw new Error(result.error || 'Failed to edit deadline')
      }

      toast({
        title: t('updated_title'),
        description: t('updated_description'),
      })

      fetchData()
    } catch (error) {
      toast({
        title: t('update_failed_title'),
        description: error instanceof Error ? error.message : t('retry'),
        variant: 'destructive',
      })
    }
  }

  const handleDeadlineDelete = async (deadline: Deadline) => {
    try {
      const response = await fetch(`/api/deadlines/${deadline.id}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const result = await response.json()
        throw new Error(result.error || 'Failed to delete deadline')
      }

      toast({ title: t('deleted_title') })
      fetchData()
    } catch (error) {
      toast({
        title: t('delete_failed_title'),
        description: error instanceof Error ? error.message : t('retry'),
        variant: 'destructive',
      })
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-8">
        <PageHeader title={t('title')} />
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-lg border p-4">
              <div className="flex items-center gap-4">
                <div className="w-12 space-y-1">
                  <Skeleton className="h-5 w-8 mx-auto" />
                  <Skeleton className="h-3 w-6 mx-auto" />
                </div>
                <Skeleton className="w-px h-8" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-4 w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Statutory deadlines (moms, arbetsgivardeklaration, F-skatt) are generated
  // from the company's tax settings — none present usually means those
  // settings were never filled in, so point there instead of letting the page
  // read as an empty manual todo list.
  const hasSystemDeadlines = deadlines.some((d) => d.source === 'system')

  return (
    <div className="space-y-8">
      <PageHeader title={t('title')} />

      {!hasSystemDeadlines && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border px-4 py-3">
          <div className="flex items-center gap-3">
            <CalendarClock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <p className="text-sm">
              <span className="font-medium">{t('no_system_deadlines_title')}</span>
              <span className="text-muted-foreground ml-1.5">
                {t('no_system_deadlines_description')}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button size="sm" onClick={handleGenerateSystemDeadlines} disabled={isGenerating}>
              {isGenerating && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              {t('generate_action')}
            </Button>
            <Link
              href="/settings/tax"
              className="group inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('generate_open_settings')}
              <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
            </Link>
          </div>
        </div>
      )}

      {/* Overdue invoices alert */}
      {overdueInvoices.count > 0 && (
        <Link href="/invoices?status=unpaid" className="group block">
          <div className="flex items-center justify-between rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 transition-colors hover:bg-destructive/10">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
              <p className="text-sm">
                <span className="font-medium">{t('overdue_invoices', { count: overdueInvoices.count })}</span>
                <span className="text-muted-foreground ml-2 tabular-nums">
                  {formatCurrency(overdueInvoices.total)}
                </span>
              </p>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
          </div>
        </Link>
      )}

      <DeadlineList
        deadlines={deadlines}
        customers={customers}
        onDeadlineCreate={handleDeadlineCreate}
        onDeadlineToggle={handleDeadlineToggle}
        onDeadlineEdit={handleDeadlineEdit}
        onDeadlineDelete={handleDeadlineDelete}
      />
    </div>
  )
}
