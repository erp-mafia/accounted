import type { BookingTemplateCategory, BookingTemplateLibraryLine } from '@/types'
import type { TemplateGroup } from './booking-templates'
import { isReverseChargeVatAccount } from './vat-entries'

/**
 * One vocabulary for every place a person picks how something books: the
 * families of the static catalog (booking-templates.ts). Library templates,
 * system and own alike, are filed into the same families here, so the
 * picker beside a bank row, Ny verifikation, Bokför direkt, Bokför från
 * mall and Inställningar > Mallar all say the same words.
 *
 * The stored `category` column stays as the machine field it always was
 * (the vat category routes an entry into the momsredovisning series); it
 * is derived from the lines on save and never shown.
 */
export const GROUP_ORDER: TemplateGroup[] = [
  'premises', 'vehicle', 'it_software', 'office_supplies', 'goods', 'marketing',
  'travel', 'representation', 'insurance', 'professional_services',
  'bank_finance', 'telecom', 'education', 'personnel', 'revenue',
  'financial', 'tax', 'closing', 'private_transfers', 'equipment',
]

/** i18n keys in the `tx_template_picker` namespace. */
export const GROUP_LABEL_KEYS: Record<TemplateGroup, string> = {
  premises: 'group_premises',
  vehicle: 'group_vehicle',
  it_software: 'group_it_software',
  office_supplies: 'group_office_supplies',
  goods: 'group_goods',
  marketing: 'group_marketing',
  travel: 'group_travel',
  representation: 'group_representation',
  insurance: 'group_insurance',
  professional_services: 'group_professional_services',
  bank_finance: 'group_bank_finance',
  telecom: 'group_telecom',
  education: 'group_education',
  personnel: 'group_personnel',
  revenue: 'group_revenue',
  financial: 'group_financial',
  tax: 'group_tax',
  closing: 'group_closing',
  private_transfers: 'group_private_transfers',
  equipment: 'group_equipment',
}

const PRIVATE_ACCOUNTS = new Set(['2010', '2011', '2012', '2013', '2017', '2018', '2019', '2893', '2898'])

/**
 * The family of a BAS account, following where the static catalog files
 * the same accounts. Ranges, not single numbers, so a company's own
 * sub-accounts land beside their siblings.
 */
export function groupForAccount(account: string | null | undefined): TemplateGroup | null {
  const a = (account ?? '').trim()
  if (!/^\d{4}$/.test(a)) return null
  const n = Number(a)
  if (a === '1630' || a === '2650' || a.startsWith('25') || a.startsWith('27')) return 'tax'
  if (PRIVATE_ACCOUNTS.has(a)) return 'private_transfers'
  if (a.startsWith('12')) return 'equipment'
  if (a.startsWith('1') || a.startsWith('2')) return 'financial'
  if (a.startsWith('3')) return 'revenue'
  if (a.startsWith('4')) return 'goods'
  if (n >= 5000 && n <= 5399) return 'premises'
  if (a === '5420' || a === '5421') return 'it_software'
  if (n >= 5400 && n <= 5499) return 'office_supplies'
  if (n >= 5500 && n <= 5599) return 'equipment'
  if (n >= 5600 && n <= 5699) return 'vehicle'
  if (n >= 5700 && n <= 5899) return 'travel'
  if (n >= 5900 && n <= 5999) return 'marketing'
  if (n >= 6000 && n <= 6069) return 'marketing'
  if (n >= 6070 && n <= 6079) return 'representation'
  if (n >= 6080 && n <= 6199) return 'office_supplies'
  if (n >= 6200 && n <= 6299) return 'telecom'
  if (n >= 6300 && n <= 6399) return 'insurance'
  if (n >= 6400 && n <= 6499) return 'professional_services'
  if (n >= 6500 && n <= 6569) return 'professional_services'
  if (n >= 6570 && n <= 6579) return 'bank_finance'
  if (n >= 6580 && n <= 6599) return 'professional_services'
  if (n >= 6600 && n <= 6899) return 'office_supplies'
  if (n >= 6900 && n <= 6999) return 'bank_finance'
  if (a.startsWith('7')) return 'personnel'
  if (n >= 8800 && n <= 8999) return 'closing'
  if (a.startsWith('84')) return 'bank_finance'
  if (a.startsWith('8')) return 'financial'
  return null
}

/**
 * The family a library template belongs to. The stored category decides
 * for the families the account alone cannot (a VAT netting, a year-end
 * posting, an owner's transaction); everything else follows the first
 * business line's account, then the first line's.
 */
export function libraryTemplateGroup(t: { category: BookingTemplateCategory; lines: BookingTemplateLibraryLine[] }): TemplateGroup {
  switch (t.category) {
    case 'vat':
    case 'tax_account':
      return 'tax'
    case 'year_end':
      return 'closing'
    case 'private_transfer':
      return 'private_transfers'
    case 'salary':
      return 'personnel'
    case 'representation':
      return 'representation'
    default:
      break
  }
  const lines = Array.isArray(t.lines) ? t.lines : []
  const business =
    lines.find((l) => l.type === 'business' && /^[3-8]/.test(l.account ?? '')) ??
    lines.find((l) => l.type === 'business') ??
    lines.find((l) => l.type !== 'vat') ??
    lines[0]
  return groupForAccount(business?.account) ?? (t.category === 'financial' ? 'bank_finance' : 'financial')
}

/**
 * The machine category for a set of template lines. Only `vat` carries
 * behaviour (entries route into the momsredovisning series); the rest keep
 * the historical filing so existing rows and their group stay stable.
 */
export function deriveLibraryCategory(lines: BookingTemplateLibraryLine[]): BookingTemplateCategory {
  const accounts = (Array.isArray(lines) ? lines : []).map((l) => (l.account ?? '').trim()).filter((a) => /^\d{4}$/.test(a))
  if (accounts.length === 0) return 'other'
  const nonVat = accounts.filter((a) => !a.startsWith('26'))
  if (accounts.includes('2650') && nonVat.length === 0) return 'vat'
  if (accounts.some((a) => isReverseChargeVatAccount(a)) || accounts.some((a) => /^33\d\d$/.test(a))) return 'eu_trade'
  if (accounts.includes('1630')) return 'tax_account'
  if (accounts.some((a) => PRIVATE_ACCOUNTS.has(a))) return 'private_transfer'
  if (accounts.some((a) => a.startsWith('7')) && accounts.some((a) => a.startsWith('27'))) return 'salary'
  if (accounts.some((a) => /^607\d$/.test(a))) return 'representation'
  if (accounts.some((a) => /^88\d\d$|^89\d\d$|^21\d\d$/.test(a))) return 'year_end'
  if (accounts.some((a) => a.startsWith('8'))) return 'financial'
  return 'other'
}
