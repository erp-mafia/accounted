# Kassaregister and Personalliggare Reference

Certified cash registers (kassaregister) and staff ledgers (personalliggare) under Skatteförfarandelagen (SFL 2011:1244), Skatteförfarandeförordningen (SFF 2011:1261) and Skatteverkets föreskrifter (SKVFS). Verified against primary sources on 2026-09-17. Amounts and dates matter more than completeness here; anything not confirmable in a primary source carries an inline **Osäkert** line instead of a guess.


## Table of Contents
1. The one-minute decision
2. Who must use a kassaregister (SFL 39 kap 4 §)
3. Exemptions (SFL 39 kap 5 §)
4. The fyra prisbasbelopp threshold
5. Foreign companies and fast driftställe
6. Individual exemptions (SFL 39 kap 9 §)
7. Payment methods: kontant, kontokort, Swish
8. Anmälan to Skatteverket (SFL 7 kap)
9. Technical requirements and the föreskrift stack
10. The 1 January 2027 change
11. Kassakvitto: the receipt duty and its contents
12. Dagrapporter, journalminne, retention, driftsavbrott
13. Personalliggare: which industries
14. Personalliggare: contents and form
15. Personalliggare på byggarbetsplats
16. Tillsyn and kontrollbesök (SFL 42 kap)
17. Kontrollavgift (SFL 50-51 kap)
18. Proposals not yet law: prop. 2025/26:282
19. Ask-the-user rules
20. Sources

---

## 1. The one-minute decision

```
Sells varor/tjänster in näringsverksamhet against kontant betalning or kontokort?   SFL 39:4
  (Skatteverket counts Swish and other elektroniska betaltjänster: see §7)
  ├─ No (100 % invoiced) ................................... no kassaregister duty
  └─ Yes → any exemption in 39 kap 5 §?
       1. Sales normally ≤ 4 prisbasbelopp incl. moms ....... 236 800 kr for 2026
       2. Skattebefriad under IL (stat, region, kommun, konkursbo, allmännyttig
          ideell förening): but NOT if no fast driftställe in Sweden (39:5 st 3)
       3. Taxitrafik (taxitrafiklagen 2012:211)
       4. Distansavtal / hemförsäljningsavtal
       5. Varuautomat, liknande automat, automatiserad affärslokal
       6. Automatspel enligt spellagen (2018:1138)
     otherwise → tillverkardeklarerat register + kontrollenhet or kontrollsystem,
                 anmält to Skatteverket, kvitto offered at every sale
```

Självständiga verksamheter inside one näringsverksamhet are assessed **separately** (SFL 39 kap 6 §). Torg- och marknadshandel is **not** an exemption (§3).

## 2. Who must use a kassaregister (SFL 39 kap 4 §)

> "Den som i näringsverksamhet säljer varor eller tjänster mot kontant betalning eller mot
> betalning med kontokort ska använda kassaregister."

*Kassaregister* (SFL 39 kap 2 §) = "kassaapparat, kassaterminal, kassasystem och liknande apparatur för registrering av försäljning av varor och tjänster mot kontant betalning eller mot betalning med kontokort".

- **Register everything**: "All försäljning och annan löpande användning av ett kassaregister ska registreras i kassaregistret" (39 kap 7 § 1 st).
- **Offer a receipt**: "Vid varje försäljning ska ett av kassaregistret framställt kvitto tas fram och erbjudas kunden" (39 kap 7 § 2 st). The duty is to offer, not to make the customer take it.
- **Certified**: the register must reliably show all registreringar and all programmeringar och inställningar that are behandlingshistorik under BFL, and "Kassaregistret ska vara certifierat" (39 kap 8 §). Certification is done by a body accredited under EU reg. 765/2008 and lagen (2011:791) (SFF 9 kap 2 §, Förordning 2022:1179).

Invoiced sales fall outside the duty. A **kontantfaktura** issued at the moment of payment is an alternative, if it meets BFL's verifikation requirements; Skatteverket requires a löpnummer on it, a copy in the bokföring, and the cash payment booked no later than the next arbetsdag.

## 3. Exemptions (SFL 39 kap 5 §)

| # | Exemption (39 kap 5 § 1 st) | Notes |
|---|---|---|
| 1 | Sells only "i obetydlig omfattning" against kontant/kontokort | See §4: four prisbasbelopp |
| 2 | Befriad från skattskyldighet under IL (1999:1229) for that income | Stat, regioner, kommuner, konkursbon, allmännyttiga ideella föreningar. Does **not** apply to a näringsidkare operating in Sweden without fast driftställe (39 kap 5 § 3 st, Lag 2022:1673) |
| 3 | Taxitrafik enligt taxitrafiklagen (2012:211) | Taxameterreglerna apply instead |
| 4 | **Distansavtal** or **hemförsäljningsavtal** | Defined in 39 kap 2 §. Skatteverket: app/web ordering by a guest *seated in* the restaurant or café is **not** a distansavtal |
| 5 | Varuautomat, liknande automat, automatiserad affärslokal | Unmanned sale |
| 6 | Automatspel enligt spellagen (2018:1138) | |

