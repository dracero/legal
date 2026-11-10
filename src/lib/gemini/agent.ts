import { z } from 'zod';
import { Type } from '@google/genai';
import { APP_CONFIG } from '../config.ts';
import { geminiRotator } from './key-rotator.ts';
import { loadPrompt } from '../prompts/loader.ts';
import { evaluarEnServidorOPA, type HechosCaso, type PolicyDecision } from '../opa/evaluator.ts';
import {
  hybridRetrieveAndExpandSubgraph,
  completarNodosFaltantesNeo4j,
  getAllCatalogOKFNodes,
  type OKFNode,
  type GraphEdge,
} from '../neo4j/client.ts';
import {
  validarGrafoConSHACL,
  auditarDictamenEpistemico,
  type SHACLValidationReport,
  type EpistemicAuditResult,
} from '../shacl/validator.ts';

// Modelo único configurado (sin modelo fallback)
export const CONFIGURED_GEMINI_MODEL = APP_CONFIG.gemini.model;

// Esquema Zod estricto para Agente 1 (FactExtractorFlow) - Universal y Agnóstico de Dominio
export const HechosCasoSchema = z.object({
  sujetos_involucrados: z.array(z.string()),
  parte_evaluada: z.string(),
  rol_o_condicion_juridica: z.string(),
  conductas_relevantes: z.array(z.string()),
  omisiones_atribuidas: z.array(z.string()),
  danos_o_resultados: z.array(z.string()),
  clausulas_o_defensas_invocadas: z.array(z.string()),
  resumen_factico: z.string(),
});

// Structured Output Schema para Gemini 3.6 Flash
const GEMINI_FACT_EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    sujetos_involucrados: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Partes o personas humanas o jurídicas involucradas en el caso',
    },
    parte_evaluada: {
      type: Type.STRING,
      description: 'Sujeto o entidad cuya conducta o responsabilidad se somete a dictamen',
    },
    rol_o_condicion_juridica: {
      type: Type.STRING,
      description: 'Calidad o posición jurídica del sujeto evaluado (ej: locador, proveedor, fiduciario, contratista, administrado, etc.)',
    },
    conductas_relevantes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Acciones positivas realizadas por las partes relevantes para el análisis',
    },
    omisiones_atribuidas: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Deberes o prestaciones que se imputan no haber sido cumplidos',
    },
    danos_o_resultados: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Perjuicios, efectos o resultados fácticos verificados',
    },
    clausulas_o_defensas_invocadas: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Estipulaciones contractuales, defensas, dispensas o exenciones alegadas',
    },
    resumen_factico: {
      type: Type.STRING,
      description: 'Síntesis concisa y objetiva de los hechos fácticos',
    },
  },
  required: [
    'sujetos_involucrados',
    'parte_evaluada',
    'rol_o_condicion_juridica',
    'conductas_relevantes',
    'omisiones_atribuidas',
    'danos_o_resultados',
    'clausulas_o_defensas_invocadas',
    'resumen_factico',
  ],
};

/**
 * Invoca el modelo Gemini configurado sin modelo fallback ni degradación silenciosa.
 */
async function invokeGemini(params: {
  systemInstruction: string;
  contents: string;
  responseMimeType?: string;
  responseSchema?: any;
  maxOutputTokens?: number;
}): Promise<string> {
  const modelName = CONFIGURED_GEMINI_MODEL;

  const config: Record<string, any> = {
    systemInstruction: params.systemInstruction,
  };
  if (params.responseMimeType) config.responseMimeType = params.responseMimeType;
  if (params.responseSchema) config.responseSchema = params.responseSchema;
  if (params.maxOutputTokens) config.maxOutputTokens = params.maxOutputTokens;

  return await geminiRotator.executeWithRotation(async (client, key, masked) => {
    const response = await client.models.generateContent({
      model: modelName,
      contents: params.contents,
      config,
    });

    if (!response.text || response.text.trim().length === 0) {
      throw new Error(`El modelo Gemini '${modelName}' no devolvió texto en su respuesta.`);
    }

    return response.text.trim();
  }, `invokeGemini (${modelName})`);
}

