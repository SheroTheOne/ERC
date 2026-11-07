# ADR-0011: Node.js kör TypeScript direkt, TypeScript 6 för typkontroll

- **Status:** Accepterad
- **Datum:** 2026-11-07

## Kontext

Backend och de delade kontrakten är TypeScript. Den klassiska lösningen är att kompilera till `dist/` med `tsc` eller köra via `tsx`. Det ger ett extra steg, källkodskartor och en risk att `dist/` och källkoden skiljer sig. Node.js 26 kan köra TypeScript direkt genom att ta bort typerna (type stripping), utan någon transformering.

TypeScript 7 (den nya kompilatorn skriven i Go) har släppts, men `typescript-eslint` 8.72 stöder bara TypeScript `< 6.1`.

## Beslut

- **API:t, migreringarna och seeden körs med `node fil.ts`,** både i utveckling (`node --watch`) och i produktion. Det finns inget byggsteg för backend.
- Därför gäller `erasableSyntaxOnly` (inga `enum`, `namespace` eller parameteregenskaper), `verbatimModuleSyntax` och importer med filändelsen `.ts` (`allowImportingTsExtensions`, `noEmit`).
- `packages/contracts` exporterar `./src/index.ts` direkt. Det fungerar eftersom workspace-länken löses upp till `packages/contracts`, och Node tar bara bort typer i filer som ligger utanför `node_modules`.
- **TypeScript 6.0 används för typkontroll** (`tsc --noEmit`). Byte till TypeScript 7 görs när `typescript-eslint` stöder det.
- Webben byggs av Vite som vanligt.

## Konsekvenser

- Den kod som körs är exakt den som granskas. Stackspår pekar på rätt rader utan källkodskartor.
- Typfel stoppar inte körningen, de fångas av `npm run typecheck` i CI.
- Docker-avbildningen behöver bara produktionsberoenden och källkod.

## Alternativ som valdes bort

- **`tsc` till `dist/`:** ger ett extra steg och en till sak som kan gå isär.
- **`tsx` eller `ts-node`:** extra beroende för något som Node nu gör själv.
- **TypeScript 7 utan typmedveten linting:** reglerna `no-unsafe-*` och `no-floating-promises` är viktigare än en snabbare kompilator.
