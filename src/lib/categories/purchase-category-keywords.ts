/**
 * Words on a receipt or invoice line that say what was bought, per purchase
 * category, in Swedish and English. Language knowledge, not jurisdiction
 * knowledge: no account numbers, no authority or brand names.
 *
 * How a keyword matches (matchKeyword in propose-purchase-category.ts):
 *   - lower-cased, punctuation folded to spaces, diacritics kept ('tåg' must
 *     not become the English 'tag');
 *   - a keyword of five letters or more matches inside a word, because
 *     Swedish compounds put the head noun last ('skrivbordsstol',
 *     'returfrakt');
 *   - a shorter keyword, or one written with a leading '=', matches a whole
 *     word only ('taxi', 'kurs', '=server' so that 'servering' stays a meal).
 *
 * strong words name the thing itself; weak words are generic and only count
 * when no strong word on the line matched anything ('subscription' says SaaS
 * unless the line also says 'tidning'). Within a tier the longest matching
 * keyword wins, so 'mobilt bredband' beats 'mobil'; an exact tie between two
 * categories leaves the line undecided.
 */
import type { PurchaseCategoryCode } from './purchase-categories'

export interface CategoryKeywords {
  strong: readonly string[]
  weak?: readonly string[]
}

export const PURCHASE_CATEGORY_KEYWORDS: Partial<Record<PurchaseCategoryCode, CategoryKeywords>> = {
  'expense.software.saas': {
    strong: [
      'saas', 'software', 'programvara', 'programvaruabonnemang', 'software subscription', 'bokföringsprogram',
      'affärssystem', 'api usage', 'api credits',
    ],
    weak: [
      'subscription', 'abonnemang', 'prenumeration', 'månadsabonnemang', 'årsabonnemang', 'per user',
      'per seat', 'seats', 'monthly plan', 'annual plan', 'pro plan', 'team plan', 'business plan',
    ],
  },
  'expense.software.licence': {
    strong: [
      'programlicens', 'programvarulicens', 'software license', 'software licence', 'perpetual license',
      'perpetual licence', 'license key', 'licence key', 'licensnyckel',
    ],
    weak: ['licens', 'license', 'licence'],
  },

  'expense.equipment.hardware': {
    strong: [
      'dator', 'laptop', 'macbook', 'imac', 'ipad', 'iphone', 'smartphone', 'mobiltelefon', 'surfplatta',
      '=tablet', 'computer', 'computers', 'skärm', 'bildskärm', '=monitor', 'tangentbord', 'keyboard', 'mus', 'mouse', 'datormus',
      'headset', 'hörlurar', 'headphones', 'webbkamera', 'webcam', 'dockningsstation', 'docking station',
      'usb', 'hdmi', 'laddare', 'charger', 'router', 'hårddisk', 'hard drive', 'ssd', 'minneskort',
      'skrivare', 'printer',
    ],
    weak: ['kabel', 'cable'],
  },
  'expense.software.cloud_hosting': {
    strong: [
      'hosting', 'webbhotell', 'web hosting', 'molntjänst', 'molnlagring', 'cloud storage', '=server',
      'serverhyra', 'vps', '=compute', 'cdn', 'bandwidth', 'data transfer',
    ],
    weak: ['cloud', 'moln'],
  },
  'expense.software.domains': {
    strong: ['domän', 'domännamn', 'domänregistrering', 'domain', 'domain name', 'domain registration', 'dns'],
  },
  'expense.software.services': {
    strong: [
      'it support', 'it tjänster', 'it konsult', 'datorsupport', 'it drift', 'drifttjänst', 'helpdesk',
      'managed services', 'it services', 'it consulting', 'webbutveckling', 'web development',
      'systemutveckling',
    ],
    weak: ['support'],
  },

  'expense.telecom.mobile': {
    strong: [
      'mobilabonnemang', 'mobil', 'mobilsurf', 'surf', 'samtalsavgift', 'sms', 'mms', 'roaming', 'esim',
      'simkort', 'sim kort', 'mobile plan', 'mobile subscription', 'data plan', '5g', '4g',
    ],
  },
  'expense.telecom.landline': {
    strong: ['fast telefoni', 'fasttelefoni', 'landline', 'telefonväxel', '=växel', 'ip telefoni', 'voip'],
  },
  'expense.telecom.internet': {
    strong: [
      'bredband', 'broadband', 'fiber', 'fiberanslutning', 'internet', 'internetabonnemang',
      'mobilt bredband', 'uppkoppling', 'adsl',
    ],
  },

  'expense.office.supplies': {
    strong: [
      'kontorsmaterial', 'kontorsmateriel', 'office supplies', 'papper', 'kopieringspapper', 'a4', 'penna',
      'pennor', 'kulspetspenna', 'pen', 'pens', 'pärm', 'pärmar', 'binder', 'häftapparat', 'stapler', 'gem',
      'post it', 'anteckningsblock', 'notepad', 'kuvert', 'envelope', 'toner', 'bläckpatron',
      'skrivarpatron', 'ink cartridge', 'tejp', 'tape', 'etiketter', 'labels', 'plastficka', 'suddgummi', 'whiteboardpenna',
    ],
  },
  'expense.office.printing': {
    strong: ['trycksaker', 'tryckeri', 'printing', 'blanketter', 'kopiering', 'utskrift', 'print job'],
  },
  'expense.equipment.furniture': {
    strong: [
      'kontorsmöbel', 'kontorsmöbler', 'möbel', 'möbler', 'furniture', 'skrivbord', 'desk', 'kontorsstol',
      'stol', 'chair', 'bord', 'table', 'hylla', 'bokhylla', 'shelf', 'förvaringsskåp', 'skåp', 'cabinet',
      'lampa', 'skrivbordslampa', 'lamp', 'whiteboard', 'gardin', 'matta', 'kaffemaskin', 'kaffebryggare',
      'coffee machine', 'mikrovågsugn', 'kylskåp', 'vattenkokare',
    ],
  },
  'expense.education.literature': {
    strong: [
      'facklitteratur', 'bok', 'böcker', 'book', 'books', 'tidning', 'tidningar', 'tidskrift', 'magazine',
      'newspaper', 'ebook', 'e bok', 'ljudbok', 'audiobook', 'dagstidning',
    ],
  },
  'expense.office.postage': {
    strong: ['porto', 'frimärke', 'frimärken', 'postage', 'stamps', 'brevporto', 'rekommenderat brev'],
  },

  'expense.premises.rent': {
    strong: [
      'lokalhyra', 'kontorshyra', 'office rent', 'hyresavi', 'månadshyra', 'coworking', 'kontorsplats',
      'skrivbordsplats', 'desk rental', 'garagehyra', 'lagerhyra', 'förrådshyra', 'storage unit',
    ],
    weak: ['rent'],
  },
  'expense.premises.electricity': {
    strong: [
      'elräkning', 'elförbrukning', 'elnät', 'elnätsavgift', 'elhandel', 'elpris', 'electricity', 'kwh',
      'nätavgift',
    ],
  },
  'expense.premises.heating': {
    strong: ['fjärrvärme', 'uppvärmning', 'heating', '=värme', 'pellets', 'eldningsolja', 'district heating'],
  },
  'expense.premises.water': {
    strong: ['vatten och avlopp', 'va avgift', 'vattenavgift', 'water and sewage', 'avlopp', 'vattenförbrukning'],
  },
  'expense.premises.cleaning': {
    strong: [
      'städning', 'kontorsstädning', 'lokalvård', 'cleaning', 'städtjänst', 'fönsterputs', 'sophämtning',
      'avfall', 'renhållning', 'waste collection',
    ],
  },
  'expense.premises.repairs': {
    strong: [
      'fastighetsunderhåll', 'hantverkare', 'snickeri', 'rörmokare', 'elektriker', 'vvs', 'renovering',
      'renovation', 'målning',
    ],
  },

  'expense.equipment.tools': {
    strong: [
      'verktyg', 'tool', 'tools', 'borrmaskin', 'skruvdragare', 'borr', 'drill', 'såg', 'saw', 'hammare',
      'hammer', 'skruvmejsel', 'screwdriver', 'tång', 'hylsnyckel', 'bits', 'bitsats', 'vattenpass',
      'måttband', 'stege', 'ladder', 'slipmaskin', 'multiverktyg', 'verktygslåda', 'toolbox', 'kompressor',
    ],
  },
  'expense.equipment.machinery': {
    strong: ['machinery', 'produktionsmaskin', 'cnc', 'svetsaggregat', 'welder', 'generator', 'tryckluft'],
    weak: ['maskin', 'machine'],
  },
  'expense.equipment.rental': {
    strong: [
      'maskinhyra', 'hyrmaskin', 'utrustningshyra', 'equipment rental', 'liftuthyrning', 'ställningshyra',
      'byggställning',
    ],
  },
  'expense.equipment.repairs': {
    strong: ['reparation', 'repair', 'serviceavtal', 'service agreement'],
    weak: ['service', 'underhåll', 'maintenance'],
  },
  'expense.consumables.operating_supplies': {
    strong: [
      'förbrukningsmaterial', 'consumables', 'städmaterial', 'toalettpapper', 'hushållspapper',
      'pappershanddukar', 'diskmedel', 'tvål', 'handtvål', 'soppåsar', 'batterier', 'glödlampa',
    ],
  },

  'expense.vehicle.fuel': {
    strong: [
      'bensin', 'diesel', 'drivmedel', 'fuel', 'petrol', 'gasoline', 'e85', 'hvo', 'hvo100', 'tankning',
      'blyfri', 'adblue', 'elbilsladdning', 'billaddning', 'snabbladdning', 'ev charging',
    ],
  },
  'expense.vehicle.parking': {
    strong: [
      'parkering', 'parking', 'p avgift', 'parkeringsavgift', 'parkeringsbiljett', 'p hus', 'parkeringshus',
    ],
  },
  'expense.vehicle.repairs': {
    strong: [
      'bilservice', 'bilreparation', 'däckbyte', 'däck', 'hjulskifte', 'verkstad', 'besiktning', 'oljebyte',
      'motorolja', 'torkarblad', 'bromsbelägg', 'car service', 'tyre', 'tyres', 'tire', 'tires',
      'däckhotell', 'reservdel', 'spare part', 'bilbesiktning',
    ],
  },
  'expense.vehicle.leasing': {
    strong: ['billeasing', 'leasingbil', 'car leasing', 'car lease'],
    weak: ['leasing', 'leasingavgift', 'lease'],
  },
  'expense.vehicle.insurance_tax': {
    strong: [
      'fordonsskatt', 'vägtrafikskatt', 'bilförsäkring', 'trafikförsäkring', 'fordonsförsäkring',
      'vehicle tax', 'car insurance', 'motor insurance',
    ],
  },
  'expense.vehicle.congestion_tax': {
    strong: [
      'trängselskatt', 'congestion', 'congestion charge', 'vägavgift', 'vägtull', 'broavgift', 'brotull',
      'toll', 'infrastrukturavgift',
    ],
  },
  'expense.vehicle.accessories': {
    strong: [
      'biltvätt', 'car wash', 'biltillbehör', 'car accessories', 'spolarvätska', 'vindrutevätska', 'bilvax',
      'isskrapa', 'kylarvätska',
    ],
  },

  'expense.travel.flight': {
    strong: [
      'flyg', 'flygbiljett', 'flygresa', 'inrikesflyg', 'utrikesflyg', 'flight', 'flights', 'airline',
      'airfare', 'air ticket', 'boardingkort', 'boarding pass', 'flygskatt',
    ],
  },
  'expense.travel.train': {
    strong: [
      'tåg', 'tågbiljett', '=train', 'rail', 'railway', 'buss', 'bus', 'bussbiljett', 'kollektivtrafik',
      'public transport', 'pendeltåg', 'tunnelbana', '=metro', 'subway', 'spårvagn', 'tram', 'reskassa',
      'periodbiljett', 'månadskort', 'enkelbiljett', 'färja', 'ferry',
    ],
  },
  'expense.travel.taxi': {
    strong: ['taxi', 'taxiresa', 'taxifärd', 'taxikostnad', 'taxameter', 'cab'],
  },
  'expense.travel.hotel': {
    strong: [
      'hotell', 'hotel', 'logi', 'övernattning', 'accommodation', 'lodging', 'vandrarhem', 'hostel',
      'rumsavgift', 'room charge', 'room rate',
    ],
    weak: ['nätter', 'nights', 'natt', 'night'],
  },
  'expense.travel.car_rental': {
    strong: ['hyrbil', 'biluthyrning', 'car rental', 'rental car', 'car hire'],
  },
  'expense.travel.other': {
    strong: [
      'resebyrå', 'travel agency', 'visum', 'visumavgift', 'visa fee', 'bagage', 'baggage', 'luggage',
      'reseförsäkring', 'travel insurance',
    ],
  },

  'expense.representation.client': {
    // '=representation': a compound is what its last part names, so a
    // "representationsgåva" is a gift, not a client meal (accounted#92).
    strong: [
      '=representation', 'extern representation', 'kundmöte', 'kundmiddag', 'kundlunch', 'affärsmiddag',
      'affärslunch', 'business lunch', 'business dinner', 'client dinner', 'client lunch',
    ],
  },
  'expense.representation.staff': {
    strong: [
      'personalfest', 'julbord', 'kickoff', 'kick off', 'afterwork', 'personalmiddag', 'teambuilding',
      'team building', 'sommarfest', 'intern representation', 'personalrepresentation', 'staff party',
      'christmas party', 'team dinner',
    ],
  },
  'expense.personnel.refreshments': {
    strong: [
      'fika', 'kaffe', 'coffee', 'kaffebönor', 'kaffekapslar', 'tea', 'mjölk', 'milk', 'frukt', 'fruit',
      'fruktkorg', 'bullar', 'kanelbulle', 'kakor', 'kex', 'snacks', 'godis', 'läsk', 'mineralvatten',
      'kaffebröd',
    ],
  },

  'expense.marketing.ads': {
    strong: [
      'annons', 'annonsering', 'tidningsannons', 'internetreklam', 'advertising', 'ads', 'ad spend',
      'google ads', 'facebook ads', 'meta ads', 'linkedin ads', 'sponsored', 'adwords', 'cpc',
      'impressions',
    ],
    weak: ['reklam', 'marknadsföring', 'kampanj', 'campaign'],
  },
  'expense.marketing.print': {
    strong: [
      'reklamtrycksaker', 'visitkort', 'business cards', 'broschyr', 'brochure', 'flyer', 'flygblad',
      'affisch', 'roll up', 'rollup', 'banderoll', 'dekaler', 'klistermärken', 'stickers',
    ],
  },
  'expense.marketing.events': {
    strong: [
      'mässa', 'mässor', 'mässavgift', 'utställning', 'exhibition', 'trade fair', 'trade show', '=monter',
      'booth', 'utställarplats',
    ],
  },
  'expense.marketing.gifts': {
    strong: [
      'reklamgåva', 'reklamgåvor', 'profilprodukt', 'profilprodukter', 'giveaways', 'merchandise', 'kundgåva',
      'kundgåvor', 'promotional gift', 'swag',
    ],
  },
  'expense.marketing.sponsorship': {
    strong: ['sponsring', 'sponsorship', 'sponsor', 'sponsoravtal'],
  },
  'expense.marketing.agency': {
    strong: [
      'reklambyrå', 'pr byrå', 'kommunikationsbyrå', 'mediebyrå', 'advertising agency', 'pr agency',
      'copywriting', 'seo', 'sökmotoroptimering', 'grafisk design', 'graphic design',
      'social media management',
    ],
  },

  'expense.professional_services.accounting': {
    strong: [
      'redovisning', 'bokföring', 'bokföringstjänst', 'redovisningstjänst', 'redovisningsbyrå', 'bokslut',
      'årsbokslut', 'lönehantering', 'löneadministration', 'momsdeklaration', 'accounting', 'bookkeeping',
    ],
  },
  'expense.professional_services.audit': {
    strong: ['revision', 'revisor', 'revisionsarvode', 'revisionsberättelse', 'audit', 'auditor'],
  },
  'expense.professional_services.legal': {
    strong: [
      'advokat', 'jurist', 'juridisk', 'legal', 'lawyer', 'attorney', 'rättegång', 'avtalsgranskning',
      'legal fees',
    ],
  },
  'expense.professional_services.tax_advice': {
    strong: ['skatterådgivning', 'skattekonsult', 'skatteplanering', 'tax advice', 'tax consulting'],
  },
  'expense.professional_services.consulting': {
    strong: [
      'konsult', 'konsulttjänst', 'konsultarvode', 'konsulttimmar', 'consulting', 'consultancy',
      'management consulting', 'coaching', 'affärsrådgivning',
    ],
    weak: ['rådgivning', 'advisory'],
  },
  'expense.professional_services.technical': {
    strong: ['arkitekt', 'architect', 'ingenjör', 'engineering', 'teknisk konsult', 'konstruktör'],
  },
  'expense.professional_services.staffing': {
    strong: ['bemanning', 'bemanningsföretag', 'inhyrd personal', 'personaluthyrning', 'staffing', 'temp staff'],
  },

  'expense.goods.resale': {
    strong: ['handelsvaror', 'återförsäljning', 'grossist', 'wholesale', 'lagervaror', 'resale'],
  },
  'expense.goods.materials': {
    strong: [
      'råvaror', 'råmaterial', 'raw materials', 'byggmaterial', 'virke', 'trävaror', 'reglar', 'gips',
      'cement', 'betong', 'skruv', 'skruvar', 'spik', 'tyg', 'garn', 'färg', 'lim',
    ],
    weak: ['material', 'materials'],
  },
  'expense.goods.subcontracting': {
    strong: ['underentreprenör', 'underentreprenad', 'legoarbete', 'subcontractor', 'subcontracting'],
  },
  'expense.goods.packaging': {
    strong: [
      'emballage', 'förpackning', 'förpackningsmaterial', 'packaging', 'kartong', 'kartonger', 'wellpapp',
      'bubbelplast', 'packtejp', 'packing tape', 'shipping boxes', 'flyttkartong',
    ],
  },
  'expense.goods.freight': {
    strong: [
      'frakt', 'fraktavgift', 'frakttjänst', 'freight', 'shipping', 'shipping fee', 'courier', 'kurir',
      'budfirma',
    ],
    weak: ['leverans', 'delivery', 'transport'],
  },
  'expense.goods.customs': {
    strong: [
      'tull', 'tullavgift', 'tulldeklaration', 'förtullning', 'customs', 'customs duty', 'import duty',
      'spedition', 'speditör',
    ],
  },

  'expense.education.training': {
    strong: [
      'utbildning', 'kurs', 'kurser', 'kursavgift', 'course', 'training', 'workshop', 'seminarium',
      'seminar', 'webinar', 'konferens', 'konferensavgift', 'conference', 'deltagaravgift', 'certifiering',
      'certification', 'onlinekurs', 'masterclass',
    ],
  },
  'expense.personnel.health': {
    strong: [
      'företagshälsovård', 'företagshälsa', 'hälsoundersökning', 'occupational health', 'läkarbesök',
      'vaccination', 'synundersökning', 'terminalglasögon',
    ],
  },
  'expense.personnel.wellness': {
    strong: [
      'friskvård', 'friskvårdsbidrag', 'gym', 'gymkort', 'träningskort', 'massage', 'wellness', 'fitness',
      'simhall', 'padel', 'yoga',
    ],
  },
  'expense.personnel.recruitment': {
    strong: [
      'rekrytering', 'rekryteringsföretag', 'recruitment', 'recruiting', 'headhunting', 'platsannons',
      'jobbannons', 'job ad', 'job posting',
    ],
  },
  'expense.personnel.workwear': {
    strong: [
      'arbetskläder', 'workwear', 'skyddskläder', 'skyddsskor', 'arbetsskor', 'skyddshandskar',
      'arbetshandskar', 'handskar', 'gloves', 'hjälm', 'skyddshjälm', 'varselväst', 'reflexväst',
      'skyddsglasögon', 'hörselskydd', 'safety shoes', 'hi vis',
    ],
  },
  'expense.personnel.gifts': {
    strong: ['personalgåva', 'julgåva', 'jubileumsgåva', 'staff gift', 'employee gift'],
  },

  'expense.insurance.business': {
    strong: [
      'företagsförsäkring', 'ansvarsförsäkring', 'egendomsförsäkring', 'avbrottsförsäkring',
      'kontorsförsäkring', 'rättsskydd', 'business insurance', 'liability insurance',
    ],
    weak: ['försäkring', 'försäkringspremie', 'insurance', 'premie'],
  },
  'expense.insurance.credit': {
    strong: ['kreditförsäkring', 'credit insurance'],
  },
  'expense.insurance.deductible': {
    strong: ['självrisk', 'insurance excess', 'deductible'],
  },

  'expense.bank_fees.fees': {
    strong: [
      'bankavgift', 'bankavgifter', 'bankkostnader', 'bank fee', 'bank charges', 'kortavgift', 'kontoavgift',
      'account fee', 'överföringsavgift', 'utlandsbetalning', 'transfer fee', 'paketavgift',
    ],
  },
  'expense.card_fees.payment_fees': {
    strong: [
      'transaktionsavgift', 'transaction fee', 'processing fee', 'kortinlösen', 'inlösenavgift',
      'card processing', 'payment processing', 'betalförmedling', 'swishavgift', 'payment fees',
      'merchant fee',
    ],
  },
  'expense.bank_fees.factoring': {
    strong: ['factoring', 'fakturaköp', 'factoringavgift', 'fakturabelåning', 'invoice financing'],
  },
  'expense.fees.collection': {
    strong: [
      'inkasso', 'inkassoavgift', 'kreditupplysning', 'credit check', 'credit report', 'debt collection',
      'betalningsföreläggande',
    ],
  },

  'expense.premises.alarm': {
    strong: [
      'larm', 'larmtjänst', 'alarm', 'bevakning', 'väktare', 'security guard', 'övervakning',
      'kameraövervakning', 'cctv', 'larmcentral', 'inbrottslarm', 'brandlarm',
    ],
  },

  'expense.fees.memberships': {
    strong: ['medlemsavgift', 'medlemskap', 'membership', 'föreningsavgift', 'branschorganisation', 'member fee'],
  },
  'expense.fees.authorities': {
    strong: [
      'registreringsavgift', 'ansökningsavgift', 'tillsynsavgift', 'myndighetsavgift', 'expeditionsavgift',
      'tillståndsavgift', 'government fee', 'registration fee', 'filing fee',
    ],
  },
  'expense.fees.royalties': {
    strong: ['royalty', 'royalties', 'licensavgift', 'licensavgifter', 'upphovsrätt'],
  },
  'expense.fees.patents_trademarks': {
    strong: [
      'patent', 'patentansökan', 'varumärke', 'varumärkesregistrering', 'trademark', 'trademark registration',
      'design registration',
    ],
  },
}

