'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { useCompany } from '@/contexts/CompanyContext'
import { useCustomers } from '@/lib/reference-data/hooks'
import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { useToast } from '@/components/ui/use-toast'
import { PaymentCalendar } from '@/extensions/general/calendar/components/PaymentCalendar'
import type { DeadlineFormValues } from '@/components/deadlines/DeadlineForm'
import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import type { Invoice, Deadline } from '@/types'
import { Skeleton } from '@/components/ui/skeleton'

// Everything here is scoped to the ACTIVE company. The SELECT policies are
// membership-wide (user_company_ids()), so a bare browser read showed a user
// in two companies both companies' rows. Deadlines go through /api/deadlines,
// customers through the reference-data hook, and the invoice read filters on
// company_id explicitly.
export default function CalendarWorkspace(_props: WorkspaceComponentProps) {
  const { company } = useCompany()
  const companyId = company?.id ?? null
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [deadlines, setDeadlines] = useState<Deadline[]>([])
  const { customers } = useCustomers()
  const [isLoading, setIsLoading] = useState(true)
  const { toast } = useToast()

  const fetchData = useCallback(async () => {
    if (!companyId) {
      setIsLoading(false)
      return
    }
    setIsLoading(true)

    try {
      const supabase = createClient()
      const [invoicesData, deadlinesRes] = await Promise.all([
        fetchAllRows<Invoice>(({ from, to }) =>
          supabase
            .from('invoices')
            .select('*, customer:customers(name)')
            .eq('company_id', companyId)
            .order('due_date', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
        ),
        fetch('/api/deadlines'),
      ])

      if (!deadlinesRes.ok) throw new Error(await getResponseErrorMessage(deadlinesRes))
      const deadlinesBody = (await deadlinesRes.json()) as { data?: Deadline[] }

      setInvoices(invoicesData)
      setDeadlines(deadlinesBody.data ?? [])
    } catch {
      toast({
        title: 'Kunde inte hämta data',
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }, [companyId, toast])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleDeadlineCreate = async (data: DeadlineFormValues) => {
    const response = await fetch('/api/deadlines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => null)

    if (!response?.ok) {
      toast({
        title: 'Kunde inte skapa deadline',
        description: response ? await getResponseErrorMessage(response) : undefined,
        variant: 'destructive',
      })
      // Rejecting keeps the form open with the user's input.
      throw new Error('deadline create failed')
    }

    toast({
      title: 'Deadline skapad',
      description: 'Din deadline har sparats',
    })

    fetchData()
  }

  const handleDeadlineToggle = async (deadline: Deadline) => {
    const response = await fetch(`/api/deadlines/${deadline.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The target state, not a toggle: a row something else already changed
      // must not flip back.
      body: JSON.stringify({ is_completed: !deadline.is_completed }),
    }).catch(() => null)

    if (!response?.ok) {
      toast({
        title: 'Kunde inte uppdatera deadline',
        description: response ? await getResponseErrorMessage(response) : undefined,
        variant: 'destructive',
      })
      return
    }

    toast({
      title: deadline.is_completed ? 'Markerad som ej klar' : 'Markerad som klar',
    })

    fetchData()
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
