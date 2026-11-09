import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { APP_CONFIG } from '../config.ts';
import {
  type OKFNode,
  type OKFRelation,
  upsertOKFNodeToNeo4j,
  linkOKFRelationsInNeo4j,
  getAllCatalogOKFNodes,
} from '../neo4j/client.ts';
import { validateOKFEntryWithSHACL, type SHACLValidationReport } from '../shacl/validator.ts';

export interface PDFIngestionOptions {
  fileName: string;
  lawNumber: string;
  jurisdiction: string;
  category: string;
  shapeRole: string;
  especialidades: string[];
  status: string;
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

/**
 * Descubre referencias cruzadas de forma 100% dinámica comparando el texto del artículo
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
 * Divide el texto legal por Artículos manteniendo juntos cada artículo y todos sus incisos.
 */
export async function segmentLawIntoAtomicArticles(
  rawText: string,
  options: PDFIngestionOptions
): Promise<OKFNode[]> {
  const cleanText = rawText.replace(/\r\n/g, '\n').trim();
  const slugBase =
    options.lawNumber
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'norma-pdf';

  const articleRegex =
    /(?:^|\n)\s*(?:ART[ÍIÌ]CULO|Art(?:ículo|iculo|\.)?)\s*(\d+[°º]?(?:\s*bis|\s*ter)?)\s*[\.\-—:º°]*\s*/giu;
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
    atomicUnits.push({
      artNum: 'Unico',
      body: cleanText,
    });
  }

  const { nodes: existingCatalogNodes } = await getAllCatalogOKFNodes();
  const createdNodes: OKFNode[] = [];

  for (let idx = 0; idx < atomicUnits.length; idx++) {
    const unit = atomicUnits[idx];
    const safeArtSlug = unit.artNum.toLowerCase().replace(/\s+/g, '-');
    const okf_id = `norma-${slugBase}-art-${safeArtSlug}`;

    const firstLine = unit.body.split('\n')[0].slice(0, 110).trim();
    const title = `${options.lawNumber} - Art. ${unit.artNum}: ${firstLine}`;

    const relations = discoverDynamicCrossReferences(unit.body, existingCatalogNodes);

    if (idx > 0) {
      const prevArtSlug = atomicUnits[idx - 1].artNum.toLowerCase().replace(/\s+/g, '-');
      const prevId = `norma-${slugBase}-art-${prevArtSlug}`;
      if (!relations.some((r) => r.target === prevId)) {
        relations.push({ type: 'CONCUERDA_CON', target: prevId });
      }
    }

    const structuredMarkdown = [
      `# Texto Normativo Atómico (${options.lawNumber} - Art. ${unit.artNum})`,
      unit.body,
      '',
      `# Metadatos de Ingesta OKF`,
      `- **Fuente PDF:** ${options.fileName}`,
      `- **Jurisdicción:** ${options.jurisdiction}`,
      `- **Categoría:** ${options.category}`,
      `- **Especialidades FIUBA alcanzadas:** ${options.especialidades.join(', ')}`,
    ].join('\n');

    createdNodes.push({
      okf_id,
      title,
      node_type: 'Articulo',
      shape_role: options.shapeRole,
      law_number: options.lawNumber,
      article_number: unit.artNum,
      hierarchy_level: options.jurisdiction === 'Nacional' ? 'Ley_Nacional' : 'Ley_Local',
      domain: 'Ingenieria_Legal',
      category: options.category,
      jurisdiction: options.jurisdiction,
      especialidades_fiuba: options.especialidades,
      status: options.status,
      last_updated: new Date().toISOString().slice(0, 10),
      content: structuredMarkdown,
      relations,
    });
  }

  return createdNodes;
}

/**
 * Pipeline completo de Ingesta de PDF:
 * PDF Buffer -> Extracción -> Atomización OKF -> Validación Pre-Ingesta SHACL -> Archivo .md -> Grafo Neo4j (HF Embeddings)
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
      shape_role: node.shape_role,
      law_number: node.law_number,
      article_number: node.article_number,
      hierarchy_level: node.hierarchy_level,
      domain: node.domain,
      category: node.category,
      jurisdiction: node.jurisdiction,
      especialidades_fiuba: node.especialidades_fiuba,
      status: node.status,
      last_updated: node.last_updated,
      relations: node.relations,
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
