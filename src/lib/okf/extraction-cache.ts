import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { APP_CONFIG } from '../config.ts';
import type { OntologicalEntity, DeonticRule } from '../neo4j/client.ts';

export interface CachedExtraction {
  ontological_entities: OntologicalEntity[];
  deontic_rules: DeonticRule[];
}

let memoryCache: Map<string, CachedExtraction> | null = null;
let loadedFilePath: string | null = null;
let appendQueue: Promise<void> = Promise.resolve();

function getCacheFilePath(): string {
  return path.join(APP_CONFIG.okf.extractionCacheDir, 'extractions.jsonl');
}

export function computeExtractionCacheKey(
  modelName: string,
  promptSignature: string,
  articleBody: string
): string {
  const normalizedBody = (articleBody || '').replace(/\s+/g, ' ').trim();
  return crypto
    .createHash('sha256')
    .update(`${modelName}|${promptSignature}|${normalizedBody}`)
    .digest('hex')
    .slice(0, 24);
}

export function hashPromptText(promptText: string): string {
  return crypto.createHash('sha256').update(promptText || '').digest('hex').slice(0, 12);
}

async function ensureCacheLoaded(): Promise<Map<string, CachedExtraction>> {
  const cacheFile = getCacheFilePath();
  if (memoryCache && loadedFilePath === cacheFile) {
    return memoryCache;
  }

  const map = new Map<string, CachedExtraction>();
  try {
    const raw = await fs.readFile(cacheFile, 'utf-8');
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry && typeof entry.k === 'string') {
          map.set(entry.k, {
            ontological_entities: Array.isArray(entry.e) ? entry.e : [],
            deontic_rules: Array.isArray(entry.r) ? entry.r : [],
          });
        }
      } catch {
        // Ignorar líneas truncadas ante interrupciones previas
      }
    }
  } catch {
    // Archivo de caché aún no existe
  }

  memoryCache = map;
  loadedFilePath = cacheFile;
  return map;
}

export async function getCachedExtraction(key: string): Promise<CachedExtraction | undefined> {
  const map = await ensureCacheLoaded();
  return map.get(key);
}

export async function saveCachedExtractionsBatch(
  entries: Array<{ key: string; value: CachedExtraction }>
): Promise<void> {
  if (entries.length === 0) return;

  const map = await ensureCacheLoaded();
  const lines: string[] = [];

  for (const { key, value } of entries) {
    map.set(key, value);
    lines.push(
      JSON.stringify({
        k: key,
        e: value.ontological_entities || [],
        r: value.deontic_rules || [],
      })
    );
  }

  const payload = `${lines.join('\n')}\n`;
  const cacheFile = getCacheFilePath();
  const cacheDir = path.dirname(cacheFile);

  appendQueue = appendQueue
    .then(async () => {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.appendFile(cacheFile, payload, 'utf-8');
    })
    .catch((err) => {
      console.warn('[Extraction Cache] No se pudo persistir caché en disco:', (err as Error).message);
    });

  await appendQueue;
}
