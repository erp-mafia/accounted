'use client'

import { useCallback, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import {
  INVOICE_EMAIL_DEFAULT_TEXTS,
  INVOICE_EMAIL_PLACEHOLDER_KEYS,
} from '@/lib/email/invoice-templates'
import type { CompanySettings, InvoiceEmailTextOverrides, InvoiceEmailTexts } from '@/types'

interface InvoiceEmailTextsSettingsProps {
  settings: CompanySettings
  onUpdate: (updates: Partial<CompanySettings>) => void
}

type Lang = 'sv' | 'en'
type Field = keyof InvoiceEmailTextOverrides

const LANGS: Lang[] = ['sv', 'en']

const FIELD_CONFIG: Array<{ field: Field; labelKey: string; multiline?: boolean }> = [
  { field: 'subject', labelKey: 'subject_label' },
  { field: 'greeting', labelKey: 'greeting_label' },
  { field: 'body', labelKey: 'body_label', multiline: true },
  { field: 'signoff', labelKey: 'signoff_label' },
]

// The editor always shows the EFFECTIVE text (override or standard), never an
// empty field: users see and edit the mail that actually goes out.
type DisplayTexts = Record<Lang, Record<Field, string>>

function buildDisplay(stored: InvoiceEmailTexts | null | undefined): DisplayTexts {
  const result = {} as DisplayTexts
  for (const lang of LANGS) {
    result[lang] = {} as Record<Field, string>
    for (const { field } of FIELD_CONFIG) {
      const value = stored?.[lang]?.[field]
      result[lang][field] =
        typeof value === 'string' && value.trim() !== ''
          ? value
          : INVOICE_EMAIL_DEFAULT_TEXTS[lang][field]
    }
  }
  return result
}

// Cleared fields have no meaning of their own: snap them back to standard.
function normalize(display: DisplayTexts): DisplayTexts {
  const result = {} as DisplayTexts
  for (const lang of LANGS) {
    result[lang] = {} as Record<Field, string>
    for (const { field } of FIELD_CONFIG) {
      const value = display[lang][field]
      result[lang][field] =
        value.trim() === '' ? INVOICE_EMAIL_DEFAULT_TEXTS[lang][field] : value
    }
  }
  return result
}

// Store only changes: a field equal to the standard text is NOT an override,
// so future improvements to the standard wording reach every company that
// hasn't customized. Empty result → null (column reads "all defaults").
function toOverrides(display: DisplayTexts): InvoiceEmailTexts | null {
  const result: InvoiceEmailTexts = {}
  for (const lang of LANGS) {
    const langOverrides: InvoiceEmailTextOverrides = {}
    for (const { field } of FIELD_CONFIG) {
      const value = display[lang][field].trim()
      if (value !== '' && value !== INVOICE_EMAIL_DEFAULT_TEXTS[lang][field]) {
        langOverrides[field] = value
      }
    }
    if (Object.keys(langOverrides).length > 0) result[lang] = langOverrides
  }
  return Object.keys(result).length > 0 ? result : null
}

export function InvoiceEmailTextsSettings({ settings, onUpdate }: InvoiceEmailTextsSettingsProps) {
  const t = useTranslations('settings_email_texts')
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const [texts, setTexts] = useState<DisplayTexts>(() => buildDisplay(settings.invoice_email_texts))
  // Serialized last-persisted overrides: skips no-op PUTs on blur without
  // edits. toOverrides() builds keys in a fixed order, so comparison is stable.
  const lastSavedRef = useRef<string>(
    JSON.stringify(toOverrides(buildDisplay(settings.invoice_email_texts))),
  )

  const setField = (lang: Lang, field: Field, value: string) => {
    setTexts((prev) => ({ ...prev, [lang]: { ...prev[lang], [field]: value } }))
  }

  // Whole-object save: a JSONB column update replaces the stored value, and
  // the inactive language tab is unmounted, so per-field PATCHes can't work.
  const persist = useCallback(async (display: DisplayTexts) => {
    const overrides = toOverrides(display)
    const serialized = JSON.stringify(overrides)
    if (serialized === lastSavedRef.current) return
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_email_texts: overrides }),
      })
      if (!response.ok) throw new Error()
      lastSavedRef.current = serialized
      onUpdate({ invoice_email_texts: overrides })
    } catch {
      toast({ title: t('toast_save_failed'), variant: 'destructive' })
    }
  }, [onUpdate, toast, t])

  const handleBlur = () => {
    const normalized = normalize(texts)
    setTexts(normalized)
    void persist(normalized)
  }

  const resetField = (lang: Lang, field: Field) => {
    const next = {
      ...texts,
      [lang]: { ...texts[lang], [field]: INVOICE_EMAIL_DEFAULT_TEXTS[lang][field] },
    }
    setTexts(next)
    void persist(next)
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('heading')}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('description')}</p>
      </div>

      <Tabs defaultValue="sv">
        <TabsList>
          <TabsTrigger value="sv">{t('tab_sv')}</TabsTrigger>
          <TabsTrigger value="en">{t('tab_en')}</TabsTrigger>
        </TabsList>
        {LANGS.map((lang) => (
          <TabsContent key={lang} value={lang} className="mt-4 space-y-4">
            {lang === 'en' && (
              <p className="text-xs text-muted-foreground">{t('en_tab_hint')}</p>
            )}
            {FIELD_CONFIG.map(({ field, labelKey, multiline }) => {
              const id = `invoice-email-${field}-${lang}`
              const modified =
                texts[lang][field].trim() !== INVOICE_EMAIL_DEFAULT_TEXTS[lang][field]
              const common = {
                id,
                value: texts[lang][field],
                onBlur: handleBlur,
                disabled: !canWrite,
              }
              return (
                <div key={field} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor={id}>{t(labelKey)}</Label>
                    {modified && canWrite && (
                      <button
                        type="button"
                        onClick={() => resetField(lang, field)}
                        className="text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
                      >
                        {t('reset_label')}
                      </button>
                    )}
                  </div>
                  {multiline ? (
                    <Textarea
                      {...common}
                      rows={4}
                      onChange={(e) => setField(lang, field, e.target.value)}
                    />
                  ) : (
                    <Input
                      {...common}
                      onChange={(e) => setField(lang, field, e.target.value)}
                    />
                  )}
                </div>
              )
            })}
          </TabsContent>
        ))}
      </Tabs>

      <div className="space-y-1">
        {/* Legend is rendered from code, not messages/*.json: ICU message
            syntax treats literal braces as interpolation. */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{t('placeholders_help')}</span>
          {INVOICE_EMAIL_PLACEHOLDER_KEYS.map((key) => (
            <code key={key} className="rounded bg-muted px-1 text-xs">{`{${key}}`}</code>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('firstname_note')}</p>
      </div>
    </section>
  )
}