/**
 * PASO 1: Agente Clasificador de Hechos (FactExtractorFlow)
 */
export async function extractFactsFromCase(
  casoPlanteado: string
): Promise<{ hechos: HechosCaso; modelUsed: string }> {
  const text = await invokeGemini({
    systemInstruction: loadPrompt('fact-extractor.md'),
    contents: `Caso planteado para análisis jurídico:\n${casoPlanteado}`,
    responseMimeType: 'application/json',
    responseSchema: GEMINI_FACT_EXTRACTION_SCHEMA,
  });

  const parsedJson = JSON.parse(text);
  const validated = HechosCasoSchema.parse(parsedJson);
  return { hechos: validated, modelUsed: CONFIGURED_GEMINI_MODEL };
}

export interface CapituloConfig {
  id: string;
  numeroRomano: string;
  titulo: string;
  subtitulo: string;
}

export const CAPITULOS_DICTAMEN: CapituloConfig[] = [
  {
    id: 'Encuadre_Factico_Juridico',
    numeroRomano: 'I',
    titulo: 'Sección I: Encuadre Fáctico, Sujetos y Calificación Jurídica de las Conductas',
    subtitulo: 'Identificación de partes, vínculos jurídicos, conductas analizadas y defensas o cláusulas invocadas',
  },
  {
    id: 'Exegesis_Normativa_Deontica',
    numeroRomano: 'II',
    titulo: 'Sección II: Exégesis Normativa y Matriz Deóntica del Documento Cargado',
    subtitulo: 'Análisis artículo por artículo del subgrafo OKF vigente, obligaciones, prohibiciones y jerarquía de Kelsen',
  },
  {
    id: 'Subsuncion_Responsabilidades',
    numeroRomano: 'III',
    titulo: 'Sección III: Subsunción Fáctica: Incumplimientos, Infracciones y Consecuencias Jurídicas',
    subtitulo: 'Contraste entre los hechos y la matriz deóntica OPA: deberes violados, nulidades y sanciones aplicables',
  },
  {
    id: 'Dictamen_Contrafacticos',
    numeroRomano: 'IV',
    titulo: 'Sección IV: Conclusiones, Dictamen Fundado y Escenarios Contrafácticos',
    subtitulo: 'Resolución jurídica conclusiva anclada en el texto normativo y análisis de hipótesis contrafácticas',
  },
];

/**
 * Divide un dictamen Markdown en las 4 secciones configuradas respetando encabezados ## Sección.
 */
export function splitDictamenIntoSections(
  text: string
): Array<{ id: string; titulo: string; markdown: string }> {
  const sectionRegex =
    /##\s*Secci[oó]n\s*([I|V|X]+)[^\n]*\n([\s\S]*?)(?=(?:##\s*Secci[oó]n\s*[I|V|X]+)|$)/gi;
  const matches = Array.from(text.matchAll(sectionRegex));
  const results: Array<{ id: string; titulo: string; markdown: string }> = [];

  if (matches.length >= 4) {
    for (let i = 0; i < CAPITULOS_DICTAMEN.length; i++) {
      const cap = CAPITULOS_DICTAMEN[i];
      const match = matches[i];
      const body = match ? match[0].trim() : `## ${cap.titulo}\n\n(Sección desarrollada)`;
      results.push({ id: cap.id, titulo: cap.titulo, markdown: body });
    }
  } else {
    results.push({
      id: CAPITULOS_DICTAMEN[0].id,
      titulo: CAPITULOS_DICTAMEN[0].titulo,
      markdown: text,
    });
    for (let i = 1; i < CAPITULOS_DICTAMEN.length; i++) {
      results.push({
        id: CAPITULOS_DICTAMEN[i].id,
        titulo: CAPITULOS_DICTAMEN[i].titulo,
        markdown: `*(Contenido integrado en la resolución general)*`,
      });
    }
  }

  return results;
}

