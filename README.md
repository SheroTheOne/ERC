# ERC

Ett boknings- och kundhanteringssystem för små tjänsteföretag, till exempel en frisörsalong eller en verkstad. Kunder bokar tider online, och personalen hanterar bokningar, kunder och scheman på ett ställe.

Projektet är ett portfolioprojekt med fokus på det som är svårt i riktiga system: datamodellering, samtidighet, behörigheter, tester och driftsättning.

> **Status:** Fas 0 (design) är i stort sett klar: arkitekturbeslut, datamodell, API-utkast och vyskisser finns i [`docs/`](docs/). Ingen applikationskod är skriven än.

## Mål

- Bygga ett litet system som fungerar från början till slut och går att testa via en publik demo.
- Garantera på databasnivå att en tid inte kan dubbelbokas.
- Dokumentera tekniska val och motivera dem, så att det går att följa hur jag resonerat.

**Utanför första versionen:** onlinebetalning, flera företag i samma installation (multi-tenancy), mobilapp och kalendersynk.

## Funktioner

### MVP

- Visa tjänster och lediga tider
- Boka och avboka en tid som kund
- Inloggning för personal och administratörer
- Hantera bokningar, kunder, tjänster och arbetstider
- Bekräftelse via e-post

### Senare

- Påminnelser före bokad tid
- Kundhistorik och anteckningar
- Statistik över beläggning och populära tjänster
- Kalendersynk via iCal
- Kortbetalning vid bokning

## Research

Varje fråga avslutas med ett kort beslut i [`docs/decisions/`](docs/decisions/).

| Område | Fråga | Utgångspunkt |
| --- | --- | --- |
| Liknande system | Hur fungerar flödena i Calendly, Cal.com och Bokadirekt? | Öppen |
| Dubbelbokning | Hur stoppas krockar när två personer bokar samtidigt? | `EXCLUDE` på blockerad tid inklusive buffert, idempotensnycklar ([ADR-0003](docs/decisions/0003-dubbelbokning-och-samtidighet.md)) |
| Tid och datum | Hur hanteras tidszoner och sommartid? | Arbetstider i väggklocka, allt annat i `timestamptz` ([ADR-0004](docs/decisions/0004-tid-och-tidszoner.md)) |
| Tillgänglighet | Hur räknas lediga tider ut från arbetstider, frånvaro och bokningar? | Multiranges i SQL och tidsluckor i en ren funktion ([ADR-0005](docs/decisions/0005-tillganglighetsmotor.md)) |
| Inloggning | Sessioner eller JWT, eget eller färdigt bibliotek? | Egna sessioner i PostgreSQL, eftersom Lucia inte längre utvecklas ([ADR-0008](docs/decisions/0008-autentisering-och-behorighet.md)) |
| Personuppgifter | Vad kräver GDPR för kunddata? | Minimal insamling, export och anonymisering ([ADR-0010](docs/decisions/0010-personuppgifter.md)) |
| Driftsättning | Var kan demon köras billigt? | Öppen, avgörs i Fas 5 |

## Teknik

Bekräftat i Fas 0. Motiveringarna finns i ADR:erna.

| Del | Val | Motivering |
| --- | --- | --- |
| Språk | TypeScript | Samma språk och delade typer i frontend och backend |
| Backend | Node.js 26 med Fastify, TypeBox och Kysely | Inbyggd schemavalidering, OpenAPI från koden och typade frågor ([ADR-0006](docs/decisions/0006-dataatkomst-och-migreringar.md), [ADR-0007](docs/decisions/0007-api-kontrakt-och-fel.md)) |
| Databas | PostgreSQL 18 | Constraints på tidsintervall, multiranges och `uuidv7()` ([ADR-0002](docs/decisions/0002-postgresql-som-kalla-till-sanning.md)) |
| Frontend | React med Vite | Stort ekosystem och enkel uppsättning |
| Tester | Vitest, Testcontainers och Playwright | Tester mot riktig PostgreSQL samt tester av hela flöden ([ADR-0009](docs/decisions/0009-teststrategi.md)) |
| Drift | Docker och GitHub Actions | Samma miljö lokalt och i CI |

## Datamodell

Den fullständiga modellen, med ER-diagram och en tabell över vilka regler som garanteras av databasen, finns i [`docs/database/`](docs/database/). Schemautkastet [`schema.sql`](docs/database/schema.sql) har validerats mot PostgreSQL med kontroller för sommartid, buffert, avbokning och frånvaro.

Kärnan är att dubbelbokningar stoppas av databasen, även om två förfrågningar kommer in samtidigt. Constraintet gäller den tid personalen är upptagen *inklusive* buffert, och den tiden räknas ut av en trigger:

```sql
CONSTRAINT booking_no_overlap EXCLUDE USING gist (
  staff_id WITH =,
  blocked WITH &&
) WHERE (status <> 'cancelled')
```

En översikt över arkitektur och mappstruktur finns i [`docs/architecture.md`](docs/architecture.md).

## Plan

### Fas 0: Research och design

- [ ] Gå igenom researchfrågorna och skriv ner besluten (kvar: liknande system och driftsättning)
- [x] Fastställ MVP och datamodell
- [x] Skissa de viktigaste vyerna
- [x] Skriv en första API-specifikation

**Klart när:** alla preliminära val är bekräftade eller ändrade.

### Fas 1: Projektgrund

- [ ] Sätt upp backend, frontend och PostgreSQL med Docker Compose
- [ ] Lägg till migreringar och testdata
- [ ] Sätt upp linting, tester och CI i GitHub Actions

**Klart när:** projektet startar med ett kommando och CI körs på varje pull request.

### Fas 2: Bokningskärnan

- [ ] Skapa tabeller och constraint för bokningar
- [ ] Bygg API för tjänster och bokningar
- [ ] Beräkna lediga tider
- [ ] Testa samtidiga bokningar, sommartid och avbokning

**Klart när:** ett test med parallella bokningar av samma tid ger exakt en lyckad bokning.

### Fas 3: Inloggning och administration

- [ ] Lägg till inloggning och roller
- [ ] Bygg API för kunder, personal och arbetstider

**Klart när:** tester visar att varje roll bara kommer åt det den ska.

### Fas 4: Gränssnitt

- [ ] Bygg bokningsflödet för kunder
- [ ] Bygg kalender och administrationsvyer för personal
- [ ] Säkerställ att sidorna fungerar på mobil och med tangentbord
- [ ] Skriv Playwright-tester för de viktigaste flödena

**Klart när:** det går att genomföra en bokning från början till slut i webbläsaren.

### Fas 5: Lansering

- [ ] Skicka bekräftelser via e-post
- [ ] Lägg till loggning, felhantering och rate limiting
- [ ] Driftsätt en demo med påhittad testdata
- [ ] Färdigställ README med skärmbilder, arkitekturbild och instruktioner

**Klart när:** demon är publik och går att prova utan installation.

## Licens

MIT (läggs till när koden påbörjas).
