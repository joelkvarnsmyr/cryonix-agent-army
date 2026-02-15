"use client";

import { type ReactNode } from 'react';
import * as m from 'motion/react-client';
import { type Variant } from 'motion';

// Staggered container - children animate in sequence
export function StaggerContainer({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <m.div
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: {
          transition: {
            staggerChildren: 0.06,
            delayChildren: delay,
          },
        },
      }}
      className={className}
    >
      {children}
    </m.div>
  );
}

// Fade-up item (for use inside StaggerContainer)
export function FadeUpItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <m.div
      variants={{
        hidden: { opacity: 0, y: 16, filter: 'blur(4px)' },
        visible: {
          opacity: 1,
          y: 0,
          filter: 'blur(0px)',
          transition: { duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] },
        },
      }}
      className={className}
    >
      {children}
    </m.div>
  );
}

// Scale-in card (for individual cards)
export function ScaleIn({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <m.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35, delay, ease: [0.25, 0.46, 0.45, 0.94] }}
      className={className}
    >
      {children}
    </m.div>
  );
}

// Slide-in from direction
export function SlideIn({
  children,
  className,
  from = 'left',
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  from?: 'left' | 'right' | 'top' | 'bottom';
  delay?: number;
}) {
  const offsets: Record<string, { x?: number; y?: number }> = {
    left: { x: -24 },
    right: { x: 24 },
    top: { y: -24 },
    bottom: { y: 24 },
  };

  return (
    <m.div
      initial={{ opacity: 0, ...offsets[from] }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.25, 0.46, 0.45, 0.94] }}
      className={className}
    >
      {children}
    </m.div>
  );
}

// Animated number counter
export function AnimatedNumber({
  value,
  prefix = '',
  suffix = '',
  decimals = 2,
  className,
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  className?: string;
}) {
  return (
    <m.span
      className={className}
      key={value}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
    >
      {prefix}{value.toFixed(decimals)}{suffix}
    </m.span>
  );
}

// Glow pulse on status change
export function GlowPulse({ active, color = '#00d4ff', children, className }: {
  active: boolean;
  color?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <m.div
      animate={active ? {
        boxShadow: [
          `0 0 0px ${color}00`,
          `0 0 12px ${color}40`,
          `0 0 0px ${color}00`,
        ],
      } : {}}
      transition={active ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : {}}
      className={className}
    >
      {children}
    </m.div>
  );
}

// List item with layout animation (for reordering)
export function AnimatedListItem({ children, className, layoutId }: {
  children: ReactNode;
  className?: string;
  layoutId?: string;
}) {
  return (
    <m.div
      layout
      layoutId={layoutId}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25 }}
      className={className}
    >
      {children}
    </m.div>
  );
}