/**
 * Envuelve entre corchetes citas exactas de okf_id que aparezcan sueltas en el texto
 * y normaliza sub-anclas no registradas (ej. [norma-x-art-5-anexo] -> [norma-x-art-5]) con 0 tokens LLM.
 */
export function wrapBareValidCitations(markdownText: string, validNodes: OKFNode[]): string {
  let updated = markdownText;
  const sortedNodes = [...validNodes].sort((a, b) => b.okf_id.length - a.okf_id.length);
  const validIdSet = new Set(validNodes.map((n) => n.okf_id.toLowerCase()));

  for (const node of sortedNodes) {
    const escapedId = node.okf_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 1. Envolver ocurrencias exactas sin corchetes
    const bareRegex = new RegExp(`(?<!\\[)(?<![a-zA-Z0-9_-])${escapedId}(?![a-zA-Z0-9_-])`, 'gi');
    updated = updated.replace(bareRegex, `[${node.okf_id}]`);

    // 2. Normalizar sub-anclas (ej. -anexo, -inc-1) al okf_id padre válido más específico
    const subAnchorRegex = new RegExp(`\\[(${escapedId}(?:-[a-z0-9_-]+)+)\\]`, 'gi');
    updated = updated.replace(subAnchorRegex, (fullMatch, innerId) => {
      if (validIdSet.has(String(innerId).toLowerCase())) {
        return fullMatch;
      }
      return `[${node.okf_id}]`;
    });
  }

  return updated;
}

/**
 * PASO 5: Genera el Dictamen Completo en un pase integral optimizado
 * garantizando coherencia argumental, reduciendo latencia y optimizando el consumo de cuota de Gemini 3.6 Flash.
 */
export async function generateFullDictamen(
  hechos: HechosCaso,
  directivasOPA: PolicyDecision,
  subgrafoOKF: OKFNode[]
): Promise<Array<{ id: string; titulo: string; markdown: string }>> {
  const systemPrompt = loadPrompt('dictamen-exegesis.md', {
    exampleOkfId: subgrafoOKF[0]?.okf_id || 'norma-id',
  });

  const text = await invokeGemini({
    systemInstruction: systemPrompt,
    contents: JSON.stringify({
      hechosDelCaso: hechos,
      falloDeterministaOPA: directivasOPA,
      nodosOKFVigentes: subgrafoOKF.map((n) => ({
        okf_id: n.okf_id,
        title: n.title,
        law_number: n.law_number,
        article_number: n.article_number,
        jurisdiction: n.jurisdiction,
        content: n.content,
        ontological_entities: n.ontological_entities || [],
        deontic_rules: n.deontic_rules || [],
      })),
    }),
    maxOutputTokens: APP_CONFIG.gemini.maxOutputTokens,
  });

  return splitDictamenIntoSections(text);
}

/**
 * Pase único de auto-reparación epistémica cuando Etapa 6 detecta citas alucinadas o faltantes.
 */
export async function repairDictamenEpistemicCitations(params: {
  dictamenMarkdown: string;
  validNodes: OKFNode[];
  unverifiedCitations: string[];
  citedOkfIds: string[];
}): Promise<string> {
  const systemPrompt = loadPrompt('epistemic-repair.md', {
    exampleOkfId: params.validNodes[0]?.okf_id || 'norma-id',
  });

  return await invokeGemini({
    systemInstruction: systemPrompt,
    contents: JSON.stringify({
      citasInvalidas: params.unverifiedCitations,
      citasValidasYaPresentes: params.citedOkfIds,
      nodosValidosPermitidos: params.validNodes.map((n) => ({
        okf_id: n.okf_id,
        title: n.title,
        article_number: n.article_number,
      })),
      dictamenActual: params.dictamenMarkdown,
    }),
    maxOutputTokens: APP_CONFIG.gemini.maxOutputTokens,
  });
}