Skatteverket also lists as directly exempt: licensed lotterier and vadhållning sold through ombud; färdbevis sold by a kollektivtrafikföretag under lagen om kollektivtrafik; and bingo, automatspel and certain lotterier arranged under spellagen licence.

**Föreskrift-level exemption.** SKVFS 2025:6 (in force 2026-01-01) permanently exempts from the registration duty in SFL 39 kap 7 §: (a) lotterier arrangeable without licence at an offentlig nöjestillställning under spellagen 3 kap 5 § 2 a, and (b) bollkastning, pilkastning, skjutning and similar skicklighetsspel there, where each insats is at most 3/4000 prisbasbelopp and the prize is goods worth at most 1/60 prisbasbelopp. Both only where the activity is torg- och marknadshandel. It replaced SKVFS 2023:13, which covered 2024-2025 with fixed amounts (43 kr insats, 955 kr vinst).

**Torg- och marknadshandel is not exempt.** Market, fair, festival and temporary-premises sellers need a register on the same terms as anyone else; Skatteverket is explicit that it applies "oavsett väder eller din tillgång till el", and that a seller trading both in a shop and at markets needs one in both places because the beloppsgräns is measured across the whole company. Separately, the **platsupplåtare** must document the trader's and their företrädare's identification data (SFL 39 kap 13 §; SFF 9 kap 7 §: namn/företagsnamn, personnummer/organisationsnummer, postadress, telefonnummer, kept seven years; not needed if a copy of the F-skatt decision was handed over).

## 4. The fyra prisbasbelopp threshold

SFL 39 kap 5 § 2 st: in judging "obetydlig omfattning" particular weight is given to whether the sales normally amount to, or can be assumed to amount to, **at most four prisbasbelopp during a beskattningsår**.

| Year | Prisbasbelopp | 4 × PBB (threshold, incl. moms) |
|---|---|---|
| 2026 | 59 200 kr | **236 800 kr** |

Sources: Skatteverket, "Vissa verksamheter är undantagna…" ("Fyra prisbasbelopp för år 2026 är 236 800 kronor (4 × 59 200 kronor)") and Skatteverket, "Belopp och procent 2026" ("Prisbasbeloppet inkomstår 2026: 59 200 kronor").

Mechanics to get right:
- Counts **kontant- och kortförsäljning inklusive moms only**; invoiced revenue is excluded.
- Measured over a räkenskapsår of twelve months. **Osäkert**: no primary source found stating an explicit pro-rata formula for a short or broken räkenskapsår: apply the "normalt uppgår till" test and tell the user to confirm with Skatteverket.
- "Normalt" is forward-looking: a company that can be assumed to exceed it needs a register from the start, not after crossing it.
- Applied per **självständig verksamhet** (39 kap 6 §); Skatteverket's position is that market trading alongside a shop is normally *not* självständig, so amounts are added together.
- A company below the threshold is **not obliged to offer a kvitto** either (Skatteverket), but still must produce a daily sales report under BFL and book cash receipts by the next arbetsdag.

## 5. Foreign companies and fast driftställe

Lacking a fast driftställe in Sweden is **not** an exemption: it is the opposite. SFL 39 kap 5 § 3 st removes the skattebefrielse exemption (p 2) from a näringsidkare running verksamhet in Sweden without a fast driftställe here. SFL 39 kap 8 a § (Lag 2017:194) instead lets such a näringsidkare use a register tested under the rules of **another EEA state**, if the testing shows equivalent requirements are met. Skatteverket: "Du med utländskt företag som säljer varor eller tjänster i Sverige ska använda kassaregister precis som svenska företag." SKVFS 2014:10 has a dedicated 7 kap, "Undantag för utländska företag utan fast driftsställe i Sverige".

## 6. Individual exemptions (SFL 39 kap 9 §)

Skatteverket may decide on an exemption in an individual case if the need for reliable underlag for skattekontroll can be met another way, or a particular duty is oskälig; the decision may carry conditions (39 kap 9 §, Lag 2013:384; bemyndigande in 39 kap 10 § and SFF 9 kap 3 § p 4). Forms: **SKV 1510**, and **SKV 1523** for kedjeföretag. The decision states duration and conditions. Explicitly **not** accepted grounds (Skatteverket): outdoor sales in bad weather, or no electricity at the point of sale.

