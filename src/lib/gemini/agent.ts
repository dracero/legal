import { z } from 'zod';
import { GoogleGenAI, Type } from '@google/genai';
import { APP_CONFIG, getNextGeminiApiKey } from '../config.ts';
import { evaluarEnServidorOPA, type HechosIngenieria, type PolicyDecision } from '../opa/evaluator.ts';
import {
  hybridRetrieveAndExpandSubgraph,
  completarNodosFaltantesNeo4j,
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

// Esquema Zod estricto para Agente 1 (FactExtractorFlow)
export const HechosIngenieriaSchema = z.object({
  rama_ingenieria: z.string(),
  rol_profesional: z.string(),
  jurisdiccion: z.enum(['CABA', 'PBA', 'Nacional']),
  esfera_responsabilidad: z.array(z.string()),
  figuras_juridicas_detectadas: z.array(z.string()),
  hay_ruina_o_impropiedad_obra: z.boolean(),
  anios_desde_recepcion: z.number(),
  subcontratista_sin_matricula_verificada: z.boolean(),
  clausula_limitacion_o_dispensa: z.boolean(),
  matricula_jurisdiccion_activa: z.boolean(),
  modalidad_ejercicio: z.enum([
    'profesional_liberal',
    'relacion_de_dependencia',
    'empresa_constructora_comercial',
  ]),
  involucra_higiene_y_seguridad: z.boolean(),
  existe_publicidad_enganosa: z.boolean(),
  tarea_tecnica_critica: z.string(),
  resumen_hechos_tecnicos: z.string(),
});

// Structured Output Schema para Gemini (sin parámetros deprecados temperature/top_p)
const GEMINI_FACT_EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    rama_ingenieria: {
      type: Type.STRING,
      description: 'Especialidad de ingeniería FIUBA (Civil, Industrial, Mecanica, Electricista, Quimica, Informatica, Electronica, Naval)',
    },
    rol_profesional: {
      type: Type.STRING,
      description: 'Rol técnico desempeñado por el ingeniero',
    },
    jurisdiccion: {
      type: Type.STRING,
      enum: ['CABA', 'PBA', 'Nacional'],
      description: 'Jurisdicción territorial donde se ejecuta la obra o servicio ingenieril',
    },
    esfera_responsabilidad: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Esferas de responsabilidad activadas (Civil, Penal, Administrativa, Etica_Profesional, Laboral)',
    },
    figuras_juridicas_detectadas: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Figuras jurídicas aplicables (Locación de obra, Ruina, Culpa in vigilando, etc.)',
    },
    hay_ruina_o_impropiedad_obra: {
      type: Type.BOOLEAN,
      description: 'True si existe ruina, colapso, falla o impropiedad para el destino (Art. 1273 CCyCN)',
    },
    anios_desde_recepcion: {
      type: Type.NUMBER,
      description: 'Años transcurridos desde la entrega o recepción definitiva de la obra',
    },
    subcontratista_sin_matricula_verificada: {
      type: Type.BOOLEAN,
      description: 'True si se subcontrató a un tercero sin verificar su matrícula habilitante local',
    },
    clausula_limitacion_o_dispensa: {
      type: Type.BOOLEAN,
      description: 'True si se pactaron cláusulas de exclusión o limitación de responsabilidad por ruina/vicios',
    },
    matricula_jurisdiccion_activa: {
      type: Type.BOOLEAN,
      description: 'True si el ingeniero titular posee matrícula activa en la jurisdicción; False si no está matriculado localmente',
    },
    modalidad_ejercicio: {
      type: Type.STRING,
      enum: ['profesional_liberal', 'relacion_de_dependencia', 'empresa_constructora_comercial'],
    },
    involucra_higiene_y_seguridad: {
      type: Type.BOOLEAN,
      description: 'True si involucra riesgos de trabajo o higiene y seguridad laboral',
    },
    existe_publicidad_enganosa: {
      type: Type.BOOLEAN,
      description: 'True si media oferta o publicidad al consumidor',
    },
    tarea_tecnica_critica: {
      type: Type.STRING,
      description: 'Identificador de la tarea crítica analizada',
    },
    resumen_hechos_tecnicos: {
      type: Type.STRING,
      description: 'Síntesis fáctica concisa del caso',
    },
  },
  required: [
    'rama_ingenieria',
    'rol_profesional',
    'jurisdiccion',
    'esfera_responsabilidad',
    'figuras_juridicas_detectadas',
    'hay_ruina_o_impropiedad_obra',
    'anios_desde_recepcion',
    'subcontratista_sin_matricula_verificada',
    'clausula_limitacion_o_dispensa',
    'matricula_jurisdiccion_activa',
    'modalidad_ejercicio',
    'involucra_higiene_y_seguridad',
    'existe_publicidad_enganosa',
    'tarea_tecnica_critica',
    'resumen_hechos_tecnicos',
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
  const apiKey = getNextGeminiApiKey();
  const client = new GoogleGenAI({ apiKey });
  const modelName = CONFIGURED_GEMINI_MODEL;

  const config: Record<string, any> = {
    systemInstruction: params.systemInstruction,
  };
  if (params.responseMimeType) config.responseMimeType = params.responseMimeType;
  if (params.responseSchema) config.responseSchema = params.responseSchema;
  if (params.maxOutputTokens) config.maxOutputTokens = params.maxOutputTokens;

  // Llamada directa sin parámetros deprecados (temperature/top_p/top_k)
  const response = await client.models.generateContent({
    model: modelName,
    contents: params.contents,
    config,
  });

  if (!response.text || response.text.trim().length === 0) {
    throw new Error(`El modelo Gemini '${modelName}' no devolvió texto en su respuesta.`);
  }

  return response.text.trim();
}

