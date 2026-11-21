import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { Type } from '@google/genai';
import { APP_CONFIG } from '../config.ts';
import { geminiRotator } from '../gemini/key-rotator.ts';
import { loadPrompt } from '../prompts/loader.ts';
import {
  type OKFNode,
  type OKFRelation,
  type OntologicalEntity,
  type DeonticRule,
  upsertOKFNodesChunkToNeo4j,
  linkOKFRelationsInNeo4j,
  getAllCatalogOKFNodes,
} from '../neo4j/client.ts';
import { validateOKFEntryWithSHACL, type SHACLValidationReport } from '../shacl/validator.ts';
import {
  computeExtractionCacheKey,
  hashPromptText,
  getCachedExtraction,
  saveCachedExtractionsBatch,
  type CachedExtraction,
} from './extraction-cache.ts';

export interface PDFIngestionOptions {
  fileName: string;
  lawNumber: string;
  jurisdiction?: string;
  category?: string;
  status?: string;
}

export interface PDFIngestionResult {
  success: boolean;
  fileName: string;
  extractedCharacters: number;
  atomicArticlesCreated: number;
  nodesIngested: OKFNode[];
  shaclReports: Array<{ okf_id: string; report: SHACLValidationReport }>;
  rejectedCount: number;
}

/**
 * Extrae texto de un archivo PDF binario usando pdf-parse con recuperación automática
 */
export async function extractTextFromPDFBuffer(buffer: Buffer): Promise<string> {
  try {
    const pdfParseModule = await import('pdf-parse/lib/pdf-parse.js').catch(() => import('pdf-parse'));
    const pdfParse = (pdfParseModule as any).default || pdfParseModule;
    const data = await pdfParse(buffer);
    if (data && typeof data.text === 'string' && data.text.trim().length > 0) {
      return data.text.trim();
    }
  } catch (err: any) {
    console.warn('[PDF-Parser] Extracción con pdf-parse alternada a flujo de texto estructurado:', err.message);
  }

  const rawStr = buffer.toString('utf-8');
  const textMatches = rawStr.match(/\(([^()]{3,})\)/g);
  if (textMatches && textMatches.length > 0) {
    return textMatches.map((m) => m.slice(1, -1).replace(/\\([()\\])/g, '$1')).join('\n');
  }

  const printable = rawStr.replace(/[^\x20-\x7E\xA0-\uFFFF\n\r\t]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (printable.length > 20) {
    return printable;
  }

  throw new Error('El archivo PDF no contiene texto extraíble válido.');
}

const DEONTIC_EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    ontological_entities: {
      type: Type.ARRAY,
      description: 'Máximo 3 entidades clave del artículo',
      items: {
        type: Type.OBJECT,
        properties: {
          nombre: { type: Type.STRING, description: 'Nombre breve del concepto o sujeto' },
          categoria: { type: Type.STRING, description: 'SujetoDeDerecho, Objeto o ConceptoJuridico' },
          descripcion: { type: Type.STRING, description: 'Alcance conciso (<= 10 palabras)' },
        },
        required: ['nombre', 'categoria', 'descripcion'],
      },
    },
    deontic_rules: {
      type: Type.ARRAY,
      description: 'Máximo 3 reglas deónticas efectivas ([] si es definitorio o de forma)',
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'Código breve (ej: REG-01)' },
          modalidad: {
            type: Type.STRING,
            enum: ['OBLIGACION', 'PROHIBICION', 'PERMISION', 'SANCION_NULIDAD'],
          },
          sujeto_normado: { type: Type.STRING, description: 'Sujeto alcanzado (breve)' },
          conducta: { type: Type.STRING, description: 'Acción o abstención prescrita (<= 12 palabras)' },
          condicion: { type: Type.STRING, description: 'Supuesto de aplicación (<= 12 palabras)' },
          consecuencia: { type: Type.STRING, description: 'Efecto jurídico o sanción (<= 12 palabras)' },
          palabras_clave: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: '3 a 5 términos concretos para subsunción OPA',
          },
        },
        required: ['id', 'modalidad', 'sujeto_normado', 'conducta', 'condicion', 'consecuencia'],
      },
    },
  },
  required: ['ontological_entities', 'deontic_rules'],
};

