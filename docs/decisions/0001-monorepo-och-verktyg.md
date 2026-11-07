# ADR-0001: Monorepo med npm workspaces, Node.js 26 och strikt TypeScript

- **Status:** Accepterad
- **Datum:** 2026-11-07

## Kontext

Backend och frontend delar API-kontrakt. Om kontrakten dupliceras glider de isär. Projektet har en utvecklare, så verktygen ska vara få och vanliga.

## Beslut

- **Ett repo med npm workspaces:** `apps/api`, `apps/web` och `packages/contracts`. Se [arkitekturöversikten](../architecture.md) för hela strukturen.
- **Node.js 26**, som är aktiv LTS sedan oktober 2026. Versionen låses i `.nvmrc` och i `engines`.
- **npm som pakethanterare.** Det följer med Node, och Corepack ingår inte längre i Node 25 och senare, så pnpm eller Yarn skulle kräva ett extra installationssteg.
- **TypeScript i strikt läge** med bland annat `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` och `verbatimModuleSyntax`. Bara ESM.
- **ESLint med `typescript-eslint` `strictTypeChecked`.** `no-explicit-any` och `no-unsafe-*` är fel, inte varningar. Prettier sköter formatering så att ESLint bara kontrollerar korrekthet.

## Konsekvenser

- En typändring i `packages/contracts` bryter bygget i båda apparna direkt.
- npm workspaces har ingen inbyggd cache för uppgifter. Det duger i den här storleken och kan kompletteras med Turborepo om byggtiderna blir ett problem.

## Alternativ som valdes bort

- **pnpm:** strängare beroendeisolering, men kräver extra installation nu när Corepack inte följer med Node.
- **Separata repon:** kontrakten skulle behöva publiceras som paket och versioneras, vilket är onödigt arbete för en utvecklare.
- **Nx eller Turborepo från start:** löser problem som projektet inte har ännu.
