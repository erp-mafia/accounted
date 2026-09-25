---
areas: [moms, fakturering]
---

# Momsfri vård, tandvård och skönhet: VAT Exemption Reference

Scope: healthcare clinics, dental practices, physiotherapists, psychologists, naprapaths, chiropractors and beauty/aesthetic salons operating in Sweden. This file decides **whether a supply is exempt**. General VAT mechanics (periods, deadlines, rutor, reverse charge, BAS 26xx, jämkning formulas) live in **`swedish-vat`**: do not restate them here. Input-VAT splitting for a clinic with both exempt and taxable revenue lives in **`blandad-verksamhet-vard.md`**.

**Legal position stated: 2026.** ML (2023:200) is used in its consolidated form t.o.m. SFS 2026:1025; PSL (2010:659) t.o.m. SFS 2026:1551. 10 kap. 6-14 §§ ML and 4 kap. 1 § PSL were **not amended for 2026** and carry their 2023 and 2018:1996 wording respectively. Nothing in the exemption rules is announced for 2027 as of 2026-09-17. See the Sources section for what was checked and when.

**Osäkert: source access.** Skatteverket's *Rättslig vägledning* (www4.skatteverket.se/rattsligvagledning) rejected every automated request on 2026-09-17 ("Request Rejected"), and the Internet Archive was offline. Where this file needs a Skatteverket position, it cites the publicly reachable pages on skatteverket.se instead, and flags anything that could only be found in Rättslig vägledning or in a ställningstagande as Osäkert rather than substituting a secondary source.



## Table of contents

