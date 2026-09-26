import type { Skill } from './types'

/**
 * Accounted's own analyses: three examples of what an analysis is, each a
 * different kind (an overview, a forecast, a list to act on). Each asks the
 * AI to build a dashboard as an artifact where the client shows artifacts,
 * with charts drawn as plain SVG: in testing, generated charts that loaded a
 * charting library drew empty or wrong, the SVG ones did not.
 */

const DASHBOARD_RULES = `## Så byggs dashboarden
- Bygg den som en artifact om din klient kan visa artifacts (till exempel Claude på webben eller i appen). Går det inte: visa samma innehåll som tabeller i svaret.
- Rita diagram som enkel SVG direkt i sidan, utan externa bibliotek, så att de fungerar överallt.
- Kontrollera innan du visar den att diagrammet och tabellerna visar samma siffror.
- Använd bara belopp du hämtat från Accounted. Räkna aldrig fram ett belopp som inte går att härleda ur bokföringen, och skilj alltid på kända och uppskattade belopp.
- Längst ner: bolagets namn, perioden och när siffrorna hämtades.
- Ändra ingenting i Accounted och lägg inga förslag. En analys läser bara.`

const manadsoversikt = `# Månadsöversikt

Så har det gått månad för månad: intäkter, kostnader, resultat och några nyckeltal, jämfört med samma period förra året.

## Så räknas den
- Period: de senaste 12 hela månaderna. Jämförelse: samma 12 månader året innan, om bokföringen finns.
- Intäkter = kontoklass 3. Kostnader = kontoklass 4 till 7. Resultat före bokslutsposter = intäkter minus kostnader (klass 8 räknas inte med, men nämn finansiella poster om de är stora).
- Bruttomarginal = (intäkter minus klass 4) delat med intäkter. Visa den bara när det finns både intäkter och klass 4.
- Likvida medel = saldot på 19xx vid varje månads slut.
- Hämta siffrorna ur resultat- och balansräkningen eller huvudboken i Accounted.

## Så visas den
- Överst fyra nyckeltal för perioden: intäkter, resultat, bruttomarginal och likvida medel idag, var och en med förändringen mot året innan.
- Ett stapeldiagram per månad med intäkter och kostnader, och resultatet som linje.
- En tabell månad för månad.
- De fem kostnadskonton som ökat mest mot året innan, i kronor. Finns inget jämförelseår: visa periodens fem största kostnadskonton och säg det.
- Tre korta insikter i klartext, till exempel en månad som sticker ut.

## Så läser du den
- Obokförda banktransaktioner finns inte med. Säg hur många de är och vad de summerar till, så att läsaren vet hur komplett bilden är.
- Ser en siffra orimlig ut (till exempel en stor omföring eller en import som vänder ett helt år), säg det i stället för att dra slutsatser av den.
- Det är en sammanställning, inte ett bokslut.

## Tools
- \`gnubok_get_income_statement\` och \`gnubok_get_balance_sheet\` per månad, eller \`gnubok_get_general_ledger\` för kontoklasserna.
- \`gnubok_get_kpi_report\` för nyckeltal när den räcker.
- \`gnubok_list_uncategorized_transactions\` för hur mycket som är obokfört.

${DASHBOARD_RULES}
`