## 7. Payment methods: kontant, kontokort, Swish

The statute names only two categories: "mot kontant betalning eller mot betalning med kontokort" (SFL 39 kap 2 § and 4 §). Swish appears nowhere in SFL, SFF or the SKVFS texts.

Skatteverket's published position (skatteverket.se/foretag/drivaforetag/kassaregister):

> "Företag som tar emot kontant- eller kortbetalningar måste registrera försäljningen i ett
> kassaregister. Det gäller också om företag tar emot betalningar elektroniskt, till exempel via
> Swish." >
> "Exempel på kontant betalning är betalning med sedlar och mynt, presentkort, kuponger som
> företaget löser in hos något annat företag och liknande. Exempel på betalning med kontokort är
> betalning med konto- eller kreditkort och andra elektroniska betalningstjänster som Swish."

So Swish and equivalent instant-payment services sit in the **kontokort** limb; gift cards and third-party-redeemed coupons sit in the **kontant** limb. At föreskrift level the concept is neutral: *betalningsmedel* = "formen för betalning oavsett om den görs i elektronisk form eller i fysisk form" (SKVFS 2014:9 2 kap 2 §; SKVFS 2014:10 2 kap 1 §, both as amended 2021). The betalningsmedel must be printed on the kassakvitto and broken out on the X- and Z-dagrapport.

**Osäkert.** Skatteverket's Swish position is published as webbtext, not in lagtext, förordning or any SKVFS, and no ställningstagande on the point could be retrieved from a primary source (rättslig vägledning at www4.skatteverket.se was unreachable). Treat the web page as Skatteverket's stated administrative position; for a borderline rail (crypto, BNPL, invoice-at-checkout) tell the user to ask Skatteverket rather than reasoning by analogy.

## 8. Anmälan to Skatteverket (SFL 7 kap)

| Duty | Rule | Timing |
|---|---|---|
| Registered as user of kassaregister | 7 kap 1 § 1 st p 8 | On registration |
| State the kassaregister that exist in the verksamhet | 7 kap 3 § | With the anmälan, before use |
| Report changes to registered data | 7 kap 4 § | Within **two weeks** of the change |
| Byggherre registers the byggarbetsplats | 7 kap 2 a § | **Before** byggverksamheten starts; must state when it starts and where it is run |
| Föreläggande if duties not met | 7 kap 5 § | - |

Contents of the anmälan (Skatteverket, "Så här anmäler du kassaregister"): for the kontrollenhet or kontrollsystem: beteckning, modell eller version, tillverkningsnummer, adress; for the kassaregister, beteckning, modell eller program, tillverkningsnummer, and whether it uses **kontrollremsa or journalminne**; plus verksamhetens namn and the address where it is used.

Each registreringsenhet with its kontrollenhet/kontrollsystem is notified as a **separate kassaregister**, except customer-held registreringsenheter where at least one unit with the same kontrollenhet/kontrollsystem and kassaregisterprogram is already notified; a register that stops working must be documented and reported "utan dröjsmål" (SKVFS 2014:10 4 kap 1 §, as amended by **SKVFS 2025:8**, in force 2025-10-01). Confirmation arrives within two days, registreringsbevis after 14 days; the register may be used as soon as it is notified. A kontrollenhet taken out of use must be kept securely for at least 12 months.

## 9. Technical requirements and the föreskrift stack

The register must be **tillverkardeklarerat** and connected to **a kontrollenhet or a kontrollsystem** (Skatteverket; SKVFS 2014:9 1 kap 1 §: "Som en del i ett kassaregistersystem ska alltid ingå en kontrollenhet eller ett kontrollsystem").

| Föreskrift | Subject | Status |
|---|---|---|
| SKVFS 2014:9 | Krav på kassaregister | Base; amended by SKVFS 2020:10 and **2021:17** (omtryck) |
| SKVFS 2021:17 | Ändring i SKVFS 2014:9 | Beslutad 2021-11-22, in force **2022-01-01** |
| SKVFS 2014:10 | Användning av kassaregister | Base; amended by SKVFS 2020:11, **2021:18** (omtryck), **2025:8** |
| SKVFS 2021:18 | Ändring i SKVFS 2014:10 | Beslutad 2021-11-22, in force **2022-01-01** |
| SKVFS 2021:16 | Standardexport av data i journalminne (the XML format) | Beslutad 2021-11-22, in force **2022-01-01** |
| SKVFS 2009:2 | Kontrollenhet till kassaregister | Amended by **SKVFS 2016:1** (in force 2016-02-01) |
| SKVFS 2020:9 | Kontrollsystem till kassaregister | In force 2021-01-01 |
| SKVFS 2015:6 | Personalliggare | Amended by **SKVFS 2018:6** (in force 2018-07-01) |
| SKVFS 2025:6 | Undantag, lotterier/skicklighetsspel | In force 2026-01-01, replaces SKVFS 2023:13 |

