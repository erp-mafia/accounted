'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { DeadlineList } from '@/components/deadlines/DeadlineList'
import { DeadlineForm } from '@/components/deadlines/DeadlineForm'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Lock, Plus } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency } from '@/lib/utils'
import type { Deadline } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const supabase = createClient()

export default function DeadlinesPage() {
  const { company } = useCompany()
  const companyId = company?.id
  const t = useTranslations('deadlines')
  const { canWrite } = useCanWrite()
  const [deadlines, setDeadlines] = useState<Deadline[]>([])
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([])
  const [overdueInvoices, setOverdueInvoices] = useState<{ count: number; total: number }>({ count: 0, total: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const [isGenerating, setIsGenerating] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingDeadline, setEditingDeadline] = useState<Deadline | null>(null)
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
        description: error instanceof Error ? getUserErrorMessage(error) : t('retry'),
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
        description: error instanceof Error ? getUserErrorMessage(error) : t('retry'),
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
        description: error instanceof Error ? getUserErrorMessage(error) : t('retry'),
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
        description: error instanceof Error ? getUserErrorMessage(error) : t('retry'),
        variant: 'destructive',
      })
      // Rethrow (like create) so a failed edit keeps the form open with the
      // user's input instead of silently discarding it.
      throw error
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
        description: error instanceof Error ? getUserErrorMessage(error) : t('retry'),
        variant: 'destructive',
      })
    }
  }

  const handleFormSubmit = async (
    data: Omit<Deadline, 'id' | 'user_id' | 'company_id' | 'created_at' | 'updated_at'>,
  ) => {
    if (editingDeadline) {
      await handleDeadlineEdit({ ...editingDeadline, ...data })
    } else {
      await handleDeadlineCreate(data)
    }
    setShowForm(false)
    setEditingDeadline(null)
  }

  const openEdit = (deadline: Deadline) => {
    setEditingDeadline(deadline)
    setShowForm(true)
  }

  const pageHeader = (
    <PageHeader
      title={t('title')}
      help={
        <HelpPopover>
          <p>{t('help_text')}</p>
          <p className="mt-2">
            <Link href="/settings/tax" className="underline underline-offset-2">
              {t('generate_open_settings')}
            </Link>
          </p>
        </HelpPopover>
      }
      action={
        <Button
          onClick={() => setShowForm(true)}
          disabled={!canWrite}
          title={!canWrite ? t('read_only_tooltip') : undefined}
        >
          {canWrite ? <Plus className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
          {t('new_deadline')}
        </Button>
      }
    />
  )

  if (isLoading) {
    return (
      <div className="space-y-8">
        {pageHeader}
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 py-3">
              <Skeleton className="h-7 w-7 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-24" />
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
  // read as an empty manual todo list. One attn line per page: this setup
  // nudge outranks the overdue-invoices note because it unlocks the page.
  const hasSystemDeadlines = deadlines.some((d) => d.source === 'system')

  return (
    <div className="space-y-8">
      {pageHeader}

      {!hasSystemDeadlines ? (
        <AttnLine
          action={{
            label: isGenerating ? t('generating') : t('generate_action'),
            onClick: () => {
              if (!isGenerating) void handleGenerateSystemDeadlines()
            },
          }}
        >
          {t('no_system_deadlines_title')} {t('no_system_deadlines_description')}
        </AttnLine>
      ) : overdueInvoices.count > 0 ? (
        <AttnLine
          action={{ label: t('overdue_invoices_action'), href: '/invoices?status=unpaid' }}
        >
          {t('overdue_invoices', { count: overdueInvoices.count })} ·{' '}
          {formatCurrency(overdueInvoices.total)}.
        </AttnLine>
      ) : null}

      <DeadlineList
        deadlines={deadlines}
        onDeadlineToggle={handleDeadlineToggle}
        onDeadlineEdit={openEdit}
      />

      <DeadlineForm
        open={showForm}
        onOpenChange={(open) => {
          if (!open) {
            setShowForm(false)
            setEditingDeadline(null)
          }
        }}
        onSubmit={handleFormSubmit}
        onDelete={(deadline) => {
          if (deadline.id) {
            const full = deadlines.find((d) => d.id === deadline.id)
            if (full) void handleDeadlineDelete(full)
          }
        }}
        initialData={editingDeadline || undefined}
        customers={customers}
      />
    </div>
  )
}
