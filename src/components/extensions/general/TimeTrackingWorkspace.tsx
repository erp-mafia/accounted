'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Download, Trash2, Upload } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { cn, formatCurrency } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { TOOLBAR_FIELD_CLASS } from '@/components/ui/toolbar-search'
import { AttnLine } from '@/components/ui/attn-line'
import { EmptyState } from '@/components/ui/empty-state'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import type { TimeEntry, TimeTrackingSettings } from '@/lib/time-tracking/types'
import type { CustomerMonthSummary } from '@/lib/time-tracking/summary'

const API = '/api/extensions/ext/time-tracking'
const NONE = '__none__'

type Tab = 'entries' | 'summary' | 'import'
type CustomerOption = { id: string; name: string }

interface ImportPreview {
  row_count: number
  total_hours: number
  first_date: string | null
  last_date: string | null
  skipped: Array<{ source_row: number; reason: string; value: string }>
  customers: Array<{
    code: string
    name: string | null
    rows: number
    hours: number
    last_date: string
    suggested_customer_id: string | null
  }>
}

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

const today = () => new Date().toISOString().slice(0, 10)

function formatHours(hours: number): string {
  return hours.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    return typeof body?.error === 'string' ? body.error : fallback
  } catch {
    return fallback
  }
}

export default function TimeTrackingWorkspace(_props: WorkspaceComponentProps) {
  const t = useTranslations('time_tracking_workspace')
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('entries')
  const [from, setFrom] = useState(() => isoDaysAgo(90))
  const [to, setTo] = useState(today)
  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [settings, setSettings] = useState<TimeTrackingSettings | null>(null)
  const [myConsultant, setMyConsultant] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)

  const loadSettings = useCallback(async () => {
    const res = await fetch(`${API}/settings`)
    if (!res.ok) return
    const json = await res.json()
    setSettings(json.data)
    setMyConsultant(json.my_consultant ?? null)
  }, [])

  useEffect(() => {
    void loadSettings()
    const supabase = createClient()
    void supabase
      .from('customers')
      .select('id, name')
      .is('archived_at', null)
      .order('name', { ascending: true })
      .then(({ data }) => setCustomers((data as CustomerOption[]) ?? []))
  }, [loadSettings])

  const fail = useCallback(
    (message: string) => toast({ title: message, variant: 'destructive' }),
    [toast],
  )

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          value={tab}
          onChange={setTab}
          aria-label={t('tabs_label')}
          options={[
            { value: 'entries', label: t('tab_entries') },
            { value: 'summary', label: t('tab_summary') },
            { value: 'import', label: t('tab_import') },
          ]}
        />
        {tab !== 'import' && (
          <div className="flex items-center gap-2">
            <Label htmlFor="tt-from" className="sr-only">{t('from')}</Label>
            <Input id="tt-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={cn(TOOLBAR_FIELD_CLASS, 'w-40')} />
            <span className="text-muted-foreground">-</span>
            <Label htmlFor="tt-to" className="sr-only">{t('to')}</Label>
            <Input id="tt-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className={cn(TOOLBAR_FIELD_CLASS, 'w-40')} />
          </div>
        )}
        <div className="ml-auto">
          <Button size="sm" onClick={() => setNewOpen(true)}>{t('new_entry')}</Button>
        </div>
      </div>

      {tab === 'entries' && <EntriesTab from={from} to={to} onError={fail} />}
      {tab === 'summary' && (
        <SummaryTab
          from={from}
          to={to}
          customers={customers}
          settings={settings}
          onSettingsSaved={setSettings}
          myConsultant={myConsultant}
          onMyConsultantSaved={(s, mine) => {
            setSettings(s)
            setMyConsultant(mine)
          }}
          onError={fail}
        />
      )}
      {tab === 'import' && (
        <ImportTab
          customers={customers}
          onImported={() => {
            void loadSettings()
            setTab('summary')
          }}
          onError={fail}
        />
      )}

      <NewEntryDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        customers={customers}
        settings={settings}
        myConsultant={myConsultant}
        onSaved={() => {
          setNewOpen(false)
          toast({ title: t('saved') })
          setTab((current) => (current === 'import' ? 'entries' : current))
        }}
        onError={fail}
      />
    </div>
  )
}

