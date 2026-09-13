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
  generateReverseChargeLines,
  generateReverseChargeBasisLines,
  generateInputVatLine,
} from './vat-entries'
import { resolveSekAmount } from './currency-utils'
import { templateAccountForForm } from '@/lib/company/entity-type'

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
  entity_applicability: 'all' | EntityType
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
  keywords: string[]
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

export interface TemplateGroupInfo {
  group: TemplateGroup
  label_sv: string
  label_en: string
  templates: BookingTemplate[]
}

export interface TemplateMatch {
  template: BookingTemplate
  confidence: number
}

// ============================================================
// Template Group Labels
// ============================================================

const GROUP_LABELS: Record<TemplateGroup, { sv: string; en: string }> = {
  premises: { sv: 'Lokalkostnader', en: 'Premises' },
  vehicle: { sv: 'Fordon', en: 'Vehicle' },
  it_software: { sv: 'IT & Programvara', en: 'IT & Software' },
  office_supplies: { sv: 'Kontorsmaterial', en: 'Office Supplies' },
  marketing: { sv: 'Marknadsföring', en: 'Marketing' },
  travel: { sv: 'Resor & Transport', en: 'Travel & Transport' },
  representation: { sv: 'Representation', en: 'Representation' },
  insurance: { sv: 'Försäkringar', en: 'Insurance' },
  professional_services: { sv: 'Professionella tjänster', en: 'Professional Services' },
  bank_finance: { sv: 'Bank & Finans', en: 'Banking & Finance' },
  telecom: { sv: 'Telekom & Internet', en: 'Telecom & Internet' },
  education: { sv: 'Utbildning', en: 'Education' },
  personnel: { sv: 'Personal', en: 'Personnel' },
  revenue: { sv: 'Intäkter', en: 'Revenue' },
  financial: { sv: 'Finansiella poster', en: 'Financial Items' },
  private_transfers: { sv: 'Privata transaktioner', en: 'Private Transfers' },
  equipment: { sv: 'Inventarier & Utrustning', en: 'Equipment' },
  goods: { sv: 'Varor & material', en: 'Goods & Materials' },
  tax: { sv: 'Skatt & moms', en: 'Tax & VAT' },
  closing: { sv: 'Bokslut', en: 'Year-end' },
}

