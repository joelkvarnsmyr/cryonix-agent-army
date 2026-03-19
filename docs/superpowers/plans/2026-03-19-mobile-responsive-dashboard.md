# Mobile Responsive Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Cryonix dashboard fully functional and visually polished on mobile devices, with a proper hamburger menu, touch-friendly navigation, and responsive content layouts.

**Architecture:** Replace the horizontal agent button bar (which overflows on mobile) with a hamburger-triggered Sheet (slide-from-left drawer) on screens < 768px. Keep the desktop nav unchanged. Improve mobile padding, footer, and content area spacing.

**Tech Stack:** Next.js 15, React 19, Tailwind CSS, shadcn/ui Sheet component (already in `@cryonix/ui`), Lucide icons

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/ui/src/index.ts` | Export Sheet components from `@cryonix/ui` |
| Create | `apps/web/src/components/dashboard/mobile-nav.tsx` | Hamburger button + Sheet drawer with full agent navigation |
| Modify | `apps/web/src/components/dashboard/dashboard-layout.tsx` | Integrate MobileNav, hide desktop nav on mobile, improve spacing |
| Modify | `apps/web/src/components/dashboard/dashboard-layout.tsx` | Show Cmd+K trigger on mobile |

---

### Task 1: Export Sheet from @cryonix/ui

**Files:**
- Modify: `packages/ui/src/index.ts`

- [ ] **Step 1: Add Sheet exports to the UI package barrel file**

Add this line after the existing Dialog export (line 11):

```typescript
export { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from './components/sheet';
```

- [ ] **Step 2: Verify the build succeeds**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to Sheet imports

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/index.ts
git commit -m "feat(ui): export Sheet components from @cryonix/ui"
```

---

### Task 2: Create MobileNav Component

**Files:**
- Create: `apps/web/src/components/dashboard/mobile-nav.tsx`

- [ ] **Step 1: Create the MobileNav component**

```tsx
"use client";

import { useState } from 'react';
import Link from 'next/link';
import { Menu, ChevronRight } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@cryonix/ui';
import { NAV_GROUPS, isActive, isGroupActive } from './dashboard-layout';

type NavGroup = (typeof NAV_GROUPS)[number];

interface MobileNavProps {
  pathname: string;
}

export function MobileNav({ pathname }: MobileNavProps) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          className="md:hidden flex items-center justify-center h-8 w-8 rounded-md hover:bg-muted/30 transition-colors"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5 text-foreground/70" />
        </button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="w-72 bg-background/95 backdrop-blur-xl border-border/30 p-0"
      >
        <SheetHeader className="px-4 pt-4 pb-2 border-b border-border/20">
          <SheetTitle className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
              <span className="text-primary font-mono text-xs font-bold">CX</span>
            </div>
            <div className="flex flex-col leading-none gap-0.5">
              <span className="font-semibold text-sm tracking-wide text-foreground/90">CRYONIX</span>
              <span className="text-[8px] font-mono text-muted-foreground/40 tracking-widest">NEXUS v2</span>
            </div>
          </SheetTitle>
        </SheetHeader>

        <nav className="flex flex-col py-2 overflow-y-auto max-h-[calc(100vh-80px)]">
          {NAV_GROUPS.map((group) => {
            const active = isGroupActive(group, pathname);
            const Icon = group.items[0].icon;

            return (
              <div key={group.id} className="px-2">
                {/* Agent group header */}
                <Link
                  href={group.items[0].href}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all ${
                    active
                      ? `bg-muted/30 ${group.accent}`
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/15'
                  }`}
                >
                  <span className={`h-2 w-2 rounded-full shrink-0 ${active ? group.dot : 'bg-muted-foreground/30'}`} />
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="text-sm font-medium">{group.items[0].label}</span>
                  <span className="text-[9px] font-mono opacity-40 ml-auto">{group.items[0].desc}</span>
                </Link>

                {/* Sub-pages (expanded when active) */}
                {active && group.subPages && group.subPages.length > 0 && (
                  <div className="ml-7 mt-0.5 mb-1 flex flex-col gap-0.5">
                    {group.subPages.map((sp) => {
                      const subActive = isActive(sp.href, pathname);
                      return (
                        <Link
                          key={sp.href}
                          href={sp.href}
                          onClick={() => setOpen(false)}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-mono transition-all ${
                            subActive
                              ? `${group.accent} bg-background/60 border border-border/30`
                              : 'text-muted-foreground/60 hover:text-foreground/70 hover:bg-muted/15'
                          }`}
                        >
                          <ChevronRight className="h-3 w-3 shrink-0 opacity-40" />
                          {sp.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/dashboard/mobile-nav.tsx
git commit -m "feat(dashboard): add MobileNav hamburger drawer component"
```

---

### Task 3: Integrate MobileNav into Dashboard Layout

**Files:**
- Modify: `apps/web/src/components/dashboard/dashboard-layout.tsx:1-442`

This task modifies the main layout to:
1. Import and render `MobileNav` (hamburger) visible only on mobile (< md)
2. Hide the horizontal agent button row on mobile (show only on md+)
3. Hide some right-side controls on mobile to reduce clutter
4. Improve main content padding for mobile

- [ ] **Step 1: Add MobileNav import**

At top of file, after the existing imports (after line 13), add:

```typescript
import { MobileNav } from '@/components/dashboard/mobile-nav';
```

- [ ] **Step 2: Export NAV_GROUPS and helper functions**

MobileNav imports `NAV_GROUPS`, `isActive`, and `isGroupActive` directly from `dashboard-layout.tsx`. Export them:

Change `const NAV_GROUPS = [` to `export const NAV_GROUPS = [`
Change `function isActive(` to `export function isActive(`
Change `function isGroupActive(` to `export function isGroupActive(`

- [ ] **Step 3: Add hamburger button to the nav (mobile only)**

In the main nav row (line 286), between the Logo and the Divider, add the MobileNav component. The hamburger should appear before the logo on mobile.

Replace the `{/* Left: Logo + nav groups */}` div (lines 288-331) with:

```tsx
{/* Left: Logo + nav groups */}
<div className="flex items-center gap-3 min-w-0">

  {/* Mobile hamburger */}
  <MobileNav pathname={pathname} />

  {/* Logo */}
  <Link href="/" className="flex items-center gap-2 group shrink-0">
    <div className="relative">
      <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20 group-hover:border-primary/40 transition-colors">
        <span className="text-primary font-mono text-xs font-bold">CX</span>
      </div>
      <div className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary animate-pulse-dot" />
    </div>
    <div className="hidden sm:flex flex-col leading-none gap-0.5">
      <span className="font-semibold text-sm tracking-wide text-foreground/90">CRYONIX</span>
      <span className="text-[8px] font-mono text-muted-foreground/40 tracking-widest">NEXUS v2</span>
    </div>
  </Link>

  {/* Divider — hidden on mobile */}
  <div className="hidden md:block h-5 w-px bg-border/30 shrink-0" />

  {/* Instance buttons — hidden on mobile, shown on md+ */}
  <div className="hidden md:flex items-center gap-1 overflow-x-auto scrollbar-none">
    {NAV_GROUPS.map((group) => {
      const Icon = group.items[0].icon;
      const active = isGroupActive(group, pathname);
      return (
        <Link key={group.id} href={group.items[0].href}>
          <button
            title={group.items[0].desc}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
              active
                ? `bg-background/80 ${group.accent} shadow-sm border border-border/40`
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/20'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${active ? group.dot : 'bg-muted-foreground/30'}`} />
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden sm:inline">{group.items[0].label}</span>
          </button>
        </Link>
      );
    })}
  </div>
</div>
```

- [ ] **Step 4: Simplify right-side controls for mobile**

In the right controls section (lines 334-385), hide the clock and WS status details on very small screens. Replace:

```tsx
{/* WS status */}
<div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/20">
  {isConnected
    ? <Wifi className="h-3 w-3 text-emerald-400" />
    : <WifiOff className="h-3 w-3 text-red-400" />
  }
  <span className="text-[9px] font-mono text-muted-foreground/60">
    {isConnected ? 'LIVE' : 'OFF'}
  </span>
</div>

{/* Clock */}
<LiveClock />
```

with:

```tsx
{/* WS status */}
<div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/20">
  {isConnected
    ? <Wifi className="h-3 w-3 text-emerald-400" />
    : <WifiOff className="h-3 w-3 text-red-400" />
  }
  <span className="hidden sm:inline text-[9px] font-mono text-muted-foreground/60">
    {isConnected ? 'LIVE' : 'OFF'}
  </span>
</div>

{/* Clock — hidden on mobile */}
<div className="hidden sm:block">
  <LiveClock />
</div>
```

- [ ] **Step 5: Improve main content mobile padding**

Change the main content area (line 429):

From:
```tsx
<main className="relative z-10 flex-1 overflow-y-auto p-3">
```

To:
```tsx
<main className="relative z-10 flex-1 overflow-y-auto p-2 sm:p-3">
```

- [ ] **Step 6: Verify no TypeScript errors**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/dashboard/dashboard-layout.tsx
git commit -m "feat(dashboard): integrate mobile hamburger nav + responsive improvements"
```

---

### Task 4: Improve Footer for Mobile

**Files:**
- Modify: `apps/web/src/components/dashboard/dashboard-layout.tsx` (DashboardFooter function, lines 184-257)

The footer currently hides all useful content on mobile. Make it show a compact version with agent dots.

- [ ] **Step 1: Replace the footer center nav section**

Replace the center nav section (lines 209-237) with a mobile-friendly version:

```tsx
{/* Center: quick-link grid — compact dots on mobile, full labels on lg+ */}
<nav className="flex items-center gap-2 sm:gap-3 flex-wrap justify-center">
  {/* Mobile: compact agent dots */}
  <div className="flex lg:hidden items-center gap-1.5">
    {NAV_GROUPS.map((group) => {
      const active = group.items.some(item => isActive(item.href, pathname));
      return (
        <Link key={group.id} href={group.items[0].href} title={group.items[0].label}>
          <span className={`inline-block h-2 w-2 rounded-full transition-all ${
            active ? `${group.dot} scale-125` : 'bg-muted-foreground/25 hover:bg-muted-foreground/45'
          }`} />
        </Link>
      );
    })}
  </div>

  {/* Desktop: full labels */}
  <div className="hidden lg:flex items-center gap-3">
    {NAV_GROUPS.map((group, gi) => (
      <div key={group.id} className="flex items-center gap-2">
        {gi > 0 && <span className="text-border/30 text-[10px]">|</span>}
        <span className={`text-[8px] font-mono font-bold tracking-widest opacity-40 ${group.accent}`}>
          {group.label}
        </span>
        {group.items.map((item) => {
          const active = isActive(item.href, pathname);
          return (
            <Link key={item.href} href={item.href} title={item.desc}>
              <span className={`text-[9px] font-mono transition-colors ${
                active ? group.accent : 'text-muted-foreground/45 hover:text-foreground/65'
              }`}>
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
    ))}
  </div>
</nav>
```

Note: `isActive` is a module-level function in the same file as `DashboardFooter`, so it's already in scope.

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/dashboard/dashboard-layout.tsx
git commit -m "feat(dashboard): mobile-friendly footer with compact agent dots"
```

---

### Task 5: Update Command Palette for Mobile Access

**Files:**
- Modify: `apps/web/src/components/dashboard/dashboard-layout.tsx` (line 355-361)

The Cmd+K button is hidden on mobile (`hidden md:flex`). On mobile, the command palette is the only way to navigate quickly since the horizontal nav is gone. Show a simplified trigger on mobile too.

- [ ] **Step 1: Make Cmd+K button visible on all screens**

Change the Cmd+K button (line 355-361):

From:
```tsx
<button
  onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
  className="hidden md:flex items-center gap-1 px-2 py-1 rounded-md bg-muted/20 hover:bg-muted/40 transition-colors"
  aria-label="Open command palette"
>
  <span className="text-[9px] font-mono text-muted-foreground/60">⌘K</span>
</button>
```

To:
```tsx
<button
  onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
  className="flex items-center gap-1 px-2 py-1 rounded-md bg-muted/20 hover:bg-muted/40 transition-colors"
  aria-label="Open command palette"
>
  <span className="text-[9px] font-mono text-muted-foreground/60">⌘K</span>
</button>
```

(Simply remove `hidden md:` prefix)

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/dashboard/dashboard-layout.tsx
git commit -m "feat(dashboard): show command palette trigger on mobile"
```

---

### Task 6: Visual QA & Build Verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run TypeScript check**

Run: `cd c:/Projects/Code/Crypto/cryonix-agent-army && pnpm type-check`
Expected: No errors

- [ ] **Step 2: Run production build**

Run: `cd c:/Projects/Code/Crypto/cryonix-agent-army && pnpm build`
Expected: Build succeeds

- [ ] **Step 3: Final commit if any fixes needed**

If build revealed issues, fix and commit with:
```bash
git commit -m "fix(dashboard): resolve build issues from mobile responsiveness changes"
```

---

## Summary of Mobile Behavior After Implementation

| Screen Size | Nav Behavior |
|-------------|-------------|
| **< 768px (mobile)** | Hamburger menu (☰) → Sheet drawer slides from left with all 7 agents + sub-pages. Desktop button row hidden. Clock hidden. WS shows icon only. Footer shows colored agent dots. |
| **768px–1024px (tablet)** | Desktop horizontal nav buttons with icons + labels. Service health hidden. Full footer. |
| **1024px+ (desktop)** | Full nav with service health pills, clock, all footer labels. No changes from current. |
