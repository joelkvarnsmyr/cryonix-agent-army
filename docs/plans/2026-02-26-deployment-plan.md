# Plan: Final Verification & Vercel Deployment (2026-02-26)

## 1. Quality Assurance & Final Build
- [ ] Run a clean production build of the `@cryonix/website` workspace to ensure no TypeScript or Next.js errors exist.
- [ ] Start the production server on a dedicated port (e.g., 3010).
- [ ] Execute the comprehensive Playwright test suite (`scripts/comprehensive-test.spec.ts`) against the running server.
- [ ] Verify that all 11 pages (Home, Signals, Performance, 7 Guides, Developer Dashboard) load correctly in multiple languages without any browser console errors.

## 2. Vercel Deployment Strategy
- [ ] Use the Vercel CLI (`npx vercel`) to initialize and deploy a new project.
- [ ] Since it's a monorepo (Turborepo), configure the project root to `apps/website`.
- [ ] Set up the necessary environment variables in the Vercel project (mock data toggles, etc.).
- [ ] Execute a production deployment (`npx vercel --prod --yes`). Note: This step might require interactive authentication if a Vercel token is not present in the environment.

## 3. Documentation
- [ ] Log the results of the final test run.
- [ ] Document the deployed Vercel URL.