# Review package: K3 årsredovisning for a mindre aktiebolag

For the accountant who reviews Accounted's K3 årsredovisning before it is
released. Release means switching on `NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED`:
a K3 report that passes every check below can then be locked, signed with
BankID and filed on paper. Until then every K3 document is a
granskningsutkast (blocker `AR-K3-DRAFT-ONLY`, watermark on every page).

Sources used throughout: BFNAR 2012:1 Årsredovisning och koncernredovisning
(K3) as consolidated 2025-12-15, for räkenskapsår that start after
2025-12-31; BFNAR 2012:4 on switching between K2 and K3; ÅRL as in force
2026-10-26 (including 5 kap. 18 a §, in force 2026-12-05). Point numbers are
K3's; paragraph numbers are ÅRL's unless another law is named.

What we ask of you: go through sections 2 to 6, answer the questions in
section 8, and say whether anything in section 7 (judged not applicable) is
wrong. Each requirement has a stable id (`fb.agare`) and a stable code
(`AR-K3-FB-MAJOR-OWNERS`); please refer to them.

## 1. Scope: what the product prepares, and what it refuses

Accounted prepares the K3 årsredovisning of a **mindre aktiebolag** in a
year that is **not its first K3 year after K2**, with **no temporary
differences beyond obeskattade reserver**, valued **without fair value**
under ÅRL 4 kap. 14 a §, in **SEK**, not in liquidation. Everything outside
that scope is refused with a blocking issue; an unanswered question is a
blocker, never a "no".

| Code | When | Source | Why it blocks |
|---|---|---|---|
| `AR-K3-STORRE-UNSUPPORTED` | Size class larger (two years over two of 50 employees, 40 MSEK balansomslutning, 80 MSEK nettoomsättning) or securities on a regulated market | ÅRL 1 kap. 3 § | Större företag need ÅRL 5 kap. 25-48 §§, kassaflödesanalys (2 kap. 1 §) and the K3 större points (section 7); not built |
| `AR-K3-SIZE-UNKNOWN` | A comparison year's figures are missing | ÅRL 1 kap. 3 § | Size cannot be decided |
| `AR-K3-LISTED-UNKNOWN`, `AR-K3-PUBLIC-UNKNOWN` | Profile question unanswered | ÅRL 1 kap. 3 §, 5 kap. 23 § andra stycket | Size and the publikt-bolag disclosures depend on them |
| `AR-K3-FIRST-YEAR-UNSUPPORTED` | The previous year was prepared under K2 | K3 kapitel 35, BFNAR 2012:4 | Transition (restated opening balance, comparatives, 35.31-35.33 notes) not built |
| `AR-K3-FIRST-YEAR-UNKNOWN` | Neither the per-year framework record nor the profile says what the previous year used | K3 35.3 | Cannot tell a first year from a later one |
| `AR-K3-TEMPORARY-DIFFERENCES-UNSUPPORTED` | Deferred tax is booked (1370-1379, 2240-2249, 8940-8949), or the user says the company has other temporary differences | K3 29.19 | Deferred tax beyond obeskattade reserver not built |
| `AR-K3-TEMPORARY-DIFFERENCES-UNKNOWN` | The profile question is unanswered (buildings and component depreciation are shown as hints) | K3 29.19 | |
| `AR-K3-FAIR-VALUE-UNSUPPORTED` | 2096 Fond för verkligt värde is used, or the user says instruments are valued at fair value | ÅRL 4 kap. 14 a-e §§, 5 kap. 10 and 12 §§, K3 kapitel 12 | Not built |
| `AR-K3-GOING-CONCERN-UNSUPPORTED` | The user says the company cannot apply the going concern principle | ÅRL 2 kap. 4 §, 5 kap. 5 §, K3 3.8 | Not built |
| `AR-K3-EQUITY-UNCLASSIFIED` | A verifikat changes equity against accounts that do not say what it is, and the user has not classified it | ÅRL 6 kap. 2 §, K3 6.3 | The specification of changes in equity would be wrong |
| `AR-K3-NOTE-FIXED-ASSETS` | Immateriella or materiella anläggningstillgångar in the ledger that the asset register cannot roll forward | ÅRL 5 kap. 8 § | The note cannot be produced |
| `AR-SCOPE-ENTITY-FRAMEWORK` | Ekonomisk förening under K3 | | The equity statement follows the aktiebolag |
| `AR-SCOPE-LIQUIDATION`, `AR-SCOPE-CURRENCY` | Liquidation, EUR | | As for K2 |

