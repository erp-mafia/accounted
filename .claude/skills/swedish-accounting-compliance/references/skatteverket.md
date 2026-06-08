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
| 12% | Restaurang/servering, hotell, camping, certain cultural activities |
| 6% | Books, newspapers, public transport, sport/cultural events. **From 1 Apr 2026: also livsmedel (tillfälligt till 31 Dec 2027)** |
| 0% | Export, international transports, financial services, healthcare, dental, education, insurance, social care |

### Livsmedel transition (Prop. 2025/26:55)
- Before 1 Apr 2026: 12%
- 1 Apr 2026 - 31 Dec 2027: 6% (tillfälligt)
- After 31 Dec 2027: expected reversion to 12%
- Transition rule: the rate applies based on when the beskattningsgrundande händelse (taxable event) occurs, typically leveransdatum, NOT fakturadatum
- Restaurang/servering stays at 12% throughout. The distinction livsmedel vs restaurangtjänst becomes critical. Take-away/avhämtning = 6%, servering/förtäring på plats = 12%

### Reporting periods for moms
| Nettoomsättning | Period | Deadline |
|---|---|---|
| > 40 MSEK | Monthly | 26th of following month (12th for Jan and Aug) |
| 1-40 MSEK | Monthly or quarterly (employer's choice, application to SKV) | Monthly: 26th. Quarterly: 12th of second month after quarter end |
| < 1 MSEK | Quarterly, or annually | Annual: latest in the inkomstdeklaration |

### Omvänd skattskyldighet (reverse charge)
Applies in certain B2B scenarios:
- Byggtjänster (construction services) between companies in byggsektorn
- EU purchases of goods (EU-förvärv)
- EU purchases of services (huvudregel: köparens land)
- Certain precious metals and investment gold

Software must support reverse charge entries: debit ingående moms, credit utgående moms, no net cash effect but must appear on momsdeklaration.

### Jämkning av ingående moms
For investeringsvaror (fastighetsinvesteringar, inventarier > 200 000 kr, fastighetstjänster > 100 000 kr): if the use of the asset changes (e.g., from momspliktig to momsfri verksamhet), the previously avdragen ingående moms must be jämkad (adjusted) over a period (10 years for fastigheter, 5 years for inventarier).

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
- Monthly filers: due the 12th (Jan, Aug) or 26th (other months) of the following month
- Paper deadline: 12th of following month regardless
- Electronic filing via Skatteverkets e-tjänst or via API (filöverföring)

### Key moms rutor (boxes)
The momsdeklaration has numbered rutor:
- 05: Momspliktig försäljning (ej export)
- 06: Momspliktiga uttag
- 07: Beskattningsunderlag vid vinstmarginalbeskattning
- 08: Hyresinkomst frivillig skattskyldighet
- 20-24: EU-related acquisitions and purchases
- 30: Utgående moms 25%
- 31: Utgående moms 12%
- 32: Utgående moms 6%
- 35: Utgående moms reverse charge
- 40: Inköp med avdragsrätt
- 41: Inköp utan avdragsrätt
- 48: Ingående moms (total avdrag)
- 49: Moms att betala eller få tillbaka
- 50: Momspliktigt belopp export

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
- Föräldraförsäkringsavgift: 2.60%
- Arbetsskadeavgift: 0.20%
- Arbetsmarknadsavgift: 2.64%
- Allmän löneavgift: 11.62%
- Efterlevandepensionsavgift: 0.60%

**Age-based reductions (2026):**
- Born 1959 or earlier (67+ at year start): only ålderspensionsavgift = 10.21%
- Born 2001-2007 (18-24): full rate 31.42% (the previous ungdomsrabatt expired 2023)

### Filing
- Monthly, together with skattedeklaration
- Deadline: same as skattedeklaration (12th or 26th)

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

Always check Skatteverket's current technical documentation. Their APIs change. The developer portal is at skatteverket.se/utvecklare.

## 7. Momsregistrering

### When required
- Momspliktig verksamhet > 80 000 kr per 12-month period (threshold from 2025)
- Below threshold: can choose to register voluntarily
- EU-handel: registration required regardless of threshold

### Registration process
- Apply via Skatteverket (blankett SKV 4620 or digitally)
- Receive momsregistreringsnummer (SE + org.nr + 01)
- Software should validate format: SE followed by 10 digits followed by 01

## 8. ROT and RUT

### ROT-avdrag (2026)
- 30% of arbetskostnad (not material)
- Max 50 000 kr per person per year
- Only for privatpersoner who own the bostad
- Applies to: reparation, underhåll, om- och tillbyggnad
- Filing: via Skatteverket's system, contractor submits begäran

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
Proposed law to allow Skatteverket to access digital bokföring directly via internet during revision/kontroll. Currently (spring 2026) in riksdag processing.

### What it means for software developers
- Skatteverket may connect to your system and access bokföring directly
- NOT unlimited access: only when legal grund for kontroll/revision already exists
- You need: proper access controls, audit logging, ability to grant read-only access
- Data must be complete, correct, and accessible in real-time
- Consider implementing a "revisionsläge" or read-only API endpoint

### Timeline
- Lagrådsremiss: November 2025
- Proposition: February 2026
- Expected riksdag decision: Spring 2026
- Proposed effective date: 1 July 2026

### Implications for Accounted
Your system stores bokföring in the cloud. Under the new rules, Skatteverket could request access to a customer's data directly in your system. You should:
1. Have granular access controls (per-company read access)
2. Maintain complete audit trails
3. Ensure data immutability (event-sourced architecture helps here)
4. Be able to produce standardized exports (SIE4, PDF reports) on demand
5. Document your system's compliance in the systemdokumentation
