# Bostadsrättsförening support - research and gap analysis

Status: research, 2026-09-15, written on top of the ekonomisk förening foundation branch (`docs/research/ekonomisk-forening-support-design.md`). This is not legal advice; every rule below is cited to its primary source and must be re-verified when implementation ships.

## Executive summary

A bostadsrättsförening (BRF) is an ekonomisk förening whose purpose is to grant its members bostadsrätt in the association's buildings (BRL 1 kap. 2 §). Everything the ekonomisk förening branch delivers (juridisk-person tax mechanics, member capital under bundet eget kapital, föreningsstämma, revisor, Bolagsverket filing at seven months) carries over. What makes a BRF materially different, and why it cannot be "an ekonomisk förening with a checkbox":

1. **Tax.** An äkta BRF is a privatbostadsföretag (IL 2 kap. 17 §) and is not taxed on its property income at all (IL 39 kap. 25 §): årsavgifter, hyror and räntekostnader on the property never reach the tax base. Only capital income outside the property and non-property activities are taxed. An oäkta BRF is taxed like any ekonomisk förening plus uttagsbeskattning on below-market member fees with KU31 to members. The INK2S adjustment set is therefore the inverse of the EF branch: for an äkta BRF almost the whole result is exempt (SKV 2195 helper form, INK2S 4.3c/4.5c/4.6b/4.9/4.14a/4.17).
2. **Accounting framework.** From financial years beginning after 2025-12-31 every BRF must apply K3 (BFN decision 2025-06-16, new K3 chapter 38). K2 is closed to BRFs. Component depreciation of the building (K3 17.4 with 38.10) is mandatory, and a kassaflödesanalys is mandatory for every BRF regardless of size (ÅRL 2 kap. 1 §). Accounted's K3 document is today a "granskningsutkast" with paper filing disabled, so BRF support is a K3-quality project, not a K2 adapter.
3. **Förvaltningsberättelse.** ÅRL 6 kap. 3 a § plus K3 38.2 to 38.9 require a fixed set of nyckeltal for the year and three prior years (årsavgift per kvm, skuldsättning per kvm, sparande per kvm, räntekänslighet, energikostnad per kvm, and in K3 38.3 also nettoomsättning, soliditet, skuldsättning per kvm upplåten med bostadsrätt and årsavgifternas andel av intäkterna), a mandatory explanation of how future commitments are financed when the result is a loss, and statements on privatbostadsföretag status, tomträtt, samfällighet and underhållsplan. Several of these need data Accounted does not hold today: kvadratmeter upplåtna med bostadsrätt and hyresrätt, and the split of costs into värme, el and vatten.
4. **Equity.** Bundet eget kapital holds insatser (2083), upplåtelseavgifter (ÅRL 3 kap. 10 b § treats them as insatser; BAS has no own account so practice renames 2087) and fond för yttre underhåll (2088), which K3 38.11 to 38.12 present as their own post and move by omföring between fritt and bundet eget kapital when the stämma or stadgar-based decision is executed, never through the income statement. The inre reparationsfond is a liability to members (2892).
5. **Registers and members.** BRL 9 kap. 8 to 11 §§ require a medlemsförteckning and a lägenhetsförteckning with pantsättningar and the överlåtelseavtal attached, open to public extract. Every transfer triggers a KU55 to Skatteverket by 31 January with fields including överlåtelsepris, kapitaltillskott and the apartment's share (BRL and SFL). Fees (årsavgift, upplåtelseavgift, överlåtelseavgift, pantsättningsavgift, andrahandsupplåtelseavgift) are governed by BRL 7 kap. 14 § and the stadgar.
6. **Operations.** A BRF's revenue is avisering of årsavgifter and hyror by andelstal to every apartment, monthly or quarterly, usually with autogiro; fastighetsavgift (2026: at most 1 784 kr per bostadslägenhet, capped at 0,3 % of taxeringsvärdet) and fastighetsskatt on lokaler; VAT that is mostly exempt with taxable islands (parking to non-members, lokaler under frivillig skattskyldighet, el and solar sales).

Market size for context: about 31 000 active BRFs managing roughly 1,3 million homes (hittabrf.se statistics), most of them served by ekonomiska förvaltare (Nabo, SBC, HSB, Riksbyggen, Simpleko, Fastum) whose product is exactly the list above. That is the competitive bar for "support".