The first-year status comes from the framework stored per räkenskapsår
(`fiscal_period_frameworks`, from BFNAR 2012:4) when that record is reliable:
an election, the year's locked årsredovisning (a year that existed before the
table and had a version past draft takes that version's framework), or a year
that followed a reliable year. A value that is only the company's default
does not count, and the profile question "Enligt vilket regelverk upprättades
föregående årsredovisning?" (K3, K2, none) decides. The same rule decides
whether a move to K2 is a switch from K3 under BFNAR 2012:4 punkt 2-3: when
the previous årsredovisning's framework is only a default, the settings ask
for it before any reasons are asked or printed. A company with no earlier
report is a förstagångstillämpare under 35.3 with nothing to restate: it gets
the generated note in section 4.

## 2. Structure and statements

| Part | How | Source |
|---|---|---|
| Order | Förvaltningsberättelse, resultaträkning, balansräkning, (förändring i eget kapital as its own statement when chosen), noter | K3 3.10 |
| Resultaträkning | Kostnadsslagsindelad, ÅRL bilaga 2 | ÅRL 3 kap. 1-4 §§, K3 kapitel 5 |
| Balansräkning | ÅRL bilaga 1 with K3's own posts: Balanserade utgifter för utvecklingsarbeten (1010-1019), Uppskjuten skattefordran (1370-1379), Aktuell skattefordran (1640-1649 and a net debit on 25xx), Fond för utvecklingsutgifter (2089), Fond för verkligt värde (2096), Avsättningar för skatter split into uppskjuten skatt (2240-2249) and övrig (2250-2259) | ÅRL bilaga 1, K3 4.3, 29.6, 29.20 |
| Jämförelseår | Every post, both years | ÅRL 3 kap. 5 § |
| Förändring i eget kapital | From the year's verifikat per post and kind: årets resultat (a), retroaktiva effekter and rättelse av fel (b), poster direkt mot eget kapital (c), transaktioner med ägare (d), omföringar (e); in förvaltningsberättelsen by default, as a statement of its own on request; ties to the balance sheet or blocks (`AR-EQUITY-SPECIFICATION-MISMATCH`) | ÅRL 6 kap. 2 § andra stycket, K3 6.3, 3.10 |
| Kassaflödesanalys | Not included for a mindre företag | ÅRL 2 kap. 1 § (voluntary for mindre företag); our statement does not meet K3 kapitel 7 yet |
| Flerårsöversikt | Nettoomsättning, resultat efter finansiella poster, soliditet (obeskattade reserver at 79.4 percent in equity) | ÅRL 6 kap. 1 § första stycket |
| Underskrifter, fastställelseintyg | As for K2 | ÅRL 2 kap. 7 §, 8 kap. 3 § |

## 3. Förvaltningsberättelse

Producer: generated (from the books), typed (the user writes or picks),
confirmed (the user confirms a statement). "Ask" means the user answers
whether it applies; the answer is printed only when it applies.

| Id | Title in the document | Source | When | How it is met, what the user gives |
|---|---|---|---|---|
| `fb.verksamhet` | Verksamhet | ÅRL 6 kap. 1 §, K3 3.7 a | Always | Typed (existing text field, prefilled from the bolagsordning wording) |
| `fb.vasentliga_handelser` | Väsentliga händelser under räkenskapsåret | ÅRL 6 kap. 1 § andra stycket 2, K3 3.7 b | Always | Typed (existing field; prefilled "Inga väsentliga händelser utöver löpande verksamhet ...", see question 5) |
| `fb.externa_faktorer` | Viktiga externa faktorer | ÅRL 6 kap. 1 § andra stycket 1, K3 3.7 c | Ask | Typed |
| `fb.speciella_omstandigheter` | Speciella omständigheter | ÅRL 6 kap. 1 § andra stycket 1, K3 3.7 d | Ask; applies when equity was corrected for an error | Typed |
| `fb.agare` | Ägarförhållanden | K3 3.7 e | Ask (owners over ten percent) | Typed |
| `fb.agarstruktur` | Förändringar i ägarstrukturen | K3 3.7 g | Ask | Typed |
| `fb.flerarsoversikt` | Flerårsöversikt | ÅRL 6 kap. 1 §, K3 3.5A | Always | Generated |
| `fb.fortlevnad` | (nothing printed when applied) | ÅRL 2 kap. 4 §, 5 kap. 5 §, K3 3.8 | Always | Choice; "cannot continue" blocks |
| `fb.kontrollbalans` | Kontrollbalansräkning | ABL 25 kap. 13 §, K3 3.11 | Eget kapital below half the aktiekapital in the balance sheet | Typed: drawn up or to be drawn up, and when |
| `fb.egna_aktier` | Egna aktier | ÅRL 6 kap. 1 § andra stycket 6-9 | 2094 held or moved | Typed |
| `fb.eget_kapital` | Förändring av eget kapital | ÅRL 6 kap. 2 §, K3 6.3, 3.10 | Always | Generated; unclassified verifikat block until classified |
| `fb.resultatdisposition` | Förslag till resultatdisposition | ÅRL 6 kap. 2 § första stycket, K3 3.14 | Always | Typed with the amounts from the balance sheet (fritt eget kapital) |