const BATCH_DEONTIC_EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    articles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          article_index: { type: Type.INTEGER, description: 'Índice numérico (0-based) del artículo evaluado' },
          ontological_entities: DEONTIC_EXTRACTION_SCHEMA.properties.ontological_entities,
          deontic_rules: DEONTIC_EXTRACTION_SCHEMA.properties.deontic_rules,
        },
        required: ['article_index', 'ontological_entities', 'deontic_rules'],
      },
    },
  },
  required: ['articles'],
};

/**
 * Extrae dinámicamente la Ontología y la Lógica Deóntica de un lote de artículos
 * en una sola llamada a Gemini 3.6 Flash, optimizando el consumo de cuota y velocidad.
 */
async function extractOntologyAndDeonticBatch(
  items: Array<{ index: number; title: string; body: string }>
): Promise<Map<number, CachedExtraction>> {
  const modelName = APP_CONFIG.gemini.model;
  const resultMap = new Map<number, CachedExtraction>();

  const promptBlocks = items
    .map((item) => `[ARTICLE_INDEX=${item.index}] Título: ${item.title}\nTexto:\n${item.body}`)
    .join('\n\n---\n\n');

  const responseText = await geminiRotator.executeWithRotation(async (client) => {
    const response = await client.models.generateContent({
      model: modelName,
      contents: `Analiza cada artículo listado por su [ARTICLE_INDEX] y extrae de forma concisa su ontología y matriz deóntica:\n\n${promptBlocks}`,
      config: {
        systemInstruction: loadPrompt('deontic-batch-extractor.md'),
        responseMimeType: 'application/json',
        responseSchema: BATCH_DEONTIC_EXTRACTION_SCHEMA,
        maxOutputTokens: APP_CONFIG.gemini.maxOutputTokens,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    return response.text || '{}';
  }, `Extraer Lote Deóntico (${items.length} artículos)`);

  const parsed = JSON.parse(responseText);
  if (Array.isArray(parsed.articles)) {
    for (const entry of parsed.articles) {
      if (typeof entry.article_index === 'number') {
        resultMap.set(entry.article_index, {
          ontological_entities: Array.isArray(entry.ontological_entities) ? entry.ontological_entities : [],
          deontic_rules: Array.isArray(entry.deontic_rules) ? entry.deontic_rules : [],
        });
      }
    }
  }

  return resultMap;
}

/**
 * Extrae dinámicamente la Ontología y la Lógica Deóntica del texto del artículo
 * utilizando exclusivamente Gemini 3.6 Flash (sin fallback sintético).
 */
export async function extractOntologyAndDeonticLogicFromArticle(
  articleText: string,
  articleTitle: string
): Promise<CachedExtraction> {
  const modelName = APP_CONFIG.gemini.model;

  return await geminiRotator.executeWithRotation(async (client) => {
    const response = await client.models.generateContent({
      model: modelName,
      contents: `Analiza el siguiente artículo normativo y extrae de forma concisa su ontología y lógica deóntica:\n\nArtículo: ${articleTitle}\n\nTexto:\n${articleText}`,
      config: {
        systemInstruction: loadPrompt('deontic-article-extractor.md'),
        responseMimeType: 'application/json',
        responseSchema: DEONTIC_EXTRACTION_SCHEMA,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    return {
      ontological_entities: Array.isArray(parsed.ontological_entities) ? parsed.ontological_entities : [],
      deontic_rules: Array.isArray(parsed.deontic_rules) ? parsed.deontic_rules : [],
    };
  }, `Extraer Deóntica (${articleTitle})`);
}

/**
 * Descubre referencias cruzadas dinámicamente comparando el texto del artículo
 * contra el catálogo actual de nodos existentes en Neo4j.
 */
function discoverDynamicCrossReferences(bodyText: string, existingCatalogNodes: OKFNode[]): OKFRelation[] {
  const lowerBody = bodyText.toLowerCase();
  const relations: OKFRelation[] = [];
  const seenTargets = new Set<string>();

  for (const existing of existingCatalogNodes) {
    if (seenTargets.has(existing.okf_id)) continue;

    const lawMatch =
      existing.law_number &&
      existing.law_number.length >= 4 &&
      lowerBody.includes(existing.law_number.toLowerCase());

    const artMatch =
      existing.article_number &&
      existing.article_number.length >= 2 &&
      new RegExp(`\\b(?:art(?:[íi]culo|\\.)?\\s*)?${existing.article_number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
        bodyText
      );

    if (lawMatch || artMatch) {
      seenTargets.add(existing.okf_id);
      relations.push({
        type: 'CONCUERDA_CON',
        target: existing.okf_id,
      });
    }
  }

  return relations;
}

const ORDINAL_IDENTIFIERS =
  '(?:[ÚU]NIC[OA]|[Úu]nic[oa]|PRIMER[OA]|Primer[oa]|SEGUND[OA]|Segund[oa]|TERCER[OA]|Tercer[oa]|CUART[OA]|Cuart[oa]|QUINT[OA]|Quint[oa]|SEXT[OA]|Sext[oa]|S[ÉE]PTIM[OA]|S[ée]ptim[oa]|OCTAV[OA]|Octav[oa]|NOVEN[OA]|Noven[oa]|D[ÉE]CIM[OA]|D[ée]cim[oa])';

// Encabezado estricto al inicio de línea: evita falsos cortes en citas internas ("art. 14 de la ley") o palabras ("Artes", "Artificial")
const LINE_ARTICLE_REGEX = new RegExp(
  `(?:^|\\n)[ \\t]*(?:ART[ÍIÌ]CULO|Art[íi]culo|ART\\.|Art\\.|CL[ÁA]USULA|Cl[áa]usula)[ \\t]+(\\d+[°ºª]?(?:[ \\t]*(?:bis|ter|qu[aá]ter|quinquies|sexies|BIS|TER|QU[ÁA]TER))?|${ORDINAL_IDENTIFIERS})(?:[ \\t]*[\\.\\-—:º°ª\\)]+[ \\t]*|(?=\\n)|[ \\t]+(?=[A-ZÁÉÍÓÚÑ¡¿"«(\\d]))`,
  'gu'
);

// Respaldo para documentos estructurados únicamente por Secciones (solo si no hay Artículos/Cláusulas)
const LINE_SECTION_REGEX = new RegExp(
  `(?:^|\\n)[ \\t]*(?:SECCI[ÓO]N|Secci[óo]n)[ \\t]+(\\d+[°ºª]?|[IVXLCDM]+|${ORDINAL_IDENTIFIERS})(?:[ \\t]*[\\.\\-—:º°ª\\)]+[ \\t]*|(?=\\n)|[ \\t]+(?=[A-ZÁÉÍÓÚÑ¡¿"«(]))`,
  'gu'
);

// Respaldo inline para textos pegados en una sola línea (ej. "Artículo 1°: ... Artículo 2°: ...")
const INLINE_ARTICLE_REGEX =
  /(?:^|(?<=[.;:\n])\s+)(?:ART[ÍIÌ]CULO|Art[íi]culo|ART\.|Art\.|CL[ÁA]USULA|Cl[áa]usula)[ \t]+(\d+[°ºª]?(?:[ \t]*(?:bis|ter|qu[aá]ter))?)[ \t]*(?:[\.\-—:]+|(?<=[°ºª])[ \t]*[\.\-—:]*)[ \t]+/gu;

/**
 * Segmentación estructural pura (sin llamadas LLM):
 * Evita falsos cortes por citas en prosa y mantiene íntegros los artículos con sus incisos.
 */
export function splitLegalTextIntoAtomicUnits(
  rawText: string
): Array<{ artNum: string; body: string }> {
  const cleanText = rawText
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .trim();

  let matches = Array.from(cleanText.matchAll(LINE_ARTICLE_REGEX));
  if (matches.length === 0) {
    matches = Array.from(cleanText.matchAll(LINE_SECTION_REGEX));
  }
  if (matches.length === 0 || (!cleanText.includes('\n') && matches.length <= 1)) {
    const inlineMatches = Array.from(cleanText.matchAll(INLINE_ARTICLE_REGEX));
    if (inlineMatches.length > matches.length) {
      matches = inlineMatches;
    }
  }

  const atomicUnits: Array<{ artNum: string; body: string }> = [];

  if (matches.length > 0) {
    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const artNum = current[1].replace(/[°ºª]/g, '').replace(/\s+/g, ' ').trim();
      const startIndex = current.index ?? 0;
      const endIndex = i + 1 < matches.length ? (matches[i + 1].index ?? cleanText.length) : cleanText.length;
      const body = cleanText.slice(startIndex, endIndex).trim();
      if (body.length > 10) {
        atomicUnits.push({ artNum, body });
      }
    }
    return atomicUnits;
  }

  // Si no tiene numeración explícita de artículos, dividir por párrafos o secciones lógicas
  const sections = cleanText.split(/\n{2,}/).filter((s) => s.trim().length > 30);
  if (sections.length > 0) {
    return sections.map((sec, idx) => ({
      artNum: `Sec-${idx + 1}`,
      body: sec.trim(),
    }));
  }

  return [{ artNum: 'Unico', body: cleanText }];
}

/**
 * Detecta artículos puramente formales o derogados sin contenido deóntico útil
 * para omitir llamadas innecesarias a Gemini (0 tokens), conservando el nodo en Neo4j.
 */
export function isNonNormativeBoilerplate(body: string): boolean {
  const strippedHeader = (body || '')
    .replace(
      /^(?:ART[ÍIÌ]CULO|Art[íi]culo|ART\.|Art\.|CL[ÁA]USULA|Cl[áa]usula|SECCI[ÓO]N|Secci[óo]n)[ \t]+[^\n.:\-—]{1,25}[\.\-—:º°ª\)]*[ \t]*/u,
      ''
    )
    .trim();

  if (strippedHeader.length < 15) return true;
  if (strippedHeader.length > 220) return false;

  const normalized = strippedHeader
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const hasNormativeSignal =
    /\b(?:debera|deberan|oblig|prohib|sancion|multa|nulidad|indemniz|derecho|responsab|plazo|pena|infracc)\b/.test(
      normalized
    );
  if (hasNormativeSignal) return false;

  const isClosingFormula =
    /\b(?:comuniquese|publiquese|archivese|registrese|cumplase|dese a la direccion nacional del registro oficial|de forma|notifiquese)\b/.test(
      normalized
    );
  if (isClosingFormula) return true;

  const isRepealedPlaceholder =
    /^(?:\(?articulo\s+)?(?:derogad[oa]|sin\s+efecto|vetad[oa]|observad[oa]|suprimid[oa]|reservad[oa]|nota\s+de\s+redaccion|texto\s+suprimido)\b/.test(
      normalized
    );
  return isRepealedPlaceholder;
}

interface PreparedUnit {
  index: number;
  artNum: string;
  body: string;
  okf_id: string;
  title: string;
  relations: OKFRelation[];
  cacheKey: string;
  boilerplate: boolean;
}

function resolveIngestConcurrency(): number {
  const configured = APP_CONFIG.gemini.ingestConcurrency;
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.max(Math.floor(configured), 1), 16);
  }
  const activeKeyCount = geminiRotator.getAvailableKeys(true).length;
  return Math.min(Math.max(activeKeyCount, 2), 4);
}

function buildOKFNode(
  item: PreparedUnit,
  extracted: CachedExtraction,
  options: PDFIngestionOptions,
  today: string
): OKFNode {
  return {
    okf_id: item.okf_id,
    title: item.title,
    node_type: 'Articulo',
    law_number: options.lawNumber,
    article_number: item.artNum,
    hierarchy_level: 'Norma_Vigente',
    domain: 'Derecho_General',
    category: options.category || 'Normativa_Cargada',
    jurisdiction: options.jurisdiction || 'General',
    status: options.status || 'Vigente',
    last_updated: today,
    content: item.body,
    relations: item.relations,
    ontological_entities: extracted.ontological_entities,
    deontic_rules: extracted.deontic_rules,
  };
}

interface ExtractionRunStats {
  nodes: OKFNode[];
  totalUnits: number;
  cacheHits: number;
  boilerplateSkipped: number;
  batchesCount: number;
  concurrency: number;
  fallbackArticleCalls: number;
  geminiMs: number;
}

async function segmentAndExtractNodes(
  rawText: string,
  options: PDFIngestionOptions,
  onChunkReady?: (chunkNodes: OKFNode[]) => void
): Promise<ExtractionRunStats> {
  const slugBase =
    options.lawNumber
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'norma-cargada';

  const atomicUnits = splitLegalTextIntoAtomicUnits(rawText);
  const { nodes: existingCatalogNodes } = await getAllCatalogOKFNodes();

  const modelName = APP_CONFIG.gemini.model;
  const promptSignature = hashPromptText(
    `${loadPrompt('deontic-batch-extractor.md')}|${loadPrompt('deontic-article-extractor.md')}`
  );

  const seenIds = new Map<string, number>();
  const preparedUnits: PreparedUnit[] = [];

  for (let idx = 0; idx < atomicUnits.length; idx++) {
    const unit = atomicUnits[idx];
    const safeArtSlug =
      unit.artNum
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || String(idx + 1);

    const baseId = `norma-${slugBase}-art-${safeArtSlug}`;
    const count = (seenIds.get(baseId) || 0) + 1;
    seenIds.set(baseId, count);
    const okf_id = count === 1 ? baseId : `${baseId}-${count}`;

    const firstLine = unit.body.split('\n')[0].trim();
    const cleanFirstLine = firstLine
      .replace(
        /^(?:ART[ÍIÌ]CULO|Art[íi]culo|ART\.|Art\.|CL[ÁA]USULA|Cl[áa]usula|SECCI[ÓO]N|Secci[óo]n)[ \t]+[0-9A-Za-zÁÉÍÓÚáéíóúÑñ°ºª\s]*[\.\-—:\)]*[ \t]*/u,
        ''
      )
      .slice(0, 90)
      .trim();

    const artDisplay = count === 1 ? unit.artNum : `${unit.artNum} (${count})`;
    const title = cleanFirstLine
      ? `${options.lawNumber} - Art. ${artDisplay}: ${cleanFirstLine}`
      : `${options.lawNumber} - Art. ${artDisplay}`;

    const relations = discoverDynamicCrossReferences(unit.body, existingCatalogNodes);
    if (idx > 0) {
      const prevId = preparedUnits[idx - 1].okf_id;
      if (!relations.some((r) => r.target === prevId)) {
        relations.push({ type: 'CONCUERDA_CON', target: prevId });
      }
    }

    const trimmedBody = unit.body.trim();
    preparedUnits.push({
      index: idx,
      artNum: artDisplay,
      body: trimmedBody,
      okf_id,
      title,
      relations,
      cacheKey: computeExtractionCacheKey(modelName, promptSignature, trimmedBody),
      boilerplate: isNonNormativeBoilerplate(trimmedBody),
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const extractedMap = new Map<number, CachedExtraction>();
  const pendingUnits: PreparedUnit[] = [];
  const immediateNodes: OKFNode[] = [];
  let cacheHits = 0;
  let boilerplateSkipped = 0;

  for (const unit of preparedUnits) {
    if (unit.boilerplate) {
      boilerplateSkipped++;
      const empty: CachedExtraction = { ontological_entities: [], deontic_rules: [] };
      extractedMap.set(unit.index, empty);
      immediateNodes.push(buildOKFNode(unit, empty, options, today));
      continue;
    }

    const cached = await getCachedExtraction(unit.cacheKey);
    if (cached) {
      cacheHits++;
      extractedMap.set(unit.index, cached);
      immediateNodes.push(buildOKFNode(unit, cached, options, today));
      continue;
    }

    pendingUnits.push(unit);
  }

  if (immediateNodes.length > 0 && onChunkReady) {
    onChunkReady(immediateNodes);
  }

  // Agrupar solo los artículos que faltan en caché (hasta 25 artículos o 25.000 caracteres por lote)
  const batches: PreparedUnit[][] = [];
  let currentBatch: PreparedUnit[] = [];
  let currentChars = 0;

  for (const item of pendingUnits) {
    if (currentBatch.length >= 25 || (currentBatch.length > 0 && currentChars + item.body.length > 25000)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push(item);
    currentChars += item.body.length;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  const geminiT0 = performance.now();
  let fallbackArticleCalls = 0;
  const concurrency = resolveIngestConcurrency();
  let nextBatchIdx = 0;

  async function processNextBatch(): Promise<void> {
    while (nextBatchIdx < batches.length) {
      const bIdx = nextBatchIdx++;
      const batch = batches[bIdx];
      const batchT0 = performance.now();
      const newlyCached: Array<{ key: string; value: CachedExtraction }> = [];

      if (batch.length === 1) {
        const item = batch[0];
        const res = await extractOntologyAndDeonticLogicFromArticle(item.body, item.title);
        extractedMap.set(item.index, res);
        newlyCached.push({ key: item.cacheKey, value: res });
        console.log(
          `[PDF-Timing] Lote ${bIdx + 1}/${batches.length} (1 art. individual) -> ${Math.round(performance.now() - batchT0)}ms`
        );
      } else {
        try {
          const batchResult = await extractOntologyAndDeonticBatch(batch);
          for (const item of batch) {
            const val = batchResult.get(item.index);
            if (val) {
              extractedMap.set(item.index, val);
              newlyCached.push({ key: item.cacheKey, value: val });
            }
          }
          console.log(
            `[PDF-Timing] Lote ${bIdx + 1}/${batches.length} (${batch.length} arts., batch) -> ${Math.round(performance.now() - batchT0)}ms`
          );
        } catch (batchErr: any) {
          const msg = String(batchErr?.message || batchErr);
          if (
            msg.includes('No hay claves disponibles') ||
            msg.includes('Se agotaron los reintentos') ||
            msg.includes('Falta configurar GEMINI_API_KEY')
          ) {
            throw batchErr;
          }
          console.warn(
            `[Gemini Batch Extraction] Lote ${bIdx + 1} falló (${msg}), procesando artículos individualmente...`
          );
        }

        // Completar cualquier artículo faltante del lote de manera individual
        for (const item of batch) {
          if (!extractedMap.has(item.index)) {
            fallbackArticleCalls++;
            const fbT0 = performance.now();
            const fallbackRes = await extractOntologyAndDeonticLogicFromArticle(item.body, item.title);
            extractedMap.set(item.index, fallbackRes);
            newlyCached.push({ key: item.cacheKey, value: fallbackRes });
            console.log(
              `[PDF-Timing] Fallback individual (${item.okf_id}) -> ${Math.round(performance.now() - fbT0)}ms`
            );
          }
        }
      }

      // Checkpoint incremental en caché de disco + disparo inmediato de persistencia solapada
      await saveCachedExtractionsBatch(newlyCached);

      if (onChunkReady) {
        const chunkNodes = batch.map((item) =>
          buildOKFNode(
            item,
            extractedMap.get(item.index) || { ontological_entities: [], deontic_rules: [] },
            options,
            today
          )
        );
        onChunkReady(chunkNodes);
      }
    }
  }

  if (batches.length > 0) {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, batches.length) }, () => processNextBatch())
    );
  }

  const geminiMs = Math.round(performance.now() - geminiT0);
  console.log(
    `[PDF-Timing] Gemini total (${batches.length} lotes, concurrencia=${concurrency}, cacheHits=${cacheHits}, boilerplateOmitidos=${boilerplateSkipped}, fallbacks=${fallbackArticleCalls}) -> ${geminiMs}ms`
  );

  const createdNodes: OKFNode[] = preparedUnits.map((item) =>
    buildOKFNode(
      item,
      extractedMap.get(item.index) || { ontological_entities: [], deontic_rules: [] },
      options,
      today
    )
  );

  return {
    nodes: createdNodes,
    totalUnits: preparedUnits.length,
    cacheHits,
    boilerplateSkipped,
    batchesCount: batches.length,
    concurrency,
    fallbackArticleCalls,
    geminiMs,
  };
}

/**
 * Segmentación Atómica Normativa (Estándar Google OKF):
 * Divide el texto legal por Artículos/Cláusulas manteniendo juntos cada artículo y todos sus incisos.
 */
export async function segmentLawIntoAtomicArticles(
  rawText: string,
  options: PDFIngestionOptions
): Promise<OKFNode[]> {
  const stats = await segmentAndExtractNodes(rawText, options);
  return stats.nodes;
}

/**
 * Pipeline completo de Ingesta de PDF con solapamiento incremental:
 * Mientras Gemini extrae los lotes restantes, cada lote completado ya valida SHACL,
 * guarda su .md, calcula embeddings locales y persiste por UNWIND en Neo4j.
 */
export async function ingestLawPDFFromFrontend(
  buffer: Buffer,
  options: PDFIngestionOptions
): Promise<PDFIngestionResult> {
  const totalT0 = performance.now();

  const pdfT0 = performance.now();
  const rawText = await extractTextFromPDFBuffer(buffer);
  const pdfParseMs = Math.round(performance.now() - pdfT0);

  const okfDir = APP_CONFIG.okf.contentDir;
  await fs.mkdir(okfDir, { recursive: true });

  const nodesIngested: OKFNode[] = [];
  const shaclReports: Array<{ okf_id: string; report: SHACLValidationReport }> = [];
  let rejectedCount = 0;
  let shaclMs = 0;
  let fsWriteMs = 0;
  let embedAndNeo4jMs = 0;

  // Cola serializada de persistencia para solapar CPU/disco/Neo4j con la espera de red de Gemini
  let persistChain: Promise<void> = Promise.resolve();
  let persistError: Error | null = null;

  const persistChunk = async (chunkNodes: OKFNode[]) => {
    if (persistError) return;
    const validNodes: OKFNode[] = [];

    const sT0 = performance.now();
    for (const node of chunkNodes) {
      const report = await validateOKFEntryWithSHACL(node);
      shaclReports.push({ okf_id: node.okf_id, report });
      if (!report.conforms) {
        rejectedCount++;
        continue;
      }
      validNodes.push(node);
    }
    shaclMs += performance.now() - sT0;

    if (validNodes.length === 0) return;

    const fT0 = performance.now();
    const FS_CHUNK = 50;
    for (let i = 0; i < validNodes.length; i += FS_CHUNK) {
      await Promise.all(
        validNodes.slice(i, i + FS_CHUNK).map((node) => {
          const frontmatterObj = {
            okf_id: node.okf_id,
            title: node.title,
            node_type: node.node_type,
            law_number: node.law_number,
            article_number: node.article_number,
            hierarchy_level: node.hierarchy_level,
            domain: node.domain,
            category: node.category,
            jurisdiction: node.jurisdiction,
            status: node.status,
            last_updated: node.last_updated,
            relations: node.relations,
            ontological_entities: node.ontological_entities,
            deontic_rules: node.deontic_rules,
          };
          const fileContent = matter.stringify(node.content, frontmatterObj);
          return fs.writeFile(path.join(okfDir, `${node.okf_id}.md`), fileContent, 'utf-8');
        })
      );
    }
    fsWriteMs += performance.now() - fT0;

    const nT0 = performance.now();
    await upsertOKFNodesChunkToNeo4j(validNodes);
    embedAndNeo4jMs += performance.now() - nT0;

    nodesIngested.push(...validNodes);
  };

  const enqueueChunk = (chunkNodes: OKFNode[]) => {
    persistChain = persistChain
      .then(() => persistChunk(chunkNodes))
      .catch((err) => {
        if (!persistError) persistError = err instanceof Error ? err : new Error(String(err));
      });
  };

  const segT0 = performance.now();
  let stats: ExtractionRunStats;
  try {
    stats = await segmentAndExtractNodes(rawText, options, enqueueChunk);
  } catch (err) {
    await persistChain;
    throw err;
  }
  const segmentAndGeminiMs = Math.round(performance.now() - segT0);

  const tailT0 = performance.now();
  await persistChain;
  const persistTailWaitMs = Math.round(performance.now() - tailT0);
  if (persistError) {
    throw persistError;
  }

  // Ordenar nodesIngested en el orden original del documento
  const orderMap = new Map<string, number>(stats.nodes.map((n, i) => [n.okf_id, i]));
  nodesIngested.sort((a, b) => (orderMap.get(a.okf_id) ?? 0) - (orderMap.get(b.okf_id) ?? 0));

  let neo4jLinkMs = 0;
  if (nodesIngested.length > 0) {
    const linkT0 = performance.now();
    await linkOKFRelationsInNeo4j(nodesIngested);
    neo4jLinkMs = Math.round(performance.now() - linkT0);
  }

  const totalMs = Math.round(performance.now() - totalT0);
  console.log(
    `[PDF-Timing] Resumen "${options.fileName}" (${stats.totalUnits} arts., ${rawText.length} chars, cacheHits=${stats.cacheHits}, boilerplate=${stats.boilerplateSkipped}) -> ` +
      `Total: ${totalMs}ms | PDF-Parse: ${pdfParseMs}ms | Segment+Gemini: ${segmentAndGeminiMs}ms | ` +
      `ColaPersistTail: ${persistTailWaitMs}ms (SHACL: ${Math.round(shaclMs)}ms, FS: ${Math.round(fsWriteMs)}ms, Embed+Neo4j-UNWIND: ${Math.round(embedAndNeo4jMs)}ms) | Neo4j-Links: ${neo4jLinkMs}ms`
  );

  return {
    success: nodesIngested.length > 0 && rejectedCount === 0,
    fileName: options.fileName,
    extractedCharacters: rawText.length,
    atomicArticlesCreated: stats.totalUnits,
    nodesIngested,
    shaclReports,
    rejectedCount,
  };
}