## Statutory map (primary sources)

| Area | Rule | What it requires |
|---|---|---|
| Legal form | BRL (1991:614) 1 kap. 2 §, EFL (2018:672) applies subsidiarily | A BRF is an ekonomisk förening; must be registered with Bolagsverket |
| Ekonomisk plan | BRL 3 kap.; Boverket allmänna råd 1995:6; from 2024-01-01 a teknisk underhållsplan for 50 years is attached | No upplåtelse before a plan intygad by two Boverket-approved intygsgivare is registered at Bolagsverket |
| Fees | BRL 7 kap. 14 § | Insats, årsavgift; upplåtelseavgift, överlåtelseavgift, pantsättningsavgift and andrahandsupplåtelseavgift only if the stadgar allow; andrahandsupplåtelseavgift capped at 10 % of prisbasbeloppet per year |
| Registers | BRL 9 kap. 8 § (medlemsförteckning), 9 to 10 §§ (lägenhetsförteckning: beteckning, belägenhet, rumsantal, plan registration date, bostadsrättshavare, insats; pantsättning noted at once; överlåtelseavtal attached), 11 § (public extract) | Statutory registers the association must keep and expose |
| Stadgar | BRL 9 kap. 5 § | Must state grunderna för årsavgift and for fond for underhåll of the building |
| Annual report | ÅRL 2 kap. 1 § (kassaflödesanalys for every BRF), 3 kap. 10 b § (insatser and upplåtelseavgifter as bundet eget kapital), 6 kap. 3 a § (nyckeltal; upplysning vid förlust), 8 kap. 3 § (filing within seven months, årsredovisning plus revisionsberättelse, paper) | Document content and filing |
| Framework | BFNAR 2012:1 (K3) chapter 38, BFN decision 2025-06-16; BFNAR 2023:1 for years before | K3 mandatory for financial years beginning after 2025-12-31; component depreciation (17.4, 38.10); fond för yttre underhåll as own bundet post moved by omföring (38.11 to 38.12); nettoomsättning note (38.13) |
| Nyckeltal | ÅRL 6 kap. 3 a § first paragraph 1 to 5 with BFNAR 2023:1 points 6 to 11 / K3 38.5 to 38.9 | Årsavgift per kvm upplåten med bostadsrätt; skuldsättning per kvm (räntebärande skulder / (kvm bostadsrätt + kvm hyresrätt)); sparande per kvm (justerat resultat = årets resultat + avskrivningar + utrangeringar + planerat underhåll, adjusted for non-recurring items, / total kvm); räntekänslighet (räntebärande skulder / årsavgifter); energikostnad per kvm (värme + el + vatten / total kvm); three prior years |
| Income tax | IL 2 kap. 17 § (privatbostadsföretag: at least 60 % qualified activity by taxeringsvärde-based hyresvärde), 39 kap. 25 to 27 §§ | Äkta: property income and costs are outside the tax base, ränteinkomster attributable to the property too (HFD 2013 not. 44); taxed on other capital income, non-member rentals, sideline activities; oäkta: ordinary rules plus uttagsbeskattning and KU31 |
| Declaration | Skatteverket "Deklarera åt en bostadsrättsförening"; SKV 2195 | INK2 always; äkta with only property management: page 1 fields 1.1/1.2 via SKV 2195; otherwise INK2R plus INK2S with 4.1, 4.3c, 4.5c, 4.6b (schablonintäkt on fund shares), 4.9, 4.14a, 4.15, 4.17 |
| Property tax | Lag (2007:1398) om kommunal fastighetsavgift; Skatteverket tables | 2026: max 1 784 kr per bostadslägenhet, capped at 0,3 % of taxeringsvärdet; fastighetsskatt 1 % on lokaler; the association, not the member, pays |
| VAT | ML (2023:200); Skatteverket "Moms i en ekonomisk förening eller bostadsrättsförening" | Årsavgifter and bostadshyror exempt; parking to non-members taxable at 25 % (ancillary-to-housing exception; rule change 2027-04-01); lokaler under frivillig skattskyldighet; individual metering of el is taxable; blandad verksamhet apportionment; 120 000 kr registration threshold |
| Kontrolluppgifter | SFL 22 kap.; Skatteverket KU55 guidance | KU55 for every transfer (sale, gift, arv, bodelning) by 31 January with fields 630 to 646 including överlåtelsepris, andel, förvärvsdatum och pris, kapitaltillskott (amortisation times andelstal plus special contributions), inre reparationsfond at sale and purchase, oäkta status; KU31 for oäkta member benefits |
| Filing | Bolagsverket "Årsredovisning för bostadsrättsförening"; FAR 2026-03 | Since 2025-01-01 every BRF files årsredovisning and revisionsberättelse with fastställelseintyg within seven months; paper (no digital service for föreningar); förseningsavgifter 7 500 + 7 500 + 15 000 kr; vite and liquidation risk |