1. [Where the exemption lives in ML 2023:200](#1-where-the-exemption-lives-in-ml-2023200)
2. [What "sjukvård" requires: the two routes](#2-what-sjukvård-requires-the-two-routes)
3. [Legitimerade yrken (PSL 2010:659 4 kap. 1 §)](#3-legitimerade-yrken-psl-2010659-4-kap-1-)
4. [Medical purpose versus aesthetic purpose](#4-medical-purpose-versus-aesthetic-purpose)
5. [Uthyrning av vårdpersonal](#5-uthyrning-av-vårdpersonal)
6. [Adjacent services](#6-adjacent-services)
7. [Sales of goods in a clinic or salon](#7-sales-of-goods-in-a-clinic-or-salon)
8. [Master decision table](#8-master-decision-table)
9. [Booking patterns (BAS 2026)](#9-booking-patterns-bas-2026)
10. [Error patterns and ask-the-user rules](#10-error-patterns-and-ask-the-user-rules)

---

## 1. Where the exemption lives in ML 2023:200

The rules moved on 1 July 2023. Old **ML 1994:200 3 kap. 4-5 §§** is dead law: never cite it, and treat any client memo, template or software VAT code that references it as untested.

| Paragraph (ML 2023:200) | Content |
|------|------|
| 10 kap. 6 § | The exemption itself: *"Från skatteplikt undantas tillhandahållanden av sjukvård eller tandvård."* |
| 10 kap. 7 § | Definition of **sjukvård**: the medical-purpose test, the facility/legitimation test, sjuktransporter (2 st), medicinskt betingad fotvård (3 st) |
| 10 kap. 8 § | Definition of **tandvård**: measures to prevent, investigate or treat sjukdomar, kroppsfel och skador **i munhålan** |
| 10 kap. 9 § | Ancillary goods and services supplied **by the care provider** as *ett led i* the care, plus kontroller och analyser av prov |
| 10 kap. 10 § | Carve-outs that stay **taxable**: glasögon and other synhjälpmedel, goods supplied by apotekare/receptarie, veterinary care |
| 10 kap. 11 § | **Dentaltekniska produkter** and services on them: exempt only when supplied by a tandläkare or tandtekniker |
| 10 kap. 12 § | Modersmjölk, blod och organ från människor |
| 10 kap. 13 § | Läkemedel to hospitals or dispensed on prescription |
| 10 kap. 14 § | **Social omsorg**: barnomsorg, äldreomsorg, stöd/service till vissa funktionshindrade och annan jämförlig social omsorg, plus ancillary supplies |

Exempt supplies give **no right to deduct input VAT** (ML 13 kap. 6 §: deduction only *"i den utsträckning ... använder varorna och tjänsterna för sina beskattade transaktioner"*). That is why the exemption is a cost, not a benefit, and why section 4 below decides the economics of an aesthetic clinic.

EU basis: Article 132.1 b (hospital and medical care by public or recognised bodies) and 132.1 c (medical care by medical/paramedical professionals as defined by the member state) of Directive 2006/112/EG. HFD reads ML 10 kap. 7 § in conformity with those articles.

---

## 2. What "sjukvård" requires: the two routes

ML 10 kap. 7 § first paragraph: sjukvård means *åtgärder för att medicinskt förebygga, utreda eller behandla sjukdomar, kroppsfel och skador samt mödra- och förlossningsvård*, **if** the measure either

1. **Route A: facility:** is taken at a hospital or other inrättning drivet av det allmänna, or, within private business, at an **inrättning för sluten vård**; or
2. **Route B: legitimation:** is otherwise taken by someone with **särskild legitimation att utöva yrke inom sjukvården**.

Two things must hold at once, and agents get this wrong in both directions:

- **Purpose test** (a medical purpose in the HFD/EU sense: see section 4), **and**
- **Performer/place test** (Route A or Route B).

A legitimerad läkare doing a purely cosmetic injection fails the purpose test → taxable. A hudterapeut treating a diagnosed skin disease in an open-care salon fails the performer test (no legitimation, not sluten vård) → taxable. Private **open** care is only ever exempt via Route B; "inrättning för sluten vård" means in-patient facilities, not an ordinary mottagning.

Also exempt without meeting the purpose test:

- **Sjuktransporter** with vehicles specially fitted for the purpose (10 kap. 7 § 2 st): ambulances, not ordinary taxi/patient transport.
- **Medicinskt betingad fotvård** is equated with sjukvård (10 kap. 7 § 3 st), without any condition on who performs it or where. Ordinary pedicure is not.
- **Kontroller och analyser av prov** taken as a step in the care (10 kap. 9 § 1 st 2).

---

## 3. Legitimerade yrken (PSL 2010:659 4 kap. 1 §)

Twenty-two professions carry legitimation. Socialstyrelsen issues it (PSL 4 kap. 10 §).

| # | Yrke | # | Yrke |
|---|------|---|------|
| 1 | apotekare | 12 | naprapat |
| 2 | arbetsterapeut | 13 | optiker |
| 3 | audionom | 14 | ortopedingenjör |
| 4 | barnmorska | 15 | psykolog |
| 5 | biomedicinsk analytiker | 16 | psykoterapeut |
| 6 | dietist | 17 | receptarie |
| 7 | fysioterapeut | 18 | röntgensjuksköterska |
| 8 | hälso- och sjukvårdskurator | 19 | sjukhusfysiker |
| 9 | kiropraktor | 20 | sjuksköterska |
| 10 | logoped | 21 | tandhygienist |
| 11 | läkare | 22 | tandläkare |

Rules that follow from the list:

- **Undersköterska is not legitimerad.** Since 1 July 2023 it is a *skyddad yrkestitel* (PSL 4 kap. 5 a §). A sole-trading undersköterska selling care in open care does **not** get Route B.
- **Massör, hudterapeut, personlig tränare, kostrådgivare, akupunktör, osteopat** are not on the list. Their services are taxable unless they also hold one of the 22 legitimations and act in that capacity. A **fotvårdsterapeut** is likewise not legitimerad, but *medicinskt betingad fotvård* is equated with sjukvård by 10 kap. 7 § 3 st regardless of who performs it: see the fotvård row below.
- **Naprapat and kiropraktor are legitimerade** (nos. 9 and 12): their treatment of sjukdomar, kroppsfel och skador is exempt. A *non-legitimerad* naprapat/kiropraktor (title used without legitimation) is taxable. Always verify in Socialstyrelsen's register of legitimerad hälso- och sjukvårdspersonal (HOSP) and keep the printout.
- **Fysioterapeut** (formerly sjukgymnast) is legitimerad; "personlig tränare" in the same studio is not.
- **Ortopedingenjör** is legitimerad, but Skatteverket states that an ortopedingenjör's sale of goods and services **in their own business is nevertheless taxable** (skatteverket.se, *Momssatser och undantag från moms*). Treat this as an exception to Route B.
- Legitimation of a **company** does not exist. The test attaches to the individual performing the measure; the invoicing entity can be an AB as long as the measure is taken by a legitimerad person (or at a Route A facility).

---

## 4. Medical purpose versus aesthetic purpose

This single boundary generates more errors than everything else in the file combined.

### The governing case

**HFD 2013 ref. 67** (2013-09-24, mål 4461-10, PFC Clinic AB), decided after the EU preliminary ruling in **C-91/12 PFC Clinic** (EU:C:2013:198):

> ML's sjukvård exemption applies only to *"sådana medicinska åtgärder som utförs i syfte att diagnostisera, tillhandahålla vård för och bota sjukdomar eller hälsoproblem eller i syfte att skydda, upprätthålla eller återställa människors hälsa. Sådana estetiska operationer och behandlingar som utförs med annat syfte omfattas inte av undantaget."*

HFD added that the legitimation condition was met in that case, and that the burden fell on the clinic: because the investigation did not show **to what extent** each treatment had the required purpose, the case was sent back to Skatteverket to set the deductible amount. The practical lesson is that **the clinic that cannot document purpose per treatment loses**. C-91/12 point 29 is the operative sentence: *ingrepp som utförs av rent kosmetiska skäl* are outside both 132.1 b and 132.1 c. Purely subjective patient perception of the procedure is not enough; the purpose must be medically grounded.

The exemption is also read restrictively (C-307/01 *d'Ambrumenil*, referenced by the Swedish courts in the PFC chain), and the forarbeten to the original ML said the exemption should not reach *skönhetsvård, allmän rekreation och dylikt* (prop. 1989/90:111 s. 106 f.).

### Assessment unit

**Per treatment and per patient, not per clinic and not per practitioner.** The same doctor, on the same day, in the same room, can perform an exempt and a taxable botox injection. Build the booking system so that the VAT code is set on the treatment line, from the clinical indication: never defaulted from the clinic's org type.

### Treatment-by-treatment guidance

| Treatment | Exempt when | Taxable when |
|------|------|------|
| **Botulinumtoxin (botox)** | Treating a diagnosed condition: kronisk migrän, hyperhidros, spasticitet, blefarospasm, bruxism with documented indication, performed by legitimerad personal | Glabellar lines, crow's feet, "preventive" wrinkle treatment, any purely cosmetic indication |
| **Fillers (hyaluronsyra m.m.)** | Reconstructive use after sjukdom, skada eller medfött kroppsfel (e.g. lipoatrofi, defekt efter trauma/tumöroperation) | Lip augmentation, cheek/jawline contouring, general rejuvenation |
| **Laser / IPL** | Treatment of a diagnosed skin disease, ärr or vascular malformation on medical indication by legitimerad personal | Permanent hårborttagning, hudföryngring, cellulitbehandling and similar appearance-driven treatments. These were the treatments at issue in HFD 2013 ref. 67; the court did not rule them taxable as such, it set the purpose test and remitted the case because the evidence did not show to what extent a medical purpose existed |
| **Plastikkirurgi** | Rekonstruktiv kirurgi following sjukdom, skada eller medfött kroppsfel (bröstrekonstruktion efter cancer, ärrkorrektion, korrigering av funktionsnedsättande deformitet); bröstreduktion or ögonlocksplastik where there is a documented medical indication (ryggbesvär, synfältspåverkan) | Bröstförstoring, bukplastik, fettsugning, ansiktslyft, pannlyft, öronplastik and näsplastik done for appearance: the list of procedures in HFD 2013 ref. 67 |
| **Hudvård / ansiktsbehandling** | Essentially never: hudterapeut lacks legitimation, so Route B fails even for a medical-sounding indication | Default: 25 % |
| **Tandblekning / kosmetisk tandvård** | Only where the measure treats sjukdom, kroppsfel eller skada i munhålan (ML 10 kap. 8 §): e.g. missfärgning efter rotbehandling of a damaged tooth | Bleaching and veneers for appearance, smycken, kosmetisk tandsmyckning |
| **Medicinsk fotvård** | Diabetesfotvård and other medically motivated fotvård (ML 10 kap. 7 § 3 st) | Kosmetisk pedikyr, nagelvård |

### Evidence that supports a medical purpose

Skatteverket and the courts look for contemporaneous clinical documentation, not for the invoice text. Keep, per treatment:

1. **Journalanteckning** naming diagnosis or clinical indication (ICD-10 where used).
2. **Remiss or referral** from another vårdgivare, where one exists.
3. The **legitimation** of the performer (HOSP printout, dated).
4. Evidence of the **payer** where relevant: a region or Försäkringskassan paying supports medical purpose but does not by itself create it.
5. For borderline aesthetic work, a short **indikationsbedömning** signed by the legitimerad performer, made *before* treatment.

Marketing material is evidence too, and it cuts against the taxpayer: a clinic whose price list sells "föryngring" and whose journal says "migrän" has a problem. Flag inconsistency between price list and journal to the user.

**Ask the user** whenever a treatment line is coded exempt and any of the following holds: the treatment appears in the taxable column above; there is no diagnosis in the source data; the performer's legitimation is unverified; or the same treatment code has been booked both exempt and taxable in the same period without a documented reason.

---

## 5. Uthyrning av vårdpersonal

### The change in practice

**HFD 2018 ref. 41** (2018-06-07, mål 7270-17, Medcura AB) held that a **bemanningsföretag's letting of care staff is not exempt**. The court noted that the old lagen (1968:430) om mervärdeskatt had an express provision covering a subcontractor performing care for a vårdgivare, that **no equivalent provision exists in the current ML**, and that Skatteverket's earlier practice of exempting staffing rested on förarbetsuttalanden (prop. 1991/92:122 s. 8) rather than on the statute. The supply the staffing company makes is **personaluthyrning**, a taxable service, regardless of whether the individual hired out performs measures that would be sjukvård in the patient's hands.

Consequence: from the ruling onward, staffing of doctors, nurses, physiotherapists and dentists into someone else's clinic is **taxable at 25 %**, and the receiving clinic: whose own output is exempt, cannot deduct that VAT. This is the single largest cost shock in the sector and the reason clinics restructure toward vårdavtal.

**Osäkert:** Skatteverket followed the ruling with a ställningstagande and, later, a statement on the date from which the changed practice was applied. Neither the diarienummer nor the tillämpningstidpunkt could be confirmed from a primary source on 2026-09-17: Skatteverket's *Rättslig vägledning* and ställningstagande archive rejected automated access, and the Internet Archive was offline. Do not state a transition date from memory. Look both up on skatteverket.se before relying on them in an omprövning of any period between the ruling (2018-06-07) and the date the clinic actually started charging VAT.

### What Skatteverket applies today

Skatteverket, *Vårdföretag och personaluthyrning* (skatteverket.se), states it plainly:

> *"Vårdtjänster är undantagna från momsplikt. Uthyrning av vårdpersonal är däremot inte en tjänst som i sig utgör sjukvård. Därför ska du som arbetar som inhyrd vårdpersonal ta ut moms på dina tjänster."* ... *"Du ska däremot inte ta ut moms när du tillhandahåller vård direkt till dina patienter i egen regi, under eget ansvar. Det innebär att du måste ha en egen organisatorisk struktur och att du inte får tillhöra någon annan vårdmottagning. Det ska alltid vara tydligt för patienterna att det är din egen vårdmottagning som tillhandahåller vården."*

### Hyra av personal versus vård under eget ansvar

| Indicator | Points to **taxable personaluthyrning** | Points to **exempt vård i egen regi** |
|------|------|------|
| Who is the patient's motpart | The clinic that engaged the consultant | The consultant's own mottagning |
| Organisatorisk struktur | Uses the hirer's premises, equipment, staff and journal system as an integrated part of the hirer's unit | Own organisational structure: own or separately contracted premises, own equipment, own or own-controlled personnel |
| Pricing basis | Per hour, per shift, per jourpass | Per patient, per treatment, per capitation |
| Who selects and books patients | The hirer | The consultant's own mottagning |
| Clinical and patient-safety responsibility | Rests with the hirer as vårdgivare | Rests with the consultant as vårdgivare (own IVO registration, own patientförsäkring) |
| What the patient is told | Patient believes they are treated by the hirer's clinic | It is clear to the patient that the consultant's own mottagning provides the care |
| Substitution | The staffing party may send another qualified person | The named vårdgivare must perform |

When the indicators point in both directions, the decisive questions are **who is the patient's counterparty** and **whether an own organisational structure exists**. Vaguely drafted "konsultavtal" that in substance transfer a person into the hirer's line organisation are personaluthyrning even if titled otherwise.

**Ask the user** before coding a subcontracting practitioner's invoice exempt: is the practitioner registered with IVO as vårdgivare in their own right; does the patient contract with them; who owns the journal; how is the fee calculated; who carries the patientförsäkring.

### Consequences to raise with the client

- The 25 % becomes a **real cost** to the receiving exempt clinic. Compare a vårdavtal (exempt supply of care to the region/clinic) against personaluthyrning before signing.
- The letting practitioner crosses the VAT registration threshold quickly. The threshold for 2026 is **120,000 SEK årsomsättning inom landet**, and it must also not have been exceeded in either of the two preceding calendar years (ML 18 kap. 4 §, Lag 2024:942, in force 1 January 2025 and unchanged for 2026). See `swedish-vat` for the period and deadline rules.
- A clinic that both treats patients and hires out staff is **blandad verksamhet**: see `blandad-verksamhet-vard.md`.

---

## 6. Adjacent services

| Service | VAT treatment | Basis / note |
|------|------|------|
| **Intyg och utlåtanden**: körkortsintyg, pensionsintyg, försäkringsintyg, intyg till arbetsgivare | **25 %** | Skatteverket lists *bedömningar och utlåtanden i exempelvis körkorts- och pensionsfrågor* as taxable. The purpose is to inform a third party's decision, not to protect health (cf. C-307/01 d'Ambrumenil) |
| **Sjukintyg / läkarintyg issued as part of an ongoing treatment episode** | Exempt | Ancillary to the exempt care under ML 10 kap. 9 §, provided it is genuinely *ett led i* the care and not a standalone certificate product |
| **Företagshälsovård** | **Split** | Skatteverket: hälsoundersökningar and vaccinations can be exempt sjukvård; *stora delar av det förebyggande arbetsmiljöarbetet*: ergonomi, föreläsningar, arbetsmiljökartläggning, is taxable at 25 %. Price and invoice the components separately |
| **Vaccinationer** | Exempt when performed by legitimerad personal or at a Route A facility | Listed by Skatteverket as an example of sjukvård. Travel vaccination given by a sjuksköterska in a clinic is exempt; a pharmacy's sale of the vaccine as a good is not (ML 10 kap. 10 § 2) |
| **Allmän hälsoundersökning** | Exempt | Listed by Skatteverket as sjukvård |
| **Massage** | **25 %** by default | Exempt only where it treats a diagnosed sjukdom/skada **and** is given at a Route A facility or by a legitimerad person (typically fysioterapeut/naprapat). Massage *för muskelavslappning och ökat välbefinnande* is taxable |
| **Naprapati / kiropraktik** | Exempt when performed by a **legitimerad** naprapat/kiropraktor treating sjukdom, kroppsfel eller skada | PSL 4 kap. 1 §, nos. 9 and 12. Verify legitimation in HOSP: the titles are used by non-legitimerade practitioners |
| **Psykoterapi / samtalsstöd** | Exempt when given by legitimerad psykolog or legitimerad psykoterapeut (or leg. läkare) | Skatteverket lists *samtalsstöd vid relationsstörningar* as sjukvård. Coaching, "mental träning" and unlicensed counselling are taxable |
| **Personlig träning, friskvård, rekreation** | Never exempt | Skatteverket lists *allmän rekreation och friskvård* as taxable in the vård context. The rate is then **not automatically 25 %**: Skatteverket's 2026 rate guidance puts **6 %** on *aktiviteter i form av idrott eller fysisk träning som utövas i Riksidrottsförbundets medlemsförbund*, on styrketräning, jazzdans, aerobics, workout och kampsporter as a separate item, and on entréavgift till idrottsevenemang och deltagaravgifter till idrottstävlingar. A gym pass or a group class is 6 %; a PT hour sold as a personal service, and massage for wellbeing, are 25 %. Decide the rate per activity and see `swedish-vat` for the full rate table |
| **Kostrådgivning** | **25 %** for general weight-loss advice; exempt only when it treats a diagnosed sjukdom/skada and Route A or B is met (a legitimerad dietist is on the list) | Skatteverket's own distinction |
| **Alternativvård**: aromaterapi, healing, rosenterapi, zonterapi | **25 %** | Skatteverket lists these as taxable regardless of how they are described |
| **Tandtekniskt arbete** | Exempt when the **dentaltekniska produkt** or the service on it is supplied by a **tandläkare or tandtekniker** | ML 10 kap. 11 §. A dental lab run by a tandtekniker invoices the dentist without VAT. A trading company with no tandtekniker performing the work does not qualify |
| **Tandvårdsprodukter sold over the counter**: tandborstar, tandtråd, munsköljmedel | **25 %** | Skatteverket lists them expressly as taxable |
| **Vård av djur** | **25 %** | ML 10 kap. 10 § 3 |
| **Social omsorg** | Exempt | ML 10 kap. 14 §. But separately sold **servicetjänster**: städning, tvätt, matlagning, inköp, are 25 % per Skatteverket |

---

## 7. Sales of goods in a clinic or salon

Start from ML 10 kap. 9 §: goods supplied **by the care provider** are exempt only if the supply is *ett led i* the exempt care. That is a narrow test: the good must be an integral, subordinate part of the treatment actually given, not a retail sale to the same person.

| Item | Treatment |
|------|------|
| **Material consumed in the treatment**: suturer, bedövning, förband, engångsinstrument, the filler/toxin itself in an exempt treatment | Exempt as part of the care (10 kap. 9 §). No separate revenue line |
| **Hudvårdsprodukter, schampo, kosttillskott sold to take home** | **25 %.** Retail sale, not *ett led i* care, even when recommended by the practitioner and sold in the same room |
| **Glasögon och andra synhjälpmedel** | **25 %, always**: ML 10 kap. 10 § 1 makes this taxable *även om leveransen görs som ett led i tillhandahållandet av sjukvård*. An optiker's eye examination can be exempt while the spectacles sold in the same transaction are taxable. Split the invoice |
| **Kontaktlinser and lens fluids** | Treat as synhjälpmedel → 25 %. **Osäkert:** the statute names *glasögon eller andra synhjälpmedel* without listing lenses; no primary Skatteverket text confirming contact lenses was reachable. Confirm before applying to a large optician client |
| **Hörapparater** | Standalone retail sale: 25 %. Where the audionom supplies and fits the device as an integral part of an exempt utprovning, ML 10 kap. 9 § can reach it. **Osäkert**: no primary source confirming Skatteverket's position on hörapparater was reachable; get a written position or a förhandsbesked for a client with material volume |
| **Läkemedel** | Exempt when delivered to a hospital or dispensed on prescription (10 kap. 13 §). Goods supplied by an **apotekare or receptarie** are taxable (10 kap. 10 § 2). Naturläkemedel and OTC products sold in a clinic: 25 % |
| **Dentaltekniska produkter** (kronor, broar, bettskenor) | Exempt when supplied by tandläkare or tandtekniker (10 kap. 11 §) |
| **Presentkort in a salon** | A voucher is an **enfunktionsvoucher** only if both the VAT amount payable and the place of supply are already known when it is issued (ML 2 kap. 27 §). A salon voucher redeemable against a mix of exempt care and 25 % treatments is therefore a **flerfunktionsvoucher**: no VAT on issue, VAT arises on redemption (ML 5 kap. 43 §). A voucher for a named 25 % treatment is an enfunktionsvoucher and its transfer is itself the taxable supply (ML 5 kap. 40 §). Book unredeemed vouchers on **2421 Ej inlösta presentkort** |

### Mixed packages

A "medicinsk ansiktsbehandling" bundling an exempt consultation with a taxable cosmetic treatment, or a dental package bundling exempt treatment with taxable bleaching, needs a split.

1. **Is there one single supply or several?** If one element is subordinate and has no independent purpose for the average customer, it follows the principal supply's treatment.
2. If there are several independent supplies at one price, split the consideration. ML 8 kap. 20 § allows **uppdelning efter skälig grund** where the taxable part of the beskattningsunderlag cannot be established directly.
3. Prefer a split based on **separate list prices** for the components. Document the key.
4. Never let a small exempt element make a package exempt, or a small taxable element make it taxable. **Ask the user** for the component price list before coding a package.

---

## 8. Master decision table

Read left to right. All four columns must be satisfied for "Momsfri".

| Service | Performed by | Purpose / basis | Result |
|------|------|------|------|
| Läkarbesök, diagnostik, behandling | Leg. läkare | Medically prevent/investigate/treat | Momsfri |
| Fysioterapi efter skada | Leg. fysioterapeut | Treat skada | Momsfri |
| Naprapatbehandling, ryggbesvär | Leg. naprapat | Treat kroppsfel/skada | Momsfri |
| Naprapatbehandling | Ej legitimerad "naprapat" | Any | 25 % |
| Samtalsterapi | Leg. psykolog / psykoterapeut | Treat psykisk ohälsa | Momsfri |
| Livscoaching, mental träning | Coach | Wellbeing | 25 % |
| Tandlagning, rotfyllning | Tandläkare / tandhygienist | Sjukdom i munhålan | Momsfri |
| Tandblekning | Tandläkare | Kosmetiskt | 25 % |
| Bettskena | Tandläkare / tandtekniker | Dentalteknisk produkt, 10 kap. 11 § | Momsfri |
| Botox, kronisk migrän | Leg. läkare | Documented diagnosis | Momsfri |
| Botox, rynkor | Leg. läkare | Kosmetiskt | 25 % |
| Filler, läppförstoring | Leg. sjuksköterska | Kosmetiskt | 25 % |
| Filler, rekonstruktion efter trauma | Leg. läkare | Restore health | Momsfri |
| Laser hårborttagning | Anyone | Kosmetiskt | 25 % |
| Laserbehandling av diagnosticerad hudsjukdom | Leg. läkare | Treat sjukdom | Momsfri |
| Bröstrekonstruktion efter cancer | Leg. läkare | Restore health | Momsfri |
| Bröstförstoring | Leg. läkare | Kosmetiskt | 25 % |
| Ansiktsbehandling, peeling | Hudterapeut | Any | 25 % |
| Medicinsk fotvård, diabetes | Fotvårdsterapeut or leg. personal | 10 kap. 7 § 3 st | Momsfri |
| Pedikyr | Fotvårdsterapeut | Kosmetiskt | 25 % |
| Massage för välbefinnande | Massör | Wellbeing | 25 % |
| Vaccination | Leg. sjuksköterska | Medically prevent | Momsfri |
| Friskvårdstimme, PT | PT | Rekreation | 25 % |
| Körkortsintyg | Leg. läkare | Third-party decision | 25 % |
| Uthyrning av läkare till annan mottagning | Bemanningsbolag / eget AB | Personaluthyrning | 25 % |
| Vård i egen regi under eget ansvar på annans adress | Leg. personal, egen vårdgivare | Care to the patient | Momsfri |
| Försäljning av hudvårdsprodukt | Klinik | Retail | 25 % |
| Glasögon sålda vid synundersökning | Optiker | 10 kap. 10 § 1 | 25 % |
| Städning såld separat av omsorgsföretag | Omsorgsföretag | Servicetjänst | 25 % |

---

## 9. Booking patterns (BAS 2026)

Accounts verified against BAS 2026 (bas.se). Use sub-accounts under 30xx to separate the streams: the grundkontoplan only publishes 3000-3004 at that level, so a clinic should open dedicated sub-accounts (e.g. 3041 momsfri vård, 3051 estetiska behandlingar 25 %) and map them back to 3004/3001.

| Account | Name (BAS 2026) | Use in a clinic or salon |
|------|------|------|
| **3001** | Försäljning inom Sverige, 25 % moms | Aesthetic treatments, retail products, intyg, företagshälsovårdens momspliktiga del |
| **3004** | Försäljning inom Sverige, momsfri | Exempt sjukvård, tandvård, social omsorg |
| **3620** | Tillfällig uthyrning av personal | Personaluthyrning of care staff: always 25 % |
| **3740** | Öres- och kronutjämning | Rounding in kassaregister settlement |
| **3990 / 3999** | Övriga ersättningar, bidrag och intäkter / Övriga rörelseintäkter | No-show fees and other non-supply compensation (see `blandad-verksamhet-vard.md`) |
| **2611** | Utgående moms på försäljning inom Sverige, 25 % | Output VAT on the taxable stream |
| **2641** | Debiterad ingående moms | Input VAT fully attributable to the taxable stream |
| **2649** | Ingående moms, blandad verksamhet | Deductible share of shared input VAT |
| **6999** | Ingående moms, blandad verksamhet | Non-deductible share, expensed |
| **2421** | Ej inlösta presentkort | Salon gift vouchers not yet redeemed |

**Worked entry: mixed consultation invoice, 3,000 SEK exempt care plus 2,500 SEK excl. VAT cosmetic treatment**

| Account | Debit | Credit |
|------|------|------|
| 1510 Kundfordringar | 6,125.00 | |
| 3004 Försäljning inom Sverige, momsfri | | 3,000.00 |
| 3001 Försäljning inom Sverige, 25 % moms | | 2,500.00 |
| 2611 Utgående moms på försäljning inom Sverige, 25 % | | 625.00 |

**Worked entry: inhyrd läkare invoices a clinic 80,000 SEK excl. VAT for a month of shifts (the letting company's books)**

| Account | Debit | Credit |
|------|------|------|
| 1510 Kundfordringar | 100,000.00 | |
| 3620 Tillfällig uthyrning av personal | | 80,000.00 |
| 2611 Utgående moms på försäljning inom Sverige, 25 % | | 20,000.00 |

In the **receiving** exempt clinic the same invoice is booked gross to a personnel-cost account: the 20,000 SEK is not deductible and is a cost.

---

## 10. Error patterns and ask-the-user rules

1. **Citing ML 1994:200 3 kap. 4-5 §§.** Repealed for supplies from 1 July 2023. The current cites are ML 2023:200 10 kap. 6-14 §§.
2. **Exempting a whole clinic because it is "a clinic".** The test is per treatment. A single VAT code on the customer or on the org unit is a design defect.
3. **Treating legitimation as sufficient.** Route B only fixes *who*; the purpose test still has to be met (HFD 2013 ref. 67).
4. **Treating purpose as sufficient.** A medically motivated treatment given by a non-legitimerad person in open care is taxable.
5. **Exempting personaluthyrning.** Taxable since HFD 2018 ref. 41; substance over the contract's title.
6. **Exempting glasögon.** ML 10 kap. 10 § 1 makes them taxable even as a step in care.
7. **Exempting retail skincare** because the clinic's core revenue is exempt.
8. **Forgetting that exempt revenue kills input VAT deduction** and that mixed revenue triggers apportionment and possibly jämkning: see `blandad-verksamhet-vard.md`.
9. **Missing the VAT registration duty** when a previously fully exempt clinic starts selling aesthetics or letting staff.

**Ask the user, never guess, when:**

- a treatment could be either medical or aesthetic and the source data carries no diagnosis;
- the performer's legitimation is not evidenced;
- a consultant invoices a clinic and it is unclear whether they act as vårdgivare in their own right;
- a package price bundles exempt and taxable elements with no component prices;
- a client asks to change the VAT treatment of a treatment type retroactively: that is an omprövning with skattetillägg exposure (`swedish-vat`).

---

## Sources

All checked **2026-09-17** unless stated.

| Source | What was taken from it |
|------|------|
| **Mervärdesskattelag (2023:200)**, consolidated t.o.m. **SFS 2026:1025**, via lagen.nu (source: beta.rkrattsbaser.gov.se) | 10 kap. 6, 7, 8, 9, 10, 11, 12, 13, 14 §§ (full text); 13 kap. 6 § (main deduction rule); 8 kap. 20 § (uppdelning efter skälig grund of the beskattningsunderlag); 2 kap. 26-27 §§ and 5 kap. 40-43 §§ (voucher rules); 18 kap. 4 § (120,000 SEK threshold, Lag 2024:942). 10 kap. 6-14 §§ carry no amending-law annotation: original 2023:200 wording |
| **Patientsäkerhetslag (2010:659)**, consolidated t.o.m. **SFS 2026:1551**, retrieved by lagen.nu 2026-09-08 | 4 kap. 1 § legitimation table (22 professions, table per **Lag 2018:1996**, unchanged for 2026); 4 kap. 2, 3, 4, 5 §§; 4 kap. 5 a § (skyddad yrkestitel undersköterska); 4 kap. 10 § (Socialstyrelsen prövar) |
| **HFD 2013 ref. 67**, 2013-09-24, mål 4461-10 (PFC Clinic AB), via lagen.nu (source: rattspraxis.etjanst.domstol.se) | The purpose test for estetiska operationer och behandlingar; the list of procedures at issue; the burden on the taxpayer to show purpose per treatment; prop. 1989/90:111 s. 106 f. |
| **C-91/12 PFC Clinic**, EU:C:2013:198 | Points 25, 27, 29 as quoted inside HFD 2013 ref. 67 |
| **HFD 2018 ref. 41**, 2018-06-07, mål 7270-17 (Medcura AB), via lagen.nu | Uthyrning av vårdpersonal is taxable; absence of a subcontractor provision in the current ML; prop. 1991/92:122 s. 8; C-141/00 Kügler and C-91/12 on the scope of Art. 132.1 b and c |
| **skatteverket.se**, *Vårdföretag och personaluthyrning* (/foretag/moms/sarskildamomsregler/vardforetagochpersonaluthyrning…) | Current administrative position on personaluthyrning versus vård i egen regi under eget ansvar; the "egen organisatorisk struktur" test; 25 % rate |
| **skatteverket.se**, *Momssatser och undantag från moms* (/foretag/moms/saljavarorochtjanster/momssatserochundantagfranmoms…) | Lists of exempt and taxable examples: hälsoundersökning, vaccination, samtalsstöd, medicinsk fotvård, ambulans; taxable: uthyrning av vårdpersonal, skönhetsvård, estetiska behandlingar utan medicinska skäl, allmän rekreation och friskvård, kostrådgivning, massage, alternativvård, synhjälpmedel, intyg i körkorts- och pensionsfrågor, naturläkemedel, djurvård, tandborstar/tandtråd; the ortopedingenjör exception; företagshälsovård split; social omsorg servicetjänster at 25 % |
| **skatteverket.se**, *Belopp och procent: inkomstår 2026* | Moms 25/12/6 %, livsmedel 6 % from 2026-04-01 (rate table used only by reference here; see `swedish-vat`) |
| **BAS 2026 kontoplan v 1.1**, bas.se | Every account number and name in section 9, read from the published BAS 2026 chart. "#" marks accounts not to be used under K2: none of the accounts cited here carries "#" |

**Not obtainable on 2026-09-17, therefore flagged Osäkert in the text rather than asserted:** the diarienummer and application date of Skatteverket's ställningstagande following HFD 2018 ref. 41; Skatteverket's position on hörapparater and on kontaktlinser as synhjälpmedel. All three sit in *Rättslig vägledning* or in the ställningstagande archive, both behind the block described at the top of this file.