Kassaregister föreskrifter are issued under **SFF 9 kap 3 §**; personalliggare föreskrifter under **SFF 9 kap 6 §**.

**Kontrollenhet vs kontrollsystem.** A kontrollenhet is a physical certified unit at the register (SKVFS 2009:2); a kontrollsystem is the server-side alternative introduced by SKVFS 2020:9. They are alternatives, never both. The choice shows in three places: the anmälan (§8); the kassakvitto, which must print the tillverkningsnummer of whichever is used (SKVFS 2014:9 7 kap 1 § l); and the permitted length of the register's tillverkningsnummer: max 48 characters with a kontrollenhet, max 17 with a kontrollsystem (SKVFS 2014:9 2 kap 23 §).

**Tillverkardeklaration** (SKVFS 2014:9 8 kap): one per version of a kassaregistermodell or -program offered on the Swedish market; must show the model was tested together with a certified kontrollenhet, with methods and results in a testprotokoll; forms part of the register's documentation; must reach Skatteverket **at least two weeks before** the model is placed on the Swedish market (form **SKV 1509**). A new declaration is needed on a version update only if the change affects regulated functions: or whenever Skatteverket asks. Skatteverket does not test the registers; that is the manufacturer's responsibility. Manufacturers of kontrollenheter or kontrollsystem must first be certified by an accredited body, then apply for a **huvudnyckel** (form **SKV 1511**).

## 10. The 1 January 2027 change

Skatteverket states it on its kassaregister landing page, verbatim:

> "Från och med den 1 januari 2027 ska ditt kassaregister uppfylla Skatteverkets föreskrift om krav
> på kassaregister (SKVFS 2021:17). Om ditt kassaregister har ett så kallat journalminne ska det
> kunna ta fram registreringar i formatet XML. Kontakta din kassaregisterleverantör om du har
> frågor om ditt kassaregister. Ytterligare information finns även i Skatteverkets föreskrift om
> användning av kassaregister (SKVFS 2021:18)."

| Question | Answer |
|---|---|
| What changes | Every register in use must meet SKVFS 2014:9 **in its SKVFS 2021:17 lydelse**, not the pre-2022 lydelse |
| Who is affected | Any company still running a register tillverkardeklarerat under the older lydelse. The XML rule bites only on registers with a **journalminne**; registers with a paper **kontrollremsa** are unaffected by it |
| Which XML | The standard export defined in **SKVFS 2021:16**; schema and explanation are published on Skatteverket's Schemalager (XML) page |
| What to do | Contact the leverantör. A replacement or version upgrade needs a new tillverkardeklaration; a replaced register must be both anmält (new) and avanmält (old) |
| Föreskrift transition | SKVFS 2021:17 entered into force 2022-01-01 and allowed the older lydelse of 2 kap 17 § and 4 kap 9-10 §§ **vid tillverkning** only up to and including 2022-12-31 |

**Osäkert: read before advising.** The date 1 January 2027 was found only on Skatteverket's own web page. It is not in SFL, not in SFF, and not in the published text of SKVFS 2021:16, 2021:17 or 2021:18 (all three in force 2022-01-01), nor in any later kassaregister SKVFS located (2023:13, 2025:6, 2025:8). Skatteverket's own list "Tillverkardeklarerade kassaregister" (updated 2026-08-28) still describes declarations as certifying compliance with SKVFS 2014:9. Treat 2027-01-01 as Skatteverket's published administrative end-date for tolerating pre-2022 registers, cite the Skatteverket page for it, and do **not** present it as an övergångsbestämmelse in a föreskrift. If the user needs the formal legal basis, tell them to ask Skatteverket.

## 11. Kassakvitto: the receipt duty and its contents

Duty: SFL 39 kap 7 § 2 st. Skatteverket: "Vid varje försäljning ska du ta fram och erbjuda ett kassakvitto, på papper eller digitalt, oavsett betalsätt."

Contents: **SKVFS 2014:9 7 kap 1 §**. A kassakvitto must contain at least:

| | Uppgift |
|---|---|
| a | Företagets namn och organisationsnummer eller personnummer |
| b | Den adress där försäljning sker |
| c | Datum och klockslag för försäljningen |
| d | Löpnummer ur en obruten stigande nummerserie |
| e | Kassabeteckning |
| f | Artikelnamn och antal varor som sålts |
| g | Benämning på tjänster och antal tjänster som sålts |
| h | Försäljningsbelopp per vara/tjänst inkl. moms och totalbelopp för kunden att betala |
| i | Den mervärdesskatt som belöper på försäljningsbeloppet |
| j | Momsens fördelning på olika skattesatser |
| k | **Betalningsmedel** |
| l | Tillverkningsnummer for the kontrollenhet (SKVFS 2009:2) or the kontrollsystem (SKVFS 2020:9) |
| m | The words "elektroniskt kassakvitto" if issued in electronic form |

