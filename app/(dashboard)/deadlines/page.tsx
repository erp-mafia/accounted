'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { DeadlineList } from '@/components/deadlines/DeadlineList'
import { DeadlineForm, type DeadlineFormValues } from '@/components/deadlines/DeadlineForm'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { CalendarPlus, Lock, Plus } from 'lucide-react'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency } from '@/lib/utils'
import type { Deadline } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const supabase = createClient()

/**
 * The sentence the route meant to say, from a response it refused.
 *
 * The parsed body goes to the mapper as-is. Wrapping it in `new Error()` first,
 * which every handler here used to do, stringifies the canonical envelope
 * `{ error: { code, message } }` into "[object Object]": the mapper then has
 * nothing to match on and falls through to the generic "Något gick fel",
 * discarding the route's own Swedish reason and its Zod field list. Passing the
 * status as well means a body-less or non-JSON refusal still resolves to the
 * right sentence, so a 403 read-only refusal reads as one instead of as a
 * generic failure.
 */
async function describeFailure(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null)
  return getUserErrorMessage(body, { statusCode: response.status })
}

export default function DeadlinesPage() {
  const { company } = useCompany()
  const companyId = company?.id
  const t = useTranslations('deadlines')
  const { canWrite } = useCanWrite()
  const [deadlines, setDeadlines] = useState<Deadline[]>([])
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([])
  const [overdueInvoices, setOverdueInvoices] = useState<{ count: number; total: number; unconverted: number }>({ count: 0, total: 0, unconverted: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const [isGenerating, setIsGenerating] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingDeadline, setEditingDeadline] = useState<Deadline | null>(null)
  const { toast } = useToast()

  // Returns whether the list on screen was actually refreshed. Handlers that
  // confirm an outcome to the user need that: claiming a row moved while the
  // reload failed would describe a list the user is not looking at.
  const fetchData = useCallback(async (): Promise<boolean> => {
    if (!companyId) return false
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
        fetchAllRows<{ total_sek: number | null; total: number | null; currency: string | null }>(({ from, to }) =>
          supabase
            .from('invoices')
            .select('total_sek, total, currency')
            .eq('company_id', companyId)
            // The open statuses, and only those the CHECK actually allows
            // (draft, sent, paid, partially_paid, overdue, cancelled,
            // credited): draft is not owed yet, paid/cancelled/credited are
            // settled. There is no 'unpaid' status; this filter used to name
            // one, so every invoice the reminder run had already flipped to
            // 'overdue' fell out of the total silently. partially_paid is
            // deliberately absent: the sum below is the invoice total, not
            // remaining_amount, so counting one would report money already
            // received as still owed, and the action link lands on the
            // invoices tab that lists exactly sent + overdue.
            .in('status', ['sent', 'overdue'])
            .lt('due_date', today)
            .order('id', { ascending: true })
            .range(from, to),
        ),
      ])

      // Non-SEK invoices without a stored SEK conversion (rate fetch failed at
      // creation) are excluded from the SEK sum rather than mixed in raw, and
      // surfaced as a count in the attn line instead.
      let overdueTotal = 0
      let unconvertedCount = 0
      for (const inv of overdueRows) {
        if (inv.total_sek != null) overdueTotal += inv.total_sek
        else if (!inv.currency || inv.currency === 'SEK') overdueTotal += inv.total || 0
        else unconvertedCount++
      }

      setDeadlines(deadlineRows)
      setCustomers(customerRows)
      setOverdueInvoices({ count: overdueRows.length, total: overdueTotal, unconverted: unconvertedCount })
      return true
    } catch {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
      return false
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
      const response = await fetch('/api/tax-deadlines/generate', {
        method: 'POST',
      }).catch(() => null)

      // The request never reached the route (offline, connection reset), so
      // point at the connection rather than the data.
      if (!response) {
        toast({
          title: t('generate_failed_title'),
          description: t('load_failed_description'),
          variant: 'destructive',
        })
        return
      }

      if (!response.ok) {
        toast({
          title: t('generate_failed_title'),
          description: await describeFailure(response),
          variant: 'destructive',
        })
        return
      }

      // Only a malformed success body reaches the catch below now.
      const result = await response.json()

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

  // Returns whether the create landed. False keeps the form open with the
  // user's input (handleFormSubmit only closes it on success); the toast above
  // each return is the user's copy of why. Not a throw: DeadlineForm's submit
  // wrapper has no catch, so a rejection here would escape as an unhandled
  // promise rejection rather than control flow.
  const handleDeadlineCreate = async (data: DeadlineFormValues): Promise<boolean> => {
    const response = await fetch('/api/deadlines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => null)

    if (!response) {
      // The request never reached the route (offline, connection reset), so
      // point at the connection rather than the data.
      toast({
        title: t('create_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
      return false
    }

    if (!response.ok) {
      toast({
        title: t('create_failed_title'),
        description: await describeFailure(response),
        variant: 'destructive',
      })
      return false
    }

    toast({
      title: t('created_title'),
      description: t('created_description'),
    })

    fetchData()
    return true
  }

  // "Ångra" on the marked-done toast. It lives here rather than inline in the
  // toast so it gets the same treatment as every other mutation on this page:
  // gated on res.ok, refetched, and answered with exactly one sentence. A
  // Skatteverket deadline that is still marked done must never be reported as
  // back on the list, and a failed undo must not look like a successful one.
  const handleUndoComplete = useCallback(
    async (deadline: Deadline) => {
      const response = await fetch(`/api/deadlines/${deadline.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The target state, not a toggle: clicking undo twice, or undoing a row
        // something else already un-ticked, must not re-complete the deadline.
        body: JSON.stringify({ is_completed: false }),
      }).catch(() => null)

      // null: the request never completed (offline, connection reset). Nothing
      // was undone, so point at the connection rather than the data.
      if (!response) {
        toast({
          title: t('undo_failed'),
          description: t('load_failed_description'),
          variant: 'destructive',
        })
        return
      }

      if (!response.ok) {
        toast({
          title: t('undo_failed'),
          // The route knows why it refused (gone, read-only member); prefer its
          // own message over generic retry copy.
          description: await describeFailure(response),
          variant: 'destructive',
        })
        return
      }

      // Confirm only once the row is provably back. When the reload failed,
      // fetchData has already said so and TOAST_LIMIT is 1, so a success
      // sentence here would evict that warning and render alone.
      if (!(await fetchData())) return

      toast({ title: t('marked_not_done', { title: deadline.title }) })
    },
    [fetchData, toast, t],
  )

  const handleDeadlineToggle = async (deadline: Deadline) => {
    const wasCompleted = deadline.is_completed
    const newCompleted = !wasCompleted

    const response = await fetch(`/api/deadlines/${deadline.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_completed: newCompleted }),
    }).catch(() => null)

    if (!response) {
      toast({
        title: t('toggle_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
      return
    }

    if (!response.ok) {
      toast({
        title: t('toggle_failed_title'),
        description: await describeFailure(response),
        variant: 'destructive',
      })
      return
    }

    fetchData()

    if (newCompleted) {
      toast({
        title: t('marked_done', { title: deadline.title }),
        action: (
          <ToastAction
            altText={t('undo')}
            onClick={() => {
              void handleUndoComplete(deadline)
            }}
          >
            {t('undo')}
          </ToastAction>
        ),
      })
    } else {
      toast({ title: t('marked_not_done', { title: deadline.title }) })
    }
  }

  // Sends ONLY the form-managed fields: the PUT route whitelists to the same
  // set, and posting a whole Deadline row from here would fabricate system
  // fields (source, status, reminder_offsets) that only the whitelist drops.
  // Returns whether the edit landed, same contract as create: false keeps the
  // form open with the user's input instead of silently discarding it.
  const handleDeadlineEdit = async (id: string, data: DeadlineFormValues): Promise<boolean> => {
    const response = await fetch(`/api/deadlines/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => null)

    if (!response) {
      toast({
        title: t('update_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
      return false
    }

    if (!response.ok) {
      toast({
        title: t('update_failed_title'),
        description: await describeFailure(response),
        variant: 'destructive',
      })
      return false
    }

    toast({
      title: t('updated_title'),
      description: t('updated_description'),
    })

    fetchData()
    return true
  }

  const handleDeadlineDelete = async (deadline: Deadline) => {
    const response = await fetch(`/api/deadlines/${deadline.id}`, {
      method: 'DELETE',
    }).catch(() => null)

    if (!response) {
      toast({
        title: t('delete_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
      return
    }

    if (!response.ok) {
      toast({
        title: t('delete_failed_title'),
        description: await describeFailure(response),
        variant: 'destructive',
      })
      return
    }

    toast({ title: t('deleted_title') })
    fetchData()
  }

  const handleFormSubmit = async (data: DeadlineFormValues) => {
    const ok = editingDeadline
      ? await handleDeadlineEdit(editingDeadline.id, data)
      : await handleDeadlineCreate(data)
    // On failure the handler has already toasted; leave the form open so the
    // user's input survives a retry.
    if (!ok) return
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
        <div className="flex items-center gap-2">
          {ENABLED_EXTENSION_IDS.has('calendar') && (
            <Button variant="outline" asChild>
              <Link href="/settings/account">
                <CalendarPlus className="mr-2 h-4 w-4" />
                {t('subscribe_calendar')}
              </Link>
            </Button>
          )}
          <Button
            onClick={() => setShowForm(true)}
            disabled={!canWrite}
            title={!canWrite ? t('read_only_tooltip') : undefined}
          >
            {canWrite ? <Plus className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
            {t('new_deadline')}
          </Button>
        </div>
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
          {formatCurrency(overdueInvoices.total)}
          {overdueInvoices.unconverted > 0
            ? ` ${t('overdue_invoices_fx', { count: overdueInvoices.unconverted })}`
            : ''}.
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
