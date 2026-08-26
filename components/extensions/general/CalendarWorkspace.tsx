'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { guardBrowserWrite } from '@/lib/company/tab-guard'
import { useToast } from '@/components/ui/use-toast'
import { PaymentCalendar } from '@/extensions/general/calendar/components/PaymentCalendar'
import type { DeadlineFormValues } from '@/components/deadlines/DeadlineForm'
import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import type { Invoice, Deadline } from '@/types'
import { Skeleton } from '@/components/ui/skeleton'

export default function CalendarWorkspace({ userId }: WorkspaceComponentProps) {
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [deadlines, setDeadlines] = useState<Deadline[]>([])
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const { toast } = useToast()
  const supabase = createClient()

  const fetchData = useCallback(async () => {
    setIsLoading(true)

    try {
      const { data: invoicesData, error: invoicesError } = await supabase
        .from('invoices')
        .select('*, customer:customers(name)')
        .order('due_date', { ascending: true })

      if (invoicesError) throw invoicesError

      const { data: deadlinesData, error: deadlinesError } = await supabase
        .from('deadlines')
        .select('*, customer:customers(name)')
        .is('dismissed_at', null)
        .order('due_date', { ascending: true })

      if (deadlinesError) throw deadlinesError

      const { data: customersData, error: customersError } = await supabase
        .from('customers')
        .select('id, name')
        .is('archived_at', null)
        .order('name', { ascending: true })

      if (customersError) throw customersError

      setInvoices(invoicesData || [])
      setDeadlines(deadlinesData || [])
      setCustomers(customersData || [])
    } catch {
      toast({
        title: 'Kunde inte hämta data',
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }, [supabase, toast])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleDeadlineCreate = async (data: DeadlineFormValues) => {
    // Cross-tab guard (WL-09): browser-direct Supabase write, outside the
    // patched-fetch seam. The blocking dialog is the user feedback.
    if (!guardBrowserWrite()) return
    try {
      const { error } = await supabase.from('deadlines').insert([data])

      if (error) throw error

      toast({
        title: 'Deadline skapad',
        description: 'Din deadline har sparats',
      })

      fetchData()
    } catch (error) {
      toast({
        title: 'Kunde inte skapa deadline',
        variant: 'destructive',
      })
      throw error
    }
  }

  const handleDeadlineToggle = async (deadline: Deadline) => {
    if (!guardBrowserWrite()) return
    try {
      const { error } = await supabase
        .from('deadlines')
        .update({
          is_completed: !deadline.is_completed,
          completed_at: !deadline.is_completed ? new Date().toISOString() : null,
        })
        .eq('id', deadline.id)

      if (error) throw error

      toast({
        title: deadline.is_completed ? 'Markerad som ej klar' : 'Markerad som klar',
      })

      fetchData()
    } catch {
      toast({
        title: 'Kunde inte uppdatera deadline',
        variant: 'destructive',
      })
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  return (
    <PaymentCalendar
      invoices={invoices}
      deadlines={deadlines}
      customers={customers}
      onDeadlineCreate={handleDeadlineCreate}
      onDeadlineToggle={handleDeadlineToggle}
    />
  )
}
