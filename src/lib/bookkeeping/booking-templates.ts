import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  TransactionCategory,
  MappingResult,
  VatJournalLine,
  Transaction,
  EntityType,
  VatTreatment,
  RiskLevel,
} from '@/types'
import {
  getVatRate,
  generateReverseChargePurchaseLines,
  reverseChargeKindForSupplierType,
  generateInputVatLine,
} from './vat-entries'
import { resolveSekAmount } from './currency-utils'
import { getOutputVatAccount } from './invoice-accounts'
import { grossVat } from '@/lib/bookkeeping/gross-split'
import { templateAccountForForm } from '@/lib/company/entity-type'
import {
  resolveSkattekontoAccount,
  templateSkattekontoAccount,
  templateTouchesSkattekonto,
  type SkattekontoLedgerAccount,
} from '@/lib/skatteverket/skattekonto-account'
import { vatTreatmentForRegistration, type VatRegistration } from './vat-registration'

// ============================================================
// Types
// ============================================================

export type TemplateGroup =
  | 'premises'
  | 'vehicle'
  | 'it_software'
  | 'office_supplies'
  | 'marketing'
  | 'travel'
  | 'representation'
  | 'insurance'
  | 'professional_services'
  | 'bank_finance'
  | 'telecom'
  | 'education'
  | 'personnel'
  | 'revenue'
  | 'financial'
  | 'private_transfers'
  | 'equipment'
  // Three families the library (system + own templates) files under. Goods
  // has static templates since 2026-09-10; tax and VAT settlements
  // (1630/2650/25xx) and year-end postings (88xx) are library only.
  | 'goods'
  | 'tax'
  | 'closing'

export interface BookingTemplate {
  id: string
  name_sv: string
  name_en: string
  group: TemplateGroup
  direction: 'expense' | 'income' | 'transfer'
  /** `all`, one legal form, or a list of forms the template is valid for. */
  entity_applicability: 'all' | EntityType | readonly EntityType[]
  debit_account: string
  credit_account: string
  debit_account_ab?: string
  credit_account_ab?: string
  vat_treatment: VatTreatment | null
  vat_rate: number
  deductibility: 'full' | 'non_deductible' | 'conditional'
  deductibility_note_sv?: string
  special_rules_sv?: string
  mcc_codes: number[]
  /**
   * Words in the bank text that point at this template. A keyword of more
   * than three letters may sit inside a word; a shorter one, or one written
   * with a leading '=', matches a whole word only (keywordMatches).
   */
  keywords: string[]
  /**
   * Words that say the text is something this template is not, matched like
   * keywords: any one of them keeps the template out, whatever its keywords
   * or MCC say.
   */
  excluded_keywords?: readonly string[]
  risk_level: RiskLevel
  requires_review: boolean
  impact_score: number
  auto_match_confidence: number
  default_private: boolean
  fallback_category: TransactionCategory
  description_sv: string
  common: boolean
  requires_vat_registration_data?: boolean
  /**
   * Supplier-type hint for reverse-charge bookings. Determines which 44xx/45xx
   * basbelopp account is emitted alongside the 2645/2614 fiktiv-moms pair so
   * Skatteverket's momsdeklaration rutor 20-24 line up with rutor 30-32
   * (felkod FK004 if absent). Default 'eu_business' when unset.
   */
  reverse_charge_supplier_type?: 'eu_business' | 'non_eu_business' | 'swedish_business'
}

/**
 * Whether a template may be used by a company of the given form. A template
 * lists `all`, one form, or several forms; the payroll and juridisk-person
 * templates name both the aktiebolag and the ekonomisk förening because the
 * postings (7210/2710/2731, 2510, 7412, 1350) do not depend on the form.
 */
export function templateAppliesToForm(
  template: Pick<BookingTemplate, 'entity_applicability'>,
  entityType: EntityType,
): boolean {
  const scope = template.entity_applicability
  if (scope === 'all') return true
  return Array.isArray(scope) ? scope.includes(entityType) : scope === entityType
}

export interface TemplateMatch {
  template: BookingTemplate
  confidence: number
}

// ============================================================
// Template Data
// ============================================================

/**
 * Words that make a text a gift. A gift books by who gets it and why (6071
 * within 300 kr exkl. moms to a customer, 5960 as a reklamgåva, 7690/7699 to
 * staff, 6993 to a charity: swedish-daily-bookkeeping, B9), never as a meal,
 * so these keep the meal templates out (accounted#86, #92). 'present' is a
 * whole word: it sits inside "representation".
 */
const GIFT_WORDS: readonly string[] = [
  'gåva', 'gåvor', 'julklapp', 'presentkort', '=present', '=presenter', '=gift', '=gifts', 'gift card',
]