const kassaprognos = `# Kassaprognos 30 dagar

Hur mycket pengar som finns på företagskontot dag för dag de kommande 30 dagarna, och om det riskerar att bli för lite.

## Så räknas den
- Start: saldot på företagskontot idag enligt senaste banksynk (konto 1930, eller de 19xx-konton som är bankkonton). Finns ingen banksynk: använd det bokförda saldot och säg tydligt att det inte är bankens.
- In: obetalda kundfakturor på sitt förfallodatum. Redan förfallna kundfakturor räknas inte in i saldot, de listas separat som möjliga extra inbetalningar.
- Ut: obetalda leverantörsfakturor på sitt förfallodatum (redan förfallna dras dag 1), och kostnader som dragits varje månad de senaste tre månaderna (lön, skatt, hyra, abonnemang) på ungefär samma dag igen, med snittbeloppet. En dragning som hamnar på en helg flyttas till närmaste vardag.
- En kostnad som redan finns som leverantörsfaktura räknas inte två gånger.
- Varningsgräns: en månads vanliga utbetalningar, om användaren inte sagt något annat.

## Så visas den
- Överst: saldot idag, lägsta saldot under perioden och vilken dag, och om varningsgränsen underskrids.
- En linje dag för dag med saldot, gränsen som en streckad linje och de stora in- och utbetalningarna markerade.
- En tabell med de tio största posterna, med datum, belopp och om beloppet är känt (faktura) eller uppskattat (återkommande).
- Listan med förfallna kundfakturor som kan ge extra pengar.

## Så läser du den
- Det är en prognos. Skilj alltid på kända belopp och uppskattningar, och säg när banken senast synkades.
- Underskrids gränsen: föreslå vad som kan göras (flytta pengar från ett annat konto, skjuta en betalning, påminna en kund), men gör ingenting själv.

## Tools
- \`gnubok_list_cash_accounts\` och \`gnubok_connect_bank\` för bankkonton, saldo och senaste synk.
- \`gnubok_list_invoices\` och \`gnubok_list_supplier_invoices\` för obetalda fakturor och förfallodagar.
- \`gnubok_query_journal\` och \`gnubok_list_uncategorized_transactions\` för återkommande dragningar de senaste tre månaderna.

${DASHBOARD_RULES}
`

const kostnadskoll = `# Kostnadskoll

Vad bolaget betalar varje månad för prenumerationer och återkommande leverantörer, vad som ökat och vad som kanske kan sägas upp.

## Så räknas den
- Period: de senaste sex hela månaderna.
- Återkommande kostnad: samma leverantör med en dragning i minst tre av de sex månaderna. Leverantören är motparten på banktransaktionen (gruppera på dess namn) eller leverantören på fakturan.
- Både bokförda och obokförda banktransaktioner räknas, så att bilden är komplett.
- Löner, skatter, moms och överföringar mellan egna konton räknas inte, och inte heller engångsköp som restaurangbesök.
- För varje återkommande kostnad: snitt per månad, per år (snitt gånger 12), senaste beloppet, och om det ökat mer än 10 procent mot snittet.
- Nya abonnemang: en leverantör som ser ut som en tjänst (inte ett engångsköp) med första dragningen de senaste 60 dagarna.
- Möjliga dubbeldragningar: samma leverantör och samma belopp inom sju dagar.

## Så visas den
- Överst: totalt per månad och per år, och hur många leverantörer det är.
- En lista sorterad på kostnad per år, med leverantör, belopp per månad, trend (upp, ner, oförändrad) och en markering för ökningar, nya abonnemang och möjliga dubbeldragningar.
- En ruta "Värt att se över": upp till fem poster där det kan finnas pengar att spara, med skälet i en rad.

## Så läser du den
- Säg aldrig upp något och ändra ingenting. Föreslå bara vad användaren kan titta på.
- En dubbeldragning kan vara två licenser. Skriv "möjlig", inte "fel".
- Betalas vissa tjänster privat och ersätts som utlägg syns de klumpvis: säg det om månaderna ser ojämna ut.

## Tools
- \`gnubok_list_uncategorized_transactions\` och \`gnubok_query_journal\` för bankens dragningar, bokförda och obokförda.
- \`gnubok_list_supplier_invoices\` för leverantörer som fakturerar.
- \`gnubok_list_cash_accounts\` för vilka konton som är bankkonton.

${DASHBOARD_RULES}
`

const base = { tier: 'workflow' as const, source: 'accounted' as const, itemKind: 'analysis' as const, version: 1 }

export const analysisSkills: Skill[] = [
  { ...base, slug: 'analys-manadsoversikt', name: 'Månadsöversikt', summary: 'Intäkter, kostnader och resultat månad för månad, med nyckeltal mot året innan, som en dashboard.', tags: ['analysis', 'dashboard', 'resultat'], body: manadsoversikt },
  { ...base, slug: 'analys-kassaprognos', name: 'Kassaprognos 30 dagar', summary: 'Saldot på företagskontot dag för dag de kommande 30 dagarna, med en varning om det blir för lite.', tags: ['analysis', 'dashboard', 'likviditet'], body: kassaprognos },
  { ...base, slug: 'analys-kostnadskoll', name: 'Kostnadskoll', summary: 'Prenumerationer och återkommande kostnader: vad de kostar per år, vad som ökat och vad som är värt att se över.', tags: ['analysis', 'dashboard', 'kostnader'], body: kostnadskoll },
]
