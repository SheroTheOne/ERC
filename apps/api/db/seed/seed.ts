// Påhittad demodata (ADR-0010). Idempotent: fasta id:n och ON CONFLICT DO NOTHING,
// så att skriptet kan köras flera gånger och e2e-tester kan referera till id:na.
import process from 'node:process';
import { loadConfig } from '../../src/config.ts';
import { createDatabase, createPool, type Database } from '../../src/db/database.ts';

export const SEED = {
  users: {
    alva: '01900000-0000-7000-8000-000000000001',
    anna: '01900000-0000-7000-8000-000000000002',
    bo: '01900000-0000-7000-8000-000000000003',
  },
  staff: {
    alva: '01900000-0000-7000-8000-0000000000a1',
    anna: '01900000-0000-7000-8000-0000000000a2',
    bo: '01900000-0000-7000-8000-0000000000a3',
  },
  services: {
    haircut: '01900000-0000-7000-8000-0000000000c1',
    beard: '01900000-0000-7000-8000-0000000000c2',
    colour: '01900000-0000-7000-8000-0000000000c3',
  },
  customers: {
    kim: '01900000-0000-7000-8000-0000000000b1',
    robin: '01900000-0000-7000-8000-0000000000b2',
  },
} as const;

const VALID_FROM = '2026-01-01';

type Shift = readonly [weekday: number, start: string, end: string];

const SCHEDULES: Readonly<Record<keyof typeof SEED.staff, readonly Shift[]>> = {
  alva: [
    [1, '09:00', '15:00'],
    [3, '09:00', '15:00'],
    [5, '09:00', '15:00'],
  ],
  anna: [1, 2, 3, 4, 5].flatMap((day): Shift[] => [
    [day, '09:00', '12:00'],
    [day, '13:00', '17:00'],
  ]),
  bo: [2, 3, 4, 5, 6].map((day): Shift => [day, '10:00', '18:00']),
};

export async function seed(db: Database): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('business')
      .values({ name: 'Salong Exempel', timezone: 'Europe/Stockholm' })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    // Lösenord sätts när inloggningen byggs i Fas 3.
    await trx
      .insertInto('appUser')
      .values([
        { id: SEED.users.alva, email: 'alva@erc.example', role: 'admin' },
        { id: SEED.users.anna, email: 'anna@erc.example', role: 'staff' },
        { id: SEED.users.bo, email: 'bo@erc.example', role: 'staff' },
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await trx
      .insertInto('staff')
      .values([
        { id: SEED.staff.alva, userId: SEED.users.alva, displayName: 'Alva' },
        { id: SEED.staff.anna, userId: SEED.users.anna, displayName: 'Anna' },
        { id: SEED.staff.bo, userId: SEED.users.bo, displayName: 'Bo' },
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await trx
      .insertInto('service')
      .values([
        {
          id: SEED.services.haircut,
          name: 'Klippning',
          description: 'Tvätt, klippning och styling.',
          durationMinutes: 45,
          bufferAfterMinutes: 15,
          priceOre: 45_000,
        },
        {
          id: SEED.services.beard,
          name: 'Skäggtrimning',
          durationMinutes: 20,
          priceOre: 25_000,
        },
        {
          id: SEED.services.colour,
          name: 'Färgning',
          description: 'Helfärg inklusive konsultation.',
          durationMinutes: 90,
          bufferBeforeMinutes: 10,
          bufferAfterMinutes: 15,
          priceOre: 120_000,
        },
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await trx
      .insertInto('staffService')
      .values([
        { staffId: SEED.staff.alva, serviceId: SEED.services.haircut },
        { staffId: SEED.staff.alva, serviceId: SEED.services.colour },
        { staffId: SEED.staff.anna, serviceId: SEED.services.haircut },
        { staffId: SEED.staff.anna, serviceId: SEED.services.beard },
        { staffId: SEED.staff.bo, serviceId: SEED.services.haircut },
        { staffId: SEED.staff.bo, serviceId: SEED.services.beard },
        { staffId: SEED.staff.bo, serviceId: SEED.services.colour },
      ])
      .onConflict((oc) => oc.columns(['staffId', 'serviceId']).doNothing())
      .execute();

    const existingHours = await trx
      .selectFrom('workingHours')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    if (existingHours.count === '0') {
      await trx
        .insertInto('workingHours')
        .values(
          Object.entries(SCHEDULES).flatMap(([staff, shifts]) =>
            shifts.map(([weekday, startTime, endTime]) => ({
              staffId: SEED.staff[staff as keyof typeof SEED.staff],
              weekday,
              startTime,
              endTime,
              validFrom: VALID_FROM,
            })),
          ),
        )
        .execute();
    }

    await trx
      .insertInto('customer')
      .values([
        {
          id: SEED.customers.kim,
          email: 'kim@example.com',
          name: 'Kim Svensson',
          phone: '+46701234567',
        },
        { id: SEED.customers.robin, email: 'robin@example.com', name: 'Robin Ek' },
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  });
}

if (import.meta.main) {
  const config = loadConfig(process.env);
  if (config.env === 'production') {
    console.error('Refusing to seed a production database.');
    process.exit(1);
  }
  const db = createDatabase(
    createPool({
      connectionString: config.databaseUrl,
      max: 1,
      applicationName: 'erc-seed',
      onIdleError: (error) => {
        console.error('idle database client error', error);
      },
    }),
  );
  try {
    await seed(db);
    console.log('Seed data loaded.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}