## What Accounted already has

From the ekonomisk förening branch:

- Legal-form spine with capabilities (`usesInk2`, `booksCurrentTax`, `supportsCorporateTaxDispositions`, `requiresAuditorRegardlessOfSize`, `supportsMemberCapital`, `preparesArsredovisning`), föreningsstämma wording, ÅRL 6 kap. 3 § member disclosures, mandatory revisionsberättelse, seven-month Bolagsverket deadline, paper-only capabilities, member-capital templates (2083, 2084), the K2 mapper legal-form option, the owner-only legal-form correction RPC.

From the rest of the product:

- K3 machinery: `lib/bokslut/assets/k3-components.ts`, the depreciation engine, K3 noter builder, K3 equity-changes statement, `generateKassaflodesanalys` (used by the K3 document). Paper filing for K3 is disabled ("granskningsutkast") and the K3 equity statement is AB-shaped.
- Recurring invoice schedules (`lib/invoices/recurring-*`) with text rows and placeholders, e-invoice, reminders: the raw material for avisering.
- Kontrolluppgifter module (`lib/salary/ku`) for KU10/KU20/KU31: the transport for KU55 exists, the record type does not.
- Fastighetsavgift only as BAS accounts (5xxx), no calculation, no deadline.
- No member register, no apartment register, no andelstal, no pant register, no autogiro (BG Autogiro / Bankgirot) integration.

## Gap analysis by module

Sizes: S (days), M (weeks), L (a quarter of one engineer). Order follows legal weight and dependency.

### 1. Legal form and tax profile (M)

- Add `bostadsrattsforening` as a fifth `EntityType`. The exhaustive `byEntityType` dispatch forces every site to answer; the answers are those of an ekonomisk förening except: `booksCurrentTax` depends on äkta/oäkta, `supportsAccountingFramework` is K3-only for years beginning after 2025-12-31, K2 allowed before.
- A per-company tax profile `privatbostadsforetag: boolean | null` re-assessed yearly (IL 2 kap. 17 § is assessed per taxation year from the latest taxeringsvärde). The year-end wizard must refuse to close the tax step while it is null.
- Registry mapping: Bolagsverket reports "Bostadsrättsförening"; map only that exact spelling (BRF is the only kind of ekonomisk förening whose name must contain "bostadsrättsförening", BRL 9 kap. 6 §, verify).

### 2. Chart of accounts and booking templates (S to M)

- Seed: 2083 Insatser, 2087 renamed Upplåtelseavgifter (document the deviation from the BAS label, as `form-accounts.ts` does for 3901), 2088 Fond för yttre underhåll, 2091/2099, 2892 Inre reparationsfond (liability), 3011 to 3014 hyror (bostäder, lokaler, garage, p-platser), 3020/3021 årsavgifter (bostäder, lokaler), 3030-series övriga avgifter (överlåtelse-, pantsättnings-, andrahandsavgifter), 4xxx or 5xxx fastighetskostnader split so energikostnad (värme, el, vatten) can be summed for the nyckeltal, 5xxx fastighetsskatt/avgift, 1110/1119 byggnad with component sub-accounts (1111 stomme, 1112 fasad, 1113 tak, 1114 stammar, 1115 installationer), 1130 mark.
- Templates: årsavgift received (per apartment, exempt), hyra lokal with and without frivillig skattskyldighet, parkering (taxable to non-members), insats and upplåtelseavgift received, överlåtelse- and pantsättningsavgift, fastighetsavgift payment, avsättning to and ianspråktagande of fond för yttre underhåll (omföring 2091 to 2088 and back, K3 38.12, never through RR), inre fond movements.