Points i and j do not apply where the sale does not make the seller skattskyldig, nor under the vinstmarginal schemes. The same requirements apply to a **returkvitto**, paper or electronic. Torg- och marknadshandel without a verksamhetslokal may give another address under b, e.g. the home address (Skatteverket).

**Osäkert / known defect.** SKVFS 2014:9 7 kap 1 § still cross-references "mervärdesskattelagen (1994:200)" and its 9 a and 9 b kap. ML 1994:200 was replaced by **ML (2023:200)** on 1 July 2023. Read those as pointing to the corresponding vinstmarginalbeskattning provisions in ML 2023:200, and do not quote the old chapter numbers to a user.

**Relationship to the invoice rules.** A kassakvitto is not a faktura. Where the buyer is a business needing input-VAT deduction, or the invoice rules otherwise apply, the document must meet ML 17 kap: including the förenklad faktura option. Use the `swedish-invoice-compliance` skill for the ML 17 kap 24 § field list, the förenklad faktura threshold and kreditfaktura handling; they are not restated here. A company exempt from the kassaregister duty is also exempt from the kvitto duty, but Skatteverket notes BFL and the momsregler may still require a proper underlag for the buyer.

## 12. Dagrapporter, journalminne, retention, driftsavbrott

- **X-dagrapport** (SKVFS 2014:9 7 kap 2 §) and **Z-dagrapport** (7 kap 3 §) have prescribed content lists of roughly twenty items each: total försäljningssumma, moms per skattesats, växelkassa, antal sålda varor/tjänster, antal kassakvitton, antal lådöppningar, antal kvittokopior, registreringar i övningsläge, försäljningssumman fördelad på olika betalningsmedel, returer, rabatter, oavslutade försäljningar, grand total försäljning / retur / netto. Only the Z-dagrapport carries a löpnummer ur en obruten stigande nummerserie.
- **One Z-dagrapport per försäljningsdag** is the company's responsibility (Skatteverket). Before the day starts: check the register's clock and register the **växelkassa**; register any change to the växelkassa during the day.
- **Definitions** (SFL 42 kap 2 §): *kontrollremsa* = running registration in paper form; *journalminne* = running registration in electronic form.
- **Retention** (SFF 9 kap 4 §): data on kontrollremsa, in journalminne or on tömningskvitto covered by SFL 42 kap 7 § 1 st must be kept **two months after the end of the calendar month** in which it was registered: unless it is räkenskapsinformation under BFL, in which case BFL 7 kap's seven-year rule governs instead.
- **Driftsavbrott**: if the register fails, document sales another way and report the fault to Skatteverket; selling on without registering is grounds for kontrollavgift. Keep the manual documentation in the bokföring and do **not** back-enter the sales once the register works again ("Det är inte meningen att du ska registrera försäljningen i kassaregistret i efterhand"). A power cut alone need not be reported.

## 13. Personalliggare: which industries

SFL 39 kap 11 § 1 st (Lag 2018:243): five categories of verksamhetslokal, defined in 39 kap 2 §:

| Verksamhet | Definition |
|---|---|
| Restaurangverksamhet | Restaurang, pizzabutik och annat liknande avhämtningsställe, gatukök, kafé, personalmatsal, catering, centralkök |
| Fordonsserviceverksamhet | Underhåll och reparation av motordrivna fordon enligt lagen (2001:559) om vägtrafikdefinitioner |
| Livsmedels- och tobaksgrossistverksamhet | Partihandel med livsmedel, drycker och tobak |
| Kropps- och skönhetsvårdsverksamhet | Behandling av en persons kropp eller omsorg om en persons yttre: excluding measures normally performed by hälso- och sjukvårdspersonal (patientsäkerhetslagen 1 kap 4 §), kirurgiska ingrepp, injektionsbehandlingar and medicinskt betingad fotvård (ML 2023:200 10 kap 7 § 3 st) |
| Tvätteriverksamhet | Rengöring av textilier m.m., plus uthyrning, färgning, lagning eller ändring in connection with it |

Plus **byggverksamhet** on a byggarbetsplats under 39 kap 11 a-11 c §§ (§15).