// ============================================================
// Template Data
// ============================================================

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

  // --- IT & SOFTWARE (3) ---
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
    keywords: ['software', 'saas', 'programvara', 'licens', 'subscription', 'app', 'microsoft', 'google', 'adobe', 'slack', 'notion', 'figma', 'github', 'atlassian', 'jira', 'antivirus', 'vpn', 'norton', '1password', 'lastpass', 'bitwarden', 'spotify', 'crm', 'hubspot', 'salesforce', 'pipedrive', 'asana', 'monday', 'trello', 'basecamp', 'clickup', 'linear', 'dropbox', 'onedrive', 'icloud', 'backup'],
    risk_level: 'NONE',
    requires_review: false,
    impact_score: 10,
    auto_match_confidence: 0.90,
    default_private: false,
    fallback_category: 'expense_software',
    description_sv: 'Programvarulicens eller SaaS-prenumeration (svensk leverantör med moms)',
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
    special_rules_sv: 'Utländsk leverantör (EU/USA) med omvänd skattskyldighet',
    mcc_codes: [5734, 5817, 5818],
    keywords: ['software', 'saas', 'eu', 'ireland', 'reverse charge', 'omvänd moms', 'openai', 'chatgpt', 'anthropic', 'claude', 'ai', 'midjourney', 'copilot', 'google cloud', 'aws', 'azure'],
    risk_level: 'LOW',
    requires_review: false,
    impact_score: 9,
    auto_match_confidence: 0.80,
    default_private: false,
    fallback_category: 'expense_software',
    description_sv: 'Programvara från utländsk leverantör med omvänd skattskyldighet',
    common: true,
    requires_vat_registration_data: true,
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
    special_rules_sv: 'Ofta EU/utländsk leverantör med omvänd skattskyldighet',
    mcc_codes: [4816],
    keywords: ['aws', 'azure', 'google cloud', 'gcp', 'hosting', 'server', 'cloud', 'vercel', 'heroku', 'digitalocean', 'cloudflare', 'hetzner', 'domän', 'domain', 'dns', 'loopia', 'binero', 'godaddy'],
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
    debit_account: '6071',
    credit_account: '1930',
    vat_treatment: 'reduced_12',
    vat_rate: 0.12,
    deductibility: 'conditional',
    deductibility_note_sv: 'Momsavdrag på högst 300 kr/person (schablon 46 kr/person vid mat och alkohol); måltider inte avdragsgilla för inkomstskatt sedan 2017',
    special_rules_sv: 'Dokumentera syfte, deltagare och företag.',
    mcc_codes: [5812, 5813, 5814],
    keywords: ['representation', 'lunch', 'middag', 'restaurang', 'restaurant', 'kund', 'kundmöte', 'gåva', 'present', 'representationsgåva'],
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
    debit_account: '7631',
    credit_account: '1930',
    vat_treatment: 'reduced_12',
    vat_rate: 0.12,
    deductibility: 'conditional',
    deductibility_note_sv: 'Enklare förtäring avdragsgill upp till 60 kr/person; måltider inte avdragsgilla för inkomstskatt sedan 2017',
    special_rules_sv: 'Personalfest, teamlunch, fika. Momsavdrag på högst 300 kr/person (schablon 46 kr/person vid mat och alkohol).',
    mcc_codes: [5812, 5813, 5814],
    keywords: ['personalfest', 'intern representation', 'teamlunch', 'personallunch', 'fika', 'julfest', 'after work', 'intern lunch'],
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
    name_sv: 'Pensionsförsäkring (AB)',
    name_en: 'Pension insurance (AB)',
    group: 'insurance',
    direction: 'expense',
    entity_applicability: 'aktiebolag',
    debit_account: '7410',
    credit_account: '1930',
    vat_treatment: 'exempt',
    vat_rate: 0,
    deductibility: 'full',
    special_rules_sv: 'AB: Pensionskostnad är en avdragsgill personalkostnad',
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
    entity_applicability: 'aktiebolag',
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
    entity_applicability: 'aktiebolag',
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
    name_sv: 'Preliminärskatt (AB)',
    name_en: 'Preliminary tax (AB)',
    group: 'personnel',
    direction: 'expense',
    entity_applicability: 'aktiebolag',
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
    debit_account: '1250',
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
    keywords: ['friskvård', 'friskvårdsbidrag', 'gym', 'gymkort', 'träningskort', 'sats sverige', 'nordic wellness', 'fitness24seven', 'actic', 'friskis', 'epassi', 'wellnet', 'massage'],
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
    entity_applicability: 'aktiebolag',
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
    entity_applicability: 'aktiebolag',
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
]

// ============================================================
// Lookup Indexes (built once at module load)
// ============================================================

const templateById = new Map<string, BookingTemplate>()
const templatesByGroup = new Map<TemplateGroup, BookingTemplate[]>()
const templatesByMcc = new Map<number, BookingTemplate[]>()

for (const t of BOOKING_TEMPLATES) {
  templateById.set(t.id, t)

  const groupList = templatesByGroup.get(t.group) || []
  groupList.push(t)
  templatesByGroup.set(t.group, groupList)

  for (const mcc of t.mcc_codes) {
    const mccList = templatesByMcc.get(mcc) || []
    mccList.push(t)
    templatesByMcc.set(mcc, mccList)
  }
}

// ============================================================
// Public API
// ============================================================

/** O(1) lookup by template ID */
export function getTemplateById(id: string): BookingTemplate | undefined {
  return templateById.get(id)
}

/** Get all templates in a group */
export function getTemplatesByGroup(group: TemplateGroup): BookingTemplate[] {
  return templatesByGroup.get(group) || []
}

/** Get templates matching a specific MCC code */
export function getTemplatesByMcc(mcc: number): BookingTemplate[] {
  return templatesByMcc.get(mcc) || []
}

