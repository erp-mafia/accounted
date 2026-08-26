'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useDimensions } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
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
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatDate } from '@/lib/utils'
import {
  Plus,
  Search,
  Lock,
  Tags,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Loader2,
} from 'lucide-react'
import DimensionValueForm, {
  type DimensionValueFormInput,
} from '@/components/dimensions/DimensionValueForm'
import {
  PROJECT_DIM_NO,
  type DimensionDto,
  type DimensionValueDto,
} from '@/components/dimensions/types'

type SortColumn = 'code' | 'name' | 'status' | 'start_date' | 'end_date'
type SortDir = 'asc' | 'desc'

type DialogState =
  | { mode: 'create' }
  | { mode: 'edit'; value: DimensionValueDto }
  | null

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, 'sv', { sensitivity: 'base' })
}

/**
 * Register for dimension values (kostnadsställen & projekt): the
 * customers-page register recipe hosted behind one segmented tab per registry
 * dimension. Archive rides the edit form's aktiv switch (PATCH is_active);
 * delete lives only in the edit dialog and surfaces the DB retention
 * trigger's Swedish "…arkivera det istället" message when the value is
 * referenced by posted lines.
 */
export default function DimensionsManager() {
  const t = useTranslations('dimensions')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  // The register renders the same session-cached registry the pickers use
  // (lib/reference-data); every write below invalidates it.
  const { dimensions: registry, isLoading, error: loadError, refresh: refreshDimensions } = useDimensions()
  const dimensions = useMemo(
    () => [...registry].sort((a, b) => a.sort_order - b.sort_order || a.sie_dim_no - b.sie_dim_no),
    [registry],
  )
  const loadFailed = !!loadError
  // The requested tab, validated against the current registry: a dimension
  // that disappears falls back to the first one.
  const [requestedDimId, setActiveDimId] = useState<string | null>(null)
  const activeDimId =
    requestedDimId && dimensions.some((d) => d.id === requestedDimId)
      ? requestedDimId
      : (dimensions[0]?.id ?? null)
  const [searchTerm, setSearchTerm] = useState('')
  const [sortColumn, setSortColumn] = useState<SortColumn>('code')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [dialog, setDialog] = useState<DialogState>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [newDimDialogOpen, setNewDimDialogOpen] = useState(false)
  const [isCreatingDimension, setIsCreatingDimension] = useState(false)

  useEffect(() => {
    if (!loadError) return
    toast({
      title: t('load_failed_title'),
      description: getErrorMessage(loadError, { locale: errorLocale }),
      variant: 'destructive',
    })
  }, [loadError, toast, t, errorLocale])

  /** After a write: refresh the shared registry (this list and every picker). */
  const loadDimensions = useCallback(() => invalidateReferenceData('ref:dimensions'), [])

  const activeDim = useMemo(
    () => dimensions.find((d) => d.id === activeDimId) ?? null,
    [dimensions, activeDimId],
  )
  const isProjectTab = activeDim?.sie_dim_no === PROJECT_DIM_NO

  // Parent (#UNDERDIM) of the active tab's dimension, when it has one.
  const parentDimName = useMemo(() => {
    if (!activeDim || activeDim.parent_sie_dim_no == null) return null
    const parent = dimensions.find(
      (d) => d.sie_dim_no === activeDim.parent_sie_dim_no,
    )
    return parent?.name ?? `#${activeDim.parent_sie_dim_no}`
  }, [dimensions, activeDim])

  const filteredValues = useMemo(() => {
    if (!activeDim) return []
    const term = searchTerm.trim().toLowerCase()
    if (!term) return activeDim.values
    return activeDim.values.filter(
      (v) =>
        v.code.toLowerCase().includes(term) || v.name.toLowerCase().includes(term),
    )
  }, [activeDim, searchTerm])

  const sortedValues = useMemo(() => {
    const arr = [...filteredValues]
    arr.sort((a, b) => {
      let cmp = 0
      switch (sortColumn) {
        case 'code':
          cmp = compareStrings(a.code, b.code)
          break
        case 'name':
          cmp = compareStrings(a.name, b.name)
          break
        case 'status':
          cmp = Number(b.is_active) - Number(a.is_active) || compareStrings(a.code, b.code)
          break
        case 'start_date':
          cmp = compareStrings(a.start_date ?? '', b.start_date ?? '')
          break
        case 'end_date':
          cmp = compareStrings(a.end_date ?? '', b.end_date ?? '')
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [filteredValues, sortColumn, sortDir])

  const updateSort = useCallback(
    (column: SortColumn) => {
      if (column === sortColumn) {
        setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortColumn(column)
        setSortDir('asc')
      }
    },
    [sortColumn],
  )

  async function handleSubmitValue(input: DimensionValueFormInput) {
    if (!activeDim || !dialog) return
    setIsSaving(true)
    try {
      if (dialog.mode === 'edit') {
        const res = await fetch(
          `/api/dimensions/${activeDim.id}/values/${dialog.value.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: input.name,
              is_active: input.is_active,
              start_date: input.start_date,
              end_date: input.end_date,
            }),
          },
        )
        const json = await res.json().catch(() => null)
        if (!res.ok) throw json ?? new Error()
        toast({ title: t('updated_title') })
      } else {
        // "Create as archived" rides the create contract's is_active field:
        // one atomic POST, no follow-up PATCH.
        const body: Record<string, unknown> = {
          code: input.code,
          name: input.name,
          is_active: input.is_active,
        }
        if (input.start_date) body.start_date = input.start_date
        if (input.end_date) body.end_date = input.end_date
        const res = await fetch(`/api/dimensions/${activeDim.id}/values`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await res.json().catch(() => null)
        if (!res.ok) throw json ?? new Error()
        toast({
          title: t('created_title'),
          description: t('created_description', { code: input.code }),
        })
      }
      setDialog(null)
      await loadDimensions()
    } catch (err) {
      toast({
        title: t('save_failed_title'),
        description: getErrorMessage(err, { locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  async function handleCreateDimension(input: NewDimensionFormInput) {
    setIsCreatingDimension(true)
    try {
      // Contract: sie_dim_no omitted → the server picks the next free ≥20;
      // parent_sie_dim_no omitted → no #UNDERDIM hierarchy.
      const body: Record<string, unknown> = {
        name: input.name,
        resets_annually: input.resets_annually,
      }
      if (input.sie_dim_no !== null) body.sie_dim_no = input.sie_dim_no
      if (input.parent_sie_dim_no !== null) {
        body.parent_sie_dim_no = input.parent_sie_dim_no
      }
      const res = await fetch('/api/dimensions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw json ?? new Error()
      const createdId = (json?.data?.dimension as { id?: string } | undefined)?.id
      toast({ title: t('dim_created_title') })
      setNewDimDialogOpen(false)
      await loadDimensions()
      if (createdId) {
        setActiveDimId(createdId)
        setSearchTerm('')
      }
    } catch (err) {
      toast({
        title: t('save_failed_title'),
        description: getErrorMessage(err, { locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setIsCreatingDimension(false)
    }
  }

  async function handleDeleteValue() {
    if (!activeDim || dialog?.mode !== 'edit') return
    setIsSaving(true)
    try {
      const res = await fetch(
        `/api/dimensions/${activeDim.id}/values/${dialog.value.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        // Values referenced by posted lines cannot be deleted: the DB
        // retention trigger's Swedish message ("…arkivera det istället")
        // rides the error envelope; surface it verbatim.
        toast({
          title: t('delete_failed_title'),
          description: getErrorMessage(json, { locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('deleted_title') })
      setDialog(null)
      await loadDimensions()
    } finally {
      setIsSaving(false)
    }
  }

  function SortableHeader({
    column,
    label,
    className,
  }: {
    column: SortColumn
    label: string
    className?: string
  }) {
    const isActive = sortColumn === column
    const Icon = isActive ? (sortDir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown
    return (
      <th className={cn(TH_CLASS, className)}>
        <button
          type="button"
          onClick={() => updateSort(column)}
          className="inline-flex items-center gap-1 transition-colors duration-150 hover:text-foreground"
        >
          {label}
          <Icon className="h-3 w-3 opacity-70" aria-hidden="true" />
        </button>
      </th>
    )
  }

  function renderStatus(value: DimensionValueDto) {
    return value.is_active ? (
      <span className="text-muted-foreground">{t('status_active')}</span>
    ) : (
      <Badge variant="outline" className="font-normal">{t('status_archived')}</Badge>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-9 w-64" />
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    )
  }

  if (loadFailed && dimensions.length === 0) {
    return (
      <EmptyState
        icon={Tags}
        title={t('load_failed_title')}
        description={t('load_failed_description')}
        actionLabel={t('retry')}
        onAction={() => void refreshDimensions()}
      />
    )
  }

  return (
    <div className="space-y-8">
      {/* Toolbar (concept scene 31): seg per registry dimension with a
          muted value count, search, and the actions far right. */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            value={activeDimId ?? ''}
            onChange={(id) => {
              setActiveDimId(id)
              setSearchTerm('')
            }}
            options={dimensions.map((dim) => ({
              value: dim.id,
              label: (
                // data-ph-mask: dimension names are user data; the wrapper
                // keeps the segment button's inline gap between name and count.
                <span data-ph-mask="" className="inline-flex items-center gap-1.5">
                  {dim.name}
                  {dim.values.length > 0 && (
                    <span className="text-muted-foreground tabular-nums">{dim.values.length}</span>
                  )}
                </span>
              ),
            }))}
          />
          <ToolbarSearch
            placeholder={t('search_placeholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            containerClassName="min-w-[180px] max-w-xs flex-1"
          />
          <div className="ml-auto flex items-center gap-4">
            <button
              type="button"
              className={cn(QUIET_LINK_CLASS, 'disabled:pointer-events-none disabled:opacity-50')}
              disabled={!canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              onClick={() => setNewDimDialogOpen(true)}
            >
              {t('new_dimension')}
            </button>
            <Button
              disabled={!canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              onClick={() => setDialog({ mode: 'create' })}
            >
              {canWrite ? <Plus className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              {t('new_value')}
            </Button>
          </div>
        </div>
        {parentDimName && (
          <p className="text-xs text-muted-foreground">
            {t('subdimension_of', { parent: parentDimName })}
          </p>
        )}
      </div>

      {/* Value list (concept dry-table: Kod, Namn, Start, Slut, Status) */}
      {sortedValues.length === 0 ? (
        searchTerm ? (
          <EmptyState
            icon={Search}
            title={t('no_search_results_title')}
            /* data-ph-mask: the search term is user data */
            description={<span data-ph-mask="">{t('no_search_results_description', { term: searchTerm })}</span>}
          />
        ) : (
          <EmptyState
            icon={Tags}
            title={t('empty_title')}
            /* data-ph-mask: the dimension name is user data */
            description={<span data-ph-mask="">{t('empty_description', { dimension: activeDim?.name ?? '' })}</span>}
            actionLabel={canWrite ? t('new_value') : undefined}
            onAction={canWrite ? () => setDialog({ mode: 'create' }) : undefined}
          />
        )
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <SortableHeader column="code" label={t('col_code')} />
                <SortableHeader column="name" label={t('col_name')} className="w-full" />
                {isProjectTab && (
                  <>
                    <SortableHeader
                      column="start_date"
                      label={t('col_start')}
                      className="hidden text-right sm:table-cell"
                    />
                    <SortableHeader
                      column="end_date"
                      label={t('col_end')}
                      className="hidden text-right sm:table-cell"
                    />
                  </>
                )}
                <SortableHeader column="status" label={t('col_status')} />
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {sortedValues.map((value) => (
                <tr
                  key={value.id}
                  className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                  onClick={() => setDialog({ mode: 'edit', value })}
                >
                  <td className={cn(TD_CLASS, 'whitespace-nowrap font-mono tabular-nums')}>
                    {value.code}
                  </td>
                  <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                    <span className="block truncate">{value.name}</span>
                  </td>
                  {isProjectTab && (
                    <>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell')}>
                        {value.start_date ? formatDate(value.start_date) : ''}
                      </td>
                      <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell')}>
                        {value.end_date ? formatDate(value.end_date) : ''}
                      </td>
                    </>
                  )}
                  <td className={cn(TD_CLASS, 'whitespace-nowrap')}>{renderStatus(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/edit dialog */}
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            {/* data-ph-mask: the dimension name is user data */}
            <DialogTitle data-ph-mask="">
              {dialog?.mode === 'edit'
                ? t('edit_value_title')
                : t('new_value_title', { dimension: activeDim?.name ?? '' })}
            </DialogTitle>
          </DialogHeader>
          {activeDim && dialog && (
            <DimensionValueForm
              key={dialog.mode === 'edit' ? dialog.value.id : 'create'}
              dimension={activeDim}
              value={dialog.mode === 'edit' ? dialog.value : null}
              isSaving={isSaving}
              onSubmit={handleSubmitValue}
              onDelete={dialog.mode === 'edit' ? handleDeleteValue : undefined}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* New dimension dialog — the content (and thus the form state)
          unmounts on close, so each open starts from a blank form. */}
      <Dialog
        open={newDimDialogOpen}
        onOpenChange={(open) => !open && setNewDimDialogOpen(false)}
      >
        <DialogContent className="sm:max-w-lg max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('new_dimension_title')}</DialogTitle>
          </DialogHeader>
          <NewDimensionForm
            dimensions={dimensions}
            isSaving={isCreatingDimension}
            onSubmit={handleCreateDimension}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface NewDimensionFormInput {
  name: string
  /** null → omit from the POST; the server picks the next free number ≥20. */
  sie_dim_no: number | null
  resets_annually: boolean
  /** null → omit from the POST; no #UNDERDIM hierarchy. */
  parent_sie_dim_no: number | null
}

/**
 * Create form for a custom registry dimension (#DIM 20+). The parent
 * (#UNDERDIM) select is an advanced, rarely-used SIE concept — kept behind a
 * quiet disclosure so the common path stays name + number.
 */
function NewDimensionForm({
  dimensions,
  isSaving,
  onSubmit,
}: {
  /** Existing dims — active ones populate the parent select. */
  dimensions: DimensionDto[]
  isSaving: boolean
  onSubmit: (input: NewDimensionFormInput) => void | Promise<void>
}) {
  const t = useTranslations('dimensions')
  const [name, setName] = useState('')
  const [numberStr, setNumberStr] = useState('')
  const [resetsAnnually, setResetsAnnually] = useState(true)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [parent, setParent] = useState('none')
  const [nameError, setNameError] = useState<string | null>(null)
  const [numberError, setNumberError] = useState<string | null>(null)

  const parentOptions = dimensions.filter((d) => d.is_active)

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const trimmedName = name.trim()
    const trimmedNumber = numberStr.trim()
    let valid = true
    if (!trimmedName || trimmedName.length > 60) {
      setNameError(t('dim_form_name_invalid'))
      valid = false
    } else {
      setNameError(null)
    }
    let sieDimNo: number | null = null
    if (trimmedNumber) {
      const parsed = Number(trimmedNumber)
      if (!Number.isInteger(parsed) || parsed < 20) {
        setNumberError(t('dim_form_number_invalid'))
        valid = false
      } else {
        setNumberError(null)
        sieDimNo = parsed
      }
    } else {
      setNumberError(null)
    }
    if (!valid) return
    void onSubmit({
      name: trimmedName,
      sie_dim_no: sieDimNo,
      resets_annually: resetsAnnually,
      parent_sie_dim_no: parent === 'none' ? null : Number(parent),
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="new-dimension-name">{t('form_name_label')}</Label>
          <Input
            id="new-dimension-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            autoFocus
          />
          {nameError && <p className="text-xs text-destructive">{nameError}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-dimension-number">{t('dim_form_number_label')}</Label>
          <Input
            id="new-dimension-number"
            type="number"
            inputMode="numeric"
            min={20}
            step={1}
            value={numberStr}
            onChange={(e) => setNumberStr(e.target.value)}
            className="tabular-nums"
          />
          <p className="text-xs text-muted-foreground">{t('dim_form_number_help')}</p>
          {numberError && <p className="text-xs text-destructive">{numberError}</p>}
        </div>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="new-dimension-resets">{t('dim_form_resets_label')}</Label>
          <p className="text-xs text-muted-foreground max-w-md">
            {t('dim_form_resets_help')}
          </p>
        </div>
        <Switch
          id="new-dimension-resets"
          checked={resetsAnnually}
          onCheckedChange={setResetsAnnually}
        />
      </div>

      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setShowAdvanced((prev) => !prev)}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={showAdvanced}
        >
          <ChevronRight
            className={`h-3 w-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
          {t('dim_form_advanced')}
        </button>
        {showAdvanced && (
          <div className="space-y-2">
            <Label>{t('dim_form_parent_label')}</Label>
            <Select value={parent} onValueChange={setParent}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('dim_form_parent_none')}</SelectItem>
                {parentOptions.map((dim) => (
                  <SelectItem key={dim.id} value={String(dim.sie_dim_no)}>
                    {dim.name} ({dim.sie_dim_no})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t('dim_form_parent_help')}</p>
          </div>
        )}
      </div>

      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={isSaving}>
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('form_create')}
        </Button>
      </div>
    </form>
  )
}
