# Skatteverket Reference

Tax compliance rules, reporting requirements, and API integration details relevant for Swedish accounting software.

## Table of Contents
1. Moms (mervärdesskatt) - rules and rates
2. Skattedeklaration
3. Arbetsgivardeklaration på individnivå (AGI)
4. F-skatt and preliminär skatt
5. Skattekonto
6. Skatteverket API integration
7. Momsregistrering
8. ROT and RUT
9. Traktamente and representation
10. Digital granskning (Prop. 2025/26:107)

---

## 1. Moms (mervärdesskatt)

### Rates (as of 2026)
| Rate | Applies to |
|---|---|
| 25% | Standard: most goods and services |
| 12% | Restaurang/servering, hotell, camping, konstverk, repairs of cyklar, skor, lädervaror, kläder and hushållslinne |
| 6% | Books, newspapers, public transport, sport/cultural events. **From 1 Apr 2026: also livsmedel (tillfälligt till 31 Dec 2027)**. **From 1 Jul 2026: also tillträde till danstillställningar (SFS 2026:841)** |
| 0% | Export, international transports, financial services, healthcare, dental, education, insurance, social care |

### Livsmedel transition (Prop. 2025/26:55)
- Before 1 Apr 2026: 12%
- 1 Apr 2026 - 31 Dec 2027: 6% (tillfälligt)
- From 1 Jan 2028: back to 12% (enacted, SFS 2026:119; the 6% rate itself is SFS 2026:118)
- Transition rule: the rate applies based on when the beskattningsgrundande händelse (taxable event) occurs, typically leveransdatum, NOT fakturadatum. For förskott the taxable event is when the payment is received (ML 7 kap 7§), so a förskott received before 1 Apr 2026 keeps 12%
- Restaurang/servering stays at 12% throughout. The distinction livsmedel vs restaurangtjänst becomes critical. Take-away/avhämtning = 6%, servering/förtäring på plats = 12%

### Reporting periods for moms
The period is keyed on beskattningsunderlaget (sales excl. moms) for the beskattningsår, not nettoomsättning.

| Beskattningsunderlag | Period | Deadline |
|---|---|---|
| > 40 MSEK (excl. EU-förvärv and import) | Monthly (no alternative) | 26th of the following month (27th in December) |
| ≤ 40 MSEK | Quarterly by default; monthly on request | Quarterly: 12th of the second month after the quarter (17 August for Apr-Jun). Monthly: 12th of the second month after the period (17th in January and August) |
| ≤ 1 MSEK | Annual (beskattningsår) by default; monthly or quarterly on request | Enskild näringsidkare without EU trade: 12 May the year after (26 June with byråanstånd). Enskild näringsidkare with EU trade: 26 February. AB/ekonomisk förening without EU trade: tied to the inkomstdeklaration date; with EU trade: 26th of the second month after year-end (27th in December) |

### Omvänd skattskyldighet (reverse charge)
Applies in certain B2B scenarios:
- Byggtjänster (construction services) between companies in byggsektorn
- EU purchases of goods (EU-förvärv)
- EU purchases of services (huvudregel: köparens land)
- Certain precious metals and investment gold

Software must support reverse charge entries: debit ingående moms, credit utgående moms, no net cash effect but must appear on momsdeklaration.

### Jämkning av ingående moms
For investeringsvaror (ML 15 kap 4§: maskiner, inventarier and similar assets where the ingående moms is at least 50 000 kr; ny-, till- eller ombyggnad of a fastighet where the ingående moms is at least 100 000 kr): if the use of the asset changes (e.g., from momspliktig to momsfri verksamhet), the previously avdragen ingående moms must be jämkad (adjusted) over the justeringsperiod (ML 15 kap 10§: 10 years for fastigheter, 5 years for other investeringsvaror).

### EU-handel
- EU-försäljning av varor: momsfri if buyer has valid VAT number (verify via VIES) and goods are transported to another EU country
- EU-förvärv: reverse charge, reported in both ruta 20 (inköp) and ruta 30/31/32 (utgående moms) + ruta 48 (ingående moms)
- Periodisk sammanställning: reported monthly or quarterly to Skatteverket for EU sales

## 2. Skattedeklaration

### Content
The skattedeklaration covers:
- Moms (utgående and ingående, per rate)
- Arbetsgivaravgifter
- Avdragen preliminär skatt (PAYE)
- Särskild löneskatt on pensionskostnader