### 3. Members, apartments, andelstal (L, the statutory core)

- Tables: `brf_apartments` (beteckning, belägenhet, rumsantal, kvm, upplåten med bostadsrätt or hyresrätt, andelstal for årsavgift and for kapitaltillskott, insats, upplåtelseavgift, plan registration date), `brf_members` (person or company, admission and exit, share of apartment), `brf_ownership_history` (append-only transfers with agreement copy reference, price, date, kind: sale, gift, arv, bodelning), `brf_pledges` (pantsättning notices, creditor, date, released date), `brf_inre_fond` balances per apartment.
- Outputs: medlemsförteckning and lägenhetsförteckning extracts (BRL 9 kap. 11 §), mäklarbild (the standard broker information sheet), KU55 file per transfer, the seven-year retention of agreements (WORM via `document_attachments`).
- This is the same bounded context the ekonomisk förening design deferred (section 5), now with apartments as the unit. It is the largest piece and the one förvaltare compete on.

### 4. Avisering and payments (L)

- Periodic fee runs: generate one avi per apartment per period from årsavgift by andelstal plus individual items (parking, förråd, individually metered el with VAT, överlåtelse- and pantsättningsavgift), with OCR, Bankgirot Autogiro (BG Autogiro file exchange for medgivanden and dragningar), e-faktura to members, reminders and dröjsmålsränta, and the member ledger (kundreskontra per apartment). The recurring-invoice schedules are a starting point but the unit of billing is the apartment, not a customer.
- Bookkeeping: årsavgifter to 3020/3021, exempt; taxable islands per ML with VAT codes; a fee change decided by the board applies from a date and must be re-assessed across all open avis.

### 5. Year-end closing and tax (M)

- Äkta BRF: the INK2 engine must produce the SKV 2195 result (property income and costs excluded, remaining capital income taxed at 20,6 %), or with activities the INK2R/INK2S set with 4.5c/4.3c for the exempt block, 4.6b schablonintäkt on fund shares, 4.9 and 4.17 for depreciation differences; bolagsskatt proposal only on the taxable residue; periodiseringsfond still allowed on the taxable part.
- Oäkta BRF: EF rules plus uttagsbeskattning (difference between market rent and member fee as income) and KU31 per member.
- Fastighetsavgift and fastighetsskatt: a per-year computation from taxeringsvärde and antal bostadslägenheter with the indexed cap (2026: 1 784 kr), booked as cost and as a kvarskatt-relevant item; a deadline in the tax calendar; the INK2 field.
- Fond för yttre underhåll: a year-end step that proposes the avsättning from the stadgar rule or the underhållsplan, posts the omföring after the stämma decision, and validates that ianspråktagande does not exceed the fund.

### 6. K3 annual report for BRF (L)

- Make the K3 document fileable on paper: today it is a draft. Needs the BRF equity presentation (insatser, upplåtelseavgifter, fond för yttre underhåll as own bundet posts; balanserat resultat and årets resultat), the K3 equity-changes statement generalised from aktiekapital to member capital, and the mandatory kassaflödesanalys (indirect or direct, BFNAR 2023:1 18 to 19).
- Förvaltningsberättelse per K3 38.2 to 38.9: privatbostadsföretag status, tomträtt with avgäld dates, samfällighet, underhållsplan present or not, the nyckeltal table for four years with the exact definitions above, upplysning vid förlust, and the note splitting nettoomsättning (38.13). Requires new company facts: kvm upplåten med bostadsrätt and hyresrätt, and a stable mapping of accounts to värme, el and vatten.
- Component depreciation: the asset register must hold the building as components with separate useful lives (K3 17.4, 38.10), and the K3 transition ingångsbalansräkning that allocates the carrying amount to components (BFN transition guidance) for every BRF migrating from K2 in 2026.

### 7. VAT (M)

- Blandad verksamhet: proportional input VAT for BRFs with taxable parking or lokaler, jämkning on investment goods, frivillig skattskyldighet registration per lokal, the 2027-04-01 parking change, and the 120 000 kr registration threshold check. The existing VAT module is turnover-driven; a BRF profile needs the apportionment key.

