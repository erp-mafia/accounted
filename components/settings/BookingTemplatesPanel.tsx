'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { HelpPopover } from '@/components/ui/help-popover'
import { useToast } from '@/components/ui/use-toast'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { SettingsGroup } from '@/components/settings/SettingsRows'
import { Loader2, Trash2, Plus, ChevronDown, Download, Upload, Pencil, Copy, Eye, EyeOff } from 'lucide-react'
import { TEMPLATE_CATEGORY_LABELS, convertLibraryToBookingTemplate } from '@/lib/bookkeeping/template-library'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { TemplateForm } from '@/components/settings/TemplateForm'
import { downloadFile } from '@/lib/browser/download-file'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { cn } from '@/lib/utils'
import type { BookingTemplateLibrary, BookingTemplateLibraryLine } from '@/types'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { useBookingTemplates } from '@/lib/reference-data/hooks'

export function BookingTemplatesPanel() {
  const t = useTranslations('settings_booking_templates')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const ENTITY_LABELS: Record<string, string> = {
    all: t('entity_all'),
    enskild_firma: t('entity_enskild_firma'),
    aktiebolag: t('entity_aktiebolag'),
  }

  // The panel renders the same session-cached list the pickers use
  // (lib/reference-data); every write below invalidates it so registry and
  // pickers can never disagree.
  const { templates, isLoading, error: templatesError } = useBookingTemplates()
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [hidingId, setHidingId] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  // Shared dialog for editing a company/team template or customizing (duplicating)
  // a read-only system template. Mode is derived from is_system.
  const [activeTemplate, setActiveTemplate] = useState<BookingTemplateLibrary | null>(null)
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (templatesError) toast({ title: t('toast_fetch_failed'), variant: 'destructive' })
  }, [templatesError, toast, t])

  const refreshTemplates = () => {
    void invalidateReferenceData('ref:booking-templates')
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      const res = await fetch('/api/settings/booking-templates', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) {
        toast({ title: t('toast_delete_failed'), variant: 'destructive' })
        return
      }
      // This list and every picker read the session cache: refresh it.
      void invalidateReferenceData('ref:booking-templates')
      toast({ title: t('toast_deleted') })
    } finally {
      setDeletingId(null)
    }
  }

  // Hide/unhide a system template for the current company only. Opt-in per
  // company: hidden templates stay listed in the collapsed section below so
  // nothing ever disappears silently.
  async function handleToggleHidden(id: string, hide: boolean) {
    setHidingId(id)
    try {
      const res = await fetch(`/api/settings/booking-templates/${id}/hide`, {
        method: hide ? 'POST' : 'DELETE',
      })
      if (!res.ok) {
        toast({
          title: hide ? t('toast_hide_failed') : t('toast_unhide_failed'),
          variant: 'destructive',
        })
        return
      }
      void invalidateReferenceData('ref:booking-templates')
      toast({ title: hide ? t('toast_hidden') : t('toast_unhidden') })
    } catch {
      // fetch itself rejected (network); same failure toast as a non-ok status.
      toast({
        title: hide ? t('toast_hide_failed') : t('toast_unhide_failed'),
        variant: 'destructive',
      })
    } finally {
      setHidingId(null)
    }
  }

  async function handleExport() {
    // The button is disabled while a run is in flight; this also covers the
    // keyboard/double-click race before React has re-rendered it.
    if (isExporting) return
    setIsExporting(true)
    try {
      const result = await downloadFile({
        url: '/api/settings/booking-templates/export',
        filename: 'bokforingsmallar.json',
        locale,
      })
      // Success is silent on purpose: the saved file is the feedback. On
      // failure nothing was written to disk, so exactly one toast tells the
      // user why. Never two: TOAST_LIMIT is 1, so a second toast in the same
      // tick evicts the first and only the last one is ever rendered.
      if (!result.ok) {
        toast({
          title: t('toast_export_failed'),
          description:
            result.reason === 'timeout' ? t('toast_export_timeout') : result.message,
          variant: 'destructive',
        })
      }
    } finally {
      setIsExporting(false)
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const payload = JSON.parse(text)
      const res = await fetch('/api/settings/booking-templates/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: t('toast_import_error'), description: json.error || t('toast_import_generic'), variant: 'destructive' })
        return
      }
      toast({ title: t('toast_import_done'), description: t('toast_import_count', { count: json.imported }) })
      refreshTemplates()
    } catch {
      toast({ title: t('toast_import_error'), description: t('toast_invalid_file'), variant: 'destructive' })
    } finally {
      // Reset input so same file can be imported again
      if (importRef.current) importRef.current.value = ''
    }
  }

  // Group templates by scope. Hidden system templates get their own collapsed
  // section instead of vanishing: the hide feature is per-company and always
  // reversible from here.
  const systemTemplates = templates.filter((tt) => tt.is_system && !tt.is_hidden)
  const hiddenSystemTemplates = templates.filter((tt) => tt.is_system && tt.is_hidden)
  const teamTemplates = templates.filter((tt) => tt.team_id && !tt.is_system)
  const companyTemplates = templates.filter((tt) => tt.company_id && !tt.is_system)

  // Names of existing company templates: used for a soft "name already exists"
  // hint when creating or customizing (never blocks save).
  const companyTemplateNames = companyTemplates.map((tt) => tt.name)

  return (
    <>
    <SettingsGroup>
      {/* Group eyebrow with the panel's actions on the right: export/import as
          quiet buttons, "Ny mall" as the one pill. The old card description
          lives behind the "?". */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1">
        <p className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <span>{t('title')}</span>
          <HelpPopover className="shrink-0">{t('description')}</HelpPopover>
        </p>
        {canWrite && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={isExporting}
              className="text-muted-foreground hover:text-foreground"
            >
              {isExporting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t('export')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => importRef.current?.click()}
              className="text-muted-foreground hover:text-foreground"
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {t('import')}
            </Button>
            <input
              ref={importRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleImport}
            />
            <Dialog open={showCreate} onOpenChange={setShowCreate}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  {t('new_template')}
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>{t('create_dialog_title')}</DialogTitle>
                </DialogHeader>
                <TemplateForm
                  mode="create"
                  entityLabels={ENTITY_LABELS}
                  duplicateNamePool={companyTemplateNames}
                  onSaved={() => {
                    setShowCreate(false)
                    refreshTemplates()
                  }}
                />
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : templates.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {t('empty_state')}
        </p>
      ) : null}
    </SettingsGroup>

    {!isLoading && templates.length > 0 && (
      <>
        {/* System templates */}
        {systemTemplates.length > 0 && (
          <TemplateSection
            title={t('section_system')}
            templates={systemTemplates}
            expandedId={expandedId}
            onToggle={setExpandedId}
            deletingId={deletingId}
            onDelete={handleDelete}
            canDelete={false}
            canEdit={false}
            canCustomize={canWrite}
            onCustomize={setActiveTemplate}
            canHide={canWrite}
            onHide={(tt) => handleToggleHidden(tt.id, true)}
            hidingId={hidingId}
            entityLabels={ENTITY_LABELS}
          />
        )}

        {/* Hidden system templates: collapsed by default, restore per row.
            Kept visible as a section so hiding is never silent. */}
        {hiddenSystemTemplates.length > 0 && (
          <SettingsGroup>
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              aria-expanded={showHidden}
              className="flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              <ChevronDown
                className={cn('h-4 w-4 shrink-0 transition-transform', !showHidden && '-rotate-90')}
              />
              <span>{t('section_hidden')}</span>
              <span className="tabular-nums">{hiddenSystemTemplates.length}</span>
            </button>
            {showHidden && (
              <div>
                {hiddenSystemTemplates.map((tt) => (
                  <div
                    key={tt.id}
                    className="flex items-center gap-3 border-b border-border px-1 py-3 transition-colors duration-150 hover:bg-secondary/60"
                  >
                    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="truncate text-sm text-muted-foreground">{tt.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {TEMPLATE_CATEGORY_LABELS[tt.category]}
                        {tt.entity_type !== 'all' && ` · ${ENTITY_LABELS[tt.entity_type]}`}
                      </span>
                    </span>
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleToggleHidden(tt.id, false)}
                        disabled={hidingId === tt.id}
                        aria-label={t('unhide')}
                        title={t('unhide')}
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        {hidingId === tt.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </SettingsGroup>
        )}

        {/* Team templates */}
        {teamTemplates.length > 0 && (
          <TemplateSection
            title={t('section_team')}
            templates={teamTemplates}
            expandedId={expandedId}
            onToggle={setExpandedId}
            deletingId={deletingId}
            onDelete={handleDelete}
            canDelete={canWrite}
            canEdit={canWrite}
            onEdit={setActiveTemplate}
            entityLabels={ENTITY_LABELS}
          />
        )}

        {/* Company templates */}
        {companyTemplates.length > 0 && (
          <TemplateSection
            title={t('section_company')}
            templates={companyTemplates}
            expandedId={expandedId}
            onToggle={setExpandedId}
            deletingId={deletingId}
            onDelete={handleDelete}
            canDelete={canWrite}
            canEdit={canWrite}
            onEdit={setActiveTemplate}
            entityLabels={ENTITY_LABELS}
          />
        )}
      </>
    )}

    {/* Shared edit / customize dialog. Editing a company or team template uses
        PUT; customizing a read-only system template creates a company-scoped
        copy via POST. The form is keyed by template id so it re-seeds state when
        switching between rows. */}
    <Dialog open={!!activeTemplate} onOpenChange={(open) => { if (!open) setActiveTemplate(null) }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {activeTemplate?.is_system ? t('customize_dialog_title') : t('edit_dialog_title')}
          </DialogTitle>
        </DialogHeader>
        {activeTemplate && (
          <TemplateForm
            key={activeTemplate.id}
            mode={activeTemplate.is_system ? 'duplicate' : 'edit'}
            initialTemplate={activeTemplate}
            entityLabels={ENTITY_LABELS}
            duplicateNamePool={companyTemplateNames}
            onSaved={() => {
              setActiveTemplate(null)
              refreshTemplates()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
    </>
  )
}

function TemplateSection({
  title,
  templates,
  expandedId,
  onToggle,
  deletingId,
  onDelete,
  canDelete,
  canEdit = false,
  canCustomize = false,
  canHide = false,
  onEdit,
  onCustomize,
  onHide,
  hidingId = null,
  entityLabels,
}: {
  title: string
  templates: BookingTemplateLibrary[]
  expandedId: string | null
  onToggle: (id: string | null) => void
  deletingId: string | null
  onDelete: (id: string) => void
  canDelete: boolean
  canEdit?: boolean
  canCustomize?: boolean
  canHide?: boolean
  onEdit?: (template: BookingTemplateLibrary) => void
  onCustomize?: (template: BookingTemplateLibrary) => void
  onHide?: (template: BookingTemplateLibrary) => void
  hidingId?: string | null
  entityLabels: Record<string, string>
}) {
  const t = useTranslations('settings_booking_templates')
  const tCommon = useTranslations('common')
  return (
    <SettingsGroup>
      {/* Origin eyebrow with count; mirrors SettingsGroup's label line. */}
      <p className="flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <span>{title}</span>
        <span className="tabular-nums">{templates.length}</span>
      </p>
      <div>
        {templates.map((tt) => {
          const isExpanded = expandedId === tt.id
          const isConvertible = convertLibraryToBookingTemplate(tt) !== null
          return (
            <div key={tt.id} className="border-b border-border">
              <div className="flex items-center gap-3 px-1 py-3 transition-colors duration-150 hover:bg-secondary/60">
                <button
                  type="button"
                  onClick={() => onToggle(isExpanded ? null : tt.id)}
                  aria-expanded={isExpanded}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                      !isExpanded && '-rotate-90',
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="truncate text-sm">{tt.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {TEMPLATE_CATEGORY_LABELS[tt.category]}
                      {tt.entity_type !== 'all' && ` · ${entityLabels[tt.entity_type]}`}
                    </span>
                    {!isConvertible && (
                      <Badge variant="warning" className="px-1.5 py-0 text-[10px]">
                        {t('unconvertible_badge')}
                      </Badge>
                    )}
                  </span>
                </button>
                {canCustomize && onCustomize && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onCustomize(tt)}
                    aria-label={t('customize')}
                    title={t('customize')}
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                )}
                {canHide && onHide && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onHide(tt)}
                    disabled={hidingId === tt.id}
                    aria-label={t('hide')}
                    title={t('hide')}
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    {hidingId === tt.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <EyeOff className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}
                {canEdit && onEdit && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onEdit(tt)}
                    aria-label={t('edit')}
                    title={t('edit')}
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
                {canDelete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onDelete(tt.id)}
                    disabled={deletingId === tt.id}
                    aria-label={tCommon('delete')}
                    title={tCommon('delete')}
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    {deletingId === tt.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}
              </div>
              {isExpanded && (
                <div className="px-1 pb-3">
                  {tt.description && (
                    <p className="mb-2 text-xs text-muted-foreground">{tt.description}</p>
                  )}
                  <table className="w-full text-xs">
                    <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                      <tr className="border-b border-border">
                        <th className="w-14 py-1 text-left">{t('th_account')}</th>
                        <th className="py-1 text-left">{t('th_description')}</th>
                        <th className="w-16 py-1 text-center">{t('th_type')}</th>
                        <th className="w-12 py-1 text-right">{t('th_debit')}</th>
                        <th className="w-12 py-1 text-right">{t('th_credit')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tt.lines.map((line: BookingTemplateLibraryLine, i: number) => (
                        <tr key={i} className="border-b border-border last:border-0">
                          <td className="py-1 font-mono">{line.account}</td>
                          <td className="py-1">{line.label}</td>
                          <td className="py-1 text-center">
                            {line.type === 'vat' && line.vat_rate
                              ? t('vat_with_rate', { rate: (line.vat_rate * 100).toFixed(0) })
                              : line.type === 'settlement' ? t('type_settlement') : t('type_cost_revenue')}
                          </td>
                          <td className="py-1 text-right">{line.side === 'debit' ? t('debit_short') : ''}</td>
                          <td className="py-1 text-right">{line.side === 'credit' ? t('credit_short') : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </SettingsGroup>
  )
}
