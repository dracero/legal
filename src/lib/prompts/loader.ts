import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { APP_CONFIG } from '../config.ts';

interface CachedPrompt {
  mtimeMs: number;
  content: string;
}

const promptCache = new Map<string, CachedPrompt>();

function resolvePromptPath(fileName: string): string {
  const configuredPath = path.join(APP_CONFIG.prompts.dir, fileName);
  if (fs.existsSync(configuredPath)) {
    return configuredPath;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const fallbackPath = path.join(moduleDir, fileName);
  if (fs.existsSync(fallbackPath)) {
    return fallbackPath;
  }

  throw new Error(
    `No se encontró el archivo de prompt '${fileName}' en '${APP_CONFIG.prompts.dir}'.`
  );
}

/**
 * Carga un system prompt externalizado desde src/lib/prompts/*.md con recarga en caliente
 * basada en mtime y sustitución de variables {{clave}}.
 */
export function loadPrompt(fileName: string, variables?: Record<string, string>): string {
  const fullPath = resolvePromptPath(fileName);
  const stat = fs.statSync(fullPath);

  const cached = promptCache.get(fullPath);
  let template: string;
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    template = cached.content;
  } else {
    template = fs.readFileSync(fullPath, 'utf-8').trim();
    promptCache.set(fullPath, { mtimeMs: stat.mtimeMs, content: template });
  }

  if (!variables) return template;

  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : ''
  );
}