/**
 * What a merchant kind, as extraction reads it (merchantCategory), can mean.
 * A restaurant receipt is a client meal, a staff meal or a meal on a trip:
 * the receipt alone cannot say which, so the kind narrows and never decides
 * on its own when it lists several.
 */
export const MERCHANT_KIND_CATEGORIES: Readonly<Record<string, readonly PurchaseCategoryCode[]>> = {
  restaurant: ['expense.representation.client', 'expense.representation.staff', 'expense.travel.meals'],
  cafe: [
    'expense.representation.client',
    'expense.representation.staff',
    'expense.travel.meals',
    'expense.personnel.refreshments',
  ],
  taxi: ['expense.travel.taxi'],
  parking: ['expense.vehicle.parking'],
  fuel: ['expense.vehicle.fuel'],
  grocery: [
    'expense.personnel.refreshments',
    'expense.representation.staff',
    'expense.representation.client',
    'expense.consumables.operating_supplies',
  ],
  hotel: ['expense.travel.hotel'],
}

/**
 * Merchant kinds a supplier's name gives away by a generic word in it, for a
 * reading without merchantCategory (an agent's own extraction, an older
 * reading). Same matching rules as the line keywords.
 */
export const SUPPLIER_NAME_KINDS: Readonly<Record<string, readonly string[]>> = {
  taxi: ['taxi', 'cab'],
  parking: ['parkering', 'parking'],
  hotel: ['hotell', 'hotel', 'vandrarhem', 'hostel'],
  restaurant: ['restaurang', 'restaurant', 'bistro', 'pizzeria', 'krog', 'trattoria', 'brasserie'],
  cafe: ['café', 'cafe', 'kafé', 'konditori', 'coffee'],
}
