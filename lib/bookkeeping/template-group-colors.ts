import type { TemplateGroup } from './booking-templates'

/**
 * One hue per family of booking templates (UI v2, Kick-style category
 * picker): the dot in front of a template and on a booked row says at a
 * glance what kind of thing it is. Families, not accounts: 5410 and 6110
 * are both "things for the office" to the person reading the list. The
 * hues are decorative, not semantic (success/warning stay reserved for
 * state), and every family has a neutral fallback.
 */
export type TemplateHue = 'green' | 'blue' | 'amber' | 'rose' | 'violet' | 'teal' | 'slate'

const HUE_BY_GROUP: Record<TemplateGroup, TemplateHue> = {
  revenue: 'green',
  it_software: 'blue',
  telecom: 'blue',
  premises: 'amber',
  equipment: 'amber',
  office_supplies: 'amber',
  vehicle: 'teal',
  travel: 'teal',
  representation: 'rose',
  marketing: 'rose',
  personnel: 'violet',
  education: 'violet',
  insurance: 'slate',
  bank_finance: 'slate',
  financial: 'slate',
  professional_services: 'violet',
  private_transfers: 'slate',
}

export function templateGroupHue(group: TemplateGroup | null | undefined): TemplateHue {
  return (group && HUE_BY_GROUP[group]) || 'slate'
}

/** Tailwind background class for the dot. Listed in full so the class scanner keeps them. */
export const HUE_DOT_CLASS: Record<TemplateHue, string> = {
  green: 'bg-emerald-500',
  blue: 'bg-sky-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-400',
  violet: 'bg-violet-500',
  teal: 'bg-teal-500',
  slate: 'bg-slate-400',
}

/** First-digit fallback for a bare account number (library templates, manual bookings). */
export function accountHue(account: string | null | undefined): TemplateHue {
  switch ((account ?? '').charAt(0)) {
    case '3':
      return 'green'
    case '4':
      return 'amber'
    case '5':
      return 'blue'
    case '6':
      return 'rose'
    case '7':
      return 'violet'
    case '8':
      return 'teal'
    default:
      return 'slate'
  }
}
