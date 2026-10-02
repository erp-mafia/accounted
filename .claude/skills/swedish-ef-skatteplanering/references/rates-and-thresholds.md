# Rates and Thresholds: Enskild Firma

<!-- toc -->
**Contents**

- [Egenavgifter (inkomstår 2025/2026, oförändrade procentsatser)](#egenavgifter-inkomstår-20252026-oförändrade-procentsatser)
- [Räntefördelningsräntor (anchored to SLR Nov 30 prior year)](#räntefördelningsräntor-anchored-to-slr-nov-30-prior-year)
- [Expansionsfond](#expansionsfond)
- [Periodiseringsfond](#periodiseringsfond)
- [Räkenskapsenlig avskrivning på inventarier](#räkenskapsenlig-avskrivning-på-inventarier)
- [PGI/SGI/brytpunkter (verify annually mot Skatteverket Belopp och procent)](#pgisgibrytpunkter-verify-annually-mot-skatteverket-belopp-och-procent)
- [Legal sources](#legal-sources)

<!-- /toc -->

Every rate and belopp used by the EF planning instruments, by topic and with the year each figure belongs to. **Verify annually** mot Skatteverkets "Belopp och procent": percentages and belopp are set per inkomstår.

## Egenavgifter (inkomstår 2025/2026, oförändrade procentsatser)

| Group | Rate |
|---|---|
| Active, 7 karensdagar (standard) | **28,97 %** |
| Active, 1 karensdag | slightly higher |
| Active, 90 karensdagar | slightly lower |
| Passive (SLP) | **24,26 %** |
| Pensionär (aktiv NV, året efter pensionsåldersgränsen: 66 år 2025, 67 år 2026; passiv NV betalar SLP 24,26 % oavsett ålder) | **10,21 %** |
| Född 1937 eller tidigare | **0 %** |

**Generell nedsättning** 7,5 % av hela avgiftsunderlaget, max 15 000 kr/år. Förutsättning: aktiv NV + underlag > 40 000 kr (40 000-gränsen är en tröskel, inte ett avdragsbelopp: vid underlag 40 001 kr utgår nedsättning på *hela* underlaget). Beräknas automatiskt av Skatteverket.
Regional nedsättning (Norrlands inland stödområde) 10 % på underlag upp till 180 000 kr (max 18 000 kr/år).

Full mechanics, karensval, schablonavdrag och interaktioner: [[egenavgifter-sgi-pgi-jsa]].

## Räntefördelningsräntor (anchored to SLR Nov 30 prior year)

| Type | Formula | 2025 | 2026 |
|---|---|---|---|
| Positiv (frivillig) | SLR + 6 pp | 7,96% | 8,55% |
| Negativ (obligatorisk) | SLR + 1 pp | 2,96% | 3,55% |

Gränsbelopp (2025+, efter prop. 2024/25:1):
- Positiv RF: kapitalunderlag ≥ 0 kr (50 000 kr-tröskeln **avskaffad** fr.o.m. inkomstår 2025)
- Negativ RF: triggas vid kapitalunderlag < **−500 000 kr** (höjt från −50 000 kr fr.o.m. inkomstår 2025)

Kapitalunderlag, sparat fördelningsbelopp och breakeven: [[rantefordelning-planning]].

## Expansionsfond

- Skatt på avsättning: **20,6%** (expansionsfondsskatt, synkad med bolagsskatten)
- Tak: **125,94% of kapitalunderlag at current year's end** (= 100 / 79,4 = gross-up-faktorn vid 20,6% skatt)
- May not cause underskott in NV
- On återföring: amount becomes NV income; 20,6% credited against year's tax

## Periodiseringsfond

- Tak: **30% of skattemässigt resultat** (vs 25% for AB)
- 6-year mandatory reversal (FIFO)
- **NO schablonintäkt** for fysiska personer
- NE-bilaga only (R32 återföring / R34 avsättning), never booked

Mechanics and interactions for both fonder: [[periodiseringsfond-expansionsfond-ef]].

## Räkenskapsenlig avskrivning på inventarier

- Huvudregeln: 30% declining balance on (IB + årets inköp: årets försäljningar)
- Kompletteringsregeln: 20% straight-line per asset over 5 years
- Förbrukningsinventarier (< halva PBB: **29 400 kr 2025 / 29 600 kr 2026**, korttidsinventarier ≤ 3 år): direktavdrag (IL 18:4; halva-PBB-gränsen har gällt sedan 2009). Nytt fr.o.m. beskattningsår som börjar efter 2024-12-31 (SFS 2024:1131) för EF med förenklat årsbokslut: hela avskrivningsunderlaget får dras av om det uppgår till högst ett halvt PBB (IL 18:13), och lager på högst ett halvt PBB behöver inte tas upp (IL 17:4 a).

## PGI/SGI/brytpunkter (verify annually mot Skatteverket Belopp och procent)

| Threshold | 2025 | 2026 |
|---|---|---|
| Prisbasbelopp (PBB) | 58 800 kr | 59 200 kr |
| Inkomstbasbelopp (IBB) | 80 600 kr | 83 400 kr |
| Lägsta PGI (0,423 PBB) | 24 870 kr | 25 042 kr |
| Lägsta SGI (0,24 PBB) | 14 112 kr | 14 208 kr |
| Skiktgräns statlig skatt | 625 800 kr | 643 000 kr |
| Brytpunkt statlig skatt (under pensionsåldersgränsen) | 643 100 kr | 660 400 kr |
| Max SGI (10 PBB) | 588 000 kr | 592 000 kr |
| Max PGI (7,5 IBB) | 604 500 kr | 625 500 kr |
| Avgiftstak (8,07 × IBB) | 650 442 kr | 673 038 kr |
| Max föräldrapenninggrundande (10 PBB) | 588 000 kr | 592 000 kr |
| Max för 7,5%-nedsättning egenavgifter (200k underlag) | 200 000 kr | 200 000 kr |
| Halva PBB (förbrukningsinventarier) | 29 400 kr | 29 600 kr |
| Pensionsåldersgräns (full egenavgift t.o.m. året då man fyller) | 66 år | 67 år |

## Legal sources

- Inkomstskattelagen (IL) 1999:1229, especially kap 13 (NV), 14 (rörelse), 18 (inventarier), 30 (P-fond), 31 (ersättningsfond), 33 (räntefördelning), 34 (expansionsfond), 60 (inkomstuppdelning familj), 62 (allmänna avdrag), 66 (ackumulerad inkomst)
- Socialavgiftslagen (SAL) 2000:980
- Lagen (1990:659) om särskild löneskatt på vissa förvärvsinkomster
- Bokföringslagen (BFL) 1999:1078: bokföringsskyldighet, K1-tröskel 3 MSEK
- BFNAR 2006:1: Enskilda näringsidkare som upprättar förenklat årsbokslut (K1)
- Lag (1995:575) mot skatteflykt
- SOU 2020:50: "Enklare skatteregler för enskild näringsverksamhet". **Delvis genomförd** via prop. 2024/25:1 (ikraft 2025-01-01): RF-trösklar omarbetade (50k slopad / -500k negativ tröskel), förenklingar för EF med förenklat årsbokslut (helt avdrag för avskrivningsunderlag ≤ halvt PBB, IL 18:13; lager ≤ halvt PBB, IL 17:4 a). Halva PBB för direktavdrag på inventarier (IL 18:4) är äldre. Den större "näringsfond"-idén (samlad ersättning för P-fond+expansionsfond+RF) **ej genomförd**.
