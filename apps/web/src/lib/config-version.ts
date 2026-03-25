import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { resolve } from 'path';

let cachedVersion: string | null = null;
let cachedMtime: number = 0;

export function getConfigVersion(): string {
  const paths = [
    '/app/cryonix.toml',
    resolve(process.cwd(), 'cryonix.toml'),
    resolve(process.cwd(), '../../cryonix.toml'),
  ];

  for (const p of paths) {
    try {
      const mtime = statSync(p).mtimeMs;
      if (mtime === cachedMtime && cachedVersion) {
        return cachedVersion;
      }
      const content = readFileSync(p, 'utf-8');
      cachedVersion = createHash('sha256').update(content).digest('hex').slice(0, 8);
      cachedMtime = mtime;
      return cachedVersion;
    } catch { continue; }
  }
  return 'unknown';
}