### Filing
- Arbetsgivardeklaration: 12th of the month after the period (17th in January and August). If beskattningsunderlaget for moms is > 40 MSEK: 26th (27th in December), but arbetsgivaravgifter and avdragen skatt must still be paid by the 12th (17th in January)
- Momsdeklaration: see the period table in section 1
- Electronic filing via Skatteverkets e-tjänst or via API (filöverföring)

### Key moms rutor (boxes)
The momsdeklaration has numbered rutor:
- 05: Momspliktig försäljning (ej export)
- 06: Momspliktiga uttag
- 07: Beskattningsunderlag vid vinstmarginalbeskattning
- 08: Hyresinkomst frivillig skattskyldighet
- 10: Utgående moms 25% on försäljning/uttag in 05-08
- 11: Utgående moms 12% on försäljning/uttag in 05-08
- 12: Utgående moms 6% on försäljning/uttag in 05-08
- 20-24: Purchases where the buyer is betalningsskyldig (EU goods/services, services from outside EU, domestic omvänd betalningsskyldighet)
- 30: Utgående moms 25% on purchases in 20-24
- 31: Utgående moms 12% on purchases in 20-24
- 32: Utgående moms 6% on purchases in 20-24
- 35: Försäljning av varor till annat EU-land
- 36: Försäljning av varor utanför EU (export)
- 37-38: Mellanmans inköp/försäljning vid trepartshandel
- 39: Försäljning av tjänster till beskattningsbar person i annat EU-land (huvudregeln)
- 40: Övrig försäljning av tjänster omsatta utomlands
- 41: Försäljning när köparen är betalningsskyldig i Sverige
- 42: Övrig försäljning m.m. (momsfri)
- 48: Ingående moms (total avdrag)
- 49: Moms att betala eller få tillbaka
- 50: Beskattningsunderlag vid import
- 60-62: Utgående moms on import 25% / 12% / 6%

## 3. Arbetsgivardeklaration på individnivå (AGI)

Since 2019, employers must report per individual each month.

### Per employee, report:
- Kontant bruttolön
- Förmåner (bil, bostad, etc.)
- Avdragen preliminär skatt
- Underlag for arbetsgivaravgifter
- Kostnadsersättningar (traktamente, bilersättning)

### Arbetsgivaravgifter (2026)
Standard rate: 31.42% on total ersättning
Breakdown:
- Ålderspensionsavgift: 10.21%
- Sjukförsäkringsavgift: 3.55%
- Föräldraförsäkringsavgift: 2.00% (2.60% until 2025)
- Arbetsskadeavgift: 0.10% (0.20% until 2025)
- Arbetsmarknadsavgift: 2.64%
- Allmän löneavgift: 12.62% (11.62% until 2025)
- Efterlevandepensionsavgift: 0.30% (0.60% until 2025)

**Age-based reductions (2026):**
- Born 1938-1958 (67+ at year start): only ålderspensionsavgift = 10.21%
- Born 1937 or earlier: no arbetsgivaravgifter (0%)
- Born 2003-2007 (turned 18 but not 23 at year start): 20.81% (ålderspensionsavgift plus half of the other avgifter) on ersättning up to 25 000 kr per calendar month, full 31.42% on the excess. Applies to ersättning paid 1 Apr 2026-30 Sep 2027 (Lag 2026:100)

### Filing
- Monthly, together with skattedeklaration
- Deadline: 12th of the following month (17th in January and August); 26th (27th in December) if beskattningsunderlaget for moms is > 40 MSEK

### New 2025/2026: föräldraledighet/VAB reporting
Employers must now report monthly when employees take föräldraledighet or VAB to Skatteverket.

## 4. F-skatt and preliminär skatt

### F-skatt
- Required for näringsverksamhet
- Applied for via Skatteverket
- Shows buyer that they are NOT responsible for paying arbetsgivaravgifter on the payment
- **2026 change**: applicant can request tidsbegränsat godkännande. Skatteverket may now require documentation proving eligibility

### FA-skatt
Combined F-skatt and A-skatt. For people who both run a business and are employed.

### Preliminär skatt (F-skattsedel)
- Debiterad preliminär skatt based on Skatteverket's estimate or the företagare's own uppgift
- Paid monthly to skattekontot
- Can be adjusted (jämkning) during the year if income differs from forecast
- Slutlig skatt beräknas vid inkomstdeklaration

## 5. Skattekonto

Every company/person with Swedish tax obligations has a skattekonto.

### How it works
- All tax payments credited (inbetalningar)
- All tax debits charged (arbetsgivaravgifter, moms, preliminärskatt, slutlig skatt)
- Interest on positive balance (intäktsränta, currently very low)
- Kostnadsränta on negative balance (higher, see Skatteverket current rates)
- Booked on the 12th or 26th each month

