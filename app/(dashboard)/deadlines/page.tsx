'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { DeadlineList } from '@/components/deadlines/DeadlineList'
import { PageHeader } from '@/components/ui/page-header'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import { formatCurrency } from '@/lib/utils'
import type { Deadline } from '@/types'

const supabase = createClient()

export default function DeadlinesPage() {
  const { company } = useCompany()
  const t = useTranslations('deadlines')
  const [deadlines, setDeadlines] = useState<Deadline[]>([])
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([])
  const [overdueInvoices, setOverdueInvoices] = useState<{ count: number; total: number }>({ count: 0, total: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const { toast } = useToast()

  const fetchData = useCallback(async () => {
    if (!company) return
    setIsLoading(true)

    try {
      const today = new Date().toISOString().split('T')[0]

      const [deadlinesRes, customersRes, overdueRes] = await Promise.all([
        supabase.from('deadlines').select('*, customer:customers(name)').eq('company_id', company.id).order('due_date', { ascending: true }),
        supabase.from('customers').select('id, name').eq('company_id', company.id).order('name', { ascending: true }),
        supabase.from('invoices').select('total_sek, total').eq('company_id', company.id).in('status', ['sent', 'unpaid']).lt('due_date', today),
      ])

      if (deadlinesRes.error) throw deadlinesRes.error
      if (customersRes.error) throw customersRes.error
      if (overdueRes.error) throw overdueRes.error

      const overdueCount = overdueRes.data?.length || 0
      const overdueTotal = (overdueRes.data || []).reduce(
        (sum, inv) => sum + (inv.total_sek || inv.total || 0),
        0
      )

      setDeadlines(deadlinesRes.data || [])
      setCustomers(customersRes.data || [])
      setOverdueInvoices({ count: overdueCount, total: overdueTotal })
    } catch {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }, [toast, t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

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
            <div key={i} className="rounded-lg border p-4 animate-pulse">
              <div className="flex items-center gap-4">
                <div className="w-12 space-y-1">
                  <div className="h-5 bg-muted rounded w-8 mx-auto" />
                  <div className="h-3 bg-muted rounded w-6 mx-auto" />
                </div>
                <div className="w-px h-8 bg-muted" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 bg-muted rounded w-48" />
                  <div className="h-3 bg-muted rounded w-24" />
                </div>
                <div className="h-4 bg-muted rounded w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <PageHeader title={t('title')} />

      {/* Overdue invoices alert */}
      {overdueInvoices.count > 0 && (
        <Link href="/invoices?status=unpaid" className="group block">
          <div className="flex items-center justify-between rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 transition-colors hover:bg-destructive/10">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
              <p className="text-sm">
                <span className="font-medium">{t('overdue_invoices', { count: overdueInvoices.count })}</span>
                <span className="text-muted-foreground ml-1.5 tabular-nums">
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
