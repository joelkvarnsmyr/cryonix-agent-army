/**
 * Pattern Detectors Index
 * Export all pattern detectors for easy importing
 */

export * from './pattern-detector.interface';
export * from './bollinger-squeeze';
export * from './volume-spike';
export * from './triangle-breakout';
export * from './rsi-divergence';

// Re-export detector classes for convenience
export { BollingerSqueezeDetector } from './bollinger-squeeze';
export { VolumeSpikeDetector } from './volume-spike';
export { TriangleBreakoutDetector } from './triangle-breakout';
export { RSIDivergenceDetector } from './rsi-divergence';