## 4. Redovisnings- och värderingsprinciper (note 1) and the notes

Note 1 always states that ÅRL and BFNAR 2012:1 are applied, valuation at
anskaffningsvärde, linear depreciation over the useful life, obeskattade
reserver gross in juridisk person (K3 29.37), revenue recognition, leasing
under the 20.29 exception, and financial instruments at (upplupet)
anskaffningsvärde. The matrix appends the paragraphs below when they apply.

| Id | Title | Source | When | How |
|---|---|---|---|---|
| `pr.ramverk` | Tillämpat regelverk | ÅRL 5 kap. 4 §, K3 1.6, 8.3 | Always | Generated (first paragraph of note 1) |
| `pr.intakter_uppdrag` | Pågående uppdrag | K3 23.29 b, 23.31 | 1470-1479 or 2430-2439 have a balance | Choice: successiv vinstavräkning with how the färdigställandegrad is measured (typed) or färdigställandemetoden, 23.31 (printed text) |
| `pr.varulager` | Varulager | ÅRL 4 kap. 9 §, K3 13, 13.14, 8.3 | 1400-1469 or 1490-1499 have a balance | Choice: lowest value FIFO, lowest value weighted average, or the inkomstskattelagen rule (13.14) |
| `pr.utveckling` | Internt upparbetade immateriella tillgångar | K3 18.7, 18.28 | Asked; applies when 1010-1019 has a balance | Choice: aktiveringsmodellen or kostnadsföringsmodellen |
| `pr.goodwill` | Goodwill | ÅRL 5 kap. 9 §, K3 18.20 | 1070-1079 has a balance | Typed: period and reasons |
| `pr.bidrag` | Offentliga bidrag | K3 24.5, 24.8 | Ask | Generated paragraph when yes |
| `pr.valuta` | Utländsk valuta | K3 8.3A, 30.3, 30.7 | Ask | Confirmed: monetary items at the closing rate; paragraph printed |
| `pr.anlaggningar` | Avskrivningsmetod och nyttjandeperioder | ÅRL 5 kap. 8 § andra stycket, K3 17.23, 18.28 | Always | Generated (note 1 and the useful lives per category from the asset register) |
| `pr.ovriga_principer` | Intäkter, leasing, skatter, finansiella instrument | K3 8.3, 23.29 a, 20.29, 29.37, kapitel 11 | Always | Generated |

