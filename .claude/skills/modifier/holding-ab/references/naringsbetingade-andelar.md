# Näringsbetingade andelar och skalbolag: utvidgad referens

Ladda denna fil när uppgiften specifikt rör definitionen av näringsbetingade andelar, kapitalvinst/-förlust på dotterandelar, eller skalbolagsbedömning.

## IL 24 kap 32-42 §§: komplett genomgång

### 24 kap 32 § IL: ägarkrets
Andel är näringsbetingad endast om den ägs av:
1. svenskt AB eller svensk ekonomisk förening som inte är investmentföretag,
2. svensk stiftelse eller ideell förening som inte är skattebefriad,
3. svensk sparbank,
4. svensk ömsesidig försäkringsförening,
5. utländsk juridisk person som hör hemma i EES och motsvarar något av ovanstående.

**HFD 2022 not. 3:** Liechtenstein-Anstalt (med EES-tillhörighet via EEA-avtalet) godtagen som motsvarighet trots låg beskattning: formell obegränsad skattskyldighet räcker.

**Skatteverket dnr 202-385227-22/111 (2022-10):** SICAV med variabelt kapital motsvarar **inte** svenskt AB (kapitalstrukturen avviker fundamentalt). Luxemburg SARL OK. Brittiska Ltd OK. Irländska DAC OK. Jersey Ltd OK om bolagsrätten motsvarar EES (efter HFD 2022 not. 3 enklare bedömning).

### 24 kap 33 § IL: kategoriseringsvillkor
Andel måste vara kapitaltillgång hos ägaren, **plus** ett av:

| Villkor | Tröskel |
|---|---|
| Onoterad andel i svenskt AB/ek.för. eller motsv. utländskt EES-bolag | Automatiskt, **inget innehavskrav** |
| Marknadsnoterad andel | **≥ 10 % av rösterna** i bolaget |
| Betingad av rörelse hos ägaren/närstående företag | Bedömning per fall |

"Betingad av rörelse", RÅ 2001 ref. 6: aktier i underleverantör betingade av eget rörelseinnehav om strategiskt samband.

### 24 kap 35 § IL: utdelning skattefri
Utdelning på näringsbetingad andel tas inte upp. Gäller även utländsk utdelning (jfr 39 a kap CFC).

### 24 kap 40 § IL: innehavstid
Marknadsnoterad andel: **≥ 1 år** vid utdelnings-/avyttringstillfället. Onoterad: inget innehavskrav. Beräknad bakåt från transaktionstidpunkt.

## IL 25 a kap: kapitalvinst/-förlust

### 25 a kap 5 § IL
- **5 § 1 st:** kapitalvinst på näringsbetingad andel tas inte upp.
- **5 § 2 st:** kapitalförlust på näringsbetingad andel är **inte avdragsgill**. Undantag: aktiefållans handelsbolagsregel.

### 25 a kap 19 § IL: avdragsförbud för "underliggande" tillgång
Förlust på fordran/tillgång vars värde till väsentlig del bestäms av näringsbetingad andel är ej avdragsgill. Typfall: säljarrevers där köparen är dotterbolaget vars aktier är näringsbetingade.

**HFD 2023 ref. 1:** Köpeskillingsrevers efter avyttring av nb-andelar omfattas **inte** av 19 §. Fordringen är inte själv en näringsbetingad andel och dess värde bestäms av köparens betalningsförmåga, inte av målbolagets värde. → Förlust på säljarrevers är avdragsgill (om verklig och definitiv).

### Aktiefållan: IL 48 kap 26 §
Kapitalförlust på delägarrätter som inte är näringsbetingade i AB → endast kvittas mot kapitalvinster på samma slag (rullning framåt). Påverkar inte näringsbetingade andelar direkt men relevant för portföljaktier (1350).

## Skalbolagsregler: IL 25 a kap 9-18 §§

### Definition (25 a kap 9 §)
Skalbolag = AB/ek.för. där marknadsvärdet av **likvida tillgångar** > **jämförelsebeloppet**.

**Likvida tillgångar:** kontanter, värdepapper, andelar i investeringsfonder, fordringar (med vissa undantag), tillgångar som inte hör till rörelsen.

**Jämförelsebeloppet:**
- Vid avyttring av samtliga andelar: **halva ersättningen**.
- Vid annan andel: proportionell beräkning enligt 25 a kap 10 §.

### Konsekvens (25 a kap 9 §)
Hela ersättningen tas upp som kapitalvinst: skattefriheten för näringsbetingade andelar bortfaller.

### Ventilen (25 a kap 12 §)
Skalbolagsbeskattning sker inte om:
1. **väsentligt inflytande** över skalbolaget inte har gått över genom avyttringen, **eller**
2. **särskilda skäl** föreligger (typiskt: skatten betalas direkt; köpare övertar bolaget och fortsätter verksamheten; säljaren visar att skatteflyktssyfte saknas).

### Skalbolagsdeklaration (SFL 27 kap 4 §)
Inom **60 dagar** från avyttring. Innehåll: balansräkning per avyttringsdagen, värdering av likvida tillgångar, jämförelsebelopp, eventuell ventilgrund.

**Säkerhet** för skatten på obeskattade vinstmedel kan krävas (SFL 27 kap 5 §). Bankgaranti eller depositionsbeslag.

## Praktiska felmönster (utöver SKILL.md huvuddokument)

**Felmönster A: Andelar i utländskt holding klassas felaktigt som icke-näringsbetingade.**
Cypern Ltd, Malta Ltd, Luxemburg SARL: alla EES → motsvarar svenskt AB enligt 24 kap 32 § 5 p. Utdelning skattefri. Säljaren betalar ingen skatt på vinst. Skatteverket misstar sig ibland och beskattar.

**Felmönster B: 1-årsregeln ignoreras vid marknadsnotering mitt under innehavet.**
Innehavet börjar som onoterat (näringsbetingat utan tidskrav), bolaget IPO:as, säljs månad 6 efter notering. Vid avyttring är andelen marknadsnoterad → 24 kap 40 § 1-årskrav räknas baklänges från avyttringen. Innehavstiden under noterad period räknas, plus motsvarande tid som onoterad → totalt > 1 år → näringsbetingad. Detta missförstås ofta.

**Felmönster C: Skalbolagsdeklaration utelämnas vid avyttring av sovande bolag.**
Säljaren tror att skalbolagsregeln bara gäller "tomma" bolag, men jämförelsebeloppstest baseras på marknadsvärden: ett bolag med 5 MSEK på bankkonto och inga rörelsetillgångar som säljs för 10 MSEK är skalbolag oavsett om det "är aktivt".

## Lagrum och källor

- IL (1999:1229) 24 kap 32-42 §§: SFS 2003:224 ikraft 2003-07-01, omnumrering SFS 2018:1206 ikraft 2019-01-01.
- IL 25 a kap 5, 9-18, 19 §§.
- IL 48 kap 26 § aktiefållan.
- SFL (2011:1244) 27 kap 2, 4, 5 §§.
- HFD 2022 not. 3 (Liechtenstein-Anstalt).
- HFD 2023 ref. 1 (köpeskillingsrevers).
- Skatteverkets rättsliga vägledning "Näringsbetingade andelar och aktier" och "Skalbolagsbeskattning".
