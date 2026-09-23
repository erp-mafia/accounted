import { useTranslations } from 'next-intl'

/** The label of an extraction field, falling back to its name for a field the schema knows but the messages do not yet. */
export function useFieldLabel(): (name: string) => string {
  const t = useTranslations('arkiv.fields')
  return (name) => (t.has(name) ? t(name) : name)
}