### For software
- Track expected debits/credits per period
- Reconcile against skattekontoutdrag from Skatteverket
- Flag underpayments to avoid kostnadsränta

## 6. Skatteverket API integration

### Momsdeklaration via API
Skatteverket offers electronic filing:
- Filöverföring: submit XML-based declarations
- OAuth2/BankID authentication flows for machine-to-machine and user-delegated access
- AGI (arbetsgivardeklaration): electronic submission required for most filers

### Authentication patterns
- BankID for user-facing authentication
- OAuth2 Authorization Code Grant (ACG) flow for delegated access
- Certificates for system-to-system (larger volumes)

### Data formats
- Skattedeklaration: XML schema defined by Skatteverket
- SIE4: for bokföring export (see sie4.md)
- Periodisk sammanställning: separate XML format for EU trade reporting

### Key endpoints (conceptual, verify current docs)
- Inkomstdeklaration
- Skattedeklaration (moms + AGI)
- Periodisk sammanställning (EU trade)
- Skattekontoutdrag

Always check Skatteverket's current technical documentation. Their APIs change. The developer portal is at https://www7.skatteverket.se/portal/apier-och-oppna-data/utvecklarportalen.

## 7. Momsregistrering

### When required
- Momspliktig omsättning inom landet > **120 000 kr** in the current calendar year, or in either of the two preceding calendar years (ML 18 kap 4§; threshold höjt 1 januari 2025 från 80 000 kr; 80 000 kr var den föregående höjningen från 2022)
- Below threshold: can choose to register voluntarily
- EU-handel: registration required regardless of threshold

### Registration process
- Apply via Skatteverket (blankett SKV 4620 or digitally)
- Receive momsregistreringsnummer (SE + org.nr + 01)
- Software should validate format: SE followed by 10 digits followed by 01

## 8. ROT and RUT

### ROT-avdrag (2026)
- 30% of arbetskostnad (not material) from 2026-01-01
- Max 50 000 kr per person per year (2026)
- Only for privatpersoner who own the bostad
- Applies to: reparation, underhåll, om- och tillbyggnad
- Filing: via Skatteverket's system, contractor submits begäran
- Temporary 50% rate applied **12 May: 31 December 2025** (prop. 2024/25:156); reverted to 30% at 2026-01-01. The takbelopp stayed at 50 000 kr throughout, only the subsidy rate changed.

### RUT-avdrag (2026)
- 50% of arbetskostnad
- Max 75 000 kr per person per year
- Applies to: hushållsnära tjänster (städning, trädgård, barnpassning, etc.)
- Combined ROT+RUT: max 75 000 kr, of which max 50 000 kr ROT

### For software
If you handle ROT/RUT, your invoices must separate arbetskostnad from materialkostnad. The ROT/RUT amount is claimed by the utförare (contractor) via Skatteverket's API, and reduces the customer's payment. You need to track: begärt belopp, godkänt belopp, utbetalt belopp.

## 9. Traktamente and representation

### Traktamente (2026)
- Heldag (minst en övernattning): 300 kr
- Halvdag: 150 kr
- Nattraktamente: 150 kr
- These are skattefria amounts per day. Amounts above are löneförmån.

### Representation (2026)
- Extern representation: avdragsgillt for enklare förtäring up to viss nivå
- Intern representation: two tillfällen per year (julfest, sommarfest etc.)
- Momsavdrag on representation: limited

## 10. Digital granskning (Prop. 2025/26:107)

### Background
Law allowing Skatteverket to access digital bokföring directly via internet during revision/kontroll. Adopted by the riksdag 25 March 2026 (bet. 2025/26:SkU11); in force since 1 July 2026.

### What it means for software developers
- Skatteverket may connect to your system and access bokföring directly
- NOT unlimited access: only when legal grund for kontroll/revision already exists
- You need: proper access controls, audit logging, ability to grant read-only access
- Data must be complete, correct, and accessible in real-time
- Consider implementing a "revisionsläge" or read-only API endpoint

### Timeline
- Lagrådsremiss: November 2025
- Proposition: February 2026
- Riksdag decision: 25 March 2026
- In force: 1 July 2026

### Implications for Accounted
Your system stores bokföring in the cloud. Under the new rules, Skatteverket could request access to a customer's data directly in your system. You should:
1. Have granular access controls (per-company read access)
2. Maintain complete audit trails
3. Ensure data immutability (event-sourced architecture helps here)
4. Be able to produce standardized exports (SIE4, PDF reports) on demand
5. Document your system's compliance in the systemdokumentation