/**
 * PASO 1: Agente Clasificador de Hechos (FactExtractorFlow)
 */
export async function extractFactsFromCase(
  casoPlanteado: string,
  especialidadIngenieria: string
): Promise<{ hechos: HechosIngenieria; modelUsed: string }> {
  const text = await invokeGemini({
    systemInstruction:
      'Extrae las variables fácticas y jurídicas del caso de ingeniería para la cátedra de Ingeniería Legal (FIUBA). Devuelve únicamente el objeto JSON conforme al esquema.',
    contents: `Especialidad FIUBA seleccionada: ${especialidadIngenieria}.\nCaso planteado: ${casoPlanteado}`,
    responseMimeType: 'application/json',
    responseSchema: GEMINI_FACT_EXTRACTION_SCHEMA,
  });

  const parsedJson = JSON.parse(text);
  const validated = HechosIngenieriaSchema.parse(parsedJson);
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
    id: 'Encuadre_Tecnico_Juridico',
    numeroRomano: 'I',
    titulo: 'Sección I: Encuadre Técnico-Ingenieril, Incumbencias y Naturaleza Jurídica de la Relación',
    subtitulo: 'Calificación del contrato de obra/servicios, roles profesionales, matriculación y alcance de título FIUBA',
  },
  {
    id: 'Exegesis_Normativa',
    numeroRomano: 'II',
    titulo: 'Sección II: Exégesis Normativa Exhaustiva y Prelación de Kelsen',
    subtitulo: 'Análisis artículo por artículo del subgrafo OKF vigente, orden público, caducidad y prescripción',
  },
  {
    id: 'Responsabilidades',
    numeroRomano: 'III',
    titulo: 'Sección III: Análisis de Responsabilidades Concurrentes (Civil, Penal, Administrativa y Ética)',
    subtitulo: 'Factores de atribución objetivos y subjetivos, culpa in eligendo/in vigilando, tipicidad penal y deontología',
  },
  {
    id: 'Variantes_Casuisticas',
    numeroRomano: 'IV',
    titulo: 'Sección IV: Hipótesis Variadas y Contrafácticos Pedagógicos de Cátedra',
    subtitulo: 'Inversión de variables deónticas OPA: relación de dependencia vs. autónomo, vicios de suelo/materiales y jurisdicción',
  },
];

/**
 * PASO 5: Agente Exégeta / Redactor de Largo Aliento por Sección (DeepLegalExpanderFlow)
 */