- **Frisör is no longer its own category.** Hairdressing sits inside *kropps- och skönhetsvårdsverksamhet*; the older wording "restaurang-, frisör- och tvätteriverksamhet" survives only in SKVFS 2015:6 7 § in its pre-2018 lydelse, replaced by SKVFS 2018:6.
- A näringsverksamhet that is *huvudsakligen* something other than the five categories is not treated as such verksamhet (39 kap 2 §, last paragraph). Skatteverket's line on **blandad verksamhet** in one lokal: required if the covered activity is **25 % or more** of the total, not required if **75 % or more** is other activity, normally judged by how omsättningen splits.
- **Family exception** (39 kap 11 § 2 st): not required for an enskild näringsverksamhet where only the näringsidkare, their make or children under 16 are verksamma, nor for a fåmansföretag or fåmanshandelsbolag where only the företagsledare, their make or children under 16 are verksamma. Skatteverket: as soon as anyone else is verksam: even briefly, the duty starts on that person's first working day, and the family members must record themselves for the **rest of that calendar month**. These exceptions do **not** exist in byggverksamhet.

## 14. Personalliggare: contents and form

**Contents (SFF 9 kap 5 §)**: (1) näringsidkarens namn och personnummer, samordningsnummer, organisationsnummer eller motsvarande utländska nummer; (2) namn och personnummer, samordningsnummer eller motsvarande utländska nummer for persons verksamma in the näringsverksamheten; (3) the time each person's **arbetspass** starts and ends. Items 2-3 apply to every verksamhetsdag and must be documented "i omedelbar anslutning till" the start and end of the arbetspass. Kept **two years after the end of the calendar year in which the beskattningsår ended**.

Also recorded: unpaid workers (praktikanter, relatives) and staff hired from a bemanningsföretag. Not recorded: e.g. a service technician from another company doing temporary work on site. In blandad verksamhet in one lokal, everyone verksam in the lokal is recorded.

**Form (SKVFS 2015:6, as amended by SKVFS 2018:6):**
- The five verksamhetslokal categories may keep it **manually or electronically** (7 §); byggverksamhet must keep it **electronically** (9 §).
- A manual liggare must be **bound** with **pre-numbered pages**, written in beständig skrift (8 §): loose sheets and spiral pads are not allowed. Skatteverket publishes a book, **SKV 605**.
- Corrections only by **tillägg**, never by erasing or obscuring; the tillägg must show what was added, by whom and when (6 §).
- Numbers use the characters 0-9; text other than names must be in Swedish (4 §). Other data may be recorded if it does not hinder Skatteverket's kontroll (5 §).
- Electronic systems must log every event (who changed what, when) and let Skatteverket inspect data backwards in time so the bevarandekrav can be checked; date and time in the formats ÅÅÅÅ:MM:DD and TT:MM:SS (11-13 §§).
- **Availability** (SFL 39 kap 12 §): available to Skatteverket in the verksamhetslokal. Someone else may keep it, but responsibility stays with the näringsidkare.

## 15. Personalliggare på byggarbetsplats

| Rule | Content |
|---|---|
| SFL 39 kap 11 a § | A company running byggverksamhet where the byggherre has provided equipment under 11 b § must keep an **elektronisk** personalliggare with identification data for the näringsidkare and, running, for everyone verksam. Persons who only briefly load or unload material, goods or equipment are **not** recorded |
| SFL 39 kap 11 b § | The **byggherre** must provide the equipment. Not required (1) until the total cost of the byggverksamhet on that byggarbetsplats can be assumed to exceed **four prisbasbelopp** (236 800 kr for 2026), or (2) for a byggherre who is a fysisk person not carrying out or commissioning projekterings-, byggnads-, rivnings- eller markarbeten in näringsverksamhet |
| SFL 39 kap 11 c § | The byggherre's duties under 11 b § and 12 § and SFL 7 kap 2 a § and 4 § may be transferred **in writing** to a näringsidkare commissioned to take independent responsibility for the work |
| SFL 39 kap 12 § 2 st | The byggherre keeps the **samlade personalliggaren** available to Skatteverket on site; each company running byggverksamhet keeps its own available to both Skatteverket and the byggherre |
| SFL 7 kap 2 a § | The byggherre registers the byggarbetsplats with Skatteverket **before** work starts, stating when it starts and where it is run |
| SKVFS 2015:6 3, 10, 14 §§ | Defines samlad personalliggare; the byggarbetsplats **identifikationsnummer** assigned under SFF 2 kap 2 a § must appear in the liggare; the samlade liggaren must let Skatteverket see data for a particular company or person at a kontrollbesök |

