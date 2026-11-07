# ADR-0006: Kysely och node-postgres, migreringar som rena SQL-filer

- **Status:** Accepterad
- **Datum:** 2026-11-07

## Kontext

Schemat använder `EXCLUDE`, range-typer, multiranges, triggers och SQL-funktioner. Det mesta av det kan ORM:er inte uttrycka. Samtidigt ska frågorna vara typade så att `any` aldrig behövs.

## Beslut

- **Drivrutin:** `pg` (node-postgres) med en pool. Varje anslutning sätter `search_path = erc` och `TimeZone = 'UTC'`. Datumtyperna får egna parsers, så att `timestamptz` blir ISO-strängar och `tstzrange` parsas explicit.
- **Frågor:** Kysely som typad frågebyggare. Specialoperatorer (`&&`, `<@`, multiranges) skrivs med `sql`-mallar och explicita returtyper.
- **Typer genereras från databasen** med `kysely-codegen` efter migrering. Det är databasen som definierar typerna, inte tvärtom. CI kontrollerar att de genererade typerna är uppdaterade.
- **Migreringar som `.sql`-filer** i `apps/api/db/migrations/NNNN_namn.sql`, körda av Kyselys `Migrator` via en egen `MigrationProvider`. Varje migrering körs i en transaktion och Migrator tar ett lås, så två samtidiga driftsättningar kan inte köra samma migrering. Migreringar går bara framåt. En ändring rättas med en ny migrering.
- **Transaktioner:** en hjälpfunktion `withTransaction(db, fn)` och ett mönster för `SAVEPOINT` (ADR-0003). Repository-lagret tar emot en `Transaction` eller en `Kysely`, så att anroparen bestämmer transaktionsgränsen.
- **Roller:** migreringar körs som `erc_owner`. Appen kör som `erc_app`, som har `SELECT/INSERT/UPDATE/DELETE` men inte `DDL`.

## Konsekvenser

- Schemat granskas som SQL, precis som det körs, och kan köras direkt med `psql`.
- `docs/database/schema.sql` blir `0001_initial.sql` i Fas 1.

## Alternativ som valdes bort

- **Prisma:** saknar stöd för `EXCLUDE`, ranges och multiranges, så de delarna skulle hamna i rå SQL vid sidan av ORM:en.
- **Drizzle:** bättre än Prisma, men migreringar som genereras från TypeScript gör SQL-funktioner och triggers till specialfall.
- **Bara rå SQL med `pg`:** fungerar, men ger inga typade resultat utan handskrivna typer.