| Id | Note title | Source | When | How |
|---|---|---|---|---|
| `not.avvikelser` | Avvikelser från redovisningsprinciper | ÅRL 2 kap. 3-4 §§, 5 kap. 5 § | Ask | Typed: reasons and effect |
| `not.principbyte` | Byte av redovisningsprincip | K3 10.6, 10.7, ÅRL 3 kap. 5 §, 5 kap. 7 § | Ask; applies when equity moved for a changed principle | Typed |
| `not.rattelse` | Rättelse av fel | K3 10.12, 10.14 | Ask; applies when equity was corrected | Typed: the error and its effect |
| `not.jamforelsetal` | Jämförelsetal | ÅRL 3 kap. 5 §, 5 kap. 7 §, K3 3.5 | Ask | Typed |
| `not.exceptionella_poster` | Exceptionella intäkter och kostnader | ÅRL 5 kap. 19 § | Ask | Typed |
| `not.arrangemang` | Ekonomiska arrangemang som inte redovisas i balansräkningen | ÅRL 5 kap. 17 § | Ask | Typed |
| `not.lan_ledande` | Lån till ledande befattningshavare | ÅRL 5 kap. 18 § | Ask (hint when 1360-1369 or 1685 has a balance) | Typed |
| `not.koncernataganden` | Åtaganden till förmån för koncernföretag m.fl. | ÅRL 5 kap. 16 § | Ask | Typed |
| `not.eventualforpliktelser_k3` | (the existing Eventualförpliktelser note) | ÅRL 5 kap. 15 §, K3 21.16A, 21.17A | Always | Confirmed: valued per 21.9-21.13, borgen always included |
| `not.stallda_sakerheter_k3` | (the existing Ställda säkerheter note) | ÅRL 5 kap. 14 §, K3 8.6A | Always | Confirmed: redovisat värde for pledges, nominal for mortgages |
| `not.handelser_efter_balansdagen` | Väsentliga händelser efter balansdagen | ÅRL 5 kap. 22 §, K3 32.4 | Ask | Typed; "no" prints "Inga väsentliga händelser har inträffat efter räkenskapsårets slut." There is no default text any more |
| `not.uppskrivningsfond` | Uppskrivningsfond | ÅRL 5 kap. 11 § | 2085 changed | Typed |
| `not.verkligt_varde` | | ÅRL 4 kap. 14 a §, 5 kap. 10, 12 §§ | Ask; applies when 2096 is used | Blocks when yes (`AR-K3-FAIR-VALUE-UNSUPPORTED`) |
| `not.narstaende_publikt` | Transaktioner med närstående | ÅRL 5 kap. 23 § andra stycket, 24 § | Publikt aktiebolag only (asked) | Typed |
| `not.mtf_prospekt` | Nya uppgifter enligt prospekt eller upptagandedokument | ÅRL 5 kap. 18 a § | Publikt aktiebolag only (asked) | Typed |
| `not.finansiella_anlaggningstillgangar` | Finansiella anläggningstillgångar | ÅRL 5 kap. 8 § | 1300-1399 (not 1370-1379) moved | Generated from the ledger per balance sheet post: ingående and utgående anskaffningsvärde, tillkommande, avgående, nedskrivningar (accounts whose name contains "nedskrivning") |
| `not.anlaggningstillgangar` | Materiella anläggningstillgångar, Anläggningstillgångar, Nedskrivningar av anläggningstillgångar | ÅRL 5 kap. 8 §, K3 17.23, 18.28 | 1000-1299 has a balance | Generated: roll-forward per category from the asset register, nedskrivningar from the ledger; blocks when the register cannot roll the ledger's assets forward |
| `not.medelantal` | Medelantal anställda | ÅRL 5 kap. 20 §, K3 8.6B | Always | Generated (payroll or the user's figure) |
| `not.langfristiga_skulder` | Långfristiga skulder | ÅRL 5 kap. 13 § | Always | Existing field with confirmation |
| `not.moderforetag` | Koncernförhållanden | ÅRL 5 kap. 21 § | Always | Existing fields with confirmation |
| `not.forsta_k3_aret` | Första gången K3 tillämpas | K3 35.3, 35.31, 35.33 | New company (no earlier report) | Generated: first report, no relief rules (35.21-35.30), no changed principles |

Also printed: Aktiekapital (amount, number of shares, kvotvärde) when the
company settings hold them. For a mindre företag the note is voluntary; the
warning when it is missing says so (ÅRL 5 kap. 34 § binds a större företag).

Order of the notes (K3 8.2): note 1, then avvikelser, principbyte, rättelse,
jämförelsetal and the first-year note, then the notes to the posts, then
the other notes. Notes are renumbered in that order.

## 5. What the user is asked, and where

On the årsredovisning page, step 3, "K3-upplysningar" lists every
requirement that is not generated or already answered by an existing field,
with its source, the question, the choices or text box, and "Obesvarad" until
answered. The same answers can be sent through the API and MCP
(`disclosure_answers` on the narrative operation, keyed by the ids above;
`previous_year_framework` and `has_other_temporary_differences` on the
compliance profile). Verifikat that change equity without saying how are
listed there to classify (rättelse av fel, ändrad redovisningsprincip,
uppskrivning, utdelning, tillskott, nyemission, omföring, ...).

## 6. Sample output

A sample K3 årsredovisning (three years of books, one computer in the asset
register, the answers below) is generated with the release flag off
(watermarked) and on, and once with no answers (to show the blockers). The
released sample passes every check at draft stage; the unanswered one lists
twenty blocking issues, one per open question. Excerpt of the released
document:

```
Förvaltningsberättelse
  Verksamhet: Bolaget bedriver konsultverksamhet inom IT med säte i Sundsvall.
  Väsentliga händelser under räkenskapsåret: Bolaget har under året tecknat ett ramavtal med en ny större kund.
  Viktiga externa faktorer: Höjda räntor under året har ökat bolagets räntekostnader.
  Ägarförhållanden: Anna Andersson äger 100 procent av aktierna och rösterna.
  Flerårsöversikt (kr): 2023 10 000 / 5 876 / 94.6; 2024 20 000 / 15 876 / 88.6; 2025 30 000 / 25 876 / 85.1
  Förändring av eget kapital (kr)
                                      Aktiekapital  Balanserat resultat  Årets resultat  Totalt
    Belopp vid årets ingång                 25 000                5 877          15 876  46 753
    Disposition enligt stämmans beslut           0               15 876         -15 876       0
    Årets resultat                               0                    0          25 876  25 876
    Belopp vid årets utgång                 25 000               21 753          25 876  72 629
Noter
  Not 1 Redovisnings- och värderingsprinciper (as in section 4)
  Not 2 Aktiekapital: 25 000 kr. Antal aktier: 250. Kvotvärde per aktie: 100 kr.
  Not 3 Materiella anläggningstillgångar: avskrivningstider per kategori, Datorer 5 år
  Not 4 Anläggningstillgångar: Datorer, ingående anskaffningsvärde 5 000 kr, utgående 5 000 kr,
        ingående ackumulerade avskrivningar -2 000 kr, årets -1 000 kr, utgående -3 000 kr,
        utgående redovisat värde 2 000 kr
  Not 5 Medelantal anställda: Bolaget har inte haft några anställda under räkenskapsåret.
  Not 6 Långfristiga skulder, Not 7 Eventualförpliktelser, Not 8 Ställda säkerheter
  Not 9 Väsentliga händelser efter balansdagen: Bolaget tecknade i februari 2026 ett hyresavtal
        för nya lokaler. Avtalet påverkar inte räkenskapsårets resultat.
```

The three PDFs go with the review request. They are generated from the test
ledger in `tests/fixtures/report-books.ts`, never from customer data.

## 7. K3 disclosure points judged not applicable

Checked against every disclosure point of K3 (2025-12-15). Points listed in
sections 3 and 4 are met there; the rest, with the reason:

**Större företag only** (the scope blocks a större företag):
2.2, 3.5, 3.12, 3.13, 7.18, 7.19, 7.20, 8.4, 8.5, 8.7, 8.8, 8.9, 8.11, 8.13,
8.16, 8.17, 8.19, 8.19A, 10.10, 10.13, 11.65, 11.66, 12.80, 12.81, 13.14
(the second paragraph, ÅRL 5 kap. 26 §), 14.11, 15.15, 16.4, 19.25, 19.26
(minority), 19.28, 20.12, 20.14, 20.21, 20.25, 21.16, 21.17, 21.18, 23.30,
24.7, 24.8A, 26.21-26.27, 28.29, 28.30, 29.33-29.36, 33.2, 35.33A.

**Mindre företag exempted by ÅRL or K3**: 3.9 (forskning och utveckling,
filialer: ÅRL 6 kap. 1 § femte stycket), 16.1 (förvaltningsfastigheter:
mindre företag need not disclose fair value).

**Koncernredovisning, not prepared by the product**: 3.3, 8.20, 9.1-9.8,
14.1-14.4 (koncern parts), 19.4-19.24.

**Other legal forms**: 3.7 f (komplementär i kommanditbolag), 14.10, 14.14
and 15.18 (insatsemission, ekonomisk förening), kapitel 36 (stiftelser),
kapitel 37 (ideella föreningar), kapitel 38 (bostadsrättsföreningar).

**Blocked rather than met** (section 1): kapitel 12 (12.4-12.82), 11.3
(switch to kapitel 12), 29.19, 29.25, 29.32 (deferred tax beyond
obeskattade reserver), kapitel 35 after K2 (35.1-35.33, 35.4; a new company
gets 35.31 and 35.33), 3.8 (going concern not applied), kapitel 7 (kassaflödesanalys
not included for a mindre företag).

**Recognition and measurement, no disclosure of their own for a mindre
företag**: 2.1, 2.4, 2.15, 2.18, 4.1, 4.5, 4.13, 5.1, 5.4, 10.1, 10.2,
11.11, 11.33, 11.64, 15.5-15.7, 17.1, 17.2, 17.21, 17.26, 18.3, 18.17,
18.24, 18.26, 18.30, 20.15, 20.28, 21.7, 21.10, 21.14, 21.15, 21.20, 22.1,
22.10, 22.11, 23.13, 23.33, 25.6, 26.13, 26.18, 27.8, 28.6, 28.21, 28.28,
32.2, 32.3, 33.1.

**Met by the structure, scope points of a chapter met above**: 1.4 (K3
applied in full), 3.4 (underskrifter, the existing signing flow), 6.1 (scope
of kapitel 6, see `fb.eget_kapital`), 8.1 (scope of kapitel 8), 8.6 (ÅRL 5
kap. 14 §, see `not.stallda_sakerheter_k3`), 19.27 (the ÅRL 5 kap. 8 §
specification of goodwill, see `not.anlaggningstillgangar`), 24.1 (scope of
kapitel 24, see `pr.bidrag`).

**Not applicable to a Swedish company reporting in SEK**: 30.13
(höginflation).

**Needs your view** (asked in section 8): 1.7 (fusion, BFNAR 2020:5),
11.47 and 11.50 (säkringsredovisning), 30.15 (utländska filialer).

## 8. Questions for the reviewer

1. **Aktuell skattefordran**: is 1640-1649 in debit plus a net debit on
   25xx the right content of the post, and should the skattekonto (1630)
   stay in Övriga fordringar?
2. **Financial fixed assets note**: impairment accounts are recognised by
   name ("nedskrivning"), and transfers between posts are not shown as a
   line of their own. Is that acceptable for a mindre företag?
3. **K2 equity specification**: the K2 PDF now also prints the roll-forward
   of changes in equity (from the verifikat) instead of the closing
   balances. Any objection?
4. **Kassaflödesanalys**: we leave it out for every mindre företag until it
   meets kapitel 7, rather than letting the user include a statement that
   does not. Agreed?
5. **Väsentliga händelser under året**: the field is prefilled with "Inga
   väsentliga händelser utöver löpande verksamhet har inträffat under
   räkenskapsåret." and confirmed with the other texts. Should it instead
   be a question that blocks until answered, like events after balansdagen?
6. **Offentliga bidrag** (`pr.bidrag`): is the generated paragraph (grants
   reduce the anskaffningsvärde, K3 24.8) the only treatment we should
   offer?
7. **Utländsk valuta** (`pr.valuta`): a confirmation that monetary items are
   at the closing rate, then a standard paragraph. Enough?
8. **Temporary differences**: booked deferred tax blocks; buildings and
   component depreciation only prompt the question. Should buildings block
   too?
9. **First K3 year**: the product trusts a per-year framework record only
   when it was elected or followed a known year, and otherwise asks. Is the
   question wording clear, and is "none, this is the first report" the
   right test for a new company under 35.3?
10. **Not asked today**: fusion (1.7), hedge accounting (11.47, 11.50),
    share-based payments (kapitel 26 recognition), foreign branches (30.15).
    Should each get a question that blocks on yes?
11. **BAS 1380**: the shared balance sheet mapping presents 1380 Andra
    långfristiga fordringar under Andra långfristiga värdepappersinnehav
    (K2 and K3). We believe it belongs under Andra långfristiga fordringar;
    please confirm before we change it (it changes K2 documents too).
12. **Note 1 on financial instruments**: is "initialt till anskaffningsvärde
    ... övriga finansiella tillgångar och skulder till upplupet
    anskaffningsvärde" right for a company applying kapitel 11?
13. **Aktiekapital note**: kept although voluntary for a mindre företag. Keep
    or drop?
14. **Order of notes**: section 4. Acceptable under 8.2?

## 9. Not built (and therefore blocked)

Större företag (P4 adds the större list to the matrix), the first K3 year
after K2 (kapitel 35), deferred tax beyond obeskattade reserver (kapitel 29),
fair value (kapitel 12), a kassaflödesanalys that meets kapitel 7, K3 for an
ekonomisk förening, and digital filing of K3 (iXBRL, separate work).
