/**
 * LÄSMIG.txt for the full archive: a Swedish, human-readable map of the ZIP.
 * The archive outlives the product subscription; whoever opens it (the user
 * years later, a revisor, a Skatteverket auditor) must understand it without
 * Accounted running.
 */

export interface ArchiveReadmeParams {
  companyName: string
  orgNumber: string | null
  generatedAt: string
  scope: 'all' | 'period'
  periodLabel?: string
  appName?: string
}

export interface DriveFolderReadmeParams {
  companyName: string
  orgNumber: string | null
  generatedAt: string
  appName?: string
}

/**
 * README for the Drive backup folder layout: one `Arkiv <år>.zip` per
 * räkenskapsår plus `Grunddata.zip`. Uploaded both as a standalone
 * LÄSMIG.txt in the Drive folder and inside Grunddata.zip.
 */
export function buildDriveFolderReadme(params: DriveFolderReadmeParams): string {
  const app = params.appName || 'Accounted'
  return [
    `SÄKERHETSKOPIA FRÅN ${app.toUpperCase()}`,
    '='.repeat(30),
    '',
    `Företag: ${params.companyName}${params.orgNumber ? ` (${params.orgNumber})` : ''}`,
    `Senast uppdaterad: ${params.generatedAt}`,
    '',
    'Den här mappen innehåller företagets löpande säkerhetskopia:',
    '',
    'Arkiv <år>.zip       Ett komplett arkiv per räkenskapsår: bokföringen som',
    '                     SIE4-fil, rapporter (JSON och CSV), underlag döpta',
    '                     efter verifikat samt behandlingshistorik för årets',
    '                     bokföring.',
    'Grunddata.zip        Register (kunder, leverantörer, fakturor, anställda,',
    '                     löner, tillgångar med mera), ursprungliga SIE-filer,',
    '                     dokument som ännu inte kopplats till verifikat samt',
    '                     fullständig behandlingshistorik.',
    '',
    'Filerna uppdateras på plats vid varje säkerhetskopiering: bara år med',
    'ändringar laddas upp på nytt. Google Drive sparar tidigare versioner i',
    'cirka 30 dagar (högerklicka på filen och välj Hantera versioner).',
    '',
    'Den här mappen är en extra säkerhetskopia som du själv råder över.',
    'Filer i Drive kan ändras eller raderas, så mappen utgör inte företagets',
    `lagliga arkiv enligt bokföringslagen: ${app} bevarar`,
    'räkenskapsinformationen i oföränderligt skick i minst 7 år (BFL 7 kap.).',
    '',
    'Varje zip innehåller en egen LÄSMIG.txt som beskriver innehållet.',
    `${app} är öppen källkod (AGPL): bokföringen förblir läsbar utan tjänsten.`,
    '',
  ].join('\n')
}

export function buildArchiveReadme(params: ArchiveReadmeParams): string {
  const app = params.appName || 'Accounted'
  const scopeLine =
    params.scope === 'all'
      ? 'Hela bokföringen (samtliga räkenskapsår)'
      : `Räkenskapsår ${params.periodLabel ?? ''}`.trim()

  const lines: string[] = [
    `SÄKERHETSKOPIA FRÅN ${app.toUpperCase()}`,
    '='.repeat(30),
    '',
    `Företag: ${params.companyName}${params.orgNumber ? ` (${params.orgNumber})` : ''}`,
    `Skapad: ${params.generatedAt}`,
    `Omfattning: ${scopeLine}`,
    '',
    'Det här arkivet innehåller företagets räkenskapsinformation i öppna',
    'format (SIE4, JSON, CSV), läsbart utan särskild programvara.',
    '',
    'Arkivet är en säkerhetskopia. En fil som lagras utanför tjänsten kan',
    'ändras eller raderas och utgör därför inte i sig det lagliga arkivet',
    `enligt bokföringslagen: ${app} bevarar räkenskapsinformationen i`,
    'oföränderligt skick i minst 7 år (BFL 7 kap.).',
    '',
    'INNEHÅLL',
    '--------',
  ]

  if (params.scope === 'all') {
    lines.push(
      'sie/                 Bokföringen som SIE4-filer, en per räkenskapsår.',
      '                     Kan importeras i de flesta svenska bokföringsprogram.',
      'sie/original/        Ursprungliga SIE-filer som importerats, bevarade',
      '                     byte för byte. manifest.json beskriver varje fil.',
      'rapporter/<år>/      Rapporter per räkenskapsår: saldobalans, resultat-',
      '                     och balansräkning, huvudbok, grundbok och moms.',
      '                     JSON för maskiner, CSV för Excel (semikolonavgränsad,',
      '                     svensk teckenkodning).',
      'dokument/<år>/       Underlag (kvitton, fakturor) döpta efter verifikat,',
      '                     t.ex. A17_kvitto.pdf. dokument/_okopplade/ innehåller',
      '                     dokument som ännu inte kopplats till något verifikat.',
      '                     dokument/manifest.json listar alla filer med SHA-256.',
      'data/                Register som JSON: kunder, leverantörer, fakturor,',
      '                     anställda, löner, tillgångar, med mera. En fil per',
      '                     tabell, radernas fältnamn följer databasen.',
      '                     Radfiler (t.ex. invoice_items.json) innehåller',
      '                     dessutom moderpostens valuta, t.ex. invoice_currency',
      '                     och invoice_exchange_rate, så att varje belopps',
      '                     enhet framgår direkt i filen.',
      'revision/            behandlingshistorik.json (alla ändringar, BFL 5 kap',
      '                     11 §) och systemdokumentation.json (kontoplan,',
      '                     verifikationsserier, arkiveringsprinciper).'
    )
  } else {
    lines.push(
      'bokforing.se         Räkenskapsårets bokföring som SIE4-fil.',
      'rapporter/           Saldobalans, resultat- och balansräkning, huvudbok,',
      '                     grundbok och momsdeklaration. JSON för maskiner,',
      '                     CSV för Excel (semikolonavgränsad).',
      'dokument/            Underlag (kvitton, fakturor) döpta efter verifikat.',
      '                     dokument/manifest.json listar alla filer med SHA-256.',
      'revision/            behandlingshistorik.json (ändringar under året samt',
      '                     ändringar som rör årets verifikat även när de',
      '                     bokförts efter årets slut) och systemdokumentation.json.'
    )
  }

  lines.push(
    '',
    'ÅTERSTÄLLNING',
    '-------------',
    `SIE-filerna kan importeras i ${app} eller annat bokföringsprogram.`,
    'Dokumentens koppling till verifikat framgår av dokument/manifest.json',
    '(fältet journal_entry_id samt verifikatnumret i filnamnet).',
    '',
    `${app} är öppen källkod (AGPL): programvaran kan även köras självhostad,`,
    'så bokföringen förblir åtkomlig oavsett tjänstens framtid.',
    ''
  )

  return lines.join('\n')
}