export const BOOKING_TEMPLATES: readonly BookingTemplate[] = [
  // --- PREMISES (3) ---
  {
    id: 'premises_rent',
    name_sv: 'Lokalhyra',
    name_en: 'Office rent',
    group: 'premises',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5010',
    credit_account: '1930',
    vat_treatment: 'exempt',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Lokalhyra är momsfri om hyresvärden inte är frivilligt momsregistrerad',
    mcc_codes: [],
    keywords: ['hyra', 'lokal', 'kontor', 'rent', 'office space', 'kontorslokal', 'coworking', 'kontorshotell', 'wework', 'norrsken', 'regus'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 10,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_office',
    description_sv: 'Månadshyra för kontors- eller affärslokal',
    common: true,
  },
  {
    id: 'premises_rent_vat',
    name_sv: 'Lokalhyra (momsbelagd)',
    name_en: 'Office rent (with VAT)',
    group: 'premises',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5010',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    special_rules_sv: 'Gäller när hyresvärden är frivilligt momsregistrerad',
    mcc_codes: [],
    keywords: ['hyra', 'lokal', 'moms', 'kontorshyra'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 8,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_office',
    description_sv: 'Lokalhyra med moms (frivilligt momsregistrerad hyresvärd)',
    common: false,
  },
  {
    id: 'premises_electricity',
    name_sv: 'El & Uppvärmning',
    name_en: 'Electricity & Heating',
    group: 'premises',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5020',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    mcc_codes: [4900],
    keywords: ['el', 'electricity', 'vattenfall', 'eon', 'fortum', 'ellevio', 'kraftbolag', 'elnät', 'värme', 'fjärrvärme', 'uppvärmning', 'vatten', 'avlopp'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 8,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_office',
    description_sv: 'El, uppvärmning och vatten för kontors- eller affärslokal',
    common: true,
  },

  // --- VEHICLE (4) ---
  {
    id: 'vehicle_fuel',
    name_sv: 'Drivmedel & Laddning',
    name_en: 'Fuel & EV Charging',
    group: 'vehicle',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5611',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    special_rules_sv: 'Drivmedel till firmabil, ej privat körning',
    mcc_codes: [5541, 5542, 5552, 5983],
    keywords: ['bensin', 'diesel', 'drivmedel', 'fuel', 'tank', 'okq8', 'circle k', 'preem', 'st1', 'shell', 'ingo', 'laddning', 'elbil', 'charging', 'tesla', 'ionity', 'recharge'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 8,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_travel',
    description_sv: 'Drivmedel (bensin/diesel) eller laddning (elbil) för tjänstefordon',
    common: true,
  },
  {
    id: 'vehicle_leasing',
    name_sv: 'Billeasing',
    name_en: 'Car leasing',
    group: 'vehicle',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5615',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'conditional',
    deductibility_note_sv: 'Max 50% momsavdrag för personbil',
    special_rules_sv: 'Personbil: halvt momsavdrag. Lastbil/lätt lastbil: fullt avdrag.',
    mcc_codes: [7513],
    keywords: ['leasing', 'billeasing', 'car lease', 'leasingavgift'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 7,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_travel',
    description_sv: 'Leasingavgift för tjänstefordon',
    common: false,
  },
  {
    id: 'vehicle_repairs',
    name_sv: 'Reparation & Service fordon',
    name_en: 'Vehicle repairs & service',
    group: 'vehicle',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5613',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    mcc_codes: [5511, 5521, 5531, 5532, 5533, 7531, 7534, 7535, 7538, 7542],
    keywords: ['bilverkstad', 'service', 'reparation', 'däck', 'mekonomen', 'autoexperten', 'bilprovning', 'besiktning'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 6,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_travel',
    description_sv: 'Reparation, service och underhåll av fordon',
    common: false,
  },
  {
    id: 'vehicle_parking',
    name_sv: 'Parkering & Vägtull',
    name_en: 'Parking & Road tolls',
    group: 'vehicle',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5619',  // 5614 does not exist in BAS 2026 (the 561x run skips it), so every
    // booking through this template failed with AccountsNotInChartError.
    // 5619 is the sibling 'Övriga kostnader för personbilar och mc'.
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    mcc_codes: [7521, 7523, 4784],
    keywords: ['parkering', 'parking', 'p-avgift', 'easypark', 'apcoa', 'q-park', 'aimo', 'trängselskatt', 'vägtull', 'toll', 'brobizz'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 7,
    auto_match_confidence: 0.90,
    default_private: false,
    fallback_category: 'expense_travel',
    description_sv: 'Parkeringsavgift och trängselskatt vid tjänsteärende',
    common: false,
  },

  // --- IT & SOFTWARE (4) ---
  {
    id: 'it_saas_subscription',
    name_sv: 'Programvara / SaaS',
    name_en: 'Software / SaaS subscription',
    group: 'it_software',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5420',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    mcc_codes: [5734, 5817, 5818],
    // Swedish web hosts and domain registrars charge 25 % moms: same account as
    // it_cloud_hosting, but 2641 instead of reverse charge. GitHub is not here:
    // GitHub, Inc. bills from the US (it_saas_non_eu, crm#1431).
    keywords: ['software', 'saas', 'programvara', 'licens', 'subscription', 'app', 'microsoft', 'google', 'adobe', 'slack', 'notion', 'figma', 'atlassian', 'jira', 'antivirus', 'vpn', 'norton', '1password', 'lastpass', 'bitwarden', 'spotify', 'crm', 'hubspot', 'salesforce', 'pipedrive', 'asana', 'monday', 'trello', 'basecamp', 'clickup', 'linear', 'dropbox', 'onedrive', 'icloud', 'backup', 'loopia', 'binero'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 10,
    auto_match_confidence: 0.90,
    default_private: false,
    fallback_category: 'expense_software',
    description_sv: 'Programvarulicens, SaaS-prenumeration, webbhotell eller domän (svensk leverantör med moms)',
    common: false,
  },
  {
    id: 'it_saas_eu',
    name_sv: 'Programvara / SaaS (omvänd moms)',
    name_en: 'Software / SaaS (reverse charge)',
    group: 'it_software',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5420',
    credit_account: '1930',
    vat_treatment: 'reverse_charge',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Leverantör i annat EU-land fakturerar utan moms; du redovisar 25 % själv (ruta 21, 30 och 48). Leverantör utanför EU, till exempel i USA: välj Programvara / SaaS utanför EU (ruta 22).',
    mcc_codes: [5734, 5817, 5818],
    // Google Workspace is billed from Ireland. Card texts also write it
    // "GOOGLE*WORKSPACE" and "GOOGLE *WORKSPACE", and every spelling needs two
    // hits here to outrank the domestic template's broader 'google' keyword.
    // 'copilot' alone is Microsoft's, billed from Ireland like Google Workspace,
    // and its spellings with the vendor give the second hit over 'microsoft'.
    // GitHub Copilot is GitHub's, billed from the US: it_saas_non_eu (crm#1431).
    keywords: ['software', 'saas', 'eu', 'ireland', 'reverse charge', 'omvänd moms', 'openai', 'chatgpt', 'anthropic', 'claude', 'ai', 'midjourney', 'copilot', 'microsoft copilot', 'microsoft 365 copilot', 'm365 copilot', 'google cloud', 'aws', 'azure', 'google workspace', 'google*workspace', 'google *workspace', 'workspace', 'gsuite', 'google gsuite', 'google*gsuite'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 9,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_software',
    description_sv: 'Programvara från leverantör i annat EU-land med omvänd skattskyldighet',
    common: true,
    requires_vat_registration_data: true,
  },
  {
    // The non-EU sibling of it_saas_eu: same cost account and MCCs, only the
    // basis box differs (4531, ruta 22). Keywords are vendors the counterpart
    // directory places outside the EU, never an EU-billed one. 'github copilot'
    // is the second hit that keeps GitHub Copilot ahead of it_saas_eu's
    // 'copilot' (crm#1431).
    id: 'it_saas_non_eu',
    name_sv: 'Programvara / SaaS utanför EU (omvänd moms)',
    name_en: 'Software / SaaS from outside the EU (reverse charge)',
    group: 'it_software',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5420',
    credit_account: '1930',
    vat_treatment: 'reverse_charge',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Leverantör utanför EU, till exempel i USA, fakturerar utan moms; du redovisar 25 % själv (ruta 22, 30 och 48). Leverantör i annat EU-land: välj Programvara / SaaS (omvänd moms), ruta 21.',
    mcc_codes: [5734, 5817, 5818],
    keywords: ['supabase', 'github', 'github copilot'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 9,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_software',
    description_sv: 'Programvara, SaaS eller molntjänst från leverantör utanför EU med omvänd skattskyldighet',
    common: true,
    requires_vat_registration_data: true,
    reverse_charge_supplier_type: 'non_eu_business',
  },
  {
    id: 'it_cloud_hosting',
    name_sv: 'Molntjänster / Hosting',
    name_en: 'Cloud services / Hosting',
    group: 'it_software',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5420',  // 5421 does not exist in BAS 2026. 5420 Programvaror is what the two
    // sibling SaaS templates already use.
    credit_account: '1930',
    vat_treatment: 'reverse_charge',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Bokförs som tjänst från annat EU-land med omvänd skattskyldighet (ruta 21, 30 och 48). Leverantör utanför EU: välj Programvara / SaaS utanför EU (ruta 22). Svensk leverantör som tar ut moms: välj Programvara / SaaS.',
    mcc_codes: [4816],
    keywords: ['aws', 'azure', 'google cloud', 'gcp', 'hosting', 'server', 'cloud', 'vercel', 'heroku', 'digitalocean', 'cloudflare', 'hetzner', 'domain', 'dns', 'godaddy'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 9,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_software',
    description_sv: 'Molnbaserade tjänster, webbhotell, serverhosting och domännamn',
    common: true,
  },

  // --- OFFICE SUPPLIES (2) ---
  {
    id: 'office_supplies_general',
    name_sv: 'Kontorsmaterial',
    name_en: 'Office supplies',
    group: 'office_supplies',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6110',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    mcc_codes: [5111, 5112, 5943, 5944],
    keywords: ['kontorsmaterial', 'pennor', 'papper', 'office supplies', 'staples', 'kontorsvaror', 'kontor', 'tryck', 'print', 'trycksaker', 'kopiering', 'visitkort'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 7,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_office',
    description_sv: 'Kontorsmaterial, trycksaker och förbrukningsvaror',
    common: true,
  },
  {
    id: 'office_postage',
    name_sv: 'Porto & Frakt',
    name_en: 'Postage & Shipping',
    group: 'office_supplies',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6250',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    special_rules_sv: 'Posttjänster kan vara momsfria, frakttjänster har normalt 25% moms',
    mcc_codes: [4215, 4211],
    keywords: ['porto', 'postnord', 'frakt', 'shipping', 'dhl', 'ups', 'fedex', 'bring', 'paket', 'schenker', 'transport'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 6,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_office',
    description_sv: 'Porto och fraktkostnader',
    common: true,
  },

  // --- MARKETING (3) ---
  {
    id: 'marketing_online_ads_eu',
    name_sv: 'Annonsering EU (omvänd moms)',
    name_en: 'Online ads EU (reverse charge)',
    group: 'marketing',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5910',
    credit_account: '1930',
    vat_treatment: 'reverse_charge',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Google/Meta fakturerar ofta från Irland → omvänd skattskyldighet',
    mcc_codes: [7311],
    keywords: ['google ads', 'facebook ads', 'meta ads', 'instagram ads', 'linkedin ads', 'annons', 'advertising', 'adwords', 'kampanj', 'seo', 'sem', 'sökmotoroptimering', 'reklam'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 9,
    auto_match_confidence: 0.90,
    default_private: false,
    fallback_category: 'expense_marketing',
    description_sv: 'Digital annonsering från EU-leverantör (Google/Meta från Irland)',
    common: true,
    requires_vat_registration_data: true,
  },
  {
    id: 'marketing_online_ads_domestic',
    name_sv: 'Annonsering (svensk moms)',
    name_en: 'Online ads (domestic VAT)',
    group: 'marketing',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5910',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    special_rules_sv: 'Svensk leverantör med momsregistrering',
    mcc_codes: [7311],
    keywords: ['annons', 'reklam', 'advertising', 'kampanj', 'blocket', 'eniro'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 7,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_marketing',
    description_sv: 'Digital annonsering från svensk leverantör med 25% moms',
    common: false,
  },
  {
    id: 'marketing_design',
    name_sv: 'Design & Reklam',
    name_en: 'Design & Promotion',
    group: 'marketing',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5920',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    mcc_codes: [7333, 7332, 7829],
    keywords: ['design', 'grafisk', 'logotyp', 'webb', 'website', 'logo', 'branding', 'grafiker', 'foto', 'fotograf', 'video', 'film', 'canva', 'hootsuite', 'social media', 'sociala medier', 'mailchimp', 'nyhetsbrev'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_marketing',
    description_sv: 'Grafisk design, reklam, foto/video och marknadsföringsverktyg',
    common: false,
  },

  // --- TRAVEL (3) ---
  {
    id: 'travel_transport',
    name_sv: 'Resor & Transport',
    name_en: 'Travel & Transport',
    group: 'travel',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5810',
    credit_account: '1930',
    vat_treatment: 'reduced_6',
    vat_rate: 0.06,
    deductibility: 'full',
    special_rules_sv: 'Persontransport har 6% moms (flyg, tåg, taxi)',
    mcc_codes: [3000, 3001, 3002, 3003, 4511, 4011, 4111, 4112, 4131, 4121],
    keywords: ['flyg', 'sas', 'norwegian', 'bra', 'flight', 'tåg', 'train', 'sj', 'sl', 'västtrafik', 'skånetrafiken', 'kollektivtrafik', 'taxi', 'uber', 'bolt', 'cab'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 7,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_travel',
    description_sv: 'Resor i tjänsten: flyg, tåg, taxi, hyrbil (6% moms)',
    common: true,
  },
  {
    id: 'travel_international',
    name_sv: 'Utrikesresa',
    name_en: 'International travel',
    group: 'travel',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5810',
    credit_account: '1930',
    vat_treatment: 'export',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Utrikesflyg och internationella resor är momsfria',
    mcc_codes: [3000, 3001, 3002, 3003, 4511],
    keywords: ['utrikes', 'international', 'airport', 'utlandsflyg'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'expense_travel',
    description_sv: 'Utrikesresor i tjänsten (momsfritt)',
    common: false,
  },
  {
    id: 'travel_hotel',
    name_sv: 'Hotell',
    name_en: 'Hotel',
    group: 'travel',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5830',  // 5820 is Hyrbilskostnader (rental car). This template is Hotell, so it
    // posted hotel nights into car hire: it balanced and was silently wrong.
    // 5830 is 'Kost och logi'.
    credit_account: '1930',
    vat_treatment: 'reduced_12',
    vat_rate: 0.12,
    deductibility: 'full',
    special_rules_sv: 'Frukost särredovisas från logikostnaden.',
    mcc_codes: [3501, 3502, 3503, 3504, 7011],
    keywords: ['hotell', 'hotel', 'logi', 'övernattning', 'scandic', 'elite', 'best western', 'booking', 'airbnb'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 6,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_travel',
    description_sv: 'Hotellövernattning i tjänsten (12% moms)',
    common: true,
  },

  // --- REPRESENTATION (3) ---
  {
    id: 'representation_external',
    name_sv: 'Extern representation',
    name_en: 'External representation',
    group: 'representation',
    direction: 'expense',
    entity_applicability: 'all',
    // A meal (the restaurant MCCs, 12 % moms, lunch and middag below) is not
    // deductible for income tax since 2017 (IL 16 kap. 2 §), so it books on
    // 6072 Representation, ej avdragsgill; 6071 is for what stays deductible,
    // such as enklare förtäring (swedish-daily-bookkeeping, B1). accounted#86.
    debit_account: '6072',
    credit_account: '1930',
    vat_treatment: 'reduced_12',
    vat_rate: 0.12,
    deductibility: 'conditional',
    // 300 kr is the VAT BASE per person and occasion, not the deduction
    // (ML 13 kap. 24-25 §§). The template has no participant count, so it
    // books the VAT on the whole amount: right up to the cap, and the note
    // tells the reviewer to check the moms line above it.
    deductibility_note_sv: 'Måltider är inte avdragsgilla för inkomstskatt sedan 2017 och bokas på 6072. Momsen är avdragsgill på ett underlag om högst 300 kr exkl. moms per person och tillfälle (högst 36 kr per person för enbart mat på restaurang, schablon 46 kr vid mat och alkohol): kontrollera momsraden mot antalet deltagare. Enklare förtäring (fika, högst 60 kr per person exkl. moms) bokas på 6071.',
    // Said where it goes: "Dokumentera" alone read as "upload a file", and
    // a written note on the verifikat is enough (crm#1342).
    special_rules_sv: 'Skriv syfte och deltagare (namn och företag) i verifikatets anteckning, eller bifoga ett underlag där de står.',
    mcc_codes: [5812, 5813, 5814],
    // Meal words only. A gift is not a meal: within 300 kr excl. moms it is
    // deductible (6071) and usually carries 25 % moms, so proposing this
    // template (6072, 12 %) for one was wrong twice (accounted#86).
    // 'representation' counts as a whole word only: a compound is what its
    // last part names, so "representationsgåva" is a gift and
    // "representationsmiddag" a meal through 'middag'. 'kund' is gone: it
    // named no meal, only "kundreskontra" and "gåva till kund" (accounted#92).
    keywords: ['=representation', 'lunch', 'middag', 'restaurang', 'restaurant', 'kundmöte'],
    excluded_keywords: GIFT_WORDS,
    risk_level: 'HIGH',
    requires_review: true,
    impact_score: 7,
    auto_match_confidence: 0.70,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Representation med kund/affärspartner (dokumentera noggrant)',
    common: true,
  },
  {
    id: 'representation_internal',
    name_sv: 'Intern representation',
    name_en: 'Internal representation',
    group: 'representation',
    direction: 'expense',
    entity_applicability: 'all',
    // The staff twin of representation_external: a teamlunch or a julbord is
    // a meal, not income-tax deductible since 2017 (IL 16 kap. 2 §), so it
    // books on 7632; 7631 is for enklare förtäring and the personalfest's
    // kringkostnader (swedish-daily-bookkeeping, B2). accounted#86.
    debit_account: '7632',
    credit_account: '1930',
    vat_treatment: 'reduced_12',
    vat_rate: 0.12,
    deductibility: 'conditional',
    deductibility_note_sv: 'Måltider är inte avdragsgilla för inkomstskatt sedan 2017 och bokas på 7632. Enklare förtäring (fika, högst 60 kr per person exkl. moms) och kringkostnader vid personalfest (högst 180 kr per person exkl. moms) bokas på 7631.',
    special_rules_sv: 'Personalfest, teamlunch, fika. Momsen är avdragsgill på ett underlag om högst 300 kr exkl. moms per person och tillfälle (högst 36 kr per person för enbart mat på restaurang, schablon 46 kr vid mat och alkohol).',
    mcc_codes: [5812, 5813, 5814],
    keywords: ['personalfest', 'intern representation', 'teamlunch', 'personallunch', 'fika', 'julfest', 'after work', 'intern lunch'],
    // A julgåva to staff is a personalkostnad (7690/7699), not a meal.
    excluded_keywords: GIFT_WORDS,
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.70,
    default_private: false,
    fallback_category: 'expense_representation',
    description_sv: 'Intern representation (personalfest, teamlunch)',
    common: true,
  },
  {
    id: 'representation_conference',
    name_sv: 'Konferens & Mässa',
    name_en: 'Conference & Trade show',
    group: 'representation',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5990',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    mcc_codes: [7941, 7922],
    keywords: ['konferens', 'mässa', 'conference', 'trade show', 'event', 'utställning', 'biljett'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 4,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'expense_education',
    description_sv: 'Avgifter för konferenser och mässor',
    common: false,
  },

  // --- INSURANCE (3) ---
  {
    id: 'insurance_business',
    name_sv: 'Företagsförsäkring',
    name_en: 'Business insurance',
    group: 'insurance',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6310',
    credit_account: '1930',
    vat_treatment: 'exempt',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Försäkringspremier är momsfria',
    mcc_codes: [6300],
    keywords: ['försäkring', 'insurance', 'företagsförsäkring', 'ansvarsförsäkring', 'konsultförsäkring', 'if', 'trygg-hansa', 'länsförsäkringar', 'folksam', 'fordonsförsäkring', 'bilförsäkring'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 6,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Företags-, ansvars- och fordonsförsäkring (momsfritt)',
    common: true,
  },
  {
    id: 'insurance_pension_ef',
    name_sv: 'Pensionsförsäkring (EF)',
    name_en: 'Pension insurance (EF)',
    group: 'insurance',
    direction: 'expense',
    entity_applicability: 'enskild_firma',
    debit_account: '6530',
    credit_account: '1930',
    vat_treatment: 'exempt',
    vat_rate: 0,
    deductibility: 'conditional',
    deductibility_note_sv: 'Avdragsgill i NE-deklarationen, inte i bokföringen direkt',
    special_rules_sv: 'EF: Pensionssparande dras av i NE-blanketten, inte som kostnad i rörelsen.',
    mcc_codes: [],
    keywords: ['pension', 'pensionsförsäkring', 'itp', 'avanza pension', 'spp'],
    risk_level: 'MEDIUM',
    requires_review: true,
    impact_score: 4,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Pensionssparande för enskild firma (granska avdragsregel)',
    common: false,
  },
  {
    id: 'insurance_pension_ab',
    name_sv: 'Pensionsförsäkring (juridisk person)',
    name_en: 'Pension insurance (legal entity)',
    group: 'insurance',
    direction: 'expense',
    entity_applicability: ['aktiebolag', 'ekonomisk_forening'],
    debit_account: '7410',
    credit_account: '1930',
    vat_treatment: 'exempt',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Aktiebolag och ekonomisk förening: pensionskostnad är en avdragsgill personalkostnad',
    mcc_codes: [],
    keywords: ['pension', 'pensionsförsäkring', 'itp', 'tjänstepension'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Tjänstepension för anställda i aktiebolag',
    common: false,
  },

  // --- PROFESSIONAL SERVICES (2) ---
  {
    id: 'prof_accounting',
    name_sv: 'Redovisning & Juridik',
    name_en: 'Accounting & Legal services',
    group: 'professional_services',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6530',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    mcc_codes: [8931, 8111],
    keywords: ['redovisning', 'bokföring', 'revisor', 'accounting', 'redovisningsbyrå', 'advokat', 'juridisk', 'legal', 'lawyer', 'jurist', 'fortnox', 'visma', 'bokio', 'dooer'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 8,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_professional_services',
    description_sv: 'Redovisning, bokföring, revision och juridiska tjänster',
    common: true,
  },
  {
    id: 'prof_consulting',
    name_sv: 'Konsulttjänster',
    name_en: 'Consulting services',
    group: 'professional_services',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6550',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    mcc_codes: [7392],
    keywords: ['konsult', 'consulting', 'rådgivning', 'advisory', 'management'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 6,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_professional_services',
    description_sv: 'Konsultarvoden och rådgivningstjänster',
    common: true,
  },

  // --- BANK & FINANCE (5) ---
  {
    id: 'bank_fees',
    name_sv: 'Bankavgifter',
    name_en: 'Bank fees',
    group: 'bank_finance',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6570',
    credit_account: '1930',
    vat_treatment: 'exempt',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Banktjänster är momsfria',
    mcc_codes: [6010, 6011, 6012],
    keywords: ['bankavgift', 'bank fee', 'kontoavgift', 'årsavgift', 'månadsavgift', 'kortavgift', 'zettle', 'izettle', 'klarna', 'swish', 'betalterminal', 'nets'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 9,
    auto_match_confidence: 0.90,
    default_private: false,
    fallback_category: 'expense_bank_fees',
    description_sv: 'Bankavgifter, kontoavgifter och kortavgifter',
    common: true,
  },
  {
    // Stripe Payments Europe Ltd (Ireland) invoices its fees without VAT and
    // the Swedish buyer reports them under reverse charge, the same way the
    // Stripe extension books fees inside a payout (extensions/general/stripe/
    // lib/payouts.ts): ruta 21 basis, 25 % fictitious VAT on 2614 and 2645.
    id: 'payment_fees_eu',
    name_sv: 'Stripe-avgifter (omvänd moms)',
    name_en: 'Stripe fees (reverse charge)',
    group: 'bank_finance',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6570',
    credit_account: '1930',
    vat_treatment: 'reverse_charge',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Fakturerat utan moms från Irland; köparen redovisar omvänd moms (ruta 21, 30 och 48).',
    mcc_codes: [],
    keywords: ['stripe'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 8,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_bank_fees',
    description_sv: 'Avgifter från Stripe (EU-leverantör) med omvänd skattskyldighet',
    common: true,
    requires_vat_registration_data: true,
  },
  {
    id: 'bank_interest_income',
    name_sv: 'Ränteintäkt',
    name_en: 'Interest income',
    group: 'bank_finance',
    direction: 'income',
    entity_applicability: 'all',
    debit_account: '1930',
    credit_account: '8310',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    mcc_codes: [],
    keywords: ['ränta', 'ränteinkomst', 'interest income', 'sparränta'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'income_other',
    description_sv: 'Ränteintäkter på bankkonto eller placeringar',
    common: false,
  },
  {
    id: 'bank_interest_expense',
    name_sv: 'Räntekostnad',
    name_en: 'Interest expense',
    group: 'bank_finance',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '8410',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    mcc_codes: [],
    keywords: ['ränta', 'räntekostnad', 'interest expense', 'låneränta'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Räntekostnad på lån eller kredit',
    common: false,
  },
  {
    id: 'bank_currency_loss',
    name_sv: 'Valutakursförlust',
    name_en: 'Currency exchange loss',
    group: 'bank_finance',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '7960',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    mcc_codes: [6051],
    keywords: ['valuta', 'currency', 'växling', 'kursförlust', 'exchange'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 4,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_currency_exchange',
    description_sv: 'Valutakursförluster vid betalning i utländsk valuta',
    common: false,
  },
  {
    id: 'bank_currency_gain',
    name_sv: 'Valutakursvinst',
    name_en: 'Currency exchange gain',
    group: 'bank_finance',
    direction: 'income',
    entity_applicability: 'all',
    debit_account: '1930',
    credit_account: '3960',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    mcc_codes: [],
    keywords: ['valuta', 'currency', 'kursvinst', 'exchange gain'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 3,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'income_other',
    description_sv: 'Valutakursvinster vid betalning i utländsk valuta',
    common: false,
  },

  // --- TELECOM (2) ---
  {
    id: 'telecom_mobile',
    name_sv: 'Mobilabonnemang',
    name_en: 'Mobile subscription',
    group: 'telecom',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6211',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'conditional',
    deductibility_note_sv: 'Blandad användning: bara yrkesmässig del avdragsgill',
    mcc_codes: [4812, 4813, 4814],
    keywords: ['mobil', 'tele2', 'telia', 'tre', 'telenor', 'hallon', 'comviq', 'mobilabonnemang', 'telefon', 'fast telefon', 'ip-telefoni', 'voip'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 8,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Telefon och mobilabonnemang (granska yrkesmässig andel)',
    common: true,
  },
  {
    id: 'telecom_internet',
    name_sv: 'Internetanslutning',
    name_en: 'Internet connection',
    group: 'telecom',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6230',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    mcc_codes: [4816],
    keywords: ['internet', 'bredband', 'fiber', 'broadband', 'bahnhof', 'telia', 'comhem'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 7,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Internetanslutning för kontor',
    common: false,
  },

  // --- EDUCATION (2) ---
  {
    id: 'education_course',
    name_sv: 'Kurs / Utbildning',
    name_en: 'Course / Training',
    group: 'education',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6991',
    credit_account: '1930',
    debit_account_ab: '7610',
    vat_treatment: 'exempt',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Utbildningstjänster är momsfria. AB: konto 7610, EF: konto 6991.',
    mcc_codes: [8220, 8241, 8244, 8249, 8299, 5815, 5816],
    keywords: ['kurs', 'utbildning', 'course', 'training', 'workshop', 'certifiering', 'certification', 'udemy', 'coursera', 'pluralsight', 'linkedin learning', 'online course'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 6,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_education',
    description_sv: 'Yrkesrelaterade kurser och utbildningar',
    common: false,
  },
  {
    id: 'education_membership',
    name_sv: 'Branschförening / Medlemskap',
    name_en: 'Trade association / Membership',
    group: 'education',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6980',
    credit_account: '1930',
    vat_treatment: 'exempt',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Föreningsavgifter är normalt momsfria',
    mcc_codes: [8641, 8651, 8661, 8699],
    keywords: ['medlemskap', 'membership', 'förening', 'branschorganisation', 'förbund', 'svenskt näringsliv', 'företagarna'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 4,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_education',
    description_sv: 'Medlemsavgift i branschorganisation eller yrkesförening',
    common: false,
  },

  // --- PERSONNEL (10) ---
  {
    id: 'personnel_salary',
    name_sv: 'Lön (netto)',
    name_en: 'Salary (net)',
    group: 'personnel',
    direction: 'expense',
    entity_applicability: ['aktiebolag', 'ekonomisk_forening'],
    debit_account: '7210',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'OBS: Denna mall bokför nettolön. Personalskatt (2710) och arbetsgivaravgifter (2731) måste bokföras separat.',
    mcc_codes: [],
    keywords: ['lön', 'salary', 'nettolön', 'löneutbetalning'],
    risk_level: 'NONE',
    requires_review: true,
    impact_score: 8,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Nettolön till anställd',
    common: true,
  },
  {
    id: 'personnel_employer_tax',
    name_sv: 'Arbetsgivaravgifter',
    name_en: 'Employer social contributions',
    group: 'personnel',
    direction: 'expense',
    entity_applicability: ['aktiebolag', 'ekonomisk_forening'],
    debit_account: '2731',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Betalning av arbetsgivaravgift-skuld. Kostnad (D: 7510 / K: 2731) bokförs vid lönekörning.',
    mcc_codes: [],
    keywords: ['arbetsgivaravgift', 'sociala avgifter', 'employer tax', 'skattekonto'],
    risk_level: 'NONE',
    requires_review: true,
    impact_score: 7,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Betalning av arbetsgivaravgifter',
    common: true,
  },
  {
    id: 'personnel_preliminary_tax',
    name_sv: 'Preliminärskatt (juridisk person)',
    name_en: 'Preliminary tax (legal entity)',
    group: 'personnel',
    direction: 'expense',
    entity_applicability: ['aktiebolag', 'ekonomisk_forening'],
    debit_account: '2510',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    mcc_codes: [],
    keywords: ['preliminärskatt', 'skatt', 'tax', 'skatteverket', 'skattekonto'],
    risk_level: 'NONE',
    requires_review: true,
    impact_score: 7,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Preliminärskatt till Skatteverket',
    common: false,
  },
  {
    id: 'personnel_mileage_taxfree',
    name_sv: 'Skattefri bilersättning (mil)',
    name_en: 'Tax-free mileage reimbursement',
    group: 'personnel',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '7331',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Ersättning till anställd för bil- och körersättning, skattefri inom Skatteverkets gränsbelopp (för 2026: kontrollera aktuell mil-ersättning). Underlag: körjournal. Ingen ingående moms.',
    mcc_codes: [],
    keywords: ['milersättning', 'mil ersättning', 'milerstättning', 'körersättning', 'kör ersättning', 'bilersättning', 'reseersättning', 'kilometerersättning'],
    risk_level: 'LOW',
    requires_review: true,
    impact_score: 5,
    auto_match_confidence: 0.95,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Skattefri milersättning till anställd (kräver körjournal)',
    common: true,
  },
  {
    id: 'personnel_mileage_taxable',
    name_sv: 'Skattepliktig bilersättning (mil)',
    name_en: 'Taxable mileage reimbursement',
    group: 'personnel',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '7332',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Den del av bilersättningen som överstiger Skatteverkets skattefria gränsbelopp. Skattepliktig för mottagaren och ska tas upp på AGI. Ingen ingående moms.',
    mcc_codes: [],
    keywords: ['skattepliktig milersättning', 'skattepliktig bilersättning', 'överskjutande bilersättning'],
    risk_level: 'MEDIUM',
    requires_review: true,
    impact_score: 5,
    auto_match_confidence: 0.90,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Skattepliktig del av bilersättning (AGI-pliktig)',
    common: false,
  },
  {
    id: 'personnel_per_diem_sweden_taxfree',
    name_sv: 'Skattefritt traktamente (Sverige)',
    name_en: 'Tax-free per diem (Sweden)',
    group: 'personnel',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '7321',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Skattefritt traktamente för tjänsteresa i Sverige inom Skatteverkets schablonbelopp. Kräver reseräkning + övernattning >50 km från tjänstestället. Ingen ingående moms.',
    mcc_codes: [],
    // Note: keywords are intentionally narrow. "utlandstraktamente" must route
    // to the abroad template, not here: so we avoid the bare "traktament"
    // substring (which would also fire on "utlandstraktamente").
    keywords: ['traktamente', 'dagtraktamente', 'helt dygn', 'halvt dygn'],
    risk_level: 'LOW',
    requires_review: true,
    impact_score: 5,
    auto_match_confidence: 0.95,
    default_private: false,
    fallback_category: 'expense_travel',
    description_sv: 'Skattefritt traktamente för tjänsteresa i Sverige (kräver reseräkning)',
    common: true,
  },
  {
    id: 'personnel_per_diem_sweden_taxable',
    name_sv: 'Skattepliktigt traktamente (Sverige)',
    name_en: 'Taxable per diem (Sweden)',
    group: 'personnel',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '7322',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Den del av traktamentet som överstiger Skatteverkets skattefria schablon. Skattepliktigt för mottagaren och ska tas upp på AGI.',
    mcc_codes: [],
    keywords: ['skattepliktigt traktamente', 'överskjutande traktamente'],
    risk_level: 'MEDIUM',
    requires_review: true,
    impact_score: 4,
    auto_match_confidence: 0.90,
    default_private: false,
    fallback_category: 'expense_travel',
    description_sv: 'Skattepliktig del av traktamente Sverige (AGI-pliktig)',
    common: false,
  },
  {
    id: 'personnel_per_diem_abroad_taxfree',
    name_sv: 'Skattefritt traktamente (utlandet)',
    name_en: 'Tax-free per diem (abroad)',
    group: 'personnel',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '7323',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Skattefritt utlandstraktamente per land enligt Skatteverkets normalbelopp. Kräver reseräkning. Tremånadersregeln gäller efter 3 mån.',
    mcc_codes: [],
    keywords: ['utlandstraktamente', 'traktamente utland', 'utlandsresa', 'utlands', 'normalbelopp'],
    risk_level: 'LOW',
    requires_review: true,
    impact_score: 4,
    auto_match_confidence: 0.90,
    default_private: false,
    fallback_category: 'expense_travel',
    description_sv: 'Skattefritt traktamente för tjänsteresa utomlands',
    common: false,
  },
  {
    id: 'personnel_per_diem_abroad_taxable',
    name_sv: 'Skattepliktigt traktamente (utlandet)',
    name_en: 'Taxable per diem (abroad)',
    group: 'personnel',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '7324',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Del av utlandstraktamente som överstiger Skatteverkets normalbelopp. Skattepliktig och AGI-pliktig.',
    mcc_codes: [],
    keywords: ['skattepliktigt utlandstraktamente'],
    risk_level: 'MEDIUM',
    requires_review: true,
    impact_score: 3,
    auto_match_confidence: 0.90,
    default_private: false,
    fallback_category: 'expense_travel',
    description_sv: 'Skattepliktig del av utlandstraktamente (AGI-pliktig)',
    common: false,
  },
  {
    id: 'personnel_congestion_charge_taxfree',
    name_sv: 'Trängselskatt (skattefri ersättning)',
    name_en: 'Congestion charge (tax-free reimbursement)',
    group: 'personnel',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '7333',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Ersättning till anställd för trängselskatt vid tjänsteresa, skattefri enligt 11 kap 26 § IL.',
    mcc_codes: [],
    keywords: ['trängselskatt', 'trängselavgift', 'congestion'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 3,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_travel',
    description_sv: 'Ersättning för trängselskatt vid tjänsteresa',
    common: false,
  },

  // --- REVENUE (4) ---
  {
    id: 'revenue_standard_25',
    name_sv: 'Försäljning 25% moms',
    name_en: 'Revenue 25% VAT',
    group: 'revenue',
    direction: 'income',
    entity_applicability: 'all',
    debit_account: '1930',
    credit_account: '3001',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    mcc_codes: [],
    keywords: ['konsult', 'tjänst', 'service', 'arvode', 'fee', 'faktura', 'försäljning', 'vara', 'produkt', 'product', 'sale'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 10,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'income_services',
    description_sv: 'Intäkter från tjänste- eller varuförsäljning med 25% moms',
    common: true,
  },
  {
    id: 'revenue_reduced_12',
    name_sv: 'Försäljning 12% moms (livsmedel/logi)',
    name_en: 'Revenue 12% VAT (food/accommodation)',
    group: 'revenue',
    direction: 'income',
    entity_applicability: 'all',
    debit_account: '1930',
    credit_account: '3002',
    vat_treatment: 'reduced_12',
    vat_rate: 0.12,
    deductibility: 'full',
    mcc_codes: [],
    keywords: ['livsmedel', 'mat', 'food', 'restaurang', 'logi'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 6,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'income_products',
    description_sv: 'Intäkter från livsmedelsförsäljning eller logi med 12% moms',
    common: true,
  },
  {
    id: 'revenue_reduced_6',
    name_sv: 'Försäljning 6% moms (böcker/kultur/transport)',
    name_en: 'Revenue 6% VAT (books/culture/transport)',
    group: 'revenue',
    direction: 'income',
    entity_applicability: 'all',
    debit_account: '1930',
    credit_account: '3003',
    vat_treatment: 'reduced_6',
    vat_rate: 0.06,
    deductibility: 'full',
    mcc_codes: [],
    // Dance keywords: tillträde till danstillställningar dropped from 25% to
    // 6% on 2026-07-01 (2025/26:SkU25, aligned with other cultural events).
    // Admission sold and paid before that stays 25%; the descriptor reflects
    // current law only. Deliberately admission-specific terms only: bare
    // 'dans' or 'entré' would also match dance courses, artist fees and
    // generic entrance charges, which are not all reduced-rate. (#1483)
    keywords: ['bok', 'böcker', 'tidning', 'tidskrift', 'e-bok', 'persontransport', 'taxi', 'buss', 'tåg', 'kultur', 'konsert', 'teater', 'museum', 'bio', 'idrott', 'danstillställning', 'dansband', 'danskväll', 'books', 'culture', 'transport'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'income_services',
    description_sv: 'Intäkter med 6% moms (böcker, persontransport, kultur, idrott, danstillställningar fr.o.m. 2026-07-01)',
    common: true,
  },
  {
    id: 'revenue_eu_services',
    name_sv: 'Tjänsteförsäljning EU (omvänd moms)',
    name_en: 'Service revenue EU (reverse charge)',
    group: 'revenue',
    direction: 'income',
    entity_applicability: 'all',
    debit_account: '1930',
    credit_account: '3308',
    vat_treatment: 'reverse_charge',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Tjänsteförsäljning till EU-företag → omvänd skattskyldighet, rapportera i ruta 39',
    mcc_codes: [],
    keywords: ['eu', 'export', 'eu service', 'reverse charge', 'utlandsförsäljning'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 6,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'income_services',
    description_sv: 'Tjänsteförsäljning till EU-företag (momsfritt, ruta 39)',
    common: true,
    requires_vat_registration_data: true,
  },
  {
    id: 'revenue_export',
    name_sv: 'Export utanför EU',
    name_en: 'Export outside EU',
    group: 'revenue',
    direction: 'income',
    entity_applicability: 'all',
    debit_account: '1930',
    credit_account: '3305',
    vat_treatment: 'export',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Export utanför EU → momsfritt, rapportera i ruta 40',
    mcc_codes: [],
    keywords: ['export', 'utland', 'usa', 'utanför eu', 'non-eu'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'income_services',
    description_sv: 'Export av varor/tjänster utanför EU (momsfritt, ruta 40)',
    common: true,
  },
  {
    id: 'revenue_exempt_domestic',
    name_sv: 'Momsfri försäljning (Sverige)',
    name_en: 'VAT-exempt sales (domestic)',
    group: 'revenue',
    direction: 'income',
    entity_applicability: 'all',
    debit_account: '1930',
    credit_account: '3100',
    credit_account_ab: '3004',
    vat_treatment: 'exempt',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Momsfri försäljning inom Sverige (t.ex. sjukvård, tandvård, utbildning, social omsorg, försäkring, finansiella tjänster) → rapportera i ruta 42',
    mcc_codes: [],
    keywords: ['momsfri', 'momsfritt', 'sjukvård', 'tandvård', 'utbildning', 'undervisning', 'social omsorg', 'kultur', 'försäkring', 'finansiella tjänster', 'exempt', 'healthcare', 'education'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.70,
    default_private: false,
    fallback_category: 'income_services',
    description_sv: 'Momsfri försäljning inom Sverige (sjukvård, utbildning m.m., ruta 42)',
    common: true,
  },

  // --- FINANCIAL (2) ---
  {
    id: 'financial_loan_repayment',
    name_sv: 'Amortering lån',
    name_en: 'Loan repayment',
    group: 'financial',
    direction: 'transfer',
    entity_applicability: 'all',
    debit_account: '2350',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    mcc_codes: [],
    keywords: ['amortering', 'lån', 'loan', 'repayment', 'avbetalning'],
    risk_level: 'NONE',
    requires_review: true,
    impact_score: 5,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Amortering av banklån',
    common: false,
  },
  {
    id: 'financial_tax_account',
    name_sv: 'Insättning skattekonto',
    name_en: 'Tax account deposit',
    group: 'financial',
    direction: 'transfer',
    entity_applicability: 'all',
    debit_account: '1630',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    mcc_codes: [],
    keywords: ['skattekonto', 'skatteverket', 'tax account', 'f-skatt', 'moms inbetalning'],
    risk_level: 'NONE',
    requires_review: true,
    impact_score: 8,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Insättning på skattekonto hos Skatteverket',
    common: true,
  },

  // --- PRIVATE TRANSFERS (5) ---
  {
    id: 'private_withdrawal_ef',
    name_sv: 'Eget uttag (EF)',
    name_en: 'Owner withdrawal (EF)',
    group: 'private_transfers',
    direction: 'transfer',
    entity_applicability: 'enskild_firma',
    debit_account: '2013',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'non_deductible',
    mcc_codes: [],
    keywords: ['eget uttag', 'privat', 'withdrawal', 'egen insättning'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 10,
    auto_match_confidence: 0.85,
    default_private: true,
    fallback_category: 'private',
    description_sv: 'Privat uttag från företagskonto (enskild firma)',
    common: true,
  },
  {
    id: 'private_deposit_ef',
    name_sv: 'Egen insättning (EF)',
    name_en: 'Owner deposit (EF)',
    group: 'private_transfers',
    direction: 'transfer',
    entity_applicability: 'enskild_firma',
    debit_account: '1930',
    credit_account: '2018',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'non_deductible',
    mcc_codes: [],
    keywords: ['egen insättning', 'insättning', 'deposit', 'tillskott'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 8,
    auto_match_confidence: 0.80,
    default_private: true,
    fallback_category: 'private',
    description_sv: 'Egen insättning till företagskonto (enskild firma)',
    common: true,
  },
  {
    id: 'shareholder_loan_received',
    name_sv: 'Lån från ägare (AB)',
    name_en: 'Shareholder loan received (AB)',
    group: 'private_transfers',
    direction: 'transfer',
    entity_applicability: 'aktiebolag',
    debit_account: '1930',
    credit_account: '2393',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'non_deductible',
    mcc_codes: [],
    keywords: ['aktieägare', 'lån', 'shareholder', 'skuld till ägare', 'insättning', 'tillskott'],
    risk_level: 'LOW',
    requires_review: true,
    impact_score: 6,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'income_other',
    description_sv: 'Ägare lånar pengar till bolaget (skuld till ägare)',
    common: true,
  },
  {
    id: 'shareholder_loan_disbursed',
    name_sv: 'Fordran på ägare (AB)',
    name_en: 'Shareholder loan disbursed (AB)',
    group: 'private_transfers',
    direction: 'transfer',
    entity_applicability: 'aktiebolag',
    debit_account: '1680',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'non_deductible',
    mcc_codes: [],
    keywords: ['aktieägare', 'lån till ägare', 'shareholder loan', 'fordran ägare'],
    risk_level: 'HIGH',
    requires_review: true,
    impact_score: 6,
    auto_match_confidence: 0.70,
    default_private: true,
    fallback_category: 'private',
    description_sv: 'Bolaget betalar ut till ägare (fordran på ägare)',
    common: false,
  },
  {
    id: 'private_expense',
    name_sv: 'Privat kostnad',
    name_en: 'Private expense',
    group: 'private_transfers',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '2013',
    credit_account: '1930',
    debit_account_ab: '2893',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'non_deductible',
    mcc_codes: [],
    keywords: ['privat', 'private', 'personlig', 'personal'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 9,
    auto_match_confidence: 0.85,
    default_private: true,
    fallback_category: 'private',
    description_sv: 'Privat kostnad betald från företagskonto',
    common: false,
  },

  // --- EQUIPMENT (2) ---
  {
    id: 'equipment_small',
    name_sv: 'Förbrukningsinventarie',
    name_en: 'Consumable equipment',
    group: 'equipment',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5410',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    special_rules_sv: 'Under halva prisbasbeloppet = förbrukningsinventarie. Inkluderar IT-utrustning, möbler, verktyg.',
    mcc_codes: [5045, 5065, 5200, 5251, 5261, 5072, 5712, 5021, 5732],
    keywords: ['tangentbord', 'mus', 'headset', 'adapter', 'monitor', 'skärm', 'dator', 'laptop', 'macbook', 'möbler', 'stol', 'skrivbord', 'ikea', 'verktyg', 'maskin', 'biltema', 'jula', 'bauhaus', 'mobil', 'telefon', 'iphone'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 7,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_equipment',
    description_sv: 'Inventarier under halva prisbasbeloppet (IT-utrustning, möbler, verktyg)',
    common: true,
  },
  {
    id: 'equipment_capital',
    name_sv: 'Inventarie (aktivering)',
    name_en: 'Capital equipment (capitalize)',
    group: 'equipment',
    direction: 'expense',
    entity_applicability: 'all',
    // BAS 2026 head account for inventarier, verktyg och installationer, the
    // same asset account the fixed-asset module defaults an equipment asset to
    // (DEFAULT_ACCOUNTS_BY_CATEGORY.equipment). 1250 became a "(Fritt konto)"
    // in BAS 2026; template-accounts-exist.test.ts pins both facts.
    debit_account: '1220',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    special_rules_sv: 'Över halva prisbasbeloppet: aktivera och skriv av. Avskrivning konto 7832.',
    mcc_codes: [],
    keywords: ['inventarie', 'anläggningstillgång', 'capital', 'aktivering', 'avskrivning'],
    risk_level: 'LOW',
    requires_review: true,
    impact_score: 4,
    auto_match_confidence: 0.70,
    default_private: false,
    fallback_category: 'expense_equipment',
    description_sv: 'Inventarie som ska aktiveras och skrivas av',
    common: false,
  },
  // ============================================================
  // Measured gaps (2026-09-10)
  //
  // Twelve months of bank bookings across the fleet landed roughly a third
  // of their company-account pairs on accounts no template covered. These
  // fill the gaps in that order: goods and materials (the catalog had no
  // 4xxx account at all), owner and equity flows, then the long tail.
  // ============================================================

  // --- Goods & materials ---
  {
    id: 'goods_purchase_domestic',
    name_sv: 'Varuinköp Sverige',
    name_en: 'Goods purchase (Sweden)',
    group: 'goods',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '4010',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    special_rules_sv: 'Varor för vidareförsäljning eller som ingår i det du levererar. Till eget bruk på kontoret: förbrukningsmaterial (5460) eller inventarier (5410).',
    mcc_codes: [5211, 5039, 5085, 5198],
    keywords: ['varuinköp', 'handelsvaror', 'inköp varor', 'råvaror', 'byggmaterial', 'byggvaror', 'byggmax', 'beijer', 'ahlsell', 'jem & fix', 'jem&fix', 'hornbach', 'k-rauta', 'grossist', 'wholesale'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 9,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_consumables',
    description_sv: 'Inköp av varor och material som säljs vidare eller ingår i det du levererar',
    common: true,
  },
  {
    id: 'goods_purchase_eu',
    name_sv: 'Varuinköp från EU (omvänd moms)',
    name_en: 'Goods purchase from EU (reverse charge)',
    group: 'goods',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '4515',
    credit_account: '1930',
    vat_treatment: 'reverse_charge',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Unionsinternt förvärv: säljaren fakturerar utan moms mot ditt VAT-nummer och du redovisar 25 % själv (ruta 20, 30 och 48). Kontot 4515 bär både kostnaden och beskattningsunderlaget.',
    mcc_codes: [],
    keywords: ['eu-varor', 'varor från eu', 'unionsinternt', 'gemenskapsinternt', 'intra-community', 'amazon.de', 'amazon.nl', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.pl'],
    risk_level: 'MEDIUM',
    requires_review: true,
    impact_score: 7,
    auto_match_confidence: 0.70,
    default_private: false,
    fallback_category: 'expense_consumables',
    description_sv: 'Varor köpta från säljare i annat EU-land utan moms på fakturan',
    common: false,
    requires_vat_registration_data: true,
    reverse_charge_supplier_type: 'eu_business',
  },
  {
    id: 'consumables',
    name_sv: 'Förbrukningsmaterial',
    name_en: 'Consumables',
    group: 'goods',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5460',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    special_rules_sv: 'Sådant som förbrukas i verksamheten: rengöring, skruv, batterier, engångsartiklar. Saker som håller längre än ett år: inventarier (5410).',
    mcc_codes: [],
    keywords: ['förbrukningsmaterial', 'förbrukningsmtrl', 'rengöring', 'städmaterial', 'batterier', 'skruv', 'engångsartiklar', 'swedol', 'würth', 'wurth'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 8,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_consumables',
    description_sv: 'Material som förbrukas löpande i verksamheten',
    common: true,
  },
  {
    id: 'goods_freight',
    name_sv: 'Frakt på varor',
    name_en: 'Freight on goods',
    group: 'goods',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5710',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    special_rules_sv: 'Frakt och transportförsäkring för varor du köper eller säljer. Vanligt porto och paket från kontoret: porto och frakt (6250).',
    mcc_codes: [4214],
    keywords: ['fraktkostnad', 'fraktavgift', 'varufrakt', 'leveransavgift', 'shipping fee', 'freight', 'transportförsäkring'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Fraktkostnader knutna till varor',
    common: false,
  },
  {
    id: 'customs_duties',
    name_sv: 'Tull och spedition',
    name_en: 'Customs and forwarding',
    group: 'goods',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5720',
    credit_account: '1930',
    vat_treatment: 'exempt',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Tullavgiften saknar moms. Importmomsen redovisas i momsdeklarationen (ruta 50 och 60) utifrån tullräkningen, inte som ingående moms på speditörens faktura.',
    mcc_codes: [],
    keywords: ['tull', 'tullverket', 'tullavgift', 'förtullning', 'customs', 'import duty', 'spedition', 'speditör', 'importavgift'],
    risk_level: 'LOW',
    requires_review: true,
    impact_score: 5,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Tullavgifter och speditionskostnader vid import',
    common: false,
  },

  // --- IT services (the 6540 family, distinct from licences on 5420) ---
  {
    id: 'it_services',
    name_sv: 'IT-tjänster och utveckling',
    name_en: 'IT services and development',
    group: 'it_software',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6540',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'full',
    special_rules_sv: 'Köpta IT-tjänster: utveckling, support, drift. Licenser och abonnemang: programvara (5420).',
    mcc_codes: [7372, 7379],
    keywords: ['it-tjänst', 'it-tjänster', 'it-konsult', 'it-support', 'webbutveckling', 'systemutveckling', 'apputveckling', 'utvecklare', 'webbyrå', 'devops', 'drift och support'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 8,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_professional_services',
    description_sv: 'IT-tjänster köpta från svensk leverantör',
    common: true,
  },
  {
    id: 'it_services_foreign',
    name_sv: 'IT-tjänster utanför EU (omvänd moms)',
    name_en: 'IT services from outside the EU (reverse charge)',
    group: 'it_software',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6540',
    credit_account: '1930',
    vat_treatment: 'reverse_charge',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Frilansplattformar och byråer utanför EU fakturerar utan moms; du redovisar 25 % själv (ruta 22, 30 och 48). Leverantör inom EU: samma booking men ruta 21, välj EU-leverantör vid granskningen.',
    mcc_codes: [],
    keywords: ['upwork', 'fiverr', 'toptal', 'freelancer.com', 'outsourcing', 'offshore', 'utländsk utvecklare'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 7,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_professional_services',
    description_sv: 'IT-tjänster köpta från leverantör utanför EU med omvänd skattskyldighet',
    common: false,
    requires_vat_registration_data: true,
    reverse_charge_supplier_type: 'non_eu_business',
  },

  // --- Long tail of external costs ---
  {
    id: 'newspapers_literature',
    name_sv: 'Tidningar och facklitteratur',
    name_en: 'Newspapers and trade literature',
    group: 'education',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6970',
    credit_account: '1930',
    vat_treatment: 'reduced_6',
    vat_rate: 0.06,
    deductibility: 'full',
    special_rules_sv: 'Tryckta och digitala tidningar, tidskrifter och böcker har 6 % moms. Utländsk digital prenumeration: omvänd moms.',
    mcc_codes: [5192, 5942, 5994],
    keywords: ['tidning', 'tidskrift', 'dagstidning', 'facklitteratur', 'dagens industri', 'svenska dagbladet', 'dagens nyheter', 'breakit', 'bonnier news', 'adlibris', 'bokus', 'akademibokhandeln', 'prenumeration tidning'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_education',
    description_sv: 'Tidningar, tidskrifter och facklitteratur för verksamheten',
    common: false,
  },
  {
    id: 'non_deductible_fees',
    name_sv: 'Böter och förseningsavgifter',
    name_en: 'Fines and late fees',
    group: 'financial',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '6992',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'non_deductible',
    deductibility_note_sv: 'Böter, viten, förseningsavgifter och skattetillägg är inte avdragsgilla och saknar moms',
    mcc_codes: [9222],
    keywords: ['böter', 'bot', 'förseningsavgift', 'kontrollavgift', 'skattetillägg', 'felparkering', 'parkeringsanmärkning', 'parkeringsböter', 'fortkörning', 'penalty'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Ej avdragsgilla avgifter: böter, viten, förseningsavgifter',
    common: false,
  },

  // --- Personnel ---
  {
    id: 'personnel_refreshments',
    name_sv: 'Personalfika och frukt',
    name_en: 'Staff refreshments',
    group: 'personnel',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '7690',
    credit_account: '1930',
    vat_treatment: 'reduced_6',
    vat_rate: 0.06,
    deductibility: 'full',
    special_rules_sv: 'Enklare förtäring på arbetsplatsen är personalvård med fullt avdrag. Livsmedel har 6 % moms, från kafé eller restaurang 12 %. Måltider med personalen: intern representation.',
    mcc_codes: [5411, 5499],
    keywords: ['personalfika', 'fruktkorg', 'frukt till kontoret', 'kontorskaffe', 'kaffe till kontoret', 'fruktbudet', 'selecta', 'jobmeal', 'kontorsfika'],
    risk_level: 'LOW',
    requires_review: true,
    impact_score: 6,
    auto_match_confidence: 0.70,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Fika, frukt och kaffe till personalen',
    common: true,
  },
  {
    id: 'personnel_wellness',
    name_sv: 'Friskvård',
    name_en: 'Wellness benefit',
    group: 'personnel',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '7699',
    credit_account: '1930',
    vat_treatment: 'reduced_6',
    vat_rate: 0.06,
    deductibility: 'full',
    special_rules_sv: 'Skattefri friskvård för anställda upp till 5 000 kr per person och år. Gym och motion har 6 % moms, massage och naprapat 25 %. Ägaren av en enskild firma är inte anställd och får ingen friskvård.',
    mcc_codes: [7997],
    // No "massage": the template books gym's 6 % and its own rule above puts
    // massage at 25 %, so the keyword proposed a rate the rule contradicts
    // (PostHog PH 118).
    keywords: ['friskvård', 'friskvårdsbidrag', 'gym', 'gymkort', 'träningskort', 'sats sverige', 'nordic wellness', 'fitness24seven', 'actic', 'friskis', 'epassi', 'wellnet'],
    risk_level: 'LOW',
    requires_review: true,
    impact_score: 6,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Friskvård för anställda',
    common: false,
  },

  // --- Vehicle ---
  {
    id: 'vehicle_tax',
    name_sv: 'Fordonsskatt',
    name_en: 'Vehicle tax',
    group: 'vehicle',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5612',
    credit_account: '1930',
    vat_treatment: 'exempt',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Fordonsskatt saknar moms. Gäller fordon som verksamheten äger; privat bil i enskild firma ersätts med milersättning i stället.',
    mcc_codes: [],
    keywords: ['fordonsskatt', 'vägtrafikskatt', 'transportstyrelsen', 'transportstyr', 'vehicle tax'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_vehicle',
    description_sv: 'Fordonsskatt för verksamhetens fordon',
    common: false,
  },
  {
    id: 'vehicle_rental',
    name_sv: 'Hyrbil',
    name_en: 'Car rental',
    group: 'vehicle',
    direction: 'expense',
    entity_applicability: 'all',
    debit_account: '5820',
    credit_account: '1930',
    vat_treatment: 'standard_25',
    vat_rate: 0.25,
    deductibility: 'conditional',
    deductibility_note_sv: 'Max 50 % momsavdrag vid hyra av personbil',
    special_rules_sv: 'Personbil: halvt momsavdrag, som vid leasing. Lastbil och lätt lastbil: fullt avdrag.',
    mcc_codes: [7512, 3355, 3357, 3366, 3381, 3387, 3389, 3393, 3405],
    keywords: ['hyrbil', 'hyra bil', 'biluthyrning', 'rental car', 'car rental', 'europcar', 'hertz', 'sixt', 'enterprise rent', 'kinto', 'recordgo', 'mabi'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 5,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'expense_travel',
    description_sv: 'Hyrbil vid tjänsteresa eller tillfälligt behov',
    common: false,
  },

  // --- Owner and equity flows (AB) ---
  {
    id: 'share_capital_deposit',
    name_sv: 'Insättning av aktiekapital',
    name_en: 'Share capital paid in',
    group: 'private_transfers',
    direction: 'transfer',
    entity_applicability: 'aktiebolag',
    debit_account: '1930',
    credit_account: '2081',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'non_deductible',
    special_rules_sv: 'Aktiekapitalet vid bolagsbildning eller nyemission. Nyemission till överkurs: överkursen på fri överkursfond (2097).',
    mcc_codes: [],
    keywords: ['aktiekapital', 'share capital', 'bolagsbildning', 'nyemission', 'aktieteckning', 'inbetalning aktiekapital'],
    risk_level: 'LOW',
    requires_review: true,
    impact_score: 8,
    auto_match_confidence: 0.85,
    default_private: false,
    fallback_category: 'income_other',
    description_sv: 'Inbetalt aktiekapital från ägarna vid bildande eller nyemission',
    common: true,
  },
  {
    id: 'shareholder_contribution',
    name_sv: 'Aktieägartillskott',
    name_en: 'Shareholder contribution',
    group: 'private_transfers',
    direction: 'transfer',
    entity_applicability: 'aktiebolag',
    debit_account: '1930',
    credit_account: '2093',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'non_deductible',
    special_rules_sv: 'Ovillkorat och villkorat tillskott bokförs båda på 2093; villkoret om återbetalning noteras i årsredovisningen. Ett lån från ägaren är i stället en skuld (2393).',
    mcc_codes: [],
    keywords: ['aktieägartillskott', 'ovillkorat aktieägartillskott', 'villkorat aktieägartillskott', 'shareholder contribution', 'kapitaltillskott'],
    risk_level: 'LOW',
    requires_review: true,
    impact_score: 7,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'income_other',
    description_sv: 'Tillskott från ägarna som stärker bolagets egna kapital',
    common: false,
  },
  {
    id: 'dividend_paid',
    name_sv: 'Utbetald utdelning',
    name_en: 'Dividend paid',
    group: 'private_transfers',
    direction: 'transfer',
    entity_applicability: 'aktiebolag',
    debit_account: '2898',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'non_deductible',
    special_rules_sv: 'Bokför stämmans beslut först: debet 2091, kredit 2898. Sedan utbetalningen härifrån. Utdelning kräver fritt eget kapital i senaste fastställda balansräkning.',
    mcc_codes: [],
    keywords: ['utdelning', 'aktieutdelning', 'vinstutdelning', 'dividend', 'beslutad utdelning'],
    risk_level: 'HIGH',
    requires_review: true,
    impact_score: 8,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Utbetalning av beslutad utdelning till aktieägarna',
    common: true,
  },

  // --- Placements (AB) ---
  {
    id: 'capital_insurance_deposit',
    name_sv: 'Insättning kapitalförsäkring',
    name_en: 'Capital insurance deposit',
    group: 'financial',
    direction: 'transfer',
    entity_applicability: ['aktiebolag', 'ekonomisk_forening'],
    debit_account: '1385',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'non_deductible',
    special_rules_sv: 'Insättningen är en finansiell tillgång, inte en kostnad. Uttag bokförs mot 1385 och vinst eller förlust på 8220. Avkastningsskatten dras av försäkringsbolaget.',
    mcc_codes: [],
    keywords: ['kapitalförsäkring', 'kf', 'insättning kapitalförsäkring', 'avanza kf', 'nordnet kf', 'skandia kapitalförsäkring'],
    risk_level: 'MEDIUM',
    requires_review: true,
    impact_score: 6,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Placering av överskott i en kapitalförsäkring',
    common: false,
  },
  {
    id: 'securities_purchase',
    name_sv: 'Köp av aktier och fonder',
    name_en: 'Purchase of shares and funds',
    group: 'financial',
    direction: 'transfer',
    entity_applicability: ['aktiebolag', 'ekonomisk_forening'],
    debit_account: '1810',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'non_deductible',
    special_rules_sv: 'Kortfristig placering av överskott i noterade aktier och fonder. Långsiktigt innehav: andra långfristiga värdepappersinnehav (1350). Vinst och förlust bokförs som finansiell post vid försäljning.',
    mcc_codes: [],
    keywords: ['aktier', 'fonder', 'värdepapper', 'fondköp', 'aktieköp', 'depå', 'avanza', 'nordnet'],
    risk_level: 'HIGH',
    requires_review: true,
    impact_score: 6,
    auto_match_confidence: 0.70,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Placering av överskott i aktier eller fonder',
    common: false,
  },

  // --- Income without VAT logic of its own ---
  {
    id: 'grant_received',
    name_sv: 'Erhållet bidrag',
    name_en: 'Grant received',
    group: 'revenue',
    direction: 'income',
    entity_applicability: 'all',
    debit_account: '1930',
    credit_account: '3985',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'Bidrag utan motprestation ligger utanför momsen. EU-bidrag: 3981, kommunala bidrag: 3987, bidrag för personal som lönebidrag: 3988.',
    mcc_codes: [],
    keywords: ['bidrag', 'projektbidrag', 'tillväxtverket', 'vinnova', 'kulturrådet', 'konstnärsnämnden', 'energimyndigheten', 'jordbruksverket', 'länsstyrelsen', 'grant'],
    risk_level: 'MEDIUM',
    requires_review: true,
    impact_score: 7,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'income_other',
    description_sv: 'Statligt bidrag eller stöd utan motprestation',
    common: false,
  },
  {
    id: 'royalty_income',
    name_sv: 'Royalty och upphovsrättsersättning',
    name_en: 'Royalty and copyright income',
    group: 'revenue',
    direction: 'income',
    entity_applicability: 'all',
    debit_account: '1930',
    credit_account: '3922',
    vat_treatment: 'reduced_6',
    vat_rate: 0.06,
    deductibility: 'full',
    special_rules_sv: 'Upplåtelse av upphovsrätt till litterära och musikaliska verk har 6 % moms. Licens på programvara eller varumärke: 25 %.',
    mcc_codes: [],
    keywords: ['royalty', 'royalties', 'upphovsrätt', 'upphovsrättslig ersättning', 'stim', 'sami', 'ifpi', 'licensintäkt', 'distrokid', 'cd baby', 'tunecore'],
    risk_level: 'LOW',
    requires_review: true,
    impact_score: 6,
    auto_match_confidence: 0.75,
    default_private: false,
    fallback_category: 'income_other',
    description_sv: 'Royalty och ersättning för upphovsrätt',
    common: false,
  },

  // --- Settlements of liabilities booked elsewhere ---
  {
    id: 'company_card_settlement',
    name_sv: 'Avräkning företagskort',
    name_en: 'Company card settlement',
    group: 'financial',
    direction: 'transfer',
    entity_applicability: 'all',
    debit_account: '2890',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'non_deductible',
    special_rules_sv: 'Kortköpen bokförs var för sig när kvittona kommer in, mot 2890. Överföringen till kortbolaget kvittar skulden.',
    mcc_codes: [],
    keywords: ['mynt', 'pleo', 'soldo', 'företagskort', 'kortavräkning', 'kortfaktura', 'card settlement'],
    risk_level: 'LOW',
    requires_review: true,
    impact_score: 6,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Betalning till kortbolag för köp som bokförts på kvittona',
    common: false,
  },
  {
    id: 'expense_reimbursement',
    name_sv: 'Återbetalning av utlägg',
    name_en: 'Expense reimbursement',
    group: 'personnel',
    direction: 'transfer',
    entity_applicability: 'all',
    debit_account: '2820',
    credit_account: '1930',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'non_deductible',
    special_rules_sv: 'Kvittot bokförs som utlägg mot 2820 när det registreras; den här utbetalningen kvittar skulden till den anställde. Är kvittot inte registrerat: bokför utbetalningen direkt på kostnadskontot.',
    mcc_codes: [],
    keywords: ['utlägg', 'ers utlägg', 'ers. utlägg', 'ersättning utlägg', 'återbetalning utlägg', 'expense reimbursement', 'reimbursement'],
    risk_level: 'LOW',
    requires_review: true,
    impact_score: 6,
    auto_match_confidence: 0.70,
    default_private: false,
    fallback_category: 'expense_other',
    description_sv: 'Utbetalning till anställd för registrerat utlägg',
    common: false,
  },

  // --- EKONOMISK FÖRENING: member capital (EFL 10-11 kap.) ---
  // Insatser are bundet eget kapital, never revenue: a paid insats credits
  // 2083 and leaves the result and the tax base untouched (ÅRL 3 kap. 10 b §,
  // Skatteverket "Deklarera för en ekonomisk förening"). Repayment on exit,
  // insatsemission, förlagsinsats redemption and decided distributions need
  // the statutory member register (EFL 5 kap.) and a stämma/board decision,
  // so they are deliberately not templates: book them manually against the
  // register until the member-capital module ships.
  {
    id: 'member_contribution_received',
    name_sv: 'Medlemsinsats inbetald',
    name_en: 'Member contribution received',
    group: 'financial',
    direction: 'transfer',
    entity_applicability: 'ekonomisk_forening',
    debit_account: '1930',
    credit_account: '2083',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv:
      'Medlemsinsatser är bundet eget kapital (ÅRL 3 kap. 10 b §), inte en intäkt, och beskattas inte hos föreningen. Stäm av mot medlemsförteckningen (EFL 5 kap.). Återbetalning vid avgång bokförs D 2083 / K 1930 först efter beslut och kontroll av utbetalningsbart belopp (EFL 10 kap. 11 §).',
    mcc_codes: [],
    keywords: ['medlemsinsats', 'insats', 'insatskapital', 'andel', 'medlemskapital'],
    risk_level: 'NONE',
    requires_review: true,
    impact_score: 8,
    auto_match_confidence: 0.6,
    default_private: false,
    fallback_category: 'income_other',
    description_sv: 'Inbetald obligatorisk insats eller överinsats från medlem',
    common: true,
  },
  {
    id: 'debenture_contribution_received',
    name_sv: 'Förlagsinsats inbetald',
    name_en: 'Subordinated member contribution received',
    group: 'financial',
    direction: 'transfer',
    entity_applicability: 'ekonomisk_forening',
    debit_account: '1930',
    credit_account: '2084',
    vat_treatment: null,
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv:
      'Förlagsinsatser (EFL 11 kap.) är bundet eget kapital som redovisas skilt från medlemsinsatserna (ÅRL 3 kap. 10 b §). Föreningen ska föra en förteckning över förlagsinsatserna (EFL 11 kap. 6 §); inlösen får ske tidigast efter fem år (EFL 11 kap. 7 §).',
    mcc_codes: [],
    keywords: ['förlagsinsats', 'förlagsandel', 'förlagsandelsbevis'],
    risk_level: 'NONE',
    requires_review: true,
    impact_score: 7,
    auto_match_confidence: 0.6,
    default_private: false,
    fallback_category: 'income_other',
    description_sv: 'Inbetald förlagsinsats från medlem eller annan',
    common: false,
  },
  {
    id: 'membership_fee_received',
    name_sv: 'Medlemsavgift',
    name_en: 'Membership fee received',
    group: 'revenue',
    direction: 'income',
    entity_applicability: 'ekonomisk_forening',
    debit_account: '1930',
    credit_account: '3901',
    vat_treatment: 'exempt',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv:
      'Medlemsavgifter som täcker föreningens administration är övriga rörelseintäkter, skattefria för föreningen och utan moms; bokslutet föreslår saldot på 3901 som avdrag i INK2S 4.5c. Motsvarande administrationskostnader är inte avdragsgilla och anges manuellt under 4.3c (Skatteverket, "Deklarera för en ekonomisk förening"). Serviceavgifter för tjänster till medlemmarna är vanlig momspliktig omsättning och bokförs med försäljningsmallarna.',
    mcc_codes: [],
    keywords: ['medlemsavgift', 'årsavgift', 'medlemskap', 'membership fee'],
    risk_level: 'NONE',
    requires_review: true,
    impact_score: 6,
    auto_match_confidence: 0.6,
    default_private: false,
    fallback_category: 'income_other',
    description_sv: 'Medlemsavgift som täcker föreningens administration (skattefri, momsfri)',
    common: true,
  },
]

// ============================================================
// Lookup Indexes (built once at module load)
// ============================================================

const templateById = new Map<string, BookingTemplate>()

for (const t of BOOKING_TEMPLATES) {
  templateById.set(t.id, t)
}

// ============================================================
// Public API
// ============================================================

/** O(1) lookup by template ID */
export function getTemplateById(id: string): BookingTemplate | undefined {
  return templateById.get(id)
}

/**
 * Fuzzy search templates by name, keywords, or description.
 * Optionally filter by entity type.
 */
/**
 * Account-number matching for template search: an all-digit token prefix-
 * matches the template's BUSINESS account(s), i.e. the cost/revenue side,
 * not the settlement side. Matching the settlement leg too would make "1930"
 * (the default bank account) light up nearly every template, which is noise,
 * not search. Transfers have no business/settlement split, so both legs
 * match. AB-variant accounts are included so the search works for both
 * entity types. Account numbers are identifiers (strings): prefix match only.
 */
function templateAccountMatches(t: BookingTemplate, token: string): boolean {
  if (!/^\d+$/.test(token)) return false
  const candidates =
    t.direction === 'expense'
      ? [t.debit_account, t.debit_account_ab]
      : t.direction === 'income'
        ? [t.credit_account, t.credit_account_ab]
        : [t.debit_account, t.credit_account, t.debit_account_ab, t.credit_account_ab]
  return candidates.some((acc) => !!acc && acc.startsWith(token))
}

export function searchTemplates(query: string, entityType?: EntityType): BookingTemplate[] {
  if (!query.trim()) return []
  const q = query.toLowerCase()
  const tokens = q.split(/\s+/).filter(Boolean)

  return BOOKING_TEMPLATES.filter((t) => {
    // Filter by entity applicability
    if (entityType && !templateAppliesToForm(t, entityType)) {
      return false
    }

    // Check if all tokens match somewhere
    return tokens.every((token) =>
      t.name_sv.toLowerCase().includes(token) ||
      t.name_en.toLowerCase().includes(token) ||
      t.description_sv.toLowerCase().includes(token) ||
      t.keywords.some((kw) => kw.toLowerCase().includes(token)) ||
      t.id.includes(token) ||
      templateAccountMatches(t, token)
    )
  })
}

/**
 * Get common templates, filtered by entity type and direction.
 */
export function getCommonTemplates(
  entityType?: EntityType,
  direction?: 'expense' | 'income' | 'transfer'
): BookingTemplate[] {
  return BOOKING_TEMPLATES.filter((t) => {
    if (!t.common) return false
    if (entityType && !templateAppliesToForm(t, entityType)) return false
    if (direction && t.direction !== direction) return false
    return true
  })
}

/**
 * Get advanced (non-common) templates, filtered by entity type and direction.
 */
export function getAdvancedTemplates(
  entityType?: EntityType,
  direction?: 'expense' | 'income' | 'transfer'
): BookingTemplate[] {
  return BOOKING_TEMPLATES.filter((t) => {
    if (t.common) return false
    if (entityType && !templateAppliesToForm(t, entityType)) return false
    if (direction && t.direction !== direction) return false
    return true
  })
}

/**
 * Validate that a template is valid for the given entity type.
 */
export function validateTemplateForEntity(
  template: BookingTemplate,
  entityType: EntityType
): { valid: boolean; error?: string } {
  if (templateAppliesToForm(template, entityType)) return { valid: true }
  const scope = template.entity_applicability
  const validFor = Array.isArray(scope) ? scope.join(', ') : String(scope)
  return {
    valid: false,
    error: `Template "${template.name_sv}" is only valid for ${validFor}. Your entity type is ${entityType}.`,
  }
}

/**
 * Common Swedish bank-description prefixes/suffixes that describe HOW a payment
 * was made, not WHAT was purchased. These get stripped before keyword matching
 * so a transaction text like "milersättning april Överföring via internet" no
 * longer collides with the `telecom_internet` template's `internet` keyword.
 *
 * Order matters: list longer phrases first so substring removal hits them
 * before shorter ones (e.g. "överföring via internet" before "internet").
 */
const BANK_NOISE_PHRASES: readonly string[] = [
  'överföring via internet',
  'överföring via mobil',
  'överföring via app',
  'överföring inom bank',
  'överföring mellan konton',
  'internetbetalning',
  // Handelsbanken's truncated form ("INTERNET BET 1"): a supplier payment
  // made in the internet bank, not an internet subscription.
  'internet bet',
  'mobilbetalning',
  'direktbetalning',
  'direktöverföring',
  'autogirobetalning',
  'autogiro',
  'bg-betalning',
  'bg betalning',
  'pg-betalning',
  'pg betalning',
  'bgmax',
  'bg-inb',
  'plusgiro',
  'bankgiro',
  'swish till',
  'swish från',
  'swish-betalning',
  'kortköp',
  'kortbetalning',
  'webbköp',
  'överföring',
  'insättning',
]

/**
 * Strip bank-payment-method noise from a description so the substring matcher
 * doesn't match on the bank's own prefix vocabulary. Operates on lowercase
 * input and collapses the whitespace it leaves behind.
 */
export function stripBankNoise(lowerText: string): string {
  let out = lowerText
  for (const phrase of BANK_NOISE_PHRASES) {
    if (out.includes(phrase)) {
      out = out.split(phrase).join(' ')
    }
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** Keywords up to this length are matched as whole words; longer ones may sit inside a word ("fjärruppvärmning"). */
const WHOLE_WORD_KEYWORD_MAX = 3

const NON_WORD = /[^\p{L}\p{N}]+/u

/** The text's words, single-spaced, with a space at each end: a whole word is ` word `. */
function paddedWordsOf(text: string): string {
  return ` ${text.split(NON_WORD).filter(Boolean).join(' ')} `
}

/**
 * Whether one keyword is in the text. A keyword longer than three letters may
 * sit inside a word: a Swedish compound puts the thing it names last
 * ("kundlunch", "fjärruppvärmning") and a card descriptor glues words
 * together ("SKATTEVERKET", "CLOUDFLARE"), so a word boundary on every
 * keyword would lose more right matches than wrong ones. A short keyword, or
 * one written with a leading '=' (the convention of the Inkorg's line
 * matcher, lib/categories/purchase-category-keywords.ts), matches whole words
 * only: '=' is for a word that mostly opens a compound naming something else
 * ("representationsgåva" is a gift, accounted#92).
 */
function keywordMatches(searchText: string, paddedWords: string, keyword: string): boolean {
  const wholeWord = keyword.startsWith('=')
  const text = wholeWord ? keyword.slice(1) : keyword
  if (wholeWord || text.length <= WHOLE_WORD_KEYWORD_MAX) return paddedWords.includes(paddedWordsOf(text))
  return searchText.includes(text)
}

/**
 * Multi-signal matching against a transaction.
 * Returns top matches sorted by confidence descending.
 */
export function findMatchingTemplates(
  transaction: Transaction,
  entityType?: EntityType
): TemplateMatch[] {
  const results: TemplateMatch[] = []
  const isExpense = transaction.amount < 0
  const isIncome = transaction.amount > 0

  const descLower = (transaction.description || '').toLowerCase()
  const merchantLower = (transaction.merchant_name || '').toLowerCase()
  const rawSearchText = `${descLower} ${merchantLower}`
  // Strip bank-method noise so e.g. "Överföring via internet" doesn't make
  // the matcher believe the merchant is "Internet" (→ 6230 telecom).
  const searchText = stripBankNoise(rawSearchText)
  const paddedWords = paddedWordsOf(searchText)
  const inText = (kw: string) => keywordMatches(searchText, paddedWords, kw.toLowerCase())

  for (const t of BOOKING_TEMPLATES) {
    // Filter entity applicability
    if (entityType && !templateAppliesToForm(t, entityType)) {
      continue
    }

    // Filter direction
    if (t.direction === 'expense' && !isExpense) continue
    if (t.direction === 'income' && !isIncome) continue
    // 'transfer' templates match both directions

    // A text that says it is something else (a gift is not a meal) keeps
    // the template out, a restaurant MCC included.
    if (t.excluded_keywords?.some(inText)) continue

    let score = 0

    // MCC exact match: +0.4
    if (transaction.mcc_code && t.mcc_codes.includes(transaction.mcc_code)) {
      score += 0.4
    }

    // Keyword matches in description + merchant: +0.3 (proportional).
    // Short keywords match whole words only: "el" inside "vercel" or
    // "hotel" made El & Uppvärmning the top proposal for a hosting bill.
    if (t.keywords.length > 0) {
      let matchedKeywords = 0
      for (const kw of t.keywords) {
        if (inText(kw)) {
          matchedKeywords++
        }
      }
      if (matchedKeywords > 0) {
        score += 0.3 * Math.min(matchedKeywords / Math.min(t.keywords.length, 3), 1)
      }
    }

    // Direction match bonus: +0.1 (only if there's already a signal)
    if (score > 0 && ((t.direction === 'expense' && isExpense) || (t.direction === 'income' && isIncome))) {
      score += 0.1
    }

    if (score > 0) {
      const confidence = Math.round(score * t.auto_match_confidence * 100) / 100
      results.push({ template: t, confidence })
    }
  }

  return results
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10)
}

/**
 * Convert a booking template into a MappingResult.
 * Follows the same pattern as buildMappingResultFromCategory in category-mapping.ts.
 */
export function buildMappingResultFromTemplate(
  template: BookingTemplate,
  transaction: Transaction,
  entityType: EntityType,
  vatRegistered?: VatRegistration,
  /**
   * The company's skattekonto account (lib/skatteverket/skattekonto-account.ts):
   * the template's 1630 books on it, 2012 for an enskild firma that runs the
   * skattekonto there (PH 175). Callers pass it for a template that names 1630.
   */
  skattekontoAccount?: SkattekontoLedgerAccount,
): MappingResult {
  const isExpense = transaction.amount < 0
  const isBusiness = !template.default_private
  // The template's treatment resolved for the company's VAT registration: a
  // non-registered company books a rate-bearing template as exempt, reverse
  // charge stays (lib/bookkeeping/vat-registration.ts).
  const vatTreatment = vatTreatmentForRegistration(template.vat_treatment, vatRegistered)

  // Resolve entity-specific accounts (EF base, AB override, förening: base
  // with owner accounts translated to the member settlement account).
  const debitAccount = templateSkattekontoAccount(
    templateAccountForForm(entityType, template.debit_account, template.debit_account_ab)!,
    skattekontoAccount,
  )
  const creditAccount = templateSkattekontoAccount(
    templateAccountForForm(entityType, template.credit_account, template.credit_account_ab)!,
    skattekontoAccount,
  )

  // Always work in SEK. For non-SEK transactions, resolve the SEK-equivalent
  // (via amount_sek or amount * exchange_rate); for SEK rows this is a no-op.
  // Without this, VAT and reverse-charge lines would be emitted in the
  // original currency and the resulting verifikation would mix currencies.
  const absAmount = Math.abs(resolveSekAmount(
    transaction.amount,
    transaction.amount_sek,
    transaction.currency,
    transaction.exchange_rate
  ))

  // Generate VAT lines
  const vatLines: VatJournalLine[] = []
  if (isBusiness && vatTreatment && template.deductibility !== 'non_deductible') {
    const vatRate = getVatRate(vatTreatment)

    if (vatTreatment === 'reverse_charge' && isExpense) {
      // EU/non-EU/domestic reverse charge: emit BOTH the fiktiv-moms pair
      // (2645|2647 / 2614) AND the basbelopp pair (44xx|45xx / 4598). The
      // basbelopp pair populates momsdeklaration rutor 20-24; without it
      // Skatteverket rejects with FK004 ("ruta 30-32 utan motsvarande
      // basbelopp i 20-24", ML 13 kap kräver båda sidor).
      //
      // A template whose debit account reports the basis itself (4515, or an
      // account with a reverse-charge momskod) loses the pair, and takes that
      // account's momssats, when the booking door settles it with the chart
      // (reconcileRcBasisWithChart): keeping the pair would double-count.
      const rcLines = generateReverseChargePurchaseLines({
        base: absAmount,
        rate: 0.25, // fiktiv moms rate; current templates are 25%
        kind: reverseChargeKindForSupplierType(template.reverse_charge_supplier_type ?? 'eu_business'),
      })
      for (const rcl of rcLines) {
        vatLines.push({
          account_number: rcl.account_number,
          debit_amount: rcl.debit_amount,
          credit_amount: rcl.credit_amount,
          description: rcl.line_description || '',
        })
      }
    } else if (vatRate > 0 && isExpense) {
      // Input VAT deduction
      const vatLine = generateInputVatLine(absAmount, vatRate)
      if (vatLine) {
        vatLines.push({
          account_number: vatLine.account_number,
          debit_amount: vatLine.debit_amount,
          credit_amount: vatLine.credit_amount,
          description: vatLine.line_description || '',
        })
      }
    } else if (vatRate > 0 && !isExpense) {
      // Output VAT (income)
      const vatAmount = grossVat(absAmount, vatRate)
      vatLines.push({
        account_number: getOutputVatAccount(vatTreatment),
        debit_amount: 0,
        credit_amount: vatAmount,
        description: `Utgående moms ${vatRate * 100}%`,
      })
    }
  }

  // Build description
  const description = `${template.name_sv}: ${transaction.description}`

  return {
    rule: null,
    template_id: template.id,
    debit_account: debitAccount,
    credit_account: creditAccount,
    risk_level: template.risk_level,
    confidence: 1.0, // User explicitly selected template
    requires_review: template.requires_review,
    default_private: template.default_private,
    vat_lines: vatLines,
    description,
  }
}

/**
 * The skattekonto account buildMappingResultFromTemplate takes for this
 * company: read (resolveSkattekontoAccount, which throws when it cannot be
 * read) only when the template names the skattekonto (1630) on either form's
 * accounts; undefined, without a read, otherwise.
 */
export async function templateSkattekontoAccountFor(
  supabase: SupabaseClient,
  companyId: string,
  template: Pick<BookingTemplate, 'debit_account' | 'credit_account' | 'debit_account_ab' | 'credit_account_ab'>,
): Promise<SkattekontoLedgerAccount | undefined> {
  return templateTouchesSkattekonto([
    template.debit_account,
    template.credit_account,
    template.debit_account_ab,
    template.credit_account_ab,
  ])
    ? await resolveSkattekontoAccount(supabase, companyId)
    : undefined
}
