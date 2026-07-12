'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Loader2, Trash2, Plus, ChevronDown, Download, Upload, Building2, Users, Globe, Pencil, Copy } from 'lucide-react'
import { TEMPLATE_CATEGORY_LABELS, convertLibraryToBookingTemplate } from '@/lib/bookkeeping/template-library'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { TemplateForm } from '@/components/settings/TemplateForm'
import type { BookingTemplateLibrary, BookingTemplateLibraryLine } from '@/types'

export function BookingTemplatesPanel() {
  const t = useTranslations('settings_booking_templates')
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const ENTITY_LABELS: Record<string, string> = {
    all: t('entity_all'),
    enskild_firma: t('entity_enskild_firma'),
    aktiebolag: t('entity_aktiebolag'),
  }

  const [templates, setTemplates] = useState<BookingTemplateLibrary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  // Shared dialog for editing a company/team template or customizing (duplicating)
  // a read-only system template. Mode is derived from is_system.
  const [activeTemplate, setActiveTemplate] = useState<BookingTemplateLibrary | null>(null)
  const importRef = useRef<HTMLInputElement>(null)

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/booking-templates')
      const json = await res.json()
      if (json.data) setTemplates(json.data)
    } catch {
      toast({ title: t('toast_fetch_failed'), variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [toast, t])

  useEffect(() => { fetchTemplates() }, [fetchTemplates])

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
      setTemplates((prev) => prev.filter((tt) => tt.id !== id))
      toast({ title: t('toast_deleted') })
    } finally {
      setDeletingId(null)
    }
  }

  async function handleExport() {
    try {
      const res = await fetch('/api/settings/booking-templates/export')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'bokforingsmallar.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast({ title: t('toast_export_failed'), variant: 'destructive' })
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
      fetchTemplates()
    } catch {
      toast({ title: t('toast_import_error'), description: t('toast_invalid_file'), variant: 'destructive' })
    } finally {
      // Reset input so same file can be imported again
      if (importRef.current) importRef.current.value = ''
    }
  }

  // Group templates by scope
  const systemTemplates = templates.filter((tt) => tt.is_system)
  const teamTemplates = templates.filter((tt) => tt.team_id && !tt.is_system)
  const companyTemplates = templates.filter((tt) => tt.company_id && !tt.is_system)

  // Names of existing company templates: used for a soft "name already exists"
  // hint when creating or customizing (never blocks save).
  const companyTemplateNames = companyTemplates.map((tt) => tt.name)

  return (
    <>
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base">{t('title')}</CardTitle>
            <CardDescription>
              {t('description')}
            </CardDescription>
          </div>
          {canWrite && (
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={handleExport}>
                <Download className="h-3.5 w-3.5 mr-1.5" />
                {t('export')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => importRef.current?.click()}>
                <Upload className="h-3.5 w-3.5 mr-1.5" />
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
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
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
                      fetchTemplates()
                    }}
                  />
                </DialogContent>
              </Dialog>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : templates.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-12">
            {t('empty_state')}
          </p>
        ) : (
          <div className="space-y-6">
            {/* System templates */}
            {systemTemplates.length > 0 && (
              <TemplateSection
                title={t('section_system')}
                icon={Globe}
                templates={systemTemplates}
                expandedId={expandedId}
                onToggle={setExpandedId}
                deletingId={deletingId}
                onDelete={handleDelete}
                canDelete={false}
                canEdit={false}
                canCustomize={canWrite}
                onCustomize={setActiveTemplate}
                entityLabels={ENTITY_LABELS}
              />
            )}

            {/* Team templates */}
            {teamTemplates.length > 0 && (
              <TemplateSection
                title={t('section_team')}
                icon={Users}
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
                icon={Building2}
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
          </div>
        )}
      </CardContent>
    </Card>

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
              fetchTemplates()
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
  icon: Icon,
  templates,
  expandedId,
  onToggle,
  deletingId,
  onDelete,
  canDelete,
  canEdit = false,
  canCustomize = false,
  onEdit,
  onCustomize,
  entityLabels,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  templates: BookingTemplateLibrary[]
  expandedId: string | null
  onToggle: (id: string | null) => void
  deletingId: string | null
  onDelete: (id: string) => void
  canDelete: boolean
  canEdit?: boolean
  canCustomize?: boolean
  onEdit?: (template: BookingTemplateLibrary) => void
  onCustomize?: (template: BookingTemplateLibrary) => void
  entityLabels: Record<string, string>
}) {
  const t = useTranslations('settings_booking_templates')
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-xs text-muted-foreground tabular-nums">{templates.length}</span>
      </div>
      <div className="space-y-1">
        {templates.map((tt) => {
          const isExpanded = expandedId === tt.id
          const isConvertible = convertLibraryToBookingTemplate(tt) !== null
          return (
            <div
              key={tt.id}
              className="rounded-lg border"
            >
              <div className="flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors">
                <button
                  type="button"
                  onClick={() => onToggle(isExpanded ? null : tt.id)}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left"
                >
                  <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-0' : '-rotate-90'}`} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{tt.name}</span>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      <span className="text-xs text-muted-foreground">
                        {TEMPLATE_CATEGORY_LABELS[tt.category]}
                        {tt.entity_type !== 'all' && ` · ${entityLabels[tt.entity_type]}`}
                      </span>
                      {!isConvertible && (
                        <Badge variant="warning" className="text-[10px] px-1.5 py-0">
                          {t('unconvertible_badge')}
                        </Badge>
                      )}
                    </div>
                  </div>
                </button>
                {canCustomize && onCustomize && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onCustomize(tt)}
                    aria-label={t('customize')}
                    title={t('customize')}
                    className="h-8 w-8 p-0 shrink-0"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                )}
                {canEdit && onEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEdit(tt)}
                    aria-label={t('edit')}
                    title={t('edit')}
                    className="h-8 w-8 p-0 shrink-0"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
                {canDelete && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(tt.id)}
                    disabled={deletingId === tt.id}
                    className="h-8 w-8 p-0 shrink-0"
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
                <div className="px-3 pb-3 pt-0">
                  {tt.description && (
                    <p className="text-xs text-muted-foreground mb-2">{tt.description}</p>
                  )}
                  <table className="w-full text-xs">
                    <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                      <tr className="border-b">
                        <th className="text-left py-1 w-14">{t('th_account')}</th>
                        <th className="text-left py-1">{t('th_description')}</th>
                        <th className="text-center py-1 w-16">{t('th_type')}</th>
                        <th className="text-right py-1 w-12">{t('th_debit')}</th>
                        <th className="text-right py-1 w-12">{t('th_credit')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tt.lines.map((line: BookingTemplateLibraryLine, i: number) => (
                        <tr key={i} className="border-b last:border-0">
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
    </div>
  )
}
