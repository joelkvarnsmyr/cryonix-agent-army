# @cryonix/ui

Shared React component library for the Cryonix dashboard, built on shadcn/ui with Radix UI primitives, Tailwind CSS, and class-variance-authority.

## Files / Structure

```
src/
  index.ts                    # Public exports (all components + cn utility)
  utils.ts                    # cn() helper (clsx + tailwind-merge)
  components/
    accordion.tsx             alert-dialog.tsx          alert.tsx
    aspect-ratio.tsx          avatar.tsx                badge.tsx
    breadcrumb.tsx            button.tsx                calendar.tsx
    card.tsx                  carousel.tsx              chart.tsx
    checkbox.tsx              collapsible.tsx           command.tsx
    context-menu.tsx          dialog.tsx                drawer.tsx
    dropdown-menu.tsx         form.tsx                  hover-card.tsx
    input-otp.tsx             input.tsx                 label.tsx
    menubar.tsx               navigation-menu.tsx       pagination.tsx
    popover.tsx               progress.tsx              radio-group.tsx
    resizable.tsx             scroll-area.tsx           select.tsx
    separator.tsx             sheet.tsx                 sidebar.tsx
    skeleton.tsx              slider.tsx                sonner.tsx
    switch.tsx                table.tsx                 tabs.tsx
    textarea.tsx              toast.tsx                 toaster.tsx
    toggle-group.tsx          toggle.tsx                tooltip.tsx
    use-toast.ts
  hooks/
    use-mobile.tsx            # Responsive breakpoint hook
```

## Key APIs / Exports

### Components (49 total)

Commonly used components exported from `@cryonix/ui`:

| Component | Description |
|---|---|
| `Button` | Primary action button with variants (default, destructive, outline, secondary, ghost, link) |
| `Card`, `CardHeader`, `CardContent`, `CardFooter` | Container card with sections |
| `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableCell` | Data table |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | Tabbed navigation |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogFooter` | Modal dialog |
| `Select`, `SelectContent`, `SelectItem`, `SelectTrigger` | Dropdown select |
| `Badge` | Status/label badge with variants |
| `Progress` | Progress bar |
| `Slider` | Range slider |
| `Switch` | Toggle switch |
| `Input` | Text input |
| `Label` | Form label |
| `Tooltip`, `TooltipProvider`, `TooltipContent` | Hover tooltip |
| `ScrollArea`, `ScrollBar` | Custom scrollable area |
| `DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem` | Dropdown menu |
| `Separator` | Visual separator |
| `toast`, `useToast`, `Toaster` | Toast notification system |

### Utilities

```typescript
import { cn } from '@cryonix/ui';

// Merges Tailwind classes with conflict resolution
cn('px-4 py-2', isActive && 'bg-primary text-white', className);
```

## Usage

Import components in `apps/web`:

```typescript
import { Button, Card, CardContent, Badge, Table, TableBody, TableRow, TableCell } from '@cryonix/ui';

export function Dashboard() {
  return (
    <Card>
      <CardContent>
        <Badge variant="outline">LIVE</Badge>
        <Button onClick={handleTrade}>Execute</Button>
      </CardContent>
    </Card>
  );
}
```

## Adding New Components

This library follows the shadcn/ui pattern. Components are vendored (copied into the project, not installed as a dependency), so they can be customized freely.

To add a new shadcn component:

1. Use the shadcn CLI from the monorepo root, targeting this package:
   ```bash
   npx shadcn@latest add <component-name>
   ```
2. Move the generated file to `src/components/` if needed.
3. Export it from `src/index.ts`.

## Testing

This package contains presentational components only. Visual correctness is verified through the `apps/web` dashboard. Type checking:

```bash
pnpm --filter @cryonix/ui type-check
```

## Dependencies

| Package | Purpose |
|---|---|
| `@radix-ui/*` | Accessible, unstyled UI primitives (25 packages) |
| `class-variance-authority` | Component variant management |
| `clsx` | Conditional class name joining |
| `tailwind-merge` | Tailwind class conflict resolution |
| `tailwindcss-animate` | Animation utilities |
| `lucide-react` | Icon library |
| `cmdk` | Command palette component |
| `embla-carousel-react` | Carousel component |
| `react-day-picker` | Calendar/date picker |
| `react-hook-form` | Form state management |
| `react-resizable-panels` | Resizable panel layout |
| `vaul` | Drawer component |
| `input-otp` | OTP input component |

Peer dependency: `react ^19.0.0`
