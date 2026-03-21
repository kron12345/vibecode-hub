import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const promptCache = new Map<string, string>();

/**
 * Load a prompt template from backend/prompts/{name}.md
 * Caches in memory after first read. No rebuild needed when prompts change.
 *
 * Resolution order:
 *  1. backend/prompts/{name}.md  (dev: __dirname = dist/src/agents → ../../../prompts/)
 *  2. dist/{name}.md             (NestJS asset copy fallback for containers)
 */
export function loadPrompt(name: string): string {
  const cached = promptCache.get(name);
  if (cached) return cached;

  // Primary: backend/prompts/ (3 levels up from dist/src/agents/)
  const primary = resolve(__dirname, '..', '..', '..', 'prompts', `${name}.md`);
  // Fallback: NestJS copies assets into dist/ root
  const fallback = resolve(__dirname, '..', '..', `${name}.md`);

  const promptPath = existsSync(primary) ? primary : fallback;
  const content = readFileSync(promptPath, 'utf-8');
  promptCache.set(name, content);
  return content;
}
