import type { RegistrySkillId } from '@/lib/agent-skills/registry'

/**
 * The flows the page shows: few and good rather than many (founder). The
 * other curated flows still run over MCP; they return here once they are as
 * good as these.
 */
export const SHOWN_FLOWS: readonly RegistrySkillId[] = ['kvittojakten', 'bookkeep', 'quarterly-vat-review', 'month-end-close']

/**
 * Every category the catalogue lists, empty or not: an empty industry invites
 * the first contribution. Ids use the registry's pack ids, so an industry that
 * gets a pack later lines up with it; most of these have no pack yet.
 */
export const CATEGORY_IDS = [
  'vertical/bygg-hantverk',
  'vertical/e-handel',
  'vertical/konsult-it',
  'vertical/restaurang-cafe',
  'vertical/vard-halsa',
  'vertical/software-saas-ai',
  'vertical/reklambyra-marknadsforing',
  'vertical/handel-butik',
  'vertical/transport-logistik',
  'vertical/fastighet',
  'vertical/jordbruk-skog',
  'vertical/kreativa-yrken',
  'vertical/utbildning',
  'vertical/ideell-forening',
  'modifier/enskild-firma',
  'modifier/single-shareholder-ab-fmb',
  'modifier/holding-ab',
  'modifier/mixed-verksamhet',
] as const
