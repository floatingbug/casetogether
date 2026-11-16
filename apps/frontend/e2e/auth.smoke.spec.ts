import { expect, test, type Page, type Route } from '@playwright/test';
import {
  ErrorResponseSchema,
  LoginRequestSchema,
  PublicUserSchema,
  type ErrorCode,
} from '@casetogether/shared';

const user = PublicUserSchema.parse({ id: 'e2e_user', displayName: 'Ada Test' });
const fictionalPassword = 'Nur-fuer-den-Browsertest-123!';

function errorBody(code: ErrorCode, message = 'Mockfehler ohne produktive Daten'): unknown {
  return ErrorResponseSchema.parse({
    error: { code, message, requestId: 'e2e_request' },
  });
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

interface MockOptions {
  meNotFound?: boolean;
  rejectLoginOrigin?: boolean;
}

async function installContractMocks(page: Page, options: MockOptions = {}): Promise<void> {
  let authenticated = false;

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const operation = `${request.method()} ${path}`;

    switch (operation) {
      case 'GET /api/v1/me':
        if (authenticated) {
          await fulfillJson(route, 200, { data: user });
        } else {
          await fulfillJson(
            route,
            options.meNotFound === true ? 404 : 401,
            errorBody(options.meNotFound === true ? 'NOT_FOUND' : 'UNAUTHENTICATED'),
          );
        }
        return;
      case 'POST /api/v1/auth/login':
        if (options.rejectLoginOrigin === true) {
          await fulfillJson(
            route,
            403,
            errorBody('CSRF_REJECTED', 'Mock detail: untrusted foreign origin'),
          );
          return;
        }
        authenticated = true;
        await fulfillJson(route, 200, { data: user });
        return;
      case 'POST /api/v1/auth/register':
        authenticated = true;
        await fulfillJson(route, 201, { data: user });
        return;
      case 'POST /api/v1/auth/logout':
        authenticated = false;
        await route.fulfill({ status: 204 });
        return;
      default:
        await fulfillJson(route, 404, errorBody('NOT_FOUND'));
    }
  });
}

async function fillLogin(page: Page): Promise<void> {
  await page.getByLabel('E-Mail-Adresse', { exact: true }).fill('ada@example.invalid');
  await page.getByLabel('Passwort', { exact: true }).fill(fictionalPassword);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > globalThis.innerWidth,
  );
  expect(hasOverflow).toBe(false);
}

test('desktop: protected redirect, mocked login and logout keep browser storage empty', async ({
  page,
}) => {
  await installContractMocks(page);

  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?redirect=\/$/);
  await expect(page.getByRole('heading', { name: 'Anmelden', exact: true })).toBeVisible();
  await expect(page.getByText('Willkommen, Ada Test.')).toHaveCount(0);

  const loginRequestPromise = page.waitForRequest('**/api/v1/auth/login');
  await fillLogin(page);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  const loginRequest = await loginRequestPromise;
  expect(loginRequest.method()).toBe('POST');
  expect(loginRequest.headers()['content-type']).toBe('application/json');
  expect(loginRequest.headers()['authorization']).toBeUndefined();
  const loginPayload: unknown = JSON.parse(loginRequest.postData() ?? '{}');
  expect(LoginRequestSchema.parse(loginPayload)).toEqual({
    email: 'ada@example.invalid',
    password: fictionalPassword,
  });

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Willkommen, Ada Test.' })).toBeVisible();
  await expect(page.getByText('Noch kein Raum geöffnet')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });

  await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Anmelden', exact: true })).toBeVisible();
  await expect(page.getByText('Willkommen, Ada Test.')).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
});

test('rejected foreign-origin response is rendered as a safe CSRF error', async ({ page }) => {
  await installContractMocks(page, { rejectLoginOrigin: true });
  await page.goto('/login');

  await fillLogin(page);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Die Anfrage wurde aus Sicherheitsgründen abgelehnt.');
  await expect(alert).not.toContainText('untrusted foreign origin');
  await expect(page.getByRole('heading', { name: 'Anmelden', exact: true })).toBeVisible();
  await expect(page.getByText('Willkommen, Ada Test.')).toHaveCount(0);
});

test('mobile viewport: registration reaches the protected responsive lobby', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installContractMocks(page);
  await page.goto('/register');

  await expect(page.getByRole('heading', { name: 'Konto erstellen', exact: true })).toBeVisible();
  await page.getByLabel('Anzeigename', { exact: true }).fill('Ada Test');
  await fillLogin(page);
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'Konto erstellen', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Willkommen, Ada Test.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abmelden', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('tablet viewport: create and join controls remain usable after mocked registration', async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await installContractMocks(page);
  await page.goto('/register');

  await page.getByLabel('Anzeigename', { exact: true }).fill('Ada Test');
  await fillLogin(page);
  await page.getByRole('button', { name: 'Konto erstellen', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Privaten Raum erstellen' })).toBeVisible();
  await expect(page.getByLabel('Einladungscode', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Raum beitreten', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Raum erstellen', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('NOT_FOUND during bootstrap clears protected content and redirects to login', async ({
  page,
}) => {
  await installContractMocks(page, { meNotFound: true });
  await page.goto('/');

  await expect(page).toHaveURL(/\/login\?redirect=\/$/);
  await expect(page.getByRole('heading', { name: 'Anmelden', exact: true })).toBeVisible();
  await expect(page.getByText('Ada Test')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});
