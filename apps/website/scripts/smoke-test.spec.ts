import { test, expect } from '@playwright/test';

const baseUrl = 'http://localhost:3001';
const locales = ['en', 'sv'];

for (const locale of locales) {
  test.describe(`Website - ${locale}`, () => {
    
    test('should load home page', async ({ page }) => {
      await page.goto(`${baseUrl}/${locale}`);
      await expect(page).toHaveTitle(/Cryonix/);
    });

    test('should load signals page', async ({ page }) => {
      await page.goto(`${baseUrl}/${locale}/signals`);
      const h1 = page.locator('h1');
      await expect(h1).toBeVisible();
    });

    test('should load performance page', async ({ page }) => {
      await page.goto(`${baseUrl}/${locale}/performance`);
      const h1 = page.locator('h1');
      await expect(h1).toBeVisible();
    });

    test('should load guides index', async ({ page }) => {
      await page.goto(`${baseUrl}/${locale}/guides`);
      const h1 = page.locator('h1');
      await expect(h1).toBeVisible();
    });

    test('should load best crypto signals guide', async ({ page }) => {
      await page.goto(`${baseUrl}/${locale}/guides/best-crypto-trading-signals`);
      const h1 = page.locator('h1');
      await expect(h1).toBeVisible();
    });

    test('should load mcp server guide', async ({ page }) => {
      await page.goto(`${baseUrl}/${locale}/guides/mcp-server-setup`);
      const h1 = page.locator('h1');
      await expect(h1).toBeVisible();
    });

    test('should load fail-closed guide', async ({ page }) => {
      await page.goto(`${baseUrl}/${locale}/guides/fail-closed-trading`);
      const h1 = page.locator('h1');
      await expect(h1).toBeVisible();
    });

    test('should load scam spotting guide', async ({ page }) => {
      await page.goto(`${baseUrl}/${locale}/guides/crypto-signal-scams`);
      const h1 = page.locator('h1');
      await expect(h1).toBeVisible();
    });

    test('should load bollinger squeeze guide', async ({ page }) => {
      await page.goto(`${baseUrl}/${locale}/guides/bollinger-squeeze-ai`);
      const h1 = page.locator('h1');
      await expect(h1).toBeVisible();
    });

    test('should load developers page', async ({ page }) => {
      await page.goto(`${baseUrl}/${locale}/developers`);
      const h1 = page.locator('h1');
      await expect(h1).toBeVisible();
    });
  });
}
