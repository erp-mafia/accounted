# Kvittning av Underskott i Enskild Firma

<!-- toc -->
**Contents**

- [Legal basis](#legal-basis)
- [Three modes of dealing with underskott](#three-modes-of-dealing-with-underskott)
- [Förutsättningar för kvittning mot andra förvärvsinkomster](#förutsättningar-för-kvittning-mot-andra-förvärvsinkomster)
- [Rullning bättre än kvittning ofta](#rullning-bättre-än-kvittning-ofta)
- [Kulturarbetare (special exemption)](#kulturarbetare-special-exemption)
- [Inrullning (rullning)](#inrullning-rullning)
- [Slutligt underskott vid avveckling](#slutligt-underskott-vid-avveckling)
- [Dödsbon](#dödsbon)
- [Kvittning vid övergång passiv → aktiv](#kvittning-vid-övergång-passiv--aktiv)
- [Komplettering med ny verksamhet](#komplettering-med-ny-verksamhet)
- [Övertagande från närstående](#övertagande-från-närstående)
- [Kvittning of olika delverksamheter](#kvittning-of-olika-delverksamheter)
- [NE-bilaga / INK1 rutor](#ne-bilaga--ink1-rutor)
- [Pitfalls](#pitfalls)
- [Implementation checklist](#implementation-checklist)

<!-- /toc -->

## Legal basis

- IL 62 kap 2-3 §§: Allmänna avdrag, underskott av aktiv nystartad NV
- IL 42 kap 33-34 §§: Slutligt underskott vid avveckling
- IL 14 kap 21-22 §§: Rullning av underskott inom NV
- Skatteverket dnr 131 657367-11/111: Allmänt avdrag för underskott av nystartad verksamhet

## Three modes of dealing with underskott

An EF underskott (negative inkomst av näringsverksamhet) can be handled in three ways:

1. **Rullning framåt**: quietly carry forward into the same näringsverksamhet, kvitta mot framtida överskott
2. **Kvittning mot andra förvärvsinkomster**: allmänt avdrag in INK1 R14.1, kvittas mot lön/pension/handelsbolagsinkomst
3. **Slutligt underskott** vid avveckling: 70% av kvarvarande underskott blir kapitalförlust som dras av i kapital

These are mutually exclusive for the same kronor.

## Förutsättningar för kvittning mot andra förvärvsinkomster

Allmänt avdrag enligt IL 62 kap 3 § kräver ALLT av följande:

1. **Aktivt bedriven** näringsverksamhet (passiv → ingen kvittning mot tjänst, bara rullning)
2. **Nystartad** verksamhet: *de första 5 åren*
3. **Inte direkt eller indirekt bedrivit likartad verksamhet** under de senaste 5 åren innan starten (anti-omklassificering-skydd)
4. **Cap: 100 000 kr/år** för vart och ett av de fem åren

Verksamhet startad 2025 → kvittning får göras i deklarationer 2026, 2027, 2028, 2029 och 2030 (för beskattningsåren 2025-2029, dvs år 1-5).

### Vad "likartad verksamhet under 5 år" betyder

Du får inte ha drivit samma typ av verksamhet (i AB, HB, EF, eller som anställd entreprenör) under 5 år innan starten. Detta utesluter:
- Restart of a dissolved EF under same name
- Spin-out from an AB you previously owned
- Move from anställning som konsult to konsult-EF in samma bransch (yes, this often catches consultants)

Skatteverket may dispens om verksamheten är genuint ny i meningfull sense.

### Cap 100 000 kr per år

Each av de 5 åren får kvitta upp till 100 000 kr: så total max över 5 år är 500 000 kr som allmänt avdrag.

Underskott som överstiger 100 000 kr ett enskilt år kan:
- Rullas framåt i NV (mot framtida överskott)
- ELLER kvittas ett senare år (om det blir ny förlust under perioden)

### Allmänt avdrag mekanik

Tekniskt: underskottet dras av som **allmänt avdrag** in INK1 sid 2 ruta **14.1**. Avdraget görs från R45 på NE.

Det allmänna avdraget minskar underlag för **jobbskatteavdrag** (subtle: less JSA om man kvittar). Det minskar också underlag för PGI och SGI (kvittning är intäktsneutral i den beräkningen: Försäkringskassan bortser från).

### Worked example

Tjänsteinkomst 280 000 kr (skatt ca 61 000 kr) + nystartad aktiv EF med 50 000 kr underskott:
- 50 000 kr förs från NE R45 till INK1 ruta 14.1 (allmänt avdrag)
- Beskattningsbar tjänsteinkomst sänks till 230 000 kr → skatt ca 46 000 kr
- Skatteminskning ≈ 15 000 kr

## Rullning bättre än kvittning ofta

**Rullning är ofta bättre än kvittning** för näringsidkare som räknar med framtida vinst. Två skäl: (1) rullat underskott kan sparas obegränsat länge, (2) det räknas av mot både inkomstskatt *och* egenavgifter: högre avdragseffekt än kvittning mot tjänst, som bara minskar inkomstskatten.

Rule of thumb: rullning ger **25-35 procentenheter bättre effekt** än kvittning mot tjänst (because kvittning bara sparar inkomstskatt; rullning sparar inkomstskatt + egenavgifter ~28,97%).

Räkneexempel (illustrativt):
```
år 1: underskott_NV = 40 000 kr, tjänsteinkomst = 250 000 kr
  option_A (kvittning):  skattereduktion ≈ 11 800 kr i år 1     # bara inkomstskatt
  option_B (rullning):   inrullas till år 2

år 2: vinst_NV_före_egenavgifter = 187 500 kr
  med inrullning: 187 500 − 40 000 = 147 500 kr → skatt+egenavgifter ≈ 46 000 kr
  utan inrullning: skatt+egenavgifter ≈ 63 200 kr på 187 500 kr
  rullningsförmån = 17 200 kr  (vs kvittning 11 800 kr)
  → rullning ≈ 5 400 kr bättre
```

Villkor: rullning kräver att verksamheten faktiskt går med vinst senare. Om verksamheten aldrig blir lönsam → kvittning bättre (eller slutligt underskott vid avveckling, 70 %-regeln).

### Possibility för omprövning

Skatteverket allows ändring av val genom omprövning inom 5 år efter deklarationsåret. So:
- År 1: gör allmänt avdrag (kvitta mot tjänst), spara ingen rullning
- Senare upptäcker att verksamheten gick med vinst → begär omprövning av år 1 → ändra valet till rullning → börja om
- Var medveten: omprövning kan utlösa **kostnadsränta** på det belopp där skatten egentligen var högre

## Kulturarbetare (special exemption)

Kulturarbetare = personer som uteslutande eller så gott som uteslutande sysslar med **konstnärlig, litterär eller liknande kulturell verksamhet**.

Specials:
- **Ingen 5-årsgräns**: kvittning får göras hur länge som helst
- **Inget årligt tak på 100 000 kr**: fri kvittning
- Cap: avdrag bara för **årets underskott** (kvarvarande underskott från tidigare år får inte dras som allmänt avdrag)
- "Uteslutande eller så gott som uteslutande" = ca 90-95% av verksamheten ska vara kulturarbetarverksamhet
- Krav: intäkter under en period som omfattar beskattningsåret och de tre föregående beskattningsåren får inte vara obetydliga (≈ minst ett halvt inkomstbasbelopp/år i genomsnitt; ≈ 34 100 kr 2021)

Skatteverket may dispens.

Planeringstips: om man har annan verksamhet vid sidan av kulturarbetarverksamheten kan det vara värt att placera den andra verksamheten i AB eller HB: för att inte späda ut 90 %-kravet för kulturarbetarkvittningen i EF:n.

## Inrullning (rullning)

Rullning is the **default** treatment for underskott of:
- Passiv NV (no kvittning mot tjänst available)
- Aktiv NV efter 5-årsgränsen
- Aktiv NV där 100k cap är fyllt
- Slutligt underskott (om verksamhet inte upphör)

Mechanics:
- Underskottet rullas in i nästa års NE-bilaga ruta R24
- Minskar resultatet i nästa år
- Räknas mot egenavgifter, inkomstskatt och statlig skatt → **högre avdragseffekt** än kvittning mot tjänst

### Ingen tidsbegränsning

Rullningen kan göras under obegränsat antal år. Skatteverket kan ifrågasätta att näringsidkaren har **vinstsyfte** om regelmässigt stora underskott uppkommer under en lång tid:
- Indikator för "ingen vinstsyfte" → hobbyverksamhet → näringsverksamhet kan avregistreras retroaktivt → underskottet återförs
- För att visa vinstsyfte: redovisa **något** av intäkter (inte enbart kostnader)

Praktiskt: det bästa sättet att visa vinstsyfte är att redovisa **åtminstone några intäkter** varje år, inte enbart kostnader. Helt intäktslös verksamhet under lång tid är en stark indikator på hobbyverksamhet.

## Slutligt underskott vid avveckling

When verksamhet upphör helt (verksamheten avslutas, alla tillgångar säljs):

### Huvudregel

Vid nedläggning av enskild näringsverksamhet:
- 70 % av slutligt underskott får utnyttjas som **kapitalförlust** i inkomstslaget kapital
- Avdraget tas in i ruta **8.4 på INK1** ("Slutligt underskott av näringsverksamhet"), året efter nedläggningsåret. **Inte ruta 14.1**: 14.1 är allmänt avdrag för nystartad aktiv NV (de första 5 åren).
- Skattereduktion = 70 % × 30 % = **21 %** skattereduktion på det kvarvarande underskottet

Worked example:
- Slutligt underskott 80 000 kr vid nedläggning
- Inkomstdeklaration året efter: 70% × 80 000 = 56 000 kr som kapitalförlust
- Skatteminskning = 30% × 56 000 = **16 800 kr** (motsvarar 21% av 80k)

### Fördelning på 3 år

Om inte tillräckligt med skatt att kvitta mot ett enda år, får avdraget delas på högst **3 år** (fördelningsåret + 2 år).

Inte några marginaleffekter i inkomstslaget kapital → inget utrymme för skatteplanering på fördelning. Bäst att utnyttja skattereduktionen så snabbt som möjligt.

### Year efter slutåret

Avdraget får göras **först inkomståret efter** att verksamheten **helt** har avslutats. Praktiskt: nedlägg verksamheten 2025, lämna sista NE för 2025, sedan i deklarationen för **2026** dras 70% i kapital.

### Restriktion vid ombildning till AB

Om verksamheten ombildas till AB, kan underskottet **inte** föras över till AB:et: det är knutet till näringsidkaren personligen. Underskottet hanteras genom:
- 70%-avdraget i kapital (om verksamheten faktiskt upphör)
- ELLER om verksamheten *fortsätter parallellt* i AB och EF, finns ingen formell upphörande → underskottet rullas vidare i EF

Spärr vid ombildning till AB: tillgångarna förs ut ur den enskilda firman till underpris utan uttagsbeskattning, varför avdrag för slutligt underskott är begränsat. Detta blockerar konstruktionen "sham ombildning + nedläggning" som annars hade kunnat konvertera framtida rullbart underskott till omedelbar kapitalförlust.

## Dödsbon

Same regler:
- Verksamheten kan fortsätta efter dödsfall
- Dödsboet kan ta över ansvar för kvarvarande underskott
- Vid bouppteckning: om endast en dödsbodelägare → dödsboet anses skiftat redan vid bouppteckning → underskottet förloras
- Vid flera dödsbodelägare → dödsboet kan leva vidare och utnyttja underskottet
- Mitigation: vid risk för att underskott försvinner, gör **partiellt arvsavstående** för att skapa flera dödsbodelägare

## Kvittning vid övergång passiv → aktiv

Exempel:
```
år 1: hyreshus (passiv), underskott 80 000 kr → rullas framåt (passiv ger ingen kvittning mot tjänst)
år 2: ytterligare 50 000 kr underskott → ackumulerat rullande 130 000 kr
år 3: ägaren slutar sin anställning, börjar arbeta ≥ 500 h/år i verksamheten → klassificering passiv → aktiv
       överskott 40 000 kr
       inrullat underskott (rullas från passiv-perioden) får kvittas mot årets aktiv-överskott → netto 0
       återstående rullande underskott = 130 000 − 40 000 = 90 000 kr
```

Effekt: hela ackumulerade underskottet (130 000 kr) kan dras av (vanlig rullning), men dessutom kan resterande 90 000 kr av nettounderskottet **kvittas mot tjänst** med allmänt avdrag: eftersom verksamheten är aktiv i bedömningsåret. Att verksamheten varit passiv under tidigare år påverkar inte rätten det aktuella året.

### 5-årsgränsens räknepunkt

Det krävs aktiv NV. 5-årsgränsen för nystartad ska gälla *från företagsstarten*:
- Verksamheten startade aktivt → 5 år börjar då
- Verksamheten startade passivt och blev sen aktiv → oklart om 5 år räknas från start eller från övergång till aktiv
- Skatteverkets ställningstagande **dnr 131 657367-11/111** ger viss vägledning: verifiera exakt tolkning vid implementation

Praktisk princip: kvittning är möjlig så länge verksamheten är aktiv under bedömningsåret, men närma fallet med försiktighet vid passiv→aktiv-övergångar nära 5-årsgränsen.

## Komplettering med ny verksamhet

Om du redan har EF (passiv eller efter 5-årsperioden) och vill **kunna kvitta mot tjänst** för en ny aktivitet:
- Att lägga **ny verksamhet** i den befintliga EF:en blandar in den nya i samma näringsverksamhet → den nya verksamheten räknas **inte** som nystartad
- Lösning: lägg den nya verksamheten i ett separat **handelsbolag** (HB) → nytt skattesubjekt → 5-årsregeln gäller från HB:ets start

This is a powerful planning move för konsult som vill behålla EF för befintlig verksamhet men starta ny inriktning med kvittningsfördel.

## Övertagande från närstående

If you take over a verksamhet from a närstående (within 5 år innan din start):
- Kvittningsregeln (5 år, 100k cap) gäller **endast om den närstående skulle ha fått kvitta** if de fortsatt
- = arvtagaren ärver kvarvarande del av 5-årsperioden, inte hela 5 år ny

Specialfall: om du tagit över via **helt och hållet köp** (inte gåva, arv, testamente) från **förälder** eller **far-/morförälder** → räknas verksamheten som **nystartad** → 5 nya år.

Buying out parents at full marknadsvärde is therefore much mer förmånligt skatteplaneringsmässigt än att ärva (motsatsen mot vad man kan tro initialt).

## Kvittning of olika delverksamheter

Inom EF: alla delverksamheter slås automatiskt ihop till **en enda näringsverksamhet** (in Sverige + i vissa fall EU-länder). Detta innebär att överskott och underskott from olika delverksamheter automatiskt kvittas, vilket ger lägre eller ingen skatt och egenavgifter på överskottet.

**Implication**: starting a profitable verksamhet samtidigt som man har en förlustverksamhet i samma EF → vinsten quenchas av förlusten utan ny ansökan eller särskild bokföring.

Räkneexempel (illustrativt): AB med 520 000 kr vinst (full bolagsskatt + utdelnings-/lönebeskattning) + separat EF med hyresfastighet (100 000 kr underskott per år).

```
option_A: behåll AB+EF separat
  AB-vinst beskattas i AB; EF-underskott rullas (kan inte kvittas mot AB-vinst)
  efter skatt på AB-vinst ≈ 299 000 kr

option_B: avveckla AB, slå ihop verksamheten i EF
  sammanlagt EF-resultat = AB-konsult-vinst − hyresfastighetens underskott
                         = 520 000 − 100 000 = 420 000 kr
  EF-skatt + egenavgifter på 420 000 ≈ 166 976 kr
  → 253 024 kr kvar

besparing ≈ 54 000 kr/år genom intern kvittning i EF
```

Detta är det **enskilt största argumentet för EF över AB** vid kombinerad förlust- och vinstverksamhet i samma hushåll.

## NE-bilaga / INK1 rutor

| Ruta | Innehåll |
|---|---|
| NE R24 | Inrullat underskott från föregående år |
| NE R45 | Underskott som ska föras till allmänt avdrag (aktiv, nystartad, ≤ 100k) |
| NE R47/R48 | Överskott / underskott av NV (aktiv → INK1 10.1/10.2, passiv → INK1 10.3/10.4; aktiv/passiv styrs av kryssrutan på NE sid 1). R48 förs nästa år till R24 |
| INK1 14.1 | Allmänt avdrag för underskott i nystartad aktiv NV (sidan 2 baksida) |
| INK1 8.4 | 70 % av slutligt underskott i avslutad EF, året efter nedläggning ("Slutligt underskott av näringsverksamhet") |

## Pitfalls

1. **Likartad-verksamhet-spärr**: anti-omklassificering, kan utlösas av tidigare konsult-AB i samma bransch
2. **Glömma rullning är ofta bättre än kvittning**: kvittning sparar bara skatt; rullning sparar skatt+egenavgifter
3. **Slutligt underskott vid ombildning till AB**: tillgångarna förs ut till underpris → avdrag begränsas
4. **Kulturarbetar-status**: 90-95%-krav måste kunna styrkas
5. **Verksamhet anses skiftad vid bouppteckning**: enmansdödsbo, underskottet försvinner; lös med partiellt arvsavstående
6. **Övertagande genom arv/gåva**: 5-årsperioden från överlåtaren räknas, inte ny 5-årsperiod
7. **Glömma JSA-effekten av allmänt avdrag**: kvittning sänker underlaget för jobbskatteavdrag
8. **Cap 100 000 kr räknas per år, inte över hela 5-årsperioden**: om du har 200 000 kr underskott år 1 och 0 underskott år 2-5, du kan bara dra 100 000 kr; resterande 100 000 kr måste rullas

## Implementation checklist

- [ ] Track verksamhetens *startdatum* (för 5-årsräkning)
- [ ] Track aktiv vs passiv per år (för kvittningsrätt)
- [ ] Track årligt allmänt avdrag mot 100 000 kr cap
- [ ] Detect kulturarbetar-status (separat code path, no caps)
- [ ] Detect ombildning till AB (begräns slutligt-underskott-avdraget)
- [ ] Persist inrullat underskott carry-forward across years
- [ ] Flag närstående-takeover via personnummer-relation check
- [ ] Allow user to model alternative scenarios (kvittning vs rullning) for omprövning planning

See also [[aktiv-passiv-naringsverksamhet]] (the prerequisite classification), [[ackumulerad-inkomst]] (annan metod att utjämna ojämn inkomst), and `swedish-year-end-closing` references/k1-forenklat-arsbokslut.md (NE-bilaga technical fields).