Only byggarbetsplatser **inside Sweden** are covered. *Byggverksamhet* (39 kap 2 §) = om-, till- och nybyggnadsarbeten, reparations- och underhållsarbeten, rivning av byggnadsverk and supporting näringsverksamhet not already covered by 11 §; a *byggarbetsplats* is "en plats där byggverksamhet bedrivs". Whether a framework agreement with several avrop is one or several byggarbetsplatser is a helhetsbedömning (Skatteverket, citing prop. 2014/15:6 s. 42). Register sites in Skatteverket's e-tjänst; the user must be behörig firmatecknare or a **registreringsombud för personalliggare bygg** (form **SKV 4856**).

## 16. Tillsyn and kontrollbesök (SFL 42 kap)

| | Kassaregister | Personalliggare |
|---|---|---|
| Tillsyn | 42 kap 3-5 §§: supervision that those who are, or may be assumed to be, obliged have a compliant register; right of access to verksamhetslokaler; Polismyndigheten assists on request; the company must hand over handlingar and upplysningar | - |
| Kontrollbesök | 42 kap 6 §: may include **kundräkning, kontrollköp, kvittokontroll och kassainventering**. Only in verksamhetslokaler the public has access to; kundräkning may also be done on an allmän plats adjoining such a lokal | 42 kap 8 §: only in verksamhetslokaler or on byggarbetsplatser; **not** in a lägenhet intended wholly or to a not insignificant part as a dwelling |
| At the visit | 42 kap 7 §: on request, produce **kontrollremsa, uppgifter från journalminne eller tömningskvitto** showing how sales were registered | 42 kap 8 a §: Skatteverket may require a person working there to prove identity, and on a byggarbetsplats ask for whose account they work; answers may be checked against the liggare |
| Notice and conduct | 42 kap 10-11 §§: no advance notice required, notice given as soon as it can be without the kontroll losing its meaning; the verksamhet must not be hindered unnecessarily | Same |

In practice staff identify themselves with tjänstelegitimation, but anonymous kontrollköp, kvittokontroller and kundräkningar may precede that; a decision on the visit is handed over or sent to the company's address. A separate kontrollbesök type exists for torg- och marknadshandel, to identify the trader and check godkännande för F-skatt (42 kap 9 §).

## 17. Kontrollavgift (SFL 50-51 kap)

| Breach | Amount | Rule |
|---|---|---|
| Obliged to use kassaregister but does not, or has not reported the registers under SFL 7 kap 3 and 4 §§ | **12 500 kr** per kontrolltillfälle | 50 kap 1-2 §§ |
| …repeat: new avgift for a breach occurring **within one year** of the earlier kontrollavgift decision | **25 000 kr** | 50 kap 2 § 2 st (Lag 2015:768) |
| Personalliggare not kept, or not kept available in the verksamhetslokal / on the byggarbetsplats; or equipment for an elektronisk personalliggare not provided | **12 500 kr** per kontrolltillfälle **plus 2 500 kr per person** verksam at the kontroll and not documented in an available liggare | 50 kap 3 § p 1-2, 4 § 1 st |
| …repeat within one year | The 12 500 kr part becomes **25 000 kr**; the 2 500 kr per person is unchanged | 50 kap 4 § 2 st (Lag 2015:769) |
| Byggherre has not reported the byggarbetsplats under SFL 7 kap 2 a § | **25 000 kr** | 50 kap 3 § p 3, 4 § 3 st |
| Platsupplåtare has not documented torg- och marknadshandel, or leverans av investeringsguld not documented | **2 500 kr** per occasion | 50 kap 7 § (Lag 2023:208) |

- No kontrollavgift for a breach covered by a **vitesföreläggande** (50 kap 5 §).
- After a decision the brist must be remedied within skälig tid; during that time no new kontrollavgift may be taken for the same brist (50 kap 6 §).
- **Befrielse**: Skatteverket shall decide on full or partial relief if full amount is oskäligt, weighing in particular age/health or similar, a felbedömning of a rule or of the facts, whether the avgift is disproportionate to the fault, and whether an unreasonably long time has passed (51 kap 1 §). Skatteverket's wording: "I vissa fall finns det skäl för en lägre avgift."
- A kontrollavgift decision can be met with begäran om omprövning or överklagande.

## 18. Proposals not yet law: prop. 2025/26:282

**Status on 2026-09-17: proposed, not adopted.** Prop. 2025/26:282 *"Effektivare kontrollmöjligheter i systemen för rot, rut, grön teknik och personalliggare"* was decided in government 4 June 2026, submitted to the riksdag 9 June 2026, bordlagd the same day, hänvisad to utskott 10 June 2026; motionstiden ends 5 October 2026. No betänkande or riksdag decision exists yet. Do not tell a client any of this binds them.

