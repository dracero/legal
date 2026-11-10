import fs from 'fs/promises';
import { Parser } from 'n3';
import factory from 'rdf-ext';
import SHACLValidator from 'rdf-validate-shacl';
import { APP_CONFIG } from '../config.ts';
import type { OKFNode } from '../neo4j/client.ts';
import type { PolicyDecision } from '../opa/evaluator.ts';

async function parseTurtleToDataset(turtleString: string) {
  const parser = new Parser();
  const quads = parser.parse(turtleString);
  return factory.dataset(quads);
}

async function loadShapesDataset() {
  const ttl = await fs.readFile(APP_CONFIG.shacl.shapesPath, 'utf-8');
  return parseTurtleToDataset(ttl);
}

export interface SHACLValidationReport {
  conforms: boolean;
  engine: string;
  violations: Array<{
    path: string;
    message: string;
    focusNode: string;
  }>;
  missingShapeRoles: string[];
  missingOkfIds: string[];
  rdfTurtlePreview: string;
}

/**
 * 1. Validador SHACL Pre-Ingesta (Evaluado con legal:OKFNodeShape en shapes.ttl)
 */
export async function validateOKFEntryWithSHACL(node: Partial<OKFNode>): Promise<SHACLValidationReport> {
  const ns = APP_CONFIG.shacl.ontologyNamespace;
  const safeId = (node.okf_id || 'nodo_sin_id').replace(/[^a-zA-Z0-9_-]/g, '_');

  const lines: string[] = [
    `@prefix legal: <${ns}> .`,
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `legal:${safeId} a legal:OKFEntry ;`,
  ];

  if (node.okf_id) lines.push(`  legal:okf_id "${escapeTurtle(node.okf_id)}" ;`);
  if (node.title) lines.push(`  legal:title "${escapeTurtle(node.title)}" ;`);
  if (node.status) lines.push(`  legal:status "${escapeTurtle(node.status)}" ;`);
  if (node.content) lines.push(`  legal:content "${escapeTurtle(node.content.slice(0, 500))}" ;`);

  lines[lines.length - 1] = lines[lines.length - 1].replace(/;$/, '.');
  const dataTurtle = lines.join('\n');

  const shapesDataset = await loadShapesDataset();
  const dataDataset = await parseTurtleToDataset(dataTurtle);
  const validator = new SHACLValidator(shapesDataset);
  const report = await validator.validate(dataDataset);

  const violations = (report.results || []).map((r: any) => ({
    path: r.path?.value ? r.path.value.replace(ns, 'legal:') : 'legal:OKFEntry',
    message: r.message?.[0]?.value || 'Violación de restricción SHACL en norma.',
    focusNode: r.focusNode?.value ? r.focusNode.value.replace(ns, 'legal:') : `legal:${safeId}`,
  }));

  return {
    conforms: Boolean(report.conforms),
    engine: 'rdf-validate-shacl (W3C SHACL)',
    violations,
    missingShapeRoles: [],
    missingOkfIds: [],
    rdfTurtlePreview: dataTurtle,
  };
}

/**
 * 2. Validador SHACL Pre-Generación sobre el Subgrafo Recuperado de Neo4j (legal:LegalAnalysisShape)
 */
export async function validarGrafoConSHACL(
  subgrafo: OKFNode[],
  directivasOPA: PolicyDecision
): Promise<SHACLValidationReport> {
  const ns = APP_CONFIG.shacl.ontologyNamespace;
  const vigentes = subgrafo.filter((n) => n.status === 'Vigente');

  const lines: string[] = [
    `@prefix legal: <${ns}> .`,
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    'legal:DictamenCasoActual a legal:DictamenLegal ;',
    '  legal:connectsHechosCaso "true"^^xsd:boolean ;',
  ];

  for (const node of vigentes) {
    const safeId = node.okf_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    lines.push(`  legal:hasNormaVigente legal:${safeId} ;`);
  }

  const presentIds = new Set(vigentes.map((n) => n.okf_id));
  const missingOkfIds: string[] = [];
  for (const reqId of directivasOPA.nodos_okf_obligatorios || []) {
    if (!presentIds.has(reqId)) {
      missingOkfIds.push(reqId);
      lines.push(`  legal:missingRequiredOPANode "${escapeTurtle(reqId)}" ;`);
    }
  }

  lines[lines.length - 1] = lines[lines.length - 1].replace(/;$/, '.');
  const dataTurtle = lines.join('\n');

  const shapesDataset = await loadShapesDataset();
  const dataDataset = await parseTurtleToDataset(dataTurtle);
  const validator = new SHACLValidator(shapesDataset);
  const report = await validator.validate(dataDataset);

  const missingShapeRoles: string[] = [];
  const violations = (report.results || []).map((r: any) => {
    const rawMsg: string = r.message?.[0]?.value || 'Violación SHACL en subgrafo.';
    const parts = rawMsg.split('|');
    if (parts.length === 2) {
      missingShapeRoles.push(parts[0]);
    }
    return {
      path: r.path?.value ? r.path.value.replace(ns, 'legal:') : 'legal:DictamenLegal',
      message: parts.length === 2 ? parts[1] : rawMsg,
      focusNode: r.focusNode?.value ? r.focusNode.value.replace(ns, 'legal:') : 'legal:DictamenCasoActual',
    };
  });

  return {
    conforms: Boolean(report.conforms),
    engine: 'rdf-validate-shacl (W3C SHACL)',
    violations,
    missingShapeRoles: Array.from(new Set(missingShapeRoles)),
    missingOkfIds,
    rdfTurtlePreview: dataTurtle,
  };
}

