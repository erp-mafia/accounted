'use client'

import { useCallback, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSeg,
  SettingsTextarea,
} from '@/components/settings/SettingsRows'
import {
  REMINDER_EMAIL_DEFAULT_TEXTS,
  REMINDER_EMAIL_PLACEHOLDER_KEYS,
  type ReminderLevelKey,
} from '@/lib/email/reminder-templates'
import type { CompanySettings, ReminderTextOverride, ReminderTextOverrides } from '@/types'

interface ReminderEmailTextsSettingsProps {
  settings: CompanySettings
  onUpdate: (updates: Partial<CompanySettings>) => void
}

type Field = keyof ReminderTextOverride

const LEVELS: ReminderLevelKey[] = ['level_1', 'level_2', 'level_3']

const FIELD_CONFIG: Array<{ field: Field; labelKey: string; multiline?: boolean }> = [
  { field: 'subject', labelKey: 'subject_label' },
  { field: 'body', labelKey: 'body_label', multiline: true },
]

// The editor always shows the EFFECTIVE text (override or standard), never an
// empty field: users see and edit the mail that actually goes out.
type DisplayTexts = Record<ReminderLevelKey, Record<Field, string>>

function buildDisplay(stored: ReminderTextOverrides | null | undefined): DisplayTexts {
  const result = {} as DisplayTexts
  for (const level of LEVELS) {
    result[level] = {} as Record<Field, string>
    for (const { field } of FIELD_CONFIG) {
      const value = stored?.[level]?.[field]
      result[level][field] =
        typeof value === 'string' && value.trim() !== ''
          ? value
          : REMINDER_EMAIL_DEFAULT_TEXTS[level][field]
    }
  }
  return result
}

// Cleared fields have no meaning of their own: snap them back to standard.
function normalize(display: DisplayTexts): DisplayTexts {
  const result = {} as DisplayTexts
  for (const level of LEVELS) {
    result[level] = {} as Record<Field, string>
    for (const { field } of FIELD_CONFIG) {
      const value = display[level][field]
      result[level][field] =
        value.trim() === '' ? REMINDER_EMAIL_DEFAULT_TEXTS[level][field] : value
    }
  }
  return result
}

// Store only changes: a field equal to the standard text is NOT an override,
// so future improvements to the standard wording reach every company that
// hasn't customized. Empty result -> null (column reads "all defaults").
function toOverrides(display: DisplayTexts): ReminderTextOverrides | null {
  const result: ReminderTextOverrides = {}
  for (const level of LEVELS) {
    const levelOverrides: ReminderTextOverride = {}
    for (const { field } of FIELD_CONFIG) {
      const value = display[level][field].trim()
      if (value !== '' && value !== REMINDER_EMAIL_DEFAULT_TEXTS[level][field]) {
        levelOverrides[field] = value
      }
    }
    if (Object.keys(levelOverrides).length > 0) result[level] = levelOverrides
  }
  return Object.keys(result).length > 0 ? result : null
}

export function ReminderEmailTextsSettings({ settings, onUpdate }: ReminderEmailTextsSettingsProps) {
  const t = useTranslations('settings_reminder_texts')
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const [level, setLevel] = useState<ReminderLevelKey>('level_1')
  const [texts, setTexts] = useState<DisplayTexts>(() =>
    buildDisplay(settings.reminder_text_overrides),
  )
  // Serialized last-persisted overrides: skips no-op PUTs on blur without
  // edits. toOverrides() builds keys in a fixed order, so comparison is stable.
  const lastSavedRef = useRef<string>(
    JSON.stringify(toOverrides(buildDisplay(settings.reminder_text_overrides))),
  )

  const setField = (level: ReminderLevelKey, field: Field, value: string) => {
    setTexts((prev) => ({ ...prev, [level]: { ...prev[level], [field]: value } }))
  }

  // Serializes the whole-object saves below: a blur and a reset can otherwise
  // race, and the older snapshot would replace the newer JSONB value.
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())

  // Whole-object save: a JSONB column update replaces the stored value, and
  // the inactive levels' fields are unmounted (conditional render below),
  // so per-field PATCHes can't work. Writes are queued so they reach the
  // server in submission order.
  const persist = useCallback((display: DisplayTexts) => {
    const overrides = toOverrides(display)
    const serialized = JSON.stringify(overrides)
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      if (serialized === lastSavedRef.current) return
      try {
        const response = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reminder_text_overrides: overrides }),
        })
        if (!response.ok) throw new Error()
        lastSavedRef.current = serialized
        onUpdate({ reminder_text_overrides: overrides })
      } catch {
        toast({ title: t('toast_save_failed'), variant: 'destructive' })
      }
    })
    return saveQueueRef.current
  }, [onUpdate, toast, t])

  const handleBlur = () => {
    const normalized = normalize(texts)
    setTexts(normalized)
    void persist(normalized)
  }

  const resetField = (level: ReminderLevelKey, field: Field) => {
    const next = {
      ...texts,
      [level]: { ...texts[level], [field]: REMINDER_EMAIL_DEFAULT_TEXTS[level][field] },
    }
    setTexts(next)
    void persist(next)
  }

  return (
    <SettingsGroup
      label={t('heading')}
      help={
        <div className="space-y-2">
          <p>{t('description')}</p>
          {/* Legend is rendered from code, not messages/*.json: ICU message
              syntax treats literal braces as interpolation. */}
          <p>
            {t('placeholders_help')}{' '}
            {REMINDER_EMAIL_PLACEHOLDER_KEYS.map((key) => (
              <code key={key} className="mr-1 rounded-sm bg-muted px-1 text-xs">{`{${key}}`}</code>
            ))}
          </p>
          <p>{t('amounts_note')}</p>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-1 py-3">
        <SettingsSeg
          value={level}
          onChange={setLevel}
          options={[
            { value: 'level_1', label: t('tab_level_1') },
            { value: 'level_2', label: t('tab_level_2') },
            { value: 'level_3', label: t('tab_level_3') },
          ]}
          aria-label={t('heading')}
        />
        {level === 'level_3' && <SettingsRowNote>{t('level_3_hint')}</SettingsRowNote>}
      </div>

      {FIELD_CONFIG.map(({ field, labelKey, multiline }) => {
        const id = `reminder-email-${field}-${level}`
        const modified =
          texts[level][field].trim() !== REMINDER_EMAIL_DEFAULT_TEXTS[level][field]
        const common = {
          id,
          value: texts[level][field],
          onBlur: handleBlur,
          disabled: !canWrite,
        }
        return (
          <SettingsRow key={`${level}-${field}`} label={t(labelKey)} htmlFor={id} align="baseline">
            {multiline ? (
              <SettingsTextarea
                {...common}
                rows={6}
                onChange={(e) => setField(level, field, e.target.value)}
              />
            ) : (
              <SettingsInput
                {...common}
                onChange={(e) => setField(level, field, e.target.value)}
              />
            )}
            {modified && canWrite && (
              <SettingsRowEnd>
                <button
                  type="button"
                  onClick={() => resetField(level, field)}
                  className="text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
                >
                  {t('reset_label')}
                </button>
              </SettingsRowEnd>
            )}
          </SettingsRow>
        )
      })}
    </SettingsGroup>
  )
}
