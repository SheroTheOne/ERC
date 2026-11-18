import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

// Demodatan från apps/api/db/seed/seed.ts. Bokningar från tidigare körningar finns kvar,
// så testerna väljer alltid första lediga tid i stället för en fast tid.
const BUSINESS = 'Salong Exempel';
const SERVICE = 'Klippning';
const SLOT_BUTTON = /^\d\d:\d\d$/;

interface SlotJson {
  readonly startsAt: string;
  readonly staffIds: readonly string[];
}
interface AvailabilityJson {
  readonly serviceId: string;
  readonly days: readonly { readonly date: string; readonly slots: readonly SlotJson[] }[];
}

/**
 * Väntar på tiderna och går till nästa vecka om den här är fullbokad (t.ex. sent på söndagen).
 * Returnerar svaret från API:t, så att testet vet vilken instant första knappen motsvarar.
 */
async function waitForSlots(page: Page, load: () => Promise<unknown>): Promise<SlotJson> {
  for (let week = 0; week < 3; week++) {
    const response = page.waitForResponse((r) => r.url().includes('/api/v1/availability?'));
    await load();
    const body = (await (await response).json()) as AvailabilityJson;
    const first = body.days.find((day) => day.slots.length > 0)?.slots[0];
    if (first !== undefined) {
      await expect(page.getByRole('button', { name: SLOT_BUTTON }).first()).toBeVisible();
      return first;
    }
    load = () => page.getByRole('button', { name: 'Nästa vecka' }).click();
  }
  throw new Error('Inga lediga tider de närmaste tre veckorna');
}

async function openService(page: Page): Promise<SlotJson> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: BUSINESS })).toBeVisible();
  return waitForSlots(page, () => page.getByRole('button', { name: new RegExp(SERVICE) }).click());
}

async function fillContact(page: Page, email: string) {
  await page.getByLabel('Namn').fill('Testa Testsson');
  await page.getByLabel('E-post').fill(email);
  await page.getByLabel(/Telefon/).fill('070-123 45 67');
}

const uniqueEmail = () => `e2e-${randomUUID().slice(0, 8)}@example.com`;

test('kunden bokar en tid från början till slut', async ({ page }) => {
  await openService(page);
  await expect(page.getByRole('heading', { level: 2 })).toContainText(SERVICE);

  await page.getByRole('button', { name: SLOT_BUTTON }).first().click();
  await expect(page.getByRole('heading', { level: 2, name: 'Bekräfta' })).toBeFocused();

  const email = uniqueEmail();
  await fillContact(page, email);
  await page.getByRole('button', { name: 'Boka tiden' }).click();

  await expect(page.getByRole('heading', { name: 'Tiden är bokad' })).toBeVisible();
  await expect(page.getByText(SERVICE, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
});

test('felaktiga uppgifter visas vid fälten och skickas inte', async ({ page }) => {
  let posted = false;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/v1/bookings')) posted = true;
  });

  await openService(page);
  await page.getByRole('button', { name: SLOT_BUTTON }).first().click();
  await page.getByLabel('E-post').fill('inte-en-adress');
  await page.getByLabel(/Telefon/).fill('12');
  await page.getByRole('button', { name: 'Boka tiden' }).click();

  await expect(page.getByLabel('Namn')).toBeFocused();
  await expect(page.getByLabel('Namn')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Skriv en giltig e-postadress.')).toBeVisible();
  await expect(page.getByText(/Skriv ett giltigt telefonnummer/)).toBeVisible();
  expect(posted).toBe(false);
});

test('en tid som hinner bokas av någon annan ger ett tydligt besked', async ({ page }) => {
  await openService(page);

  // Välj en bestämd person, så att tiden säkert försvinner när den bokas nedan.
  const staffSelect = page.getByLabel('Personal');
  await expect(staffSelect).toBeEnabled();
  const staffId = await staffSelect.locator('option').nth(1).getAttribute('value');
  expect(staffId).not.toBeNull();
  const slot = await waitForSlots(page, () => staffSelect.selectOption(staffId ?? ''));

  await page.getByRole('button', { name: SLOT_BUTTON }).first().click();
  const email = uniqueEmail();
  await fillContact(page, email);

  // En annan kund tar samma tid hos samma person under tiden.
  const services = (await (await page.request.get('/api/v1/services')).json()) as {
    items: { id: string; name: string }[];
  };
  const serviceId = services.items.find((service) => service.name === SERVICE)?.id;
  const taken = await page.request.post('/api/v1/bookings', {
    headers: { 'idempotency-key': randomUUID() },
    data: {
      serviceId,
      staffId,
      startsAt: slot.startsAt,
      contact: { name: 'Någon Annan', email: uniqueEmail() },
    },
  });
  expect(taken.status()).toBe(201);

  await page.getByRole('button', { name: 'Boka tiden' }).click();

  await expect(page.getByRole('alert')).toHaveText(
    'Tiden hann bokas av någon annan. Välj en ny tid.',
  );
  await expect(page.getByRole('button', { name: SLOT_BUTTON }).first()).toBeVisible();

  // Formuläret finns kvar när kunden väljer en ny tid.
  await page.getByRole('button', { name: SLOT_BUTTON }).first().click();
  await expect(page.getByLabel('E-post')).toHaveValue(email);
  await page.getByRole('button', { name: 'Boka tiden' }).click();
  await expect(page.getByRole('heading', { name: 'Tiden är bokad' })).toBeVisible();
});

test('flödet går att använda med tangentbordet', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 2, name: 'Välj tjänst' })).toBeFocused();

  // Första tjänsten i listan (alfabetisk ordning), vald med Tab och Enter.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /min/ }).first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Tillbaka' })).toBeVisible();

  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Tillbaka' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: 'Välj tjänst' })).toBeFocused();
});

test('sidan får ingen sidledsscroll', async ({ page }) => {
  await openService(page);
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflows).toBe(false);
});
