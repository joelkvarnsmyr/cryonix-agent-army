import { test, expect } from '@playwright/test';

const baseUrl = 'http://localhost:3010';
const locales = ['en', 'sv'];

const IGNORED_ERRORS = [
  'Framebuffer status: Framebuffer Unsupported', // Common in headless environments without full GPU support
];

for (const locale of locales) {
  test.describe(`Website - ${locale}`, () => {
    
    test('should load home page without console errors', async ({ page }) => {
      const errors: string[] = [];
      page.on('console', msg => {
        if (msg.type() === 'error' && !IGNORED_ERRORS.some(e => msg.text().includes(e))) {
          errors.push(msg.text());
        }
      });
      page.on('pageerror', err => errors.push(err.message));

      await page.goto(`${baseUrl}/${locale}`);
      // Wait for hydration and potential async errors
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);
      
      expect(errors, `Console errors found on ${locale} home: ${errors.join(', ')}`).toHaveLength(0);
      await expect(page.locator('h1')).toBeVisible();
    });

    test('should load all guide pages', async ({ page }) => {
      const guides = [
        'best-crypto-trading-signals',
        'mcp-server-setup',
        'fail-closed-trading',
        'crypto-signal-scams',
        'bollinger-squeeze-ai',
        'ai-orchestration-architecture',
        'the-drawdown-truth'
      ];

      for (const guide of guides) {
        const errors: string[] = [];
        page.on('console', msg => {
          if (msg.type() === 'error' && !IGNORED_ERRORS.some(e => msg.text().includes(e))) {
            errors.push(msg.text());
          }
        });
        
        const url = `${baseUrl}/${locale}/guides/${guide}`;
        console.log(`Checking ${url}`);
        await page.goto(url);
        await page.waitForLoadState('networkidle');
        
        await expect(page.locator('h1'), `H1 missing on ${url}`).toBeVisible();
        expect(errors, `Console errors on ${url}: ${errors.join(', ')}`).toHaveLength(0);
      }
    });

    test('should load developers page', async ({ page }) => {
      await page.goto(`${baseUrl}/${locale}/developers`);
      await expect(page.locator('h1')).toBeVisible();
      // Should show sign in button since we aren't logged in
      const signInBtn = page.locator('main button');
      await expect(signInBtn).toBeVisible();
    });
  });
}