Proposed, with entry into force **1 January 2027**:
- A utförare must state in a begäran om utbetalning whether underentreprenörer or bemanningsföretag have been used for the hushållsarbete or the grön teknik installation.
- Data in a begäran om utbetalning to be submitted **på heder och samvete**.
- Skatteverket to be able to use **tredjemansföreläggande** when checking an utbetalning.
- Kontrollbesök for a new purpose, with new powers.
- Where a person has an **employer other than the näringsidkare**, data identifying that employer must be recorded in the personalliggare (new SFL 39 kap 11 a § 2 st for verksamhetslokaler; new 11 b § 2 st for byggarbetsplatser). "Arbetsgivare" = the party responsible for paying arbetsgivaravgifter and making skatteavdrag on that person's pay.
- New SFL 39 kap **12 a §**: an elektronisk personalliggare must be designed so its data **can be transferred electronically to Skatteverket**, and must be so transferred when Skatteverket asks at a kontrollbesök or requests the data for kontroll av uppgiftsskyldighet.
- Renumbering: current 39 kap 11 a-11 c §§ become 11 b-11 d §§.
- Efterbeskattning made possible following a beslut om återbetalning under the rot/rut and grön teknik förfarandelagar; kostnadsränta computed to and including the day of repayment.

Deliberate non-changes: **kontrollavgifterna are left unchanged** (section 7.6 "Oförändrade kontrollavgifter"), and mandatory electronic personalliggare in *all* verksamheter is **not** proposed (section 7.3). A new 50 kap 3 § p 3 would extend kontrollavgift to failure to meet the electronic-transfer requirement, at the same 12 500 / 25 000 kr levels.

Split transition (Lagrådet's proposed wording): the new 39 kap 11 a § 3 st, 11 b § 2 st, 11 d §, 12 a §, 17 § and 50 kap 3 § would apply only **from 1 July 2027**, and 39 kap 12 a § 2 st not to data relating to time before 1 July 2027.

## 19. Ask-the-user rules

Do not assume: ask, and say why:

1. **Cash, card, Swish or gift cards at the point of sale, or all invoiced?** The whole duty turns on this (SFL 39:4); all-invoiced means no kassaregister, only BFL documentation.
2. **Actual and expected annual kontant-/kortförsäljning incl. moms?** The 4 PBB / 236 800 kr test is forward-looking, so a forecast counts as much as last year's figure.
3. **More than one verksamhet, and are they självständiga?** 39 kap 6 § is applied per självständig verksamhet; market trading alongside a shop normally is not.
4. **Selling at torg, marknader, mässor, festivaler or temporary premises?** Not an exemption, and it changes the address printed on the kvitto.
5. **Fast driftställe in Sweden?** Changes both 39 kap 5 § p 2 and whether an EEA-tested register may be used (39 kap 8 a §).
6. **Kontrollremsa or journalminne, and which model/version?** Decides whether the XML requirement from 2027-01-01 bites and whether a new tillverkardeklaration is needed.
7. **Which of the five personalliggare industries, and what share of omsättningen in that lokal?** The 25 % / 75 % blandad-verksamhet line.
8. **Anyone verksam besides you, your spouse and children under 16?** The family exception collapses the moment someone else works there.
9. **Byggherre or subcontractor, and expected total cost on that site?** The 4 PBB byggherre threshold and the SFL 7 kap 2 a § registration duty.
10. **Anything the sources do not settle**: an unusual payment rail, a short räkenskapsår, the formal legal basis for the 2027 date: say so and send the user to Skatteverket.

## 20. Sources

All verified 2026-09-17.

- **SFL (2011:1244)**: 7 kap 1-5 §§, 39 kap 2, 4-13 §§, 42 kap 1-11 §§, 50 kap 1-7 §§, 51 kap 1 §.
- **SFF (2011:1261)**: 9 kap 1-8 §§ (certifiering, bemyndiganden, bevarandetid, personalliggarens innehåll, torg- och marknadshandel).
- **SKVFS**: 2014:9, 2014:10, 2009:2, 2016:1, 2020:9, 2020:10, 2020:11, 2021:16, 2021:17, 2021:18, 2023:13, 2025:6, 2025:8; 2015:6 and 2018:6 for personalliggare.
- **skatteverket.se**: /foretag/drivaforetag/kassaregister and sub-pages (anmälan, användning, undantag, torg- och marknadshandel, tillsyns- och kontrollbesök, för tillverkare och leverantörer); /personalliggare and sub-pages; Belopp och procent 2026.
- **riksdagen.se**: prop. 2025/26:282 and its dokumentstatus.

Skatteverket's rättslig vägledning (www4.skatteverket.se) was unreachable during verification; where only a skatteverket.se web page supports a statement, that is said explicitly above. Bokio, Fortnox, Visma, Björn Lundén and cash-register vendors were not used and must never carry a legal conclusion here.
