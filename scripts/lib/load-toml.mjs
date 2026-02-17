/**
 * Minimal TOML reader for ESM scripts (no dependencies).
 * Reads cryonix.toml and returns a nested object.
 * Only handles flat sections with number/string/boolean values — sufficient for [timing], [engine], etc.
 */

import { readFileSync } from 'fs';

const TOML_PATHS = [
  '/app/cryonix.toml',          // Docker container
  new URL('../../cryonix.toml', import.meta.url).pathname,  // Dev (repo root)
];

let _cached = null;

export function loadToml() {
  if (_cached) return _cached;

  for (const p of TOML_PATHS) {
    try {
      const raw = readFileSync(p, 'utf-8');
      _cached = parseToml(raw);
      console.log(`[CONFIG] Loaded cryonix.toml from ${p}`);
      return _cached;
    } catch { continue; }
  }

  console.warn('[CONFIG] cryonix.toml not found — using code defaults');
  return {};
}

/**
 * Get a value: getToml('timing', 'auto_trader_poll_ms', 30000)
 */
export function getToml(section, key, fallback) {
  const cfg = loadToml();
  return cfg[section]?.[key] ?? fallback;
}

function parseToml(raw) {
  const result = {};
  let currentSection = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Section header: [section] or [section.subsection]
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      // Create nested path: "a.b" -> result.a.b = {}
      const parts = currentSection.split('.');
      let obj = result;
      for (const part of parts) {
        if (!obj[part]) obj[part] = {};
        obj = obj[part];
      }
      continue;
    }

    // Key = value
    const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (kvMatch && currentSection) {
      const [, key, rawVal] = kvMatch;
      const val = parseValue(rawVal.trim());

      // Navigate to correct section
      const parts = currentSection.split('.');
      let obj = result;
      for (const part of parts) obj = obj[part];
      obj[key] = val;
    }
  }

  return result;
}

function parseValue(raw) {
  // Remove inline comments
  const cleaned = raw.replace(/\s+#.*$/, '');

  // Boolean
  if (cleaned === 'true') return true;
  if (cleaned === 'false') return false;

  // String (quoted)
  const strMatch = cleaned.match(/^"(.*)"$/) || cleaned.match(/^'(.*)'$/);
  if (strMatch) return strMatch[1];

  // Array (simple flat arrays only)
  if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
    const inner = cleaned.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(v => parseValue(v.trim()));
  }

  // Number (int or float) — strip TOML-style underscores (30_000 → 30000)
  const numStr = cleaned.replace(/_/g, '');
  const num = Number(numStr);
  if (!isNaN(num) && numStr !== '') return num;

  return cleaned;
}
