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
 * 1. Validador SHACL Pre-Ingesta (100% impulsado por fiuba:OKFNodeShape en shapes.ttl)
 */
export async function validateOKFEntryWithSHACL(node: Partial<OKFNode>): Promise<SHACLValidationReport> {
  const ns = APP_CONFIG.shacl.ontologyNamespace;
  const safeId = (node.okf_id || 'nodo_sin_id').replace(/[^a-zA-Z0-9_-]/g, '_');
  const especialidades = Array.isArray(node.especialidades_fiuba) ? node.especialidades_fiuba : [];

  const lines: string[] = [
    `@prefix fiuba: <${ns}> .`,
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `fiuba:${safeId} a fiuba:OKFEntry ;`,
  ];

  if (node.okf_id) lines.push(`  fiuba:okf_id "${escapeTurtle(node.okf_id)}" ;`);
  if (node.title) lines.push(`  fiuba:title "${escapeTurtle(node.title)}" ;`);
  if (node.jurisdiction) lines.push(`  fiuba:jurisdiction "${escapeTurtle(node.jurisdiction)}" ;`);
  if (node.status) lines.push(`  fiuba:status "${escapeTurtle(node.status)}" ;`);
  if (node.shape_role) lines.push(`  fiuba:shape_role "${escapeTurtle(node.shape_role)}" ;`);
  for (const esp of especialidades) {
    lines.push(`  fiuba:especialidad "${escapeTurtle(esp)}" ;`);
  }

  lines[lines.length - 1] = lines[lines.length - 1].replace(/;$/, '.');
  const dataTurtle = lines.join('\n');

  const shapesDataset = await loadShapesDataset();
  const dataDataset = await parseTurtleToDataset(dataTurtle);
  const validator = new SHACLValidator(shapesDataset);
  const report = await validator.validate(dataDataset);

  const violations = (report.results || []).map((r: any) => ({
    path: r.path?.value ? r.path.value.replace(ns, 'fiuba:') : 'fiuba:OKFEntry',
    message: r.message?.[0]?.value || 'Violación de restricción SHACL.',
    focusNode: r.focusNode?.value ? r.focusNode.value.replace(ns, 'fiuba:') : `fiuba:${safeId}`,
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
 * 2. Validador SHACL Pre-Generación sobre el Subgrafo Recuperado de Neo4j (fiuba:LegalAnalysisShape en shapes.ttl)
 */
export async function validarGrafoConSHACL(
  subgrafo: OKFNode[],
  directivasOPA: PolicyDecision
): Promise<SHACLValidationReport> {
  const ns = APP_CONFIG.shacl.ontologyNamespace;
  const vigentes = subgrafo.filter((n) => n.status === 'Vigente');

  const roleToPredicate: Record<string, string> = {
    NormaFondo: 'hasNormaFondo',
    PrincipioDeResponsabilidad: 'hasPrincipioResponsabilidad',
    MarcoEjercicioProfesional: 'hasMarcoEjercicio',
    EticaProfesional: 'hasEticaProfesional',
  };

  const lines: string[] = [
    `@prefix fiuba: <${ns}> .`,
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    'fiuba:DictamenCasoActual a fiuba:DictamenLegal ;',
    '  fiuba:connectsHechoIngenieril "true"^^xsd:boolean ;',
  ];

  for (const node of vigentes) {
    const safeId = node.okf_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const pred = roleToPredicate[node.shape_role] || 'hasNormaFondo';
    lines.push(`  fiuba:hasNormaVigente fiuba:${safeId} ;`);
    lines.push(`  fiuba:${pred} fiuba:${safeId} ;`);
  }

  const presentIds = new Set(vigentes.map((n) => n.okf_id));
  const missingOkfIds: string[] = [];
  for (const reqId of directivasOPA.nodos_okf_obligatorios || []) {
    if (!presentIds.has(reqId)) {
      missingOkfIds.push(reqId);
      lines.push(`  fiuba:missingRequiredOPANode "${escapeTurtle(reqId)}" ;`);
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
      path: r.path?.value ? r.path.value.replace(ns, 'fiuba:') : 'fiuba:DictamenLegal',
      message: parts.length === 2 ? parts[1] : rawMsg,
      focusNode: r.focusNode?.value ? r.focusNode.value.replace(ns, 'fiuba:') : 'fiuba:DictamenCasoActual',
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
 * 3. Auditor Epistémico Post-Generación (Evaluado con fiuba:EpistemicAuditShape en shapes.ttl)
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

  // Extraer todas las citas explícitas [norma-...] del documento generado
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

  // También verificar menciones directas de okf_id sin corchetes
  const lowerText = dictamenMarkdown.toLowerCase();
  for (const node of subgrafo) {
    if (lowerText.includes(node.okf_id.toLowerCase())) {
      citedSet.add(node.okf_id);
    }
  }

  const citedOkfIds = Array.from(citedSet);
  const unverifiedCitations = Array.from(unverifiedSet);
  const citedLawsMatched = citedOkfIds
    .map((id) => validNodeMap.get(id.toLowerCase()))
    .filter(Boolean)
    .map((n) => `${n!.law_number} (${n!.title})`);

  const lines: string[] = [
    `@prefix fiuba: <${ns}> .`,
    '',
    'fiuba:AuditoriaActual a fiuba:AuditoriaDictamen ;',
  ];

  for (const id of citedOkfIds) {
    lines.push(`  fiuba:hasVerifiedCitation "${escapeTurtle(id)}" ;`);
  }
  for (const badId of unverifiedCitations) {
    lines.push(`  fiuba:hasHallucinatedCitation "${escapeTurtle(badId)}" ;`);
  }
  if (citedOkfIds.length === 0 && unverifiedCitations.length === 0) {
    lines.push('  fiuba:emptyAudit "true" ;');
  }

  lines[lines.length - 1] = lines[lines.length - 1].replace(/;$/, '.');
  const auditTurtle = lines.join('\n');

  const shapesDataset = await loadShapesDataset();
  const dataDataset = await parseTurtleToDataset(auditTurtle);
  const validator = new SHACLValidator(shapesDataset);
  const report = await validator.validate(dataDataset);

  const shaclPostConditionConforms = Boolean(report.conforms);
  const opaComplianceVerified = unverifiedCitations.length === 0 && citedOkfIds.length > 0;

  return {
    passed: shaclPostConditionConforms && opaComplianceVerified,
    totalNodesInSubgraph: subgrafo.length,
    citedOkfIds,
    citedLawsMatched,
    unverifiedCitations,
    opaComplianceVerified,
    shaclPostConditionConforms,
    auditSummary: shaclPostConditionConforms
      ? `Auditoría Epistémica SHACL Aprobada: ${citedOkfIds.length}/${subgrafo.length} nodos normativos del subgrafo Neo4j citados con trazabilidad exacta y 0 citas alucinadas.`
      : `Alerta Epistémica SHACL: ${(report.results || []).map((r: any) => r.message?.[0]?.value).join(' | ')}`,
  };
}

function escapeTurtle(str: string): string {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}