/** Get all groups with labels and their templates */
export function getTemplateGroups(): TemplateGroupInfo[] {
  const groups: TemplateGroupInfo[] = []
  for (const [group, labels] of Object.entries(GROUP_LABELS)) {
    const g = group as TemplateGroup
    groups.push({
      group: g,
      label_sv: labels.sv,
      label_en: labels.en,
      templates: templatesByGroup.get(g) || [],
    })
  }
  return groups
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
    if (entityType && t.entity_applicability !== 'all' && t.entity_applicability !== entityType) {
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
    if (entityType && t.entity_applicability !== 'all' && t.entity_applicability !== entityType) return false
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
    if (entityType && t.entity_applicability !== 'all' && t.entity_applicability !== entityType) return false
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
  if (template.entity_applicability === 'all') return { valid: true }
  if (template.entity_applicability === entityType) return { valid: true }
  return {
    valid: false,
    error: `Template "${template.name_sv}" is only valid for ${template.entity_applicability}. Your entity type is ${entityType}.`,
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

/**
 * Multi-signal matching against a transaction.
 * Returns top matches sorted by confidence descending.
 */
/** Keywords up to this length are matched as whole words; longer ones may sit inside a word ("fjärruppvärmning"). */
const WHOLE_WORD_KEYWORD_MAX = 3

function keywordMatches(searchText: string, searchWords: ReadonlySet<string>, keyword: string): boolean {
  if (keyword.length <= WHOLE_WORD_KEYWORD_MAX) return searchWords.has(keyword)
  return searchText.includes(keyword)
}

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
  const searchWords = new Set(searchText.split(/[^\p{L}\p{N}]+/u).filter(Boolean))

  for (const t of BOOKING_TEMPLATES) {
    // Filter entity applicability
    if (entityType && t.entity_applicability !== 'all' && t.entity_applicability !== entityType) {
      continue
    }

    // Filter direction
    if (t.direction === 'expense' && !isExpense) continue
    if (t.direction === 'income' && !isIncome) continue
    // 'transfer' templates match both directions

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
        if (keywordMatches(searchText, searchWords, kw.toLowerCase())) {
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
 * Whether an account number sits in the reverse-charge basbelopp range
 * (44xx/45xx series, ruta 20-24 inputs). Used to skip redundant basis
 * emission when the template already books to such an account.
 */
function isBasisAccount(account: string): boolean {
  return /^4[45]\d{2}$/.test(account)
}

/**
 * Convert a booking template into a MappingResult.
 * Follows the same pattern as buildMappingResultFromCategory in category-mapping.ts.
 */
export function buildMappingResultFromTemplate(
  template: BookingTemplate,
  transaction: Transaction,
  entityType: EntityType
): MappingResult {
  const isExpense = transaction.amount < 0
  const isBusiness = !template.default_private

  // Resolve entity-specific accounts (EF base, AB override, förening: base
  // with owner accounts translated to the member settlement account).
  const debitAccount = templateAccountForForm(entityType, template.debit_account, template.debit_account_ab)!
  const creditAccount = templateAccountForForm(entityType, template.credit_account, template.credit_account_ab)!

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
  if (isBusiness && template.vat_treatment && template.deductibility !== 'non_deductible') {
    const vatRate = getVatRate(template.vat_treatment)

    if (template.vat_treatment === 'reverse_charge' && isExpense) {
      // EU/non-EU/domestic reverse charge: emit BOTH the fiktiv-moms pair
      // (2645|2647 / 2614) AND the basbelopp pair (44xx|45xx / 4598). The
      // basbelopp pair populates momsdeklaration rutor 20-24; without it
      // Skatteverket rejects with FK004 ("ruta 30-32 utan motsvarande
      // basbelopp i 20-24", ML 13 kap kräver båda sidor).
      const supplierType = template.reverse_charge_supplier_type ?? 'eu_business'
      const isDomestic = supplierType === 'swedish_business'
      const rcRate = 0.25 // fiktiv moms rate; current templates are 25%

      const rcLines = generateReverseChargeLines(absAmount, rcRate, isDomestic)
      for (const rcl of rcLines) {
        vatLines.push({
          account_number: rcl.account_number,
          debit_amount: rcl.debit_amount,
          credit_amount: rcl.credit_amount,
          description: rcl.line_description || '',
        })
      }

      // Skip basbelopp emission if the template already books the expense
      // directly to a basis account (44xx/45xx series): would double-count.
      if (!isBasisAccount(debitAccount)) {
        const basisLines = generateReverseChargeBasisLines(absAmount, rcRate, supplierType)
        for (const bl of basisLines) {
          vatLines.push({
            account_number: bl.account_number,
            debit_amount: bl.debit_amount,
            credit_amount: bl.credit_amount,
            description: bl.line_description || '',
          })
        }
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
      const vatAmount = Math.round((absAmount * vatRate / (1 + vatRate)) * 100) / 100
      let vatAccount: string
      switch (template.vat_treatment) {
        case 'standard_25': vatAccount = '2611'; break
        case 'reduced_12': vatAccount = '2621'; break
        case 'reduced_6': vatAccount = '2631'; break
        default: vatAccount = '2611'
      }
      vatLines.push({
        account_number: vatAccount,
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
