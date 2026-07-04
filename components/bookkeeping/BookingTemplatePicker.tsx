'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { BookOpen, Search, Building2, Users, Globe } from 'lucide-react'
import { TEMPLATE_CATEGORY_LABELS, SCOPE_LABELS, getTemplateScope, applyTemplate } from '@/lib/bookkeeping/template-library'
import type { BookingTemplateLibrary, BookingTemplateCategory, EntityType } from '@/types'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'

interface Props {
  onApply: (lines: FormLine[], description: string) => void
  entityType?: EntityType
  /** Prefill the "total amount" field when the caller already knows it (e.g.
   *  booking from an underlag with a known total). The user can still edit it. */
  defaultAmount?: number
}

const SCOPE_ICONS = {
  system: Globe,
  team: Users,
  company: Building2,
} as const

export default function BookingTemplatePicker({ onApply, entityType, defaultAmount }: Props) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [templates, setTemplates] = useState<BookingTemplateLibrary[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<BookingTemplateCategory | 'all'>('all')
  const [amount, setAmount] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Prefill the amount from the caller's known total each time the picker
  // opens. Only when provided: callers without a known amount (e.g. the
  // journal-entry form) keep the blank-then-type behaviour.
  useEffect(() => {
    if (open && defaultAmount != null && defaultAmount > 0) {
      setAmount(String(Math.round(defaultAmount * 100) / 100))
    }
  }, [open, defaultAmount])

  const fetchTemplates = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true)
    try {
      const r = await fetch('/api/settings/booking-templates', { signal })
      const { data } = await r.json()
      setTemplates(data || [])
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toast({ title: 'Kunde inte hämta mallar', variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [toast])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    fetchTemplates(controller.signal)
    return () => { controller.abort() }
  }, [open, fetchTemplates])

  const filtered = useMemo(() => {
    let result = templates

    // Filter by entity type
    if (entityType) {
      result = result.filter((t) => t.entity_type === 'all' || t.entity_type === entityType)
    }

    // Filter by category
    if (selectedCategory !== 'all') {
      result = result.filter((t) => t.category === selectedCategory)
    }

    // Filter by search
    if (search) {
      const lower = search.toLowerCase()
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(lower) ||
          t.description.toLowerCase().includes(lower),
      )
    }

    return result
  }, [templates, entityType, selectedCategory, search])

  // Unique categories present in templates
  const availableCategories = useMemo(() => {
    const cats = new Set(templates.map((t) => t.category))
    return Array.from(cats).sort()
  }, [templates])

  const selected = selectedId ? templates.find((t) => t.id === selectedId) : null

  function handleApply() {
    if (!selected) return
    const totalAmount = parseFloat(amount)
    if (!totalAmount || totalAmount <= 0) {
      toast({ title: 'Ange belopp', description: 'Ange ett belopp för att använda mallen.', variant: 'destructive' })
      return
    }
    const lines = applyTemplate(selected.lines, totalAmount)
    // Fire-and-forget MRU bump so this template surfaces at the top next time.
    fetch(`/api/settings/booking-templates/${selected.id}/touch`, { method: 'POST' }).catch(() => {})
    onApply(lines, selected.name)
    setOpen(false)
    setSelectedId(null)
    setAmount('')
    setSearch('')
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" type="button">
          <BookOpen className="h-3.5 w-3.5 mr-1.5" />
          Använd mall
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Bokföringsmallar</DialogTitle>
        </DialogHeader>

        {/* Search + category filter */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Sök mall..."
              className="pl-9"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            <Button
              variant={selectedCategory === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSelectedCategory('all')}
              type="button"
            >
              Alla
            </Button>
            {availableCategories.map((cat) => (
              <Button
                key={cat}
                variant={selectedCategory === cat ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedCategory(cat as BookingTemplateCategory)}
                type="button"
              >
                {TEMPLATE_CATEGORY_LABELS[cat as BookingTemplateCategory]}
              </Button>
            ))}
          </div>
        </div>

        {/* Template list */}
        <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Laddar mallar...</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Inga mallar hittades.</p>
          ) : (
            filtered.map((t) => {
              const scope = getTemplateScope(t)
              const ScopeIcon = SCOPE_ICONS[scope]
              const isSelected = selectedId === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedId(isSelected ? null : t.id)}
                  className={`w-full text-left rounded-lg border p-3 transition-colors ${
                    isSelected
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/40 hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">{t.name}</div>
                      <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5">
                        <ScopeIcon className="h-3 w-3 shrink-0" />
                        <span>
                          {SCOPE_LABELS[scope]}
                          {t.entity_type !== 'all' &&
                            ` · ${t.entity_type === 'enskild_firma' ? 'EF' : 'AB'}`}
                        </span>
                      </div>
                      {t.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {t.description}
                        </p>
                      )}
                    </div>
                  </div>
                  {/* Show lines preview when selected */}
                  {isSelected && (
                    <div className="mt-2 pt-2 border-t space-y-1">
                      {t.lines.map((line, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                          <span className="w-10">{line.account}</span>
                          <span className="flex-1 truncate">{line.label}</span>
                          <span className={line.side === 'debit' ? 'text-foreground' : ''}>
                            {line.side === 'debit' ? (line.type === 'vat' && line.vat_rate ? `${(line.vat_rate * 100).toFixed(0)}% moms` : 'D') : ''}
                          </span>
                          <span className={line.side === 'credit' ? 'text-foreground' : ''}>
                            {line.side === 'credit' ? (line.type === 'vat' && line.vat_rate ? `${(line.vat_rate * 100).toFixed(0)}% moms` : 'K') : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </button>
              )
            })
          )}
        </div>

        {/* Apply section */}
        {selected && (
          <div className="flex items-end gap-3 pt-3 border-t">
            <div className="flex-1">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Totalt belopp (inkl. moms)
              </label>
              <Input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0,00"
                min="0"
                step="0.01"
                inputMode="decimal"
                autoFocus
              />
            </div>
            <Button onClick={handleApply} type="button">
              Använd mall
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