export async function generateChapterSection(
  cap: CapituloConfig,
  hechos: HechosIngenieria,
  directivasOPA: PolicyDecision,
  subgrafoOKF: OKFNode[]
): Promise<string> {
  const text = await invokeGemini({
    systemInstruction: `Actúa como Profesor Titular de Ingeniería Legal y Ejercicio Profesional (FIUBA).
Desarrolla de forma exhaustiva, doctrinal y extensa el capítulo solicitado: ${cap.titulo} (${cap.subtitulo}).
RESTRICCIÓN SIMBÓLICA ESTRICTA:
1. Debes obedecer las directivas deterministas de OPA adjuntas sin contradecirlas.
2. Debes basar toda cita legal exclusivamente en los nodos OKF provistos desde el subgrafo de Neo4j, citando explícitamente su identificador entre corchetes [okf_id] (ejemplo: [norma-ccycn-art-1273]).
3. Redacta en Markdown académico profundo y riguroso.`,
    contents: JSON.stringify({
      capituloActual: cap,
      hechosDelCaso: hechos,
      falloDeterministaOPA: directivasOPA,
      nodosOKFVigentes: subgrafoOKF.map((n) => ({
        okf_id: n.okf_id,
        title: n.title,
        law_number: n.law_number,
        article_number: n.article_number,
        jurisdiction: n.jurisdiction,
        shape_role: n.shape_role,
        content: n.content,
      })),
    }),
    maxOutputTokens: APP_CONFIG.gemini.maxOutputTokens,
  });

  return text;
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
  especialidadIngenieria: string,
  onEvent?: (event: PipelineStepEvent) => void
): Promise<{
  hechos: HechosIngenieria;
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

  // PASO 1: Extracción de Hechos (FactExtractorFlow)
  emit({
    step: 1,
    stageId: 'FactExtractorFlow',
    title: '1. Agente Clasificador de Hechos (Genkit + Zod Schema)',
    status: 'running',
    detail: `Extrayendo variables fácticas y jurídicas con esquema estricto Zod (${CONFIGURED_GEMINI_MODEL})...`,
  });

  const { hechos, modelUsed } = await extractFactsFromCase(casoPlanteado, especialidadIngenieria);

  emit({
    step: 1,
    stageId: 'FactExtractorFlow',
    title: '1. Agente Clasificador de Hechos (Genkit + Zod Schema)',
    status: 'completed',
    detail: `Rama: ${hechos.rama_ingenieria} | Jurisdicción: ${hechos.jurisdiccion} | Figuras detectadas: ${hechos.figuras_juridicas_detectadas.length}`,
    payload: { hechos, modelUsed },
  });

  // PASO 2: Motor Deóntico de Políticas (OPA / Rego)
  emit({
    step: 2,
    stageId: 'OPAPolicyGate',
    title: '2. Motor Deóntico de Políticas (OPA / Rego v1)',
    status: 'running',
    detail: 'Evaluando incumbencias, colegiación, orden público y prelación de Kelsen en OPA...',
  });

  const directivasOPA = await evaluarEnServidorOPA(hechos);

  emit({
    step: 2,
    stageId: 'OPAPolicyGate',
    title: '2. Motor Deóntico de Políticas (OPA / Rego v1)',
    status: 'completed',
    detail: `Motor ${directivasOPA.engine} (${directivasOPA.evaluation_time_ms}ms) -> ${directivasOPA.nodos_okf_obligatorios.length} nodos OKF obligatorios.`,
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
    especialidad: hechos.rama_ingenieria,
    jurisdiccion: hechos.jurisdiccion,
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
    detail: 'Validando topología RDF del subgrafo contra fiuba:LegalAnalysisShape...',
  });

  const reporteSHACLInicial = await validarGrafoConSHACL(initialNodes, directivasOPA);
  let finalNodes = initialNodes;
  let reporteSHACLFinal = reporteSHACLInicial;
  let reparacionSHACLEjecutada = false;

  if (!reporteSHACLInicial.conforms) {
    reparacionSHACLEjecutada = true;
    finalNodes = await completarNodosFaltantesNeo4j(
      initialNodes,
      reporteSHACLInicial.missingShapeRoles,
      reporteSHACLInicial.missingOkfIds,
      hechos.jurisdiccion
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
  const seccionesRedactadas: Array<{ id: string; titulo: string; markdown: string }> = [];

  for (let i = 0; i < CAPITULOS_DICTAMEN.length; i++) {
    const cap = CAPITULOS_DICTAMEN[i];
    emit({
      step: 5,
      stageId: 'DeepLegalExpanderFlow',
      title: `5. Agente Exégeta de Largo Aliento (${cap.numeroRomano}/IV)`,
      status: 'running',
      detail: `Redactando ${cap.titulo} con ${modelUsed}...`,
      payload: { currentChapterIndex: i, chapterId: cap.id },
    });

    const markdown = await generateChapterSection(cap, hechos, directivasOPA, finalNodes);
    seccionesRedactadas.push({ id: cap.id, titulo: cap.titulo, markdown });

    emit({
      step: 5,
      stageId: 'DeepLegalExpanderFlow',
      title: `5. Agente Exégeta de Largo Aliento (${cap.numeroRomano}/IV)`,
      status: 'completed',
      detail: `Capítulo ${cap.numeroRomano} completado (${markdown.length} caracteres).`,
      payload: {
        chapterCompleted: { id: cap.id, titulo: cap.titulo, markdown },
        progress: `${i + 1}/${CAPITULOS_DICTAMEN.length}`,
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
    detail: 'Verificando trazabilidad de citas contra fiuba:EpistemicAuditShape y el subgrafo Neo4j...',
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