function EntriesTab({ from, to, onError }: { from: string; to: string; onError: (m: string) => void }) {
  const t = useTranslations('time_tracking_workspace')
  const [rows, setRows] = useState<TimeEntry[] | null>(null)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [total, setTotal] = useState(0)

  const load = useCallback(
    async (offset: number) => {
      const params = new URLSearchParams({ from, to, limit: '200', offset: String(offset) })
      const res = await fetch(`${API}/entries?${params}`)
      if (!res.ok) {
        onError(await readError(res, t('load_error')))
        setRows((r) => r ?? [])
        return
      }
      const body = await res.json()
      setRows((r) => (offset === 0 ? body.data : [...(r ?? []), ...body.data]))
      setNextOffset(body.next_offset)
      setTotal(body.total)
    },
    [from, to, onError, t],
  )

  useEffect(() => {
    setRows(null)
    void load(0)
  }, [load])

  async function remove(id: string) {
    const res = await fetch(`${API}/entries/${id}`, { method: 'DELETE' })
    if (!res.ok) return onError(await readError(res, t('delete_error')))
    setRows((r) => (r ?? []).filter((x) => x.id !== id))
    setTotal((n) => n - 1)
  }

  if (rows === null) return <Skeleton className="h-64 w-full" />
  if (rows.length === 0) return <EmptyState title={t('empty_title')} description={t('empty_description')} />

  const hours = rows.reduce((s, r) => s + r.hours, 0)
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground tabular-nums">
        {t('entries_count', { shown: rows.length, total })} · {formatHours(hours)} {t('hours_unit')}
      </p>
      <Table className="stagger-enter">
        <TableHeader>
          <TableRow>
            <TableHead>{t('col_date')}</TableHead>
            <TableHead>{t('col_consultant')}</TableHead>
            <TableHead>{t('col_customer')}</TableHead>
            <TableHead>{t('col_project')}</TableHead>
            <TableHead>{t('col_code')}</TableHead>
            <TableHead className="text-right">{t('col_hours')}</TableHead>
            <TableHead>{t('col_comment')}</TableHead>
            <TableHead className="w-10"><span className="sr-only">{t('col_actions')}</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="tabular-nums whitespace-nowrap">{row.entry_date}</TableCell>
              <TableCell>{row.consultant}</TableCell>
              <TableCell className="max-w-48 truncate" data-ph-mask>
                {row.customer_name ?? row.customer_code}
                {!row.customer_id && <Badge variant="outline" className="ml-2">{t('unlinked')}</Badge>}
              </TableCell>
              <TableCell>{row.project_code ?? ''}</TableCell>
              <TableCell>{row.activity_code ?? ''}</TableCell>
              <TableCell className="text-right tabular-nums">{formatHours(row.hours)}</TableCell>
              <TableCell className="max-w-72 truncate text-muted-foreground" title={row.comment ?? ''} data-ph-mask>
                {row.comment}
              </TableCell>
              <TableCell>
                {row.invoice_id ? (
                  <span className="text-xs text-muted-foreground">{t('invoiced')}</span>
                ) : (
                  <Button size="icon-sm" variant="ghost" aria-label={t('delete')} onClick={() => void remove(row.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {nextOffset !== null && (
        <Button size="sm" variant="secondary" onClick={() => void load(nextOffset)}>{t('load_more')}</Button>
      )}
    </div>
  )
}

function SummaryTab({
  from,
  to,
  customers,
  settings,
  onSettingsSaved,
  myConsultant,
  onMyConsultantSaved,
  onError,
}: {
  from: string
  to: string
  customers: CustomerOption[]
  settings: TimeTrackingSettings | null
  onSettingsSaved: (s: TimeTrackingSettings) => void
  myConsultant: string | null
  onMyConsultantSaved: (s: TimeTrackingSettings, mine: string | null) => void
  onError: (m: string) => void
}) {
  const t = useTranslations('time_tracking_workspace')
  const [rows, setRows] = useState<CustomerMonthSummary[] | null>(null)

  const load = useCallback(async () => {
    const res = await fetch(`${API}/summary?${new URLSearchParams({ from, to })}`)
    if (!res.ok) {
      onError(await readError(res, t('load_error')))
      setRows([])
      return
    }
    setRows((await res.json()).data)
  }, [from, to, onError, t])

  useEffect(() => {
    setRows(null)
    void load()
  }, [load, settings])

  async function link(code: string, customerId: string | null) {
    const res = await fetch(`${API}/customer-links`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, customer_id: customerId }),
    })
    if (!res.ok) return onError(await readError(res, t('link_error')))
    void load()
  }

  const exportHref = `${API}/export?${new URLSearchParams({ from, to, uninvoiced: 'true' })}`

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-lg">{t('summary_title')}</h2>
          <Button size="sm" variant="secondary" className="ml-auto" asChild>
            <a href={exportHref} download>
              <Download className="h-4 w-4" />
              {t('export_basis')}
            </a>
          </Button>
        </div>
        {rows === null ? (
          <Skeleton className="h-48 w-full" />
        ) : rows.length === 0 ? (
          <EmptyState title={t('empty_title')} description={t('empty_description')} />
        ) : (
          <Table className="stagger-enter">
            <TableHeader>
              <TableRow>
                <TableHead>{t('col_month')}</TableHead>
                <TableHead>{t('col_customer')}</TableHead>
                <TableHead className="text-right">{t('col_hours')}</TableHead>
                <TableHead className="text-right">{t('col_uninvoiced')}</TableHead>
                <TableHead className="text-right">{t('col_amount')}</TableHead>
                <TableHead>{t('col_link')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.customer_key}|${row.month}`}>
                  <TableCell className="tabular-nums">{row.month}</TableCell>
                  <TableCell className="max-w-56 truncate" data-ph-mask>
                    {row.customer_name ?? row.customer_code}
                    {row.customer_code && <span className="ml-2 text-muted-foreground">{row.customer_code}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatHours(row.hours)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatHours(row.uninvoiced_billable_hours)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.uninvoiced_amount === null ? (
                      <span className="text-muted-foreground">{t('rate_missing')}</span>
                    ) : (
                      formatCurrency(row.uninvoiced_amount)
                    )}
                  </TableCell>
                  <TableCell>
                    {row.customer_code ? (
                      <CustomerSelect
                        value={row.customer_id}
                        customers={customers}
                        onChange={(id) => void link(row.customer_code!, id)}
                        label={t('link_customer', { code: row.customer_code })}
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {settings && settings.consultants.length > 0 && (
        <MyConsultantSection settings={settings} value={myConsultant} onSaved={onMyConsultantSaved} onError={onError} />
      )}
      {settings && <RatesSection settings={settings} onSaved={onSettingsSaved} onError={onError} />}
    </div>
  )
}

/** Which consultant the signed-in user is: entries logged without one (e.g. by voice through Claude) default to it. */
function MyConsultantSection({
  settings,
  value,
  onSaved,
  onError,
}: {
  settings: TimeTrackingSettings
  value: string | null
  onSaved: (s: TimeTrackingSettings, mine: string | null) => void
  onError: (m: string) => void
}) {
  const t = useTranslations('time_tracking_workspace')
  const [busy, setBusy] = useState(false)

  async function save(next: string | null) {
    setBusy(true)
    const res = await fetch(`${API}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...settings, my_consultant: next }),
    })
    setBusy(false)
    if (!res.ok) return onError(await readError(res, t('save_error')))
    const json = await res.json()
    onSaved(json.data, json.my_consultant ?? null)
  }

  return (
    <div className="space-y-2">
      <h2 className="font-display text-lg">{t('my_consultant_title')}</h2>
      <p className="max-w-xl text-sm text-muted-foreground">{t('my_consultant_help')}</p>
      <Select value={value ?? NONE} onValueChange={(v) => void save(v === NONE ? null : v)} disabled={busy}>
        <SelectTrigger className="h-8 w-56" aria-label={t('my_consultant_title')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t('my_consultant_none')}</SelectItem>
          {settings.consultants.map((c) => (
            <SelectItem key={c.code} value={c.code}>{c.code} · {c.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function CustomerSelect({
  value,
  customers,
  onChange,
  label,
}: {
  value: string | null
  customers: CustomerOption[]
  onChange: (id: string | null) => void
  label: string
}) {
  const t = useTranslations('time_tracking_workspace')
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger className="h-8 w-56" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t('not_linked')}</SelectItem>
        {customers.map((c) => (
          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function parseRate(text: string): number | null {
  const n = Number(text.replace(/\s/g, '').replace(',', '.'))
  return text.trim() === '' || !Number.isFinite(n) || n < 0 ? null : Math.round(n * 100) / 100
}

function RatesSection({
  settings,
  onSaved,
  onError,
}: {
  settings: TimeTrackingSettings
  onSaved: (s: TimeTrackingSettings) => void
  onError: (m: string) => void
}) {
  const t = useTranslations('time_tracking_workspace')
  const [defaultRate, setDefaultRate] = useState(settings.default_hourly_rate?.toString() ?? '')
  const [rates, setRates] = useState(() =>
    Object.fromEntries(settings.activity_codes.map((a) => [a.code, a.hourly_rate?.toString() ?? ''])),
  )
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    const next: TimeTrackingSettings = {
      ...settings,
      default_hourly_rate: parseRate(defaultRate),
      activity_codes: settings.activity_codes.map((a) => ({ ...a, hourly_rate: parseRate(rates[a.code] ?? '') })),
    }
    const res = await fetch(`${API}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    })
    setBusy(false)
    if (!res.ok) return onError(await readError(res, t('save_error')))
    onSaved((await res.json()).data)
  }

  return (
    <div className="space-y-4">
      <h2 className="font-display text-lg">{t('rates_title')}</h2>
      <div className="grid max-w-xl grid-cols-[minmax(0,1fr)_10rem] items-center gap-3">
        <Label htmlFor="tt-default-rate">{t('default_rate')}</Label>
        <Input
          id="tt-default-rate"
          inputMode="decimal"
          value={defaultRate}
          onChange={(e) => setDefaultRate(e.target.value)}
          className="text-right tabular-nums"
        />
        {settings.activity_codes.map((a) => (
          <div key={a.code} className="contents">
            <Label htmlFor={`tt-rate-${a.code}`}>{a.code} · {a.name}</Label>
            <Input
              id={`tt-rate-${a.code}`}
              inputMode="decimal"
              placeholder={t('rate_inherit')}
              value={rates[a.code] ?? ''}
              onChange={(e) => setRates((r) => ({ ...r, [a.code]: e.target.value }))}
              className="text-right tabular-nums"
            />
          </div>
        ))}
      </div>
      <Button size="sm" onClick={() => void save()} loading={busy}>{t('save_rates')}</Button>
    </div>
  )
}

function ImportTab({
  customers,
  onImported,
  onError,
}: {
  customers: CustomerOption[]
  onImported: () => void
  onError: (m: string) => void
}) {
  const t = useTranslations('time_tracking_workspace')
  const { toast } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [links, setLinks] = useState<Record<string, string | null>>({})
  const [fromDate, setFromDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  async function analyse(selected: File) {
    setFile(selected)
    setPreview(null)
    setBusy(true)
    const form = new FormData()
    form.append('file', selected)
    const res = await fetch(`${API}/import/preview`, { method: 'POST', body: form })
    setBusy(false)
    if (!res.ok) return onError(await readError(res, t('import_error')))
    const data: ImportPreview = (await res.json()).data
    setPreview(data)
    setLinks(Object.fromEntries(data.customers.map((c) => [c.code, c.suggested_customer_id])))
  }

  const selectedRows = useMemo(() => {
    if (!preview) return 0
    return fromDate ? null : preview.row_count
  }, [preview, fromDate])

  async function commit() {
    if (!file) return
    setBusy(true)
    const form = new FormData()
    form.append('file', file)
    form.append(
      'options',
      JSON.stringify({
        from_date: fromDate || null,
        links: Object.entries(links)
          .filter(([, id]) => id)
          .map(([code, customer_id]) => ({ code, customer_id })),
      }),
    )
    const res = await fetch(`${API}/import/commit`, { method: 'POST', body: form })
    setBusy(false)
    setConfirmOpen(false)
    if (!res.ok) return onError(await readError(res, t('import_error')))
    const result = (await res.json()).data
    toast({ title: t('import_done', { inserted: result.inserted, existing: result.already_imported }) })
    onImported()
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Label htmlFor="tt-file">{t('import_file')}</Label>
        <Input
          id="tt-file"
          type="file"
          accept=".xlsx,.xls,.ods,.csv"
          onChange={(e) => {
            const selected = e.target.files?.[0]
            if (selected) void analyse(selected)
          }}
        />
        <p className="text-sm text-muted-foreground">{t('import_hint')}</p>
      </div>

      {busy && !preview && <Skeleton className="h-48 w-full" />}

      {preview && (
        <div className="space-y-6">
          <p className="text-sm tabular-nums">
            {t('preview_summary', {
              rows: preview.row_count,
              hours: formatHours(preview.total_hours),
              first: preview.first_date ?? '-',
              last: preview.last_date ?? '-',
              customers: preview.customers.length,
            })}
          </p>
          {preview.skipped.length > 0 && (
            <AttnLine>
              {t('preview_skipped', {
                count: preview.skipped.length,
                rows: preview.skipped.slice(0, 5).map((s) => s.source_row).join(', '),
              })}
            </AttnLine>
          )}

          <div className="flex items-end gap-3">
            <div className="space-y-2">
              <Label htmlFor="tt-import-from">{t('import_from_date')}</Label>
              <Input
                id="tt-import-from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="w-44"
              />
            </div>
            <p className="pb-2 text-sm text-muted-foreground">{t('import_from_date_hint')}</p>
          </div>

          <Table className="stagger-enter">
            <TableHeader>
              <TableRow>
                <TableHead>{t('col_code')}</TableHead>
                <TableHead>{t('col_sheet_name')}</TableHead>
                <TableHead className="text-right">{t('col_rows')}</TableHead>
                <TableHead className="text-right">{t('col_hours')}</TableHead>
                <TableHead>{t('col_last')}</TableHead>
                <TableHead>{t('col_link')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.customers.map((c) => (
                <TableRow key={c.code}>
                  <TableCell>{c.code}</TableCell>
                  <TableCell className="max-w-56 truncate" data-ph-mask>{c.name ?? ''}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.rows}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatHours(c.hours)}</TableCell>
                  <TableCell className="tabular-nums">{c.last_date}</TableCell>
                  <TableCell>
                    <CustomerSelect
                      value={links[c.code] ?? null}
                      customers={customers}
                      onChange={(id) => setLinks((l) => ({ ...l, [c.code]: id }))}
                      label={t('link_customer', { code: c.code })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Button onClick={() => setConfirmOpen(true)} disabled={busy}>
            <Upload className="h-4 w-4" />
            {t('import_action')}
          </Button>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('confirm_title')}</DialogTitle>
            <DialogDescription>
              {selectedRows === null
                ? t('confirm_body_from', { date: fromDate })
                : t('confirm_body', { rows: selectedRows })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>{t('cancel')}</Button>
            <Button onClick={() => void commit()} loading={busy}>{t('import_action')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function NewEntryDialog({
  open,
  onOpenChange,
  customers,
  settings,
  myConsultant,
  onSaved,
  onError,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  customers: CustomerOption[]
  settings: TimeTrackingSettings | null
  myConsultant: string | null
  onSaved: () => void
  onError: (m: string) => void
}) {
  const t = useTranslations('time_tracking_workspace')
  const [date, setDate] = useState(today)
  const [consultant, setConsultant] = useState('')
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [project, setProject] = useState('')
  const [activity, setActivity] = useState('')
  const [hours, setHours] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  // Until the user types initials, default to their own consultant, else the first registered one.
  const effectiveConsultant = consultant || myConsultant || settings?.consultants[0]?.code || ''

  async function save() {
    const parsedHours = parseRate(hours)
    if (!customerId || !effectiveConsultant || !parsedHours) return onError(t('form_incomplete'))
    setBusy(true)
    const res = await fetch(`${API}/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entry_date: date,
        consultant: effectiveConsultant,
        customer_id: customerId,
        project_code: project.trim() || null,
        activity_code: activity.trim() || null,
        hours: parsedHours,
        comment: comment.trim() || null,
      }),
    })
    setBusy(false)
    if (!res.ok) return onError(await readError(res, t('save_error')))
    setHours('')
    setComment('')
    onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('new_entry')}</DialogTitle>
          <DialogDescription>{t('new_entry_description')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="tt-new-date">{t('col_date')}</Label>
            <Input id="tt-new-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tt-new-consultant">{t('col_consultant')}</Label>
            <Input
              id="tt-new-consultant"
              list="tt-consultants"
              value={effectiveConsultant}
              onChange={(e) => setConsultant(e.target.value.toUpperCase())}
            />
            <datalist id="tt-consultants">
              {settings?.consultants.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </datalist>
          </div>
          <div className="col-span-2 space-y-2">
            <Label>{t('col_customer')}</Label>
            <CustomerSelect value={customerId} customers={customers} onChange={setCustomerId} label={t('col_customer')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tt-new-project">{t('col_project')}</Label>
            <Input id="tt-new-project" value={project} onChange={(e) => setProject(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tt-new-code">{t('col_code')}</Label>
            <Input id="tt-new-code" list="tt-codes" value={activity} onChange={(e) => setActivity(e.target.value)} />
            <datalist id="tt-codes">
              {settings?.activity_codes.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
            </datalist>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tt-new-hours">{t('col_hours')}</Label>
            <Input
              id="tt-new-hours"
              inputMode="decimal"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="text-right tabular-nums"
            />
          </div>
          <div className="col-span-2 space-y-2">
            <Label htmlFor="tt-new-comment">{t('col_comment')}</Label>
            <Input id="tt-new-comment" value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
          <Button onClick={() => void save()} loading={busy}>{t('save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
