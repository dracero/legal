import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { Type } from '@google/genai';
import { APP_CONFIG } from '../config.ts';
import { geminiRotator } from '../gemini/key-rotator.ts';
import {
  type OKFNode,
  type OKFRelation,
  type OntologicalEntity,
  type DeonticRule,
  upsertOKFNodeToNeo4j,
  linkOKFRelationsInNeo4j,
  getAllCatalogOKFNodes,
} from '../neo4j/client.ts';
import { validateOKFEntryWithSHACL, type SHACLValidationReport } from '../shacl/validator.ts';

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
      items: {
        type: Type.OBJECT,
        properties: {
          nombre: { type: Type.STRING, description: 'Nombre del concepto o sujeto' },
          categoria: { type: Type.STRING, description: 'SujetoDeDerecho, Objeto, ConceptoJuridico, etc.' },
          descripcion: { type: Type.STRING, description: 'Definición o alcance en la norma' },
        },
        required: ['nombre', 'categoria', 'descripcion'],
      },
    },
    deontic_rules: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'Identificador (ej: REG-01)' },
          modalidad: {
            type: Type.STRING,
            enum: ['OBLIGACION', 'PROHIBICION', 'PERMISION', 'SANCION_NULIDAD'],
          },
          sujeto_normado: { type: Type.STRING, description: 'Sujeto alcanzado' },
          conducta: { type: Type.STRING, description: 'Acción, abstención o prestación prescrita' },
          condicion: { type: Type.STRING, description: 'Supuesto de hecho de aplicación' },
          consecuencia: { type: Type.STRING, description: 'Sanción, nulidad, responsabilidad o efecto legal' },
          palabras_clave: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Palabras clave para subsunción'
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
): Promise<Map<number, { ontological_entities: OntologicalEntity[]; deontic_rules: DeonticRule[] }>> {
  const modelName = APP_CONFIG.gemini.model;
  const resultMap = new Map<number, { ontological_entities: OntologicalEntity[]; deontic_rules: DeonticRule[] }>();

  const promptBlocks = items
    .map((item) => `[ARTICLE_INDEX=${item.index}] Título: ${item.title}\nTexto:\n${item.body}`)
    .join('\n\n---\n\n');

  const responseText = await geminiRotator.executeWithRotation(async (client) => {
    const response = await client.models.generateContent({
      model: modelName,
      contents: `Analiza cada artículo listado por su [ARTICLE_INDEX] y extrae estrictamente su ontología y matriz deóntica:\n\n${promptBlocks}`,
      config: {
        systemInstruction:
          'Eres un Jurista experto en Ontologías Jurídicas y Lógica Deóntica Formal. ' +
          'Tu labor es extraer estrictamente del texto provisto para cada artículo [ARTICLE_INDEX] las entidades ontológicas (conceptos y sujetos) ' +
          'y las reglas deónticas (modalidades OBLIGACION, PROHIBICION, PERMISION, SANCION_NULIDAD). ' +
          'No inventes información ajena al texto. Devuelve el JSON conforme al esquema provisto incluyendo un objeto por cada article_index.',
        responseMimeType: 'application/json',
        responseSchema: BATCH_DEONTIC_EXTRACTION_SCHEMA,
        maxOutputTokens: APP_CONFIG.gemini.maxOutputTokens,
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
): Promise<{ ontological_entities: OntologicalEntity[]; deontic_rules: DeonticRule[] }> {
  const modelName = APP_CONFIG.gemini.model;

  return await geminiRotator.executeWithRotation(async (client) => {
    const response = await client.models.generateContent({
      model: modelName,
      contents: `Analiza el siguiente artículo normativo y extrae su ontología y lógica deóntica:\n\nArtículo: ${articleTitle}\n\nTexto:\n${articleText}`,
      config: {
        systemInstruction:
          'Eres un Jurista experto en Ontologías Jurídicas y Lógica Deóntica Formal. ' +
          'Tu labor es extraer estrictamente del texto provisto las entidades ontológicas (conceptos y sujetos) ' +
          'y las reglas deónticas (modalidades OBLIGACION, PROHIBICION, PERMISION, SANCION_NULIDAD). ' +
          'No inventes información ajena al texto. Devuelve el JSON conforme al esquema provisto.',
        responseMimeType: 'application/json',
        responseSchema: DEONTIC_EXTRACTION_SCHEMA,
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

/**
 * Segmentación Atómica Normativa (Estándar Google OKF):
 * Divide el texto legal por Artículos/Cláusulas manteniendo juntos cada artículo y todos sus incisos.
 */
export async function segmentLawIntoAtomicArticles(
  rawText: string,
  options: PDFIngestionOptions
): Promise<OKFNode[]> {
  const cleanText = rawText
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .trim();

  const slugBase =
    options.lawNumber
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'norma-cargada';

  const articleRegex =
    /(?:^|\n|(?<=[.;:\n])\s*)(?:ART[ÍIÌ]CULO|Art(?:ículo|iculo|\.)?|CL[ÁA]USULA|Cl[aá]usula|SECCI[ÓO]N|Secci[oó]n)\s*(\d+[°º]?(?:\s*bis|\s*ter)?|[A-Za-z0-9\.\-]+)\s*[\.\-—:º°]*\s*/giu;
  const matches = Array.from(cleanText.matchAll(articleRegex));

  const atomicUnits: Array<{ artNum: string; body: string }> = [];

  if (matches.length > 0) {
    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const artNum = current[1].replace(/[°º]/g, '').trim();
      const startIndex = current.index ?? 0;
      const endIndex = i + 1 < matches.length ? (matches[i + 1].index ?? cleanText.length) : cleanText.length;
      const body = cleanText.slice(startIndex, endIndex).trim();
      if (body.length > 10) {
        atomicUnits.push({ artNum, body });
      }
    }
  } else {
    // Si no tiene numeración explícita de artículos, dividir por párrafos o secciones lógicas
    const sections = cleanText.split(/\n{2,}/).filter((s) => s.trim().length > 30);
    if (sections.length > 0) {
      sections.forEach((sec, idx) => {
        atomicUnits.push({ artNum: `Sec-${idx + 1}`, body: sec.trim() });
      });
    } else {
      atomicUnits.push({
        artNum: 'Unico',
        body: cleanText,
      });
    }
  }

  const { nodes: existingCatalogNodes } = await getAllCatalogOKFNodes();

  const preparedUnits = atomicUnits.map((unit, idx) => {
    const safeArtSlug = unit.artNum.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const okf_id = `norma-${slugBase}-art-${safeArtSlug}`;

    // Título limpio sin duplicar el identificador del artículo
    const firstLine = unit.body.split('\n')[0].trim();
    const cleanFirstLine = firstLine
      .replace(/^(?:ART[ÍIÌ]CULO|Art(?:ículo|iculo|\.)?|CL[ÁA]USULA|Cl[aá]usula|SECCI[ÓO]N|Secci[oó]n)\s*[0-9A-Za-z°º\s]*[\.\-—:]*\s*/iu, '')
      .slice(0, 90)
      .trim();

    const title = cleanFirstLine
      ? `${options.lawNumber} - Art. ${unit.artNum}: ${cleanFirstLine}`
      : `${options.lawNumber} - Art. ${unit.artNum}`;

    const relations = discoverDynamicCrossReferences(unit.body, existingCatalogNodes);

    if (idx > 0) {
      const prevArtSlug = atomicUnits[idx - 1].artNum.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const prevId = `norma-${slugBase}-art-${prevArtSlug}`;
      if (!relations.some((r) => r.target === prevId)) {
        relations.push({ type: 'CONCUERDA_CON', target: prevId });
      }
    }

    return { index: idx, artNum: unit.artNum, body: unit.body.trim(), okf_id, title, relations };
  });

  // Extracción dinámica por lotes (hasta 10 artículos o 35.000 caracteres por llamada a Gemini)
  const extractedMap = new Map<number, { ontological_entities: OntologicalEntity[]; deontic_rules: DeonticRule[] }>();
  const batches: Array<typeof preparedUnits> = [];
  let currentBatch: typeof preparedUnits = [];
  let currentChars = 0;

  for (const item of preparedUnits) {
    if (currentBatch.length >= 10 || (currentBatch.length > 0 && currentChars + item.body.length > 35000)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push(item);
    currentChars += item.body.length;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  for (const batch of batches) {
    if (batch.length === 1) {
      const item = batch[0];
      const res = await extractOntologyAndDeonticLogicFromArticle(item.body, item.title);
      extractedMap.set(item.index, res);
      continue;
    }

    try {
      const batchResult = await extractOntologyAndDeonticBatch(batch);
      for (const [idx, val] of batchResult.entries()) {
        extractedMap.set(idx, val);
      }
    } catch (batchErr: any) {
      console.warn(`[Gemini Batch Extraction] Lote falló (${batchErr.message}), procesando artículos individualmente...`);
    }

    // Completar cualquier artículo faltante del lote de manera individual
    for (const item of batch) {
      if (!extractedMap.has(item.index)) {
        const fallbackRes = await extractOntologyAndDeonticLogicFromArticle(item.body, item.title);
        extractedMap.set(item.index, fallbackRes);
      }
    }
  }

  const createdNodes: OKFNode[] = preparedUnits.map((item) => {
    const extracted = extractedMap.get(item.index) || {
      ontological_entities: [],
      deontic_rules: [],
    };
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
      last_updated: new Date().toISOString().slice(0, 10),
      content: item.body,
      relations: item.relations,
      ontological_entities: extracted.ontological_entities,
      deontic_rules: extracted.deontic_rules,
    };
  });

  return createdNodes;
}

/**
 * Pipeline completo de Ingesta de PDF:
 * PDF Buffer -> Extracción -> Atomización OKF + Extracción Ontológica y Deóntica -> Validación Pre-Ingesta SHACL -> Archivo .md -> Grafo Neo4j
 */
export async function ingestLawPDFFromFrontend(
  buffer: Buffer,
  options: PDFIngestionOptions
): Promise<PDFIngestionResult> {
  const rawText = await extractTextFromPDFBuffer(buffer);
  const candidateNodes = await segmentLawIntoAtomicArticles(rawText, options);

  const nodesIngested: OKFNode[] = [];
  const shaclReports: Array<{ okf_id: string; report: SHACLValidationReport }> = [];
  let rejectedCount = 0;

  const okfDir = APP_CONFIG.okf.contentDir;
  await fs.mkdir(okfDir, { recursive: true });

  for (const node of candidateNodes) {
    const report = await validateOKFEntryWithSHACL(node);
    shaclReports.push({ okf_id: node.okf_id, report });

    if (!report.conforms) {
      rejectedCount++;
      continue;
    }

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
    await fs.writeFile(path.join(okfDir, `${node.okf_id}.md`), fileContent, 'utf-8');

    await upsertOKFNodeToNeo4j(node);
    nodesIngested.push(node);
  }

  if (nodesIngested.length > 0) {
    await linkOKFRelationsInNeo4j(nodesIngested);
  }

  return {
    success: nodesIngested.length > 0 && rejectedCount === 0,
    fileName: options.fileName,
    extractedCharacters: rawText.length,
    atomicArticlesCreated: candidateNodes.length,
    nodesIngested,
    shaclReports,
    rejectedCount,
  };
}