/**
 * 3. Auditor Epistémico Post-Generación (legal:EpistemicAuditShape)
 */
export interface EpistemicAuditResult {
  passed: boolean;
  totalNodesInSubgraph: number;
  citedOkfIds: string[];
  citedLawsMatched: string[];
  unverifiedCitations: string[];
  opaComplianceVerified: boolean;
  shaclPostConditionConforms: boolean;
  auditSummary: string;
}

export async function auditarDictamenEpistemico(
  dictamenMarkdown: string,
  subgrafo: OKFNode[],
  _directivasOPA: PolicyDecision
): Promise<EpistemicAuditResult> {
  const ns = APP_CONFIG.shacl.ontologyNamespace;
  const validNodeMap = new Map<string, OKFNode>(subgrafo.map((n) => [n.okf_id.toLowerCase(), n]));

  // Extraer únicamente citas explícitas entre corchetes [norma-...] del dictamen
  const citationMatches = Array.from(dictamenMarkdown.matchAll(/\[(norma-[a-z0-9_-]+)\]/gi));
  const citedSet = new Set<string>();
  const unverifiedSet = new Set<string>();

  for (const m of citationMatches) {
    const citedId = m[1].toLowerCase();
    if (validNodeMap.has(citedId)) {
      citedSet.add(validNodeMap.get(citedId)!.okf_id);
    } else {
      unverifiedSet.add(citedId);
    }
  }

  const citedOkfIds = Array.from(citedSet);
  const unverifiedCitations = Array.from(unverifiedSet);
  const citedLawsMatched = citedOkfIds
    .map((id) => validNodeMap.get(id.toLowerCase()))
    .filter(Boolean)
    .map((n) => `${n!.law_number || n!.okf_id} (${n!.title})`);

  const lines: string[] = [
    `@prefix legal: <${ns}> .`,
    '',
    'legal:AuditoriaActual a legal:AuditoriaDictamen ;',
  ];

  for (const id of citedOkfIds) {
    lines.push(`  legal:hasVerifiedCitation "${escapeTurtle(id)}" ;`);
  }
  for (const badId of unverifiedCitations) {
    lines.push(`  legal:hasHallucinatedCitation "${escapeTurtle(badId)}" ;`);
  }
  if (citedOkfIds.length === 0 && unverifiedCitations.length === 0) {
    lines.push('  legal:emptyAudit "true" ;');
  }

  lines[lines.length - 1] = lines[lines.length - 1].replace(/;$/, '.');
  const auditTurtle = lines.join('\n');

  const shapesDataset = await loadShapesDataset();
  const dataDataset = await parseTurtleToDataset(auditTurtle);
  const validator = new SHACLValidator(shapesDataset);
  const report = await validator.validate(dataDataset);

  const shaclPostConditionConforms = Boolean(report.conforms);
  const opaComplianceVerified = unverifiedCitations.length === 0 && citedOkfIds.length > 0;
  const passed = shaclPostConditionConforms && opaComplianceVerified;

  return {
    passed,
    totalNodesInSubgraph: subgrafo.length,
    citedOkfIds,
    citedLawsMatched,
    unverifiedCitations,
    opaComplianceVerified,
    shaclPostConditionConforms,
    auditSummary: passed
      ? `Auditoría Epistémica SHACL Aprobada: ${citedOkfIds.length}/${subgrafo.length} normas del documento citadas con trazabilidad verificada y 0 citas alucinadas.`
      : `Alerta Epistémica SHACL: ${(report.results || []).map((r: any) => r.message?.[0]?.value).join(' | ') || 'Faltan citas verificadas o se detectaron citas no pertenecientes al subgrafo.'}`,
  };
}

function escapeTurtle(str: string): string {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}
