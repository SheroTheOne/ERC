# ADR-0009: Vitest mot riktig PostgreSQL, Playwright för flöden

- **Status:** Accepterad
- **Datum:** 2026-11-07

## Kontext

Det viktigaste beteendet sitter i databasen: constraints, triggers, multiranges och tidszoner. Mockar eller SQLite skulle testa något annat än det som körs i produktion.

## Beslut

| Nivå | Verktyg | Vad testas |
| --- | --- | --- |
| Enhet | Vitest, fast-check | Rena funktioner: tidsluckor, tidsrutnät, felmappning, validering |
| Databas | Vitest + PostgreSQL 18 | Constraints, triggers och SQL-funktionerna, direkt i SQL |
| Integration | Vitest + `fastify.inject` + PostgreSQL 18 | HTTP-kontrakt, behörighet, felformat, samtidighet |
| Hela flöden | Playwright | Kund bokar och avbokar, personal hanterar kalendern |

- **Databasinstans:** finns `TEST_DATABASE_URL` används den (CI-tjänst eller lokal instans). Annars startar Testcontainers `postgres:18`. Samma kod fungerar alltså med och utan Docker.
- **Isolering:** migreringarna körs en gång till en mallversion (`erc_template`). Varje testfil får en egen databas med `CREATE DATABASE … TEMPLATE erc_template`, vilket tar några millisekunder. Testfiler kan då köras parallellt. Mönstret med en transaktion som rullas tillbaka efter varje test används **inte**, eftersom samtidighetstester behöver riktiga, separata anslutningar som committar.
- **Samtidighetstester:**
  - 20 samtidiga `POST /bookings` mot samma tid, via `Promise.all` och en pool med minst 20 anslutningar. Förväntat resultat: exakt en 201, 19 svar med 409 och typen `slot-unavailable`, och exakt en aktiv rad i databasen.
  - Samma test direkt i SQL med 20 anslutningar, utan HTTP-lagret, så att det är constraintet som verifieras och inte applikationskoden.
  - **Deterministisk spärr:** en separat anslutning håller en ocommittad bokning på samma tid. Alla 20 anrop blockeras då i constraint-kontrollen, eftersom `EXCLUDE` väntar på den ocommittade raden. Testet väntar tills `pg_stat_activity` visar 20 sessioner med `wait_event_type = 'Lock'` och rullar sedan tillbaka spärrens transaktion. Alla 20 tävlar då om samma rad samtidigt. Ett test som bara gör `Promise.all` kan bli grönt av en slump, om anropen råkar köras ett i taget.
  - Testet körs 50 gånger i CI-jobbet `stress` för att fånga instabilitet.
- **Tid i tester:** klockan injiceras (`Clock`-interface) och `Date.now()` anropas aldrig direkt i domänkoden. Tester för sommartid använder fasta datum (2026-03-29, 2026-10-25) och tidszonerna `Europe/Stockholm` och `America/New_York`.
- **CI:** GitHub Actions med en `postgres:18`-tjänst. Lint, typkontroll, enhetstester, integrationstester och Playwright körs på varje pull request.

## Konsekvenser

- Lokalt krävs antingen Docker (eller Podman) eller en egen PostgreSQL 18-instans.
- Schemautkastet i Fas 0 validerades med PGlite (PostgreSQL 17 kompilerat till WASM, en enda anslutning) och 26 kontroller som täcker sommartid, buffert, avbokning och frånvaro. Samtidighet kan inte testas så, och det görs därför i Fas 2 med riktig PostgreSQL.

## Alternativ som valdes bort

- **pg-mem, SQLite eller PGlite i den ordinarie testsviten:** saknar stöd för `EXCLUDE`, flera anslutningar eller båda.
- **En delad testdatabas som töms mellan tester:** långsamt och gör det omöjligt att köra tester parallellt.
