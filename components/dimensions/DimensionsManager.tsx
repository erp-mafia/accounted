'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDate } from '@/lib/utils'
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
  fetchDimensions,
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

  const [dimensions, setDimensions] = useState<DimensionDto[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [activeDimId, setActiveDimId] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [sortColumn, setSortColumn] = useState<SortColumn>('code')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [dialog, setDialog] = useState<DialogState>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [newDimDialogOpen, setNewDimDialogOpen] = useState(false)
  const [isCreatingDimension, setIsCreatingDimension] = useState(false)

  const loadDimensions = useCallback(
    async (showSpinner: boolean) => {
      if (showSpinner) setIsLoading(true)
      try {
        const dims = await fetchDimensions()
        const sorted = [...dims].sort(
          (a, b) => a.sort_order - b.sort_order || a.sie_dim_no - b.sie_dim_no,
        )
        setDimensions(sorted)
        setLoadFailed(false)
        setActiveDimId((prev) =>
          prev && sorted.some((d) => d.id === prev) ? prev : (sorted[0]?.id ?? null),
        )
      } catch (err) {
        setLoadFailed(true)
        toast({
          title: t('load_failed_title'),
          description: getErrorMessage(err, { locale: errorLocale }),
          variant: 'destructive',
        })
      } finally {
        setIsLoading(false)
      }
    },
    [toast, t, errorLocale],
  )

  useEffect(() => {
    void loadDimensions(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      await loadDimensions(false)
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
      await loadDimensions(false)
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
      await loadDimensions(false)
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
      <TableHead className={className}>
        <button
          type="button"
          onClick={() => updateSort(column)}
          className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        >
          {label}
          <Icon className="h-3 w-3 opacity-70" aria-hidden="true" />
        </button>
      </TableHead>
    )
  }

  function renderStatusBadge(value: DimensionValueDto) {
    return value.is_active ? (
      <Badge variant="success">{t('status_active')}</Badge>
    ) : (
      <Badge variant="secondary">{t('status_archived')}</Badge>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-10 w-64" />
        <Card>
          <CardContent className="p-6 space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    )
  }

  if (loadFailed && dimensions.length === 0) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={Tags}
            title={t('load_failed_title')}
            description={t('load_failed_description')}
            actionLabel={t('retry')}
            onAction={() => void loadDimensions(true)}
          />
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-8">
      {/* Segmented tabs: one per registry dimension (1 Kostnadsställe,
          6 Projekt, plus any custom 20+ dims) */}
      <div className="space-y-2">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <Tabs
            value={activeDimId ?? undefined}
            onValueChange={(id) => {
              setActiveDimId(id)
              setSearchTerm('')
            }}
          >
            <TabsList>
              {dimensions.map((dim) => (
                <TabsTrigger key={dim.id} value={dim.id}>
                  {dim.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              disabled={!canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              onClick={() => setNewDimDialogOpen(true)}
            >
              {t('new_dimension')}
            </Button>
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

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('search_placeholder')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Value list */}
      {sortedValues.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            {searchTerm ? (
              <EmptyState
                icon={Search}
                title={t('no_search_results_title')}
                description={t('no_search_results_description', { term: searchTerm })}
              />
            ) : (
              <EmptyState
                icon={Tags}
                title={t('empty_title')}
                description={t('empty_description', { dimension: activeDim?.name ?? '' })}
                actionLabel={canWrite ? t('new_value') : undefined}
                onAction={canWrite ? () => setDialog({ mode: 'create' }) : undefined}
              />
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader column="code" label={t('col_code')} />
                    <SortableHeader column="name" label={t('col_name')} />
                    <SortableHeader column="status" label={t('col_status')} />
                    {isProjectTab && (
                      <>
                        <SortableHeader column="start_date" label={t('col_start')} />
                        <SortableHeader column="end_date" label={t('col_end')} />
                      </>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedValues.map((value) => (
                    <TableRow
                      key={value.id}
                      className="cursor-pointer"
                      onClick={() => setDialog({ mode: 'edit', value })}
                    >
                      <TableCell className="font-mono">{value.code}</TableCell>
                      <TableCell className="font-medium">{value.name}</TableCell>
                      <TableCell>{renderStatusBadge(value)}</TableCell>
                      {isProjectTab && (
                        <>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {value.start_date ? formatDate(value.start_date) : '-'}
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {value.end_date ? formatDate(value.end_date) : '-'}
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Mobile card list */}
          <div className="grid gap-4 md:hidden">
            {sortedValues.map((value) => (
              <Card
                key={value.id}
                className="cursor-pointer transition-colors duration-150 hover:bg-secondary/60"
                onClick={() => setDialog({ mode: 'edit', value })}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-sm">{value.code}</p>
                      <p className="text-sm text-muted-foreground mt-1 truncate">
                        {value.name}
                      </p>
                    </div>
                    {renderStatusBadge(value)}
                  </div>
                </CardHeader>
                {isProjectTab && (value.start_date || value.end_date) && (
                  <CardContent>
                    <p className="text-sm text-muted-foreground tabular-nums">
                      {value.start_date ? formatDate(value.start_date) : '-'}
                      {' till '}
                      {value.end_date ? formatDate(value.end_date) : '-'}
                    </p>
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      {/* Create/edit dialog */}
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
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
