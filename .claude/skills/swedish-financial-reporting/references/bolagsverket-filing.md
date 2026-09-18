# Bolagsverket Filing Requirements

## Table of Contents
1. What must be filed
2. Filing deadlines
3. Förseningsavgifter
4. Escalation and tvångslikvidation
5. Digital filing and iXBRL
6. Revisionsplikt gränsvärden
7. Filing by entity type

---

## 1. What must be filed

### Aktiebolag
- Årsredovisning (förvaltningsberättelse, resultaträkning, balansräkning, noter, kassaflödesanalys if required)
- Revisionsberättelse (if revisor exists)
- **Fastställelseintyg**: certification that RR and BR were adopted at årsstämma, with date and resolution on resultatdisposition
- Koncernredovisning and koncernrevisionsberättelse if obligated parent company

### Ekonomisk förening (FY beginning 2025-01-01+)
ALL ekonomiska föreningar must file årsredovisning and revisionsberättelse with Bolagsverket. Previously only larger ones were required to.

### Handelsbolag with juridisk person as partner
Årsredovisning filed within **6 months** (not 7) from FY end.

### Stiftelser
Filed with **Länsstyrelsen** (not Bolagsverket) within **6 months**.

---

## 2. Filing deadlines

For AB, **ÅRL 8 kap. 3 § requires the annual report to reach Bolagsverket within one month after the meeting adopts the income statement and balance sheet**. AGM timing and late-fee thresholds are separate rules, not alternative filing dates.

- Hold the ordinary AGM within six months after year-end (ABL 7 kap. 10 §).
- Calculate the filing date from the actual adoption date. For example, adoption on 30 June means receipt by 30 July, not 31 July. Earlier adoption brings the deadline forward.
- ÅRL 8 kap. 6 § normally makes seven months after year-end the first late-fee threshold. Do not replace the earlier adoption-based duty with this threshold.
- Apply the same distinction for a non-calendar financial year. Check statutory date-calculation/holiday rules and the authority calendar rather than adding a fixed number of days.

### Internal timeline

Prepare and sign the annual report before adoption. If audited, allow the statutory audit lead times. Retain the adoption resolution, fastställelseintyg and actual filing receipt. A software export or upload awaiting signature is not completion.

### Continued AGM (fortsatt bolagsstämma)

A qualifying, notified continued meeting can affect the late-fee timing under ÅRL 8 kap. 6 §. It is not a blanket nine-month filing extension: check the statutory conditions, actual adoption and the continuing one-month filing duty.

Sources: [ÅRL 8 kap. 3 and 6 §§](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/arsredovisningslag-19951554_sfs-1995-1554/), [ABL 7 kap. 10 §](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/aktiebolagslag-2005551_sfs-2005-551/), [lag (1930:173) on statutory time](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-1930173-om-berakning-av-lagstadgad-tid_sfs-1930-173/).

---

## 3. Förseningsavgifter

Legal reference: ÅRL 8:5-6 §§. Three fees at escalating intervals.

### FY beginning 2025-01-01 or later (current regime)

| | Privat AB & ekon. förening | Publikt AB |
|---|---|---|
| Avgift 1 (ÅRL 8:6 threshold) | 7,500 SEK | 15,000 SEK |
| Avgift 2 (two months after first fee notice was sent) | 7,500 SEK | 15,000 SEK |
| Avgift 3 (two months after second fee notice was sent) | 15,000 SEK | 30,000 SEK |
| **Total max** | **30,000 SEK** | **60,000 SEK** |

### Legacy amounts (FY beginning before 2025-01-01)
- Privat AB: 5,000 + 5,000 + 10,000 = 20,000 SEK
- Publikt AB: 10,000 + 10,000 + 20,000 = 40,000 SEK

Förseningsavgifter are **ej skattemässigt avdragsgilla**. Unpaid amounts sent to Kronofogden.

---

## 4. Escalation and tvångslikvidation

Keep separate clocks rather than assuming every fee follows a fixed year-end offset:

- First fee: the ÅRL 8:6 threshold, normally seven months after year-end, subject to the statutory exceptions.
- Second and third fees: the notice-linked intervals in ÅRL 8:6 a; retain the authority notices before calculating dates.
- Failure to file the required documents within eleven months can trigger compulsory-liquidation action under ABL 25:11. This is separate from the fee-notice timetable.
- ÅRL 8:12 separately addresses potential personal liability for obligations arising after fifteen months, with its statutory conditions and exceptions. Do not treat a fee calculation as a liability assessment.

Additionally:
- Failure to prepare årsredovisning within 6 months can constitute **bokföringsbrott** (BrB) regardless of filing
- Bolagsverket can issue **vitesförelägganden** against individual board members and VD (ÅRL 8:13 §)

---

## 5. Digital filing and iXBRL

### Availability
Digital filing available since 2018 (K2 AB) and 2019 (K3 AB). Remains **voluntary**; paper filing still accepted (post to Bolagsverket Årsredovisningar, SE-851 98 Sundsvall).

Currently supported only for **aktiebolag using K2 or K3**. Not yet available for: handelsbolag, ekonomiska föreningar, stiftelser.

### iXBRL technical requirements
- Format: **Inline XBRL (iXBRL) version 1.1**
- Files must be valid XHTML with embedded XBRL tags
- Extension: **.xhtml**
- Encoding: **UTF-8**
- Max size: **5 MB**
- Images: JPEG, SVG, GIF, PNG only
- No scripts allowed

### Taxonomy
Developed by BFN, Skatteverket, Finansinspektionen, SCB, Bolagsverket, FAR. Published at **taxonomier.se**.
- K2 taxonomy: BFNAR 2016:10 K2 ÅR (published 2017-09-30)
- K3 taxonomy: BFNAR 2012:1 K3 (updated 2021-10-31)

### Filing process
1. Software generates iXBRL file and uploads to Bolagsverket's "Eget utrymme"
2. Styrelseledamot or VD logs in with **BankID** to digitally sign fastställelseintyg
3. Årsredovisning not considered filed until fastställelseintyg is signed
4. Bolagsverket validates company name, signatory registration, etc. automatically

---

## 6. Revisionsplikt gränsvärden

Per ABL 9:1 §, a private AB may opt out of audit if it does NOT exceed **2 of 3** thresholds during **each of the two most recent FY**:

| Criterion | Threshold |
|---|---|
| Medelantal anställda | > 3 |
| Balansomslutning | > 1,500,000 SEK |
| Nettoomsättning | > 3,000,000 SEK |

Opt-out must be registered in bolagsordning. For parent companies, assessed at GROUP level.

### Always-audited entities
Publika AB, börsnoterade, banks, insurance companies, SVB-bolag, advokataktiebolag, municipally owned AB.

Thresholds unchanged since 2010. SOU 2021:60 recommended raising them but no legislative change as of April 2026.

---

## 7. Filing by entity type

| Entity type | Must file ÅR? | Filed with | Deadline | Revisionsberättelse? | Digital? |
|---|---|---|---|---|---|
| Privat AB | Always | Bolagsverket | Within one month after adoption | If revisor exists | Yes (K2/K3) |
| Publikt AB | Always | Bolagsverket | Within one month after adoption | Always | Yes (K2/K3) |
| Ekon. förening (FY 2025+) | All | Bolagsverket | Within one month after adoption (ÅRL 8:3) | Yes (always has revisor) | Not yet |
| HB (jur. person partner) | Yes | Bolagsverket | **6 months** | If revisionsplikt | Not yet |
| Stiftelse | Yes | **Länsstyrelsen** | **6 months** | Most have revisionsplikt | Not yet |