export interface PipelineStepEvent {
  step: number;
  stageId: string;
  title: string;
  status: 'running' | 'completed' | 'repaired' | 'failed';
  detail: string;
  payload?: any;
}

/**
 * Orquestador Completo de los 6 Pasos con soporte de Streaming de Eventos
 */
export async function executeNeuroSymbolicPipeline(
  casoPlanteado: string,
  onEvent?: (event: PipelineStepEvent) => void
): Promise<{
  hechos: HechosCaso;
  modelUsed: string;
  directivasOPA: PolicyDecision;
  subgrafoNodes: OKFNode[];
  subgrafoEdges: GraphEdge[];
  reporteSHACLInicial: SHACLValidationReport;
  reporteSHACLFinal: SHACLValidationReport;
  reparacionSHACLEjecutada: boolean;
  reparacionEpistemicaEjecutada: boolean;
  seccionesRedactadas: Array<{ id: string; titulo: string; markdown: string }>;
  dictamenCompletoMarkdown: string;
  auditoriaEpistemica: EpistemicAuditResult;
}> {
  const emit = (ev: PipelineStepEvent) => {
    if (onEvent) onEvent(ev);
  };

  // 0. Verificar si existen normas cargadas por el usuario en Neo4j
  const { nodes: catalogNodes } = await getAllCatalogOKFNodes();
  if (catalogNodes.length === 0) {
    throw new Error(
      'No se han subido documentos normativos en PDF. Por favor cargue al menos un documento legal en PDF desde el panel superior para analizar el caso (el sistema analiza estricta y exclusivamente las normas que usted ingrese).'
    );
  }

  // PASO 1: Extracción de Hechos (FactExtractorFlow)
  emit({
    step: 1,
    stageId: 'FactExtractorFlow',
    title: '1. Agente Clasificador de Hechos (Esquema Zod Estricto)',
    status: 'running',
    detail: `Extrayendo variables fácticas, sujetos y conductas con esquema Zod (${CONFIGURED_GEMINI_MODEL})...`,
  });

  const { hechos, modelUsed } = await extractFactsFromCase(casoPlanteado);

  emit({
    step: 1,
    stageId: 'FactExtractorFlow',
    title: '1. Agente Clasificador de Hechos (Esquema Zod Estricto)',
    status: 'completed',
    detail: `Parte Evaluada: ${hechos.parte_evaluada} (${hechos.rol_o_condicion_juridica}) | Conductas: ${hechos.conductas_relevantes.length} | Omisiones: ${hechos.omisiones_atribuidas.length}`,
    payload: { hechos, modelUsed },
  });

  // PASO 2: Motor Deóntico de Políticas (OPA / Rego)
  emit({
    step: 2,
    stageId: 'OPAPolicyGate',
    title: '2. Motor Deóntico de Políticas (OPA / Rego v1)',
    status: 'running',
    detail: 'Evaluando matriz deóntica (obligaciones, prohibiciones, nulidades y Kelsen) en OPA sobre la norma cargada...',
  });

  const directivasOPA = await evaluarEnServidorOPA(hechos, catalogNodes);

  emit({
    step: 2,
    stageId: 'OPAPolicyGate',
    title: '2. Motor Deóntico de Políticas (OPA / Rego v1)',
    status: 'completed',
    detail: `Motor ${directivasOPA.engine} (${directivasOPA.evaluation_time_ms}ms) -> ${directivasOPA.nodos_okf_obligatorios.length} nodos OKF obligatorios activados.`,
    payload: directivasOPA,
  });

  // PASO 3: Agente Recuperador Híbrido (Neo4j + OKF)
  emit({
    step: 3,
    stageId: 'HybridGraphRetrieverFlow',
    title: '3. Agente Recuperador Híbrido (Neo4j Hugging Face Vector + BM25 + Cypher)',
    status: 'running',
    detail: `Consultando Neo4j con embeddings Hugging Face (${APP_CONFIG.huggingface.model}) y expandiendo vecindario Cypher...`,
  });

  const queryCombined = `${casoPlanteado} ${directivasOPA.terminos_busqueda_obligatorios.join(' ')}`;
  const { nodes: initialNodes, edges: initialEdges } = await hybridRetrieveAndExpandSubgraph({
    queryText: queryCombined,
    obligatoriosOPA: directivasOPA.nodos_okf_obligatorios,
    limit: 12,
  });

  emit({
    step: 3,
    stageId: 'HybridGraphRetrieverFlow',
    title: '3. Agente Recuperador Híbrido (Neo4j Hugging Face Vector + BM25 + Cypher)',
    status: 'completed',
    detail: `Subgrafo recuperado: ${initialNodes.length} nodos OKF vigentes y ${initialEdges.length} relaciones normativas explícitas.`,
    payload: { nodes: initialNodes, edges: initialEdges },
  });

  // PASO 4: Validador Ontológico (SHACL) + Bucle de Autorreparación Determinista
  emit({
    step: 4,
    stageId: 'SHACLValidatorNode',
    title: '4. Validador Ontológico Estructural (W3C SHACL)',
    status: 'running',
    detail: 'Validando topología RDF del subgrafo contra legal:LegalAnalysisShape...',
  });

  const reporteSHACLInicial = await validarGrafoConSHACL(initialNodes, directivasOPA);
  let finalNodes = initialNodes;
  let reporteSHACLFinal = reporteSHACLInicial;
  let reparacionSHACLEjecutada = false;

  if (!reporteSHACLInicial.conforms) {
    reparacionSHACLEjecutada = true;
    finalNodes = await completarNodosFaltantesNeo4j(
      initialNodes,
      reporteSHACLInicial.missingOkfIds
    );
    reporteSHACLFinal = await validarGrafoConSHACL(finalNodes, directivasOPA);
  }

  emit({
    step: 4,
    stageId: 'SHACLValidatorNode',
    title: '4. Validador Ontológico Estructural (W3C SHACL)',
    status: reparacionSHACLEjecutada ? 'repaired' : 'completed',
    detail: reparacionSHACLEjecutada
      ? `Autorreparación SHACL ejecutada: subgrafo completado (${finalNodes.length} nodos). sh:conforms = ${reporteSHACLFinal.conforms}`
      : `Conformidad SHACL verificada (sh:conforms = true) con ${finalNodes.length} nodos conectados.`,
    payload: {
      reporteSHACLInicial,
      reporteSHACLFinal,
      reparacionSHACLEjecutada,
      nodes: finalNodes,
    },
  });

  // PASO 5: Agente Exégeta / Redactor de Largo Aliento (DeepLegalExpanderFlow)
  emit({
    step: 5,
    stageId: 'DeepLegalExpanderFlow',
    title: '5. Agente Exégeta de Largo Aliento (Pase Integral I-IV)',
    status: 'running',
    detail: `Redactando dictamen exhaustivo en 4 secciones con ${modelUsed}...`,
    payload: { currentChapterIndex: 0, chapterId: 'Dictamen_Completo' },
  });

  const seccionesRedactadas = await generateFullDictamen(hechos, directivasOPA, finalNodes);

  for (let i = 0; i < seccionesRedactadas.length; i++) {
    const sec = seccionesRedactadas[i];
    emit({
      step: 5,
      stageId: 'DeepLegalExpanderFlow',
      title: `5. Agente Exégeta de Largo Aliento (${i + 1}/IV)`,
      status: 'completed',
      detail: `Sección ${i + 1} completada (${sec.markdown.length} caracteres).`,
      payload: {
        chapterCompleted: sec,
        progress: `${i + 1}/${seccionesRedactadas.length}`,
      },
    });
  }

  let finalSections = seccionesRedactadas;
  let dictamenCompletoMarkdown = finalSections.map((s) => s.markdown).join('\n\n---\n\n');

  // PASO 6: Auditor Epistémico Post-Generación (SHACL + OPA) + Auto-Reparación (máx. 1 pase)
  emit({
    step: 6,
    stageId: 'EpistemicAuditorNode',
    title: '6. Auditor Epistémico Post-Generación (SHACL + OPA)',
    status: 'running',
    detail: 'Verificando trazabilidad de citas contra legal:EpistemicAuditShape y el subgrafo Neo4j...',
  });

  let auditoriaEpistemica = await auditarDictamenEpistemico(
    dictamenCompletoMarkdown,
    finalNodes,
    directivasOPA
  );
  let reparacionEpistemicaEjecutada = false;

  if (!auditoriaEpistemica.passed) {
    // 6A. Intento determinista (0 tokens LLM): normalizar citas exactas sin corchetes
    const normalizedMd = wrapBareValidCitations(dictamenCompletoMarkdown, finalNodes);
    if (normalizedMd !== dictamenCompletoMarkdown) {
      dictamenCompletoMarkdown = normalizedMd;
      finalSections = splitDictamenIntoSections(dictamenCompletoMarkdown);
      auditoriaEpistemica = await auditarDictamenEpistemico(
        dictamenCompletoMarkdown,
        finalNodes,
        directivasOPA
      );
      if (auditoriaEpistemica.passed) {
        reparacionEpistemicaEjecutada = true;
      }
    }
  }

  if (!auditoriaEpistemica.passed) {
    // 6B. Pase único dirigido de auto-reparación epistémica con Gemini
    emit({
      step: 6,
      stageId: 'EpistemicAuditorNode',
      title: '6. Auditor Epistémico Post-Generación (SHACL + OPA)',
      status: 'running',
      detail: 'Auto-reparación epistémica (máx. 1 pase): corrigiendo citas inválidas o faltantes...',
    });

    try {
      const repairedMd = await repairDictamenEpistemicCitations({
        dictamenMarkdown: dictamenCompletoMarkdown,
        validNodes: finalNodes,
        unverifiedCitations: auditoriaEpistemica.unverifiedCitations,
        citedOkfIds: auditoriaEpistemica.citedOkfIds,
      });

      if (repairedMd && repairedMd.trim().length > 0) {
        reparacionEpistemicaEjecutada = true;
        finalSections = splitDictamenIntoSections(repairedMd);
        dictamenCompletoMarkdown = finalSections.map((s) => s.markdown).join('\n\n---\n\n');
        auditoriaEpistemica = await auditarDictamenEpistemico(
          dictamenCompletoMarkdown,
          finalNodes,
          directivasOPA
        );
      }
    } catch (repairErr: any) {
      console.warn('[Epistemic Auto-Repair] Falló el pase de reparación:', repairErr.message);
    }
  }

  emit({
    step: 6,
    stageId: 'EpistemicAuditorNode',
    title: '6. Auditor Epistémico Post-Generación (SHACL + OPA)',
    status: !auditoriaEpistemica.passed
      ? 'failed'
      : reparacionEpistemicaEjecutada
      ? 'repaired'
      : 'completed',
    detail: reparacionEpistemicaEjecutada && auditoriaEpistemica.passed
      ? `Auto-reparación epistémica exitosa: ${auditoriaEpistemica.auditSummary}`
      : auditoriaEpistemica.auditSummary,
    payload: {
      ...auditoriaEpistemica,
      reparacionEpistemicaEjecutada,
      repairedMarkdown: reparacionEpistemicaEjecutada ? dictamenCompletoMarkdown : undefined,
    },
  });

  return {
    hechos,
    modelUsed,
    directivasOPA,
    subgrafoNodes: finalNodes,
    subgrafoEdges: initialEdges,
    reporteSHACLInicial,
    reporteSHACLFinal,
    reparacionSHACLEjecutada,
    reparacionEpistemicaEjecutada,
    seccionesRedactadas: finalSections,
    dictamenCompletoMarkdown,
    auditoriaEpistemica,
  };
}
