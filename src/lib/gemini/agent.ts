import { z } from 'zod';
import { GoogleGenAI, Type } from '@google/genai';
import { APP_CONFIG, getNextGeminiApiKey } from '../config.ts';
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
  let lastError: any = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const apiKey = getNextGeminiApiKey();
    const client = new GoogleGenAI({ apiKey });

    const config: Record<string, any> = {
      systemInstruction: params.systemInstruction,
    };
    if (params.responseMimeType) config.responseMimeType = params.responseMimeType;
    if (params.responseSchema) config.responseSchema = params.responseSchema;
    if (params.maxOutputTokens) config.maxOutputTokens = params.maxOutputTokens;

    try {
      const response = await client.models.generateContent({
        model: modelName,
        contents: params.contents,
        config,
      });

      if (!response.text || response.text.trim().length === 0) {
        throw new Error(`El modelo Gemini '${modelName}' no devolvió texto en su respuesta.`);
      }

      return response.text.trim();
    } catch (err: any) {
      lastError = err;
      const isTransient =
        err.status === 503 ||
        err.status === 429 ||
        err.message?.includes('503') ||
        err.message?.includes('429') ||
        err.message?.includes('high demand') ||
        err.message?.includes('UNAVAILABLE');

      if (isTransient && attempt < 5) {
        const delays = [1500, 3000, 5000, 8000];
        const delay = delays[attempt - 1] || 4000;
        console.warn(`[Gemini ${modelName}] Reintentando tras alta demanda transitoria (intento ${attempt}/5 en ${delay}ms)...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (err.message?.includes('Quota exceeded') || err.message?.includes('RESOURCE_EXHAUSTED')) {
        throw new Error(
          `Límite de cuota diaria gratuita alcanzado en Google AI Studio para '${modelName}' (20 solicitudes/día en Free Tier). Puede agregar claves API adicionales separadas por coma en GEMINI_API_KEY en .env o vincular un plan con facturación para solicitudes ilimitadas.`
        );
      }

      throw err;
    }
  }

  throw lastError;
}

/**
 * PASO 1: Agente Clasificador de Hechos (FactExtractorFlow)
 */
export async function extractFactsFromCase(
  casoPlanteado: string
): Promise<{ hechos: HechosCaso; modelUsed: string }> {
  const text = await invokeGemini({
    systemInstruction:
      'Eres un Jurista y Auditor Legal experto. Analiza la descripción fáctica del caso planteado y extrae con máxima rigurosidad las variables fácticas, sujetos, conductas, omisiones y defensas invocadas. Devuelve únicamente el objeto JSON conforme al esquema estricto provisto.',
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
 * PASO 5: Genera el Dictamen Completo en un pase integral optimizado
 * garantizando coherencia argumental, reduciendo latencia y optimizando el consumo de cuota de Gemini 3.6 Flash.
 */
export async function generateFullDictamen(
  hechos: HechosCaso,
  directivasOPA: PolicyDecision,
  subgrafoOKF: OKFNode[]
): Promise<Array<{ id: string; titulo: string; markdown: string }>> {
  const systemPrompt = `Actúa como Jurista y Auditor Legal experto.
Redacta el Dictamen Jurídico exhaustivo, riguroso y doctrinal estructurado estrictamente en las siguientes cuatro secciones con encabezados Markdown nivel 2:

## Sección I: Encuadre Fáctico, Sujetos y Calificación Jurídica de las Conductas
(Identificación precisa de las partes, sus roles normados, conductas analizadas y defensas/cláusulas invocadas).

## Sección II: Exégesis Normativa y Matriz Deóntica del Documento Cargado
(Análisis artículo por artículo del subgrafo OKF vigente, deberes, prohibiciones, permisiones y prelación de Kelsen).

## Sección III: Subsunción Fáctica: Incumplimientos, Infracciones y Consecuencias Jurídicas
(Contraste riguroso entre las conductas y la matriz deóntica OPA: deberes incumplidos, prohibiciones vulneradas y nulidades aplicables).

## Sección IV: Conclusiones, Dictamen Fundado y Escenarios Contrafácticos
(Resolución jurídica conclusiva fundada exclusivamente en el texto legal, hipótesis contrafácticas de cumplimiento e implicancias prácticas).

RESTRICCIÓN SIMBÓLICA ESTRICTA:
1. El análisis debe basarse ESTRICTA Y EXCLUSIVAMENTE en los nodos OKF provistos en 'nodosOKFVigentes'. No menciones ni inventes normas fuera de este conjunto.
2. Debes obedecer rigurosamente las directivas deterministas de OPA adjuntas (deberes, prohibiciones, nulidades y prelación).
3. Cita obligatoriamente cada norma utilizada mediante su identificador [okf_id] entre corchetes (ejemplo: [${subgrafoOKF[0]?.okf_id || 'norma-id'}]).
4. Redacta en Markdown académico profundo, riguroso y analítico.`;

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

  // Dividir el dictamen en las 4 secciones según los encabezados ## Sección
  const sectionRegex = /##\s*Secci[oó]n\s*([I|V|X]+)[^\n]*\n([\s\S]*?)(?=(?:##\s*Secci[oó]n\s*[I|V|X]+)|$)/gi;
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
    // Si el formateo varió levemente, particionar proporcionalmente o asignar la respuesta completa
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

export interface PipelineStepEvent {
  step: number;
  stageId: string;
  title: string;
  status: 'running' | 'completed' | 'repaired';
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

  const dictamenCompletoMarkdown = seccionesRedactadas.map((s) => s.markdown).join('\n\n---\n\n');

  // PASO 6: Auditor Epistémico Post-Generación (SHACL + OPA)
  emit({
    step: 6,
    stageId: 'EpistemicAuditorNode',
    title: '6. Auditor Epistémico Post-Generación (SHACL + OPA)',
    status: 'running',
    detail: 'Verificando trazabilidad de citas contra legal:EpistemicAuditShape y el subgrafo Neo4j...',
  });

  const auditoriaEpistemica = await auditarDictamenEpistemico(
    dictamenCompletoMarkdown,
    finalNodes,
    directivasOPA
  );

  emit({
    step: 6,
    stageId: 'EpistemicAuditorNode',
    title: '6. Auditor Epistémico Post-Generación (SHACL + OPA)',
    status: 'completed',
    detail: auditoriaEpistemica.auditSummary,
    payload: auditoriaEpistemica,
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
    seccionesRedactadas,
    dictamenCompletoMarkdown,
    auditoriaEpistemica,
  };
}
