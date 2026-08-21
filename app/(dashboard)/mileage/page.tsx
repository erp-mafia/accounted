'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { TH_CLASS, TD_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { EmptyState } from '@/components/ui/empty-state'
import { ContextPicker } from '@/components/common/ContextPicker'
import { PageHeader } from '@/components/ui/page-header'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { applyRoutePrefill, locationSuggestions } from '@/lib/mileage/route-memory'
import type { RoutePrefill } from '@/lib/mileage/route-memory'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Car, Copy, Download, Plus, Trash2, Pencil, ChevronDown, ChevronUp } from 'lucide-react'
import type { MileageTrip, MileageVehicleType } from '@/types'

interface TripFormState {
  trip_date: string
  vehicle_type: MileageVehicleType
  vehicle_registration: string
  odometer_start: string
  odometer_end: string
  distance_km: string
  from_location: string
  to_location: string
  purpose: string
  visited: string
  is_round_trip: boolean
  notes: string
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

function emptyForm(): TripFormState {
  return {
    trip_date: today(),
    vehicle_type: 'own_car',
    vehicle_registration: '',
    odometer_start: '',
    odometer_end: '',
    distance_km: '',
    from_location: '',
    to_location: '',
    purpose: '',
    visited: '',
    is_round_trip: false,
    notes: '',
  }
}

function formFromTrip(trip: MileageTrip, keepDate: boolean): TripFormState {
  // The create form takes ONE-WAY km with a round-trip toggle that doubles on
  // save. The stored distance is always the full logged distance, so a copy
  // of a round trip must present the halved (one-way) value or saving would
  // double it again. Edit mode (keepDate) shows the stored total and never
  // re-doubles.
  const displayKm =
    !keepDate && trip.is_round_trip ? Number(trip.distance_km) / 2 : Number(trip.distance_km)
  return {
    trip_date: keepDate ? trip.trip_date : today(),
    vehicle_type: trip.vehicle_type,
    vehicle_registration: trip.vehicle_registration ?? '',
    odometer_start: keepDate && trip.odometer_start != null ? String(trip.odometer_start) : '',
    odometer_end: keepDate && trip.odometer_end != null ? String(trip.odometer_end) : '',
    distance_km: String(displayKm),
    from_location: trip.from_location,
    to_location: trip.to_location,
    purpose: trip.purpose,
    visited: trip.visited ?? '',
    is_round_trip: trip.is_round_trip,
    notes: trip.notes ?? '',
  }
}

export default function MileagePage() {
  const t = useTranslations('mileage')
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [trips, setTrips] = useState<MileageTrip[]>([])
  const [loading, setLoading] = useState(true)
  const [month, setMonth] = useState<string>('all')

  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<TripFormState>(emptyForm())
  const [showMore, setShowMore] = useState(false)
  const [saving, setSaving] = useState(false)
  const [prefill, setPrefill] = useState<RoutePrefill | null>(null)
  const [distanceSuggestion, setDistanceSuggestion] = useState<{
    km: number
    fromLabel: string
    toLabel: string
  } | null>(null)

  const [bookOpen, setBookOpen] = useState(false)
  const [bookFrom, setBookFrom] = useState('')
  const [bookTo, setBookTo] = useState('')
  const [bookEntryDate, setBookEntryDate] = useState(today())
  const [counterAccount, setCounterAccount] = useState<'2820' | '2893' | '1930'>('2820')
  const [booking, setBooking] = useState(false)

  const loadTrips = useCallback(async () => {
    try {
      const res = await fetch('/api/mileage/trips')
      if (!res.ok) {
        toast({ title: t('load_error'), variant: 'destructive' })
        return
      }
      const body = await res.json()
      setTrips(body.data || [])
    } catch {
      toast({ title: t('load_error'), variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    loadTrips()
  }, [loadTrips])

  const months = useMemo(() => {
    const set = new Set(trips.map((trip) => trip.trip_date.slice(0, 7)))
    set.add(today().slice(0, 7))
    return [...set].sort().reverse()
  }, [trips])

  const visibleTrips = useMemo(
    () => (month === 'all' ? trips : trips.filter((trip) => trip.trip_date.startsWith(month))),
    [trips, month]
  )

  const draftTrips = useMemo(
    () => visibleTrips.filter((trip) => trip.status === 'draft'),
    [visibleTrips]
  )
  const draftKm = useMemo(
    () => Math.round(draftTrips.reduce((sum, trip) => sum + Number(trip.distance_km), 0) * 10) / 10,
    [draftTrips]
  )

  const suggestions = useMemo(() => locationSuggestions(trips), [trips])

  const openCreate = () => {
    setEditingId(null)
    setForm(emptyForm())
    setShowMore(false)
    setPrefill(null)
    setFormOpen(true)
  }

  const openEdit = (trip: MileageTrip) => {
    setEditingId(trip.id)
    setForm(formFromTrip(trip, true))
    setShowMore(Boolean(trip.vehicle_registration || trip.odometer_start || trip.visited || trip.notes))
    setPrefill(null)
    setFormOpen(true)
  }

  const openCopy = (trip: MileageTrip) => {
    setEditingId(null)
    setForm(formFromTrip(trip, false))
    setShowMore(false)
    setPrefill(null)
    setFormOpen(true)
  }

  // Route memory: when the from/to pair matches an earlier trip, empty km and
  // purpose fields prefill from the latest match. Prefilled values are cleared
  // again if the route stops matching before they were touched; user-typed
  // input is never overwritten, and edit mode is untouched.
  const updateRouteField = (field: 'from_location' | 'to_location', value: string) => {
    const next = { ...form, [field]: value }
    if (!editingId) {
      const result = applyRoutePrefill(trips, next, prefill)
      next.distance_km = result.distance_km
      next.purpose = result.purpose
      setPrefill(result.prefill)
    }
    setForm(next)
  }

  // A manual edit disowns that field's prefill so the hint disappears and the
  // value survives later route changes. The record itself is kept (even fully
  // disowned) as an offered-marker, so the same route never re-fills a field
  // the user deliberately emptied.
  const disownPrefill = (field: 'distance_km' | 'purpose') => {
    if (!prefill || !prefill[field]) return
    setPrefill({ ...prefill, [field]: '' })
  }

  // Distance suggestion (OpenStreetMap via our proxy): debounced lookup once
  // both endpoints are typed, create mode only. It never writes the field by
  // itself; the user applies it with a click and can still edit freely.
  useEffect(() => {
    setDistanceSuggestion(null)
    if (!formOpen || editingId) return
    const from = form.from_location.trim()
    const to = form.to_location.trim()
    if (from.length < 2 || to.length < 2) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(
        `/api/mileage/distance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { signal: controller.signal }
      )
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (typeof body?.data?.distance_km === 'number') {
            setDistanceSuggestion({
              km: body.data.distance_km,
              fromLabel: body.data.from_label,
              toLabel: body.data.to_label,
            })
          }
        })
        .catch(() => {
          // Suggestion only: a failed lookup shows nothing.
        })
    }, 700)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [form.from_location, form.to_location, formOpen, editingId])

  const applyDistanceSuggestion = () => {
    if (!distanceSuggestion) return
    disownPrefill('distance_km')
    setForm((prev) => ({ ...prev, distance_km: String(distanceSuggestion.km) }))
  }

  const submitForm = async () => {
    const km = Number(form.distance_km.replace(',', '.'))
    if (!(km > 0) || !form.from_location.trim() || !form.to_location.trim() || !form.purpose.trim()) {
      toast({ title: t('form_incomplete'), variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const payload = {
      trip_date: form.trip_date,
      vehicle_type: form.vehicle_type,
      vehicle_registration: form.vehicle_registration.trim() || null,
      odometer_start: form.odometer_start ? Number(form.odometer_start) : null,
      odometer_end: form.odometer_end ? Number(form.odometer_end) : null,
      // The round-trip toggle doubles the one-way distance on save; the stored
      // km always covers the full logged distance.
      distance_km: editingId ? km : form.is_round_trip ? km * 2 : km,
      from_location: form.from_location.trim(),
      to_location: form.to_location.trim(),
      purpose: form.purpose.trim(),
      visited: form.visited.trim() || null,
      is_round_trip: form.is_round_trip,
      notes: form.notes.trim() || null,
    }
      const res = await fetch(editingId ? `/api/mileage/trips/${editingId}` : '/api/mileage/trips', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        const message = typeof body?.error === 'string' ? body.error : body?.error?.message
        toast({ title: message || t('save_error'), variant: 'destructive' })
        return
      }
      setFormOpen(false)
      toast({ title: editingId ? t('trip_updated') : t('trip_saved') })
      await loadTrips()
    } catch {
      toast({ title: t('save_error'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const deleteTrip = async (trip: MileageTrip) => {
    const res = await fetch(`/api/mileage/trips/${trip.id}`, { method: 'DELETE' })
    if (!res.ok) {
      toast({ title: t('delete_error'), variant: 'destructive' })
      return
    }
    toast({ title: t('trip_deleted') })
    await loadTrips()
  }

  const openBook = () => {
    const base = month === 'all' ? today().slice(0, 7) : month
    const bounds = monthBounds(base)
    setBookFrom(bounds.from)
    setBookTo(bounds.to)
    setBookEntryDate(bounds.to <= today() ? bounds.to : today())
    setBookOpen(true)
  }

  const submitBook = async () => {
    setBooking(true)
    try {
      const res = await fetch('/api/mileage/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: bookFrom,
          to: bookTo,
          entry_date: bookEntryDate,
          counter_account: counterAccount,
        }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        const message = typeof body?.error === 'string' ? body.error : body?.error?.message
        toast({ title: message || t('book_error'), variant: 'destructive' })
        return
      }
      setBookOpen(false)
      toast({
        title: t('booked_title', {
          voucher: `${body.data.voucher_series ?? ''}${body.data.voucher_number ?? ''}`,
        }),
        description: t('booked_description', {
          count: body.data.trip_count,
          amount: formatCurrency(body.data.total_amount),
        }),
      })
      await loadTrips()
    } catch {
      toast({ title: t('book_error'), variant: 'destructive' })
    } finally {
      setBooking(false)
    }
  }

  const exportHref = useMemo(() => {
    if (month === 'all') return '/api/mileage/export'
    const bounds = monthBounds(month)
    return `/api/mileage/export?from=${bounds.from}&to=${bounds.to}`
  }, [month])

  const monthLabel = month === 'all' ? t('all_months') : month

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        action={
          canWrite ? (
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              {t('new_trip')}
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        {draftTrips.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {t('draft_summary', { count: draftTrips.length, km: draftKm })}
          </p>
        )}
        <div className="ml-auto flex items-center gap-2">
          {canWrite && draftTrips.length > 0 && (
            <Button variant="secondary" onClick={openBook}>
              {t('book_period')}
            </Button>
          )}
          {trips.length > 0 && (
            <Button variant="ghost" asChild>
              <a href={exportHref} download>
                <Download className="mr-2 h-4 w-4" />
                {t('export_csv')}
              </a>
            </Button>
          )}
          <ContextPicker
            items={[
              { id: 'all', label: t('all_months') },
              ...months.map((m) => ({ id: m, label: m })),
            ]}
            value={month}
            onChange={setMonth}
            triggerLabel={monthLabel}
            ariaLabel={t('month_filter')}
          />
        </div>
      </div>

      {loading ? (
        <div className="space-y-2" role="status">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : visibleTrips.length === 0 ? (
        <EmptyState
          icon={Car}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={canWrite ? t('new_trip') : undefined}
          onAction={canWrite ? openCreate : undefined}
        />
      ) : (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={TH_CLASS}>{t('col_date')}</th>
              <th className={TH_CLASS}>{t('col_route')}</th>
              <th className={TH_CLASS}>{t('col_purpose')}</th>
              <th className={`${TH_CLASS} text-right`}>{t('col_km')}</th>
              <th className={TH_CLASS}>{t('col_status')}</th>
              <th className={TH_CLASS} />
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {visibleTrips.map((trip) => (
              <tr key={trip.id} className="group hover:bg-secondary/35">
                <td className={`${TD_CLASS} tabular-nums whitespace-nowrap`}>
                  {formatDate(trip.trip_date)}
                </td>
                <td className={TD_CLASS}>
                  {trip.from_location} – {trip.to_location}
                  {trip.is_round_trip ? ` ${t('round_trip_suffix')}` : ''}
                </td>
                <td className={`${TD_CLASS} text-muted-foreground`}>{trip.purpose}</td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>
                  {Number(trip.distance_km).toLocaleString('sv-SE')}
                </td>
                <td className={TD_CLASS}>
                  {trip.status === 'draft' ? (
                    <Badge variant="outline">{t('status_draft')}</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t('status_booked')}</span>
                  )}
                </td>
                <td className={`${TD_CLASS} text-right whitespace-nowrap`}>
                  {canWrite && (
                    <span className={HOVER_REVEAL_CLASS}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('copy_trip')}
                        onClick={() => openCopy(trip)}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      {trip.status === 'draft' && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('edit_trip')}
                            onClick={() => openEdit(trip)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('delete_trip')}
                            onClick={() => deleteTrip(trip)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? t('edit_trip') : t('new_trip')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="trip_date">{t('field_date')}</Label>
                <Input
                  id="trip_date"
                  type="date"
                  value={form.trip_date}
                  onChange={(e) => setForm({ ...form, trip_date: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="vehicle_type">{t('field_vehicle')}</Label>
                <Select
                  value={form.vehicle_type}
                  onValueChange={(v) => {
                    setForm({ ...form, vehicle_type: v as MileageVehicleType })
                    // Regnr is required for a förmånsbil; surface the field.
                    if (v !== 'own_car') setShowMore(true)
                  }}
                >
                  <SelectTrigger id="vehicle_type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="own_car">{t('vehicle_own_car')}</SelectItem>
                    <SelectItem value="company_car_fossil">{t('vehicle_company_fossil')}</SelectItem>
                    <SelectItem value="company_car_electric">{t('vehicle_company_electric')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="from_location">{t('field_from')}</Label>
                <Input
                  id="from_location"
                  list="mileage-locations"
                  value={form.from_location}
                  onChange={(e) => updateRouteField('from_location', e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="to_location">{t('field_to')}</Label>
                <Input
                  id="to_location"
                  list="mileage-locations"
                  value={form.to_location}
                  onChange={(e) => updateRouteField('to_location', e.target.value)}
                />
              </div>
            </div>
            <datalist id="mileage-locations">
              {suggestions.map((location) => (
                <option key={location} value={location} />
              ))}
            </datalist>
            <div className="space-y-2">
              <Label htmlFor="purpose">{t('field_purpose')}</Label>
              <Input
                id="purpose"
                value={form.purpose}
                placeholder={t('purpose_placeholder')}
                onChange={(e) => {
                  disownPrefill('purpose')
                  setForm({ ...form, purpose: e.target.value })
                }}
              />
              {Boolean(prefill?.purpose) && (
                <p className="text-xs text-muted-foreground">{t('route_prefill_hint')}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="distance_km">
                  {editingId ? t('field_km_total') : t('field_km')}
                </Label>
                <Input
                  id="distance_km"
                  inputMode="decimal"
                  value={form.distance_km}
                  onChange={(e) => {
                    disownPrefill('distance_km')
                    setForm({ ...form, distance_km: e.target.value })
                  }}
                />
                {Boolean(prefill?.distance_km) && (
                  <p className="text-xs text-muted-foreground">{t('route_prefill_hint')}</p>
                )}
                {!editingId &&
                  distanceSuggestion &&
                  form.distance_km !== String(distanceSuggestion.km) && (
                    <button
                      type="button"
                      className="text-left text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground transition-colors duration-150"
                      title={t('distance_suggestion_route', {
                        from: distanceSuggestion.fromLabel,
                        to: distanceSuggestion.toLabel,
                      })}
                      onClick={applyDistanceSuggestion}
                    >
                      {t('distance_suggestion', { km: distanceSuggestion.km })}
                    </button>
                  )}
              </div>
              {!editingId && (
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.is_round_trip}
                      onCheckedChange={(v) => setForm({ ...form, is_round_trip: v === true })}
                    />
                    {t('field_round_trip')}
                  </label>
                </div>
              )}
            </div>

            <button
              type="button"
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors duration-150"
              onClick={() => setShowMore(!showMore)}
            >
              {showMore ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {t('more_fields')}
            </button>
            {showMore && (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="vehicle_registration">{t('field_regnr')}</Label>
                    <Input
                      id="vehicle_registration"
                      value={form.vehicle_registration}
                      onChange={(e) => setForm({ ...form, vehicle_registration: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="odometer_start">{t('field_odometer_start')}</Label>
                    <Input
                      id="odometer_start"
                      inputMode="numeric"
                      value={form.odometer_start}
                      onChange={(e) => setForm({ ...form, odometer_start: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="odometer_end">{t('field_odometer_end')}</Label>
                    <Input
                      id="odometer_end"
                      inputMode="numeric"
                      value={form.odometer_end}
                      onChange={(e) => setForm({ ...form, odometer_end: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="visited">{t('field_visited')}</Label>
                  <Input
                    id="visited"
                    value={form.visited}
                    onChange={(e) => setForm({ ...form, visited: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="notes">{t('field_notes')}</Label>
                  <Input
                    id="notes"
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  />
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setFormOpen(false)}>
                {t('cancel')}
              </Button>
              <Button onClick={submitForm} disabled={saving}>
                {saving ? t('saving') : t('save_trip')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={bookOpen} onOpenChange={setBookOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('book_period')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="book_from">{t('field_period_from')}</Label>
                <Input
                  id="book_from"
                  type="date"
                  value={bookFrom}
                  onChange={(e) => setBookFrom(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="book_to">{t('field_period_to')}</Label>
                <Input
                  id="book_to"
                  type="date"
                  value={bookTo}
                  onChange={(e) => setBookTo(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="book_entry_date">{t('field_entry_date')}</Label>
              <Input
                id="book_entry_date"
                type="date"
                value={bookEntryDate}
                onChange={(e) => setBookEntryDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="counter_account">{t('field_counter_account')}</Label>
              <Select
                value={counterAccount}
                onValueChange={(v) => setCounterAccount(v as '2820' | '2893' | '1930')}
              >
                <SelectTrigger id="counter_account">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2820">{t('counter_2820')}</SelectItem>
                  <SelectItem value="2893">{t('counter_2893')}</SelectItem>
                  <SelectItem value="1930">{t('counter_1930')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-sm text-muted-foreground">{t('book_explainer')}</p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setBookOpen(false)}>
                {t('cancel')}
              </Button>
              <Button onClick={submitBook} disabled={booking}>
                {booking ? t('booking') : t('confirm_book')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