### 8. Deadlines and calendar (S)

- Reuse the ekonomisk förening rules (INK2, seven-month filing, föreningsstämma) plus KU55 by 31 January, fastighetsavgift with INK2, the stämma window for adopting årsavgifter, and the ekonomisk plan re-registration trigger when new upplåtelser occur.

### 9. Migration and onboarding (M)

- Most BRFs come from a förvaltare with SIE4 exports and an apartment register in Excel; the import must map their chart (3011 to 3021 conventions vary) and load apartments, members and andelstal. The 2026 K2 to K3 transition (ingångsbalansräkning, component allocation) is itself an onboarding step for the whole market.

## Recommended sequencing

1. Ship the ekonomisk förening branch first: everything in it is a prerequisite and none of it changes for a BRF.
2. Phase B1: legal form, äkta/oäkta profile, chart, templates, fond för yttre underhåll omföring, KU55 on a minimal apartment register, fastighetsavgift calculation, deadlines. This makes a small self-managed BRF bookable and declarable and lets an accountant do the rest.
3. Phase B2: K3 document to fileable quality with the BRF förvaltningsberättelse, nyckeltal and kassaflödesanalys. This is the 2026 regulatory forcing function and the reason a BRF would switch tools now.
4. Phase B3: avisering with autogiro and the member ledger, the full registers, mäklarbild. This is the förvaltare product; only worth building if Accounted wants to compete with Nabo and SBC rather than serve the accountant of a BRF.

## Open questions for the founder

- Is the target the BRF's accountant (B1 plus B2) or the BRF itself (B3 as well)? The register and avisering modules are a different product surface from bookkeeping.
- K3 quality: the K3 document is a draft today. BRF support means committing to K3 for real, which also benefits every fastighetsbolag that must leave K2 in 2026.
- Data the product does not hold (kvm, taxeringsvärde, component split, andelstal): imported from the förvaltare or entered once in onboarding?

## Sources

- BFN, "Kompletterande regler för bostadsrättsföreningar": https://www.bfn.se/kompletterande-regler-for-bostadsrattsforeningar/
- BFNAR 2023:1 (full text): https://bfn.se/wp-content/uploads/bfnar2023-1-grund.pdf
- BFN, "Ändringar i K2 och K3 från 2026": https://www.bfn.se/fragor-och-svar/andringar-i-k2-och-k3-fran-2026/
- BFN, "Ändringar i K3": https://www.bfn.se/andringar-i-k3-arsredovisning-och-koncernredovisning/
- BFN, "Vad ska en bostadsrättsförening tänka på vid bytet till K3?": https://www.bfn.se/vad-ska-en-bostadsrattsforening-tanka-pa-vid-bytet-till-k3/
- BFN, draft K3 chapter 38 (Dnr 2022:51, bilaga 2): https://www.bfn.se/wp-content/uploads/remiss-informationsinnehall-brfs-arsredovisning-1.pdf
- BFN, "Bostadsrättsföreningar" (regelverk): https://www.bfn.se/redovisningsregler/vad-galler-for/bostadsrattsforeningar/
- Bostadsrättslag (1991:614): https://lagen.nu/1991:614
- Årsredovisningslag (1995:1554): https://lagen.nu/1995:1554
- Prop. 2021/22:171 Tryggare bostadsrätt: https://www.riksdagen.se/sv/dokument-och-lagar/dokument/proposition/tryggare-bostadsratt_h903171/html/
- Inkomstskattelag (1999:1229) via Riksdagen: https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/inkomstskattelag-19991229_sfs-1999-1229/
- HFD 2013 not. 44 (ränteinkomster i privatbostadsföretag): https://lagen.nu/dom/hfd/2013/not/44
- Skatteverket, "Deklarera åt en bostadsrättsförening": https://www.skatteverket.se/foreningar/deklarera/deklareraatenbostadsrattsforening.4.7eada0316ed67d7282c965.html
- Skatteverket, "Lämna kontrolluppgift om försäljning av bostadsrätt (KU55)": https://www.skatteverket.se/foreningar/driva/ekonomiskforeningellerbostadsrattsforening/lamnakontrolluppgiftomforsaljningavbostadsrattku55.4.8dcbbe4142d38302d75da1.html
- Skatteverket, "Moms i en ekonomisk förening eller bostadsrättsförening": https://www.skatteverket.se/foreningar/driva/ekonomiskforeningellerbostadsrattsforening/momsienbostadsrattsforeningellerekonomiskforening.4.6e8a1495181dad5408496b.html
- Skatteverket, "Fastighetsavgift och fastighetsskatt": https://www.skatteverket.se/privat/fastigheterochbostad/fastighetsavgiftochfastighetsskatt.4.69ef368911e1304a625800013531.html
- Bolagsverket, "Föreningar måste skicka in sin årsredovisning" (2025): https://bolagsverket.se/omoss/nyheter/nyhetsarkiv/nyhetsarkiv2025/nyhetsarkiv2025/obligatorisktforforeningarattlamnainsinarsredovisningtillbolagsverket.5514.html
- Bolagsverket, årsredovisningsguide för bostadsrättsförening: https://bolagsverket.se/forening/bostadsrattsforening/arsredovisningforbostadsrattsforening/arsredovisningsguidenforbostadsrattsforening.1473.html
- Bolagsverket, ekonomisk plan: https://bolagsverket.se/forening/bostadsrattsforening/startabostadsrattsforening/ekonomiskplanforbostadsrattsforening.1445.html
- Boverket, ekonomiska planer: https://www.boverket.se/sv/ekonomiska-planer/introduktion/bostadsrattsforeningar/
- FAR, "Ekonomiska föreningar ska lämna in handlingar till Bolagsverket" (2026-03): https://www.far.se/aktuellt/nyheter/2026/mars/alla-ekonomiska-foreningar-ska-lamna-in-handlingar-till-bolagsverket/
- FAR Online, "Fond för yttre underhåll": https://www.faronline.se/dokument/rattserien/redovisa-ratt/f/rr_fondforyttreunderhall/
- FAR Online, "Medlemsinsatser och andra avgifter, bostadsrättförening": https://www.faronline.se/dokument/rattserien/redovisa-ratt/m/rr_medlemsinsatserochandraavgifterbostadsrattforening/
- Bostadsrätterna, "Avgifter till föreningen": https://www.bostadsratterna.se/kunskapsbanken/a/avgifter-till-foreningen
- Hittabrf.se, aktiva bostadsrättsföreningar: https://www.hittabrf.se/faktaaktiva.asp

## Implementation status (2026-09-15, annual report package of the bostadsrättsförening PR)

Shipped, stacked on the BRF foundation commit:

- Förvaltningsberättelse per ÅRL 6 kap. 3 a § and BFNAR 2012:1 kapitel 38 for both templates: the 38.2 statements (privatbostadsföretag from the year's `brf_tax_profiles` row, tomträtt with giltighetstid and avgäldsperiod, samfällighet, underhållsplan from `brf_property_facts`), the nyckeltal table for the year and up to three prior years (38.3-38.9, `lib/bokslut/arsredovisning/brf-nyckeltal.ts`, definitions and account ranges documented there and printed under the table), the loss disclosure of 6 kap. 3 a § andra stycket, and the 38.13 note splitting nettoomsättning.
- Migration `20260915172000`: `loss_financing_explanation`, `planerat_underhall_override`, `sparande_adjustment`, `energikostnad_vidaredebiterad` on `arsredovisning_narratives`; `tomtratt_expires_on`, `kvm_lokaler_bostadsratt` on `brf_property_facts`. Editable in the årsredovisning narrative page (BRF block) and through the property-facts route.
- Kassaflödesanalys under K2 for the form (ÅRL 2 kap. 1 § andra stycket) and the fond för yttre underhåll as its own post with omföringar in the K3 equity statement (38.11-38.12).
- Completeness: AR-BRF-FACTS-MISSING, AR-BRF-TAX-PROFILE-MISSING, AR-BRF-LOSS-EXPLANATION, AR-BRF-KASSAFLODE (errors) and AR-BRF-COMPONENTS (warning).

Deliberately not in this package: a UI page for the property facts (API only), the K3 transition ingångsbalansräkning with component allocation for BRFs leaving K2 in 2026 (section 6, third bullet), narrative overrides for prior years (the current year's figures only), and the K3 document's general "granskningsutkast" status (AR-K3-DRAFT-ONLY still applies to every K3 report).
