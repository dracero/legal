import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { APP_CONFIG } from '../config.ts';
import type { OKFNode } from '../neo4j/client.ts';

const execFileAsync = promisify(execFile);

export interface HechosIngenieria {
  rama_ingenieria: string;
  rol_profesional: string;
  jurisdiccion: 'CABA' | 'PBA' | 'Nacional';
  esfera_responsabilidad: string[];
  figuras_juridicas_detectadas: string[];
  hay_ruina_o_impropiedad_obra: boolean;
  anios_desde_recepcion: number;
  subcontratista_sin_matricula_verificada: boolean;
  clausula_limitacion_o_dispensa: boolean;
  matricula_jurisdiccion_activa: boolean;
  modalidad_ejercicio: 'profesional_liberal' | 'relacion_de_dependencia' | 'empresa_constructora_comercial';
  involucra_higiene_y_seguridad: boolean;
  existe_publicidad_enganosa: boolean;
  tarea_tecnica_critica: string;
  resumen_hechos_tecnicos: string;
}

export interface ReglaDirectiva {
  codigo: string;
  veredicto_determinista: string;
  fundamento_okf_id: string;
  directiva_redaccion: string;
}

export interface EvaluacionPlazos {
  en_plazo_garantia_decenal: boolean;
  anios_transcurridos: number;
  plazo_maximo_caducidad_anios: number;
  plazo_prescripcion_anios: number;
  fundamento_okf_id: string;
  veredicto_determinista: string;
  directiva_redaccion: string;
}

export interface EscenarioContrafactico {
  id: string;
  titulo: string;
  hipotesis: string;
  regla_aplicable: string;
}

export interface PolicyDecision {
  engine: string;
  evaluation_time_ms: number;
  requiere_colegiacion_pba: boolean;
  requiere_consejo_nacional_caba: boolean;
  aplica_ley_defensa_consumidor: boolean;
  infracciones_ejercicio: ReglaDirectiva[];
  clausulas_nulas: ReglaDirectiva[];
  conflictos_incumbencia: ReglaDirectiva[];
  directivas_defensa_consumidor: ReglaDirectiva[];
  evaluacion_plazos: EvaluacionPlazos;
  prelacion_kelsen: Array<{ rango: number; nivel: string; aplicacion: string }>;
  nodos_okf_obligatorios: string[];
  terminos_busqueda_obligatorios: string[];
  escenarios_contrafacticos: EscenarioContrafactico[];
}

export async function evaluarEnServidorOPA(
  hechos: HechosIngenieria,
  nodosCargados: OKFNode[] = []
): Promise<PolicyDecision> {
  const start = Date.now();

  const inputPayload = {
    ...hechos,
    nodos_cargados: nodosCargados.map((n) => ({
      okf_id: n.okf_id,
      title: n.title,
      law_number: n.law_number,
      article_number: n.article_number,
      status: n.status,
      especialidades_fiuba: n.especialidades_fiuba,
      jurisdiction: n.jurisdiction,
      shape_role: n.shape_role,
      content: n.content,
    })),
  };

  // 1. Si se configuró OPA_SERVER_URL en .env, consulta el servidor REST de OPA
  if (APP_CONFIG.opa.serverUrl) {
    const restPath = APP_CONFIG.opa.queryPath.replace(/^data\./, '').replace(/\./g, '/');
    const url = `${APP_CONFIG.opa.serverUrl.replace(/\/$/, '')}/v1/data/${restPath}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: inputPayload }),
    });
    if (!response.ok) {
      throw new Error(`[OPA REST Error] HTTP ${response.status} al consultar ${url}`);
    }
    const json = await response.json();
    return mapOpaValueToDecision(json.result, 'OPA_REST_SERVER', Date.now() - start);
  }

  // 2. Evaluación directa en motor OPA local (Rego v1) sobre el directorio de políticas
  const tmpFile = path.join(
    os.tmpdir(),
    `opa_input_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
  );

  try {
    await fs.writeFile(tmpFile, JSON.stringify(inputPayload), 'utf-8');

    const { stdout } = await execFileAsync(APP_CONFIG.opa.binPath, [
      'eval',
      '--data',
      path.join(APP_CONFIG.opa.policyDir, 'fiuba_legal.rego'),
      '--input',
      tmpFile,
      '--format',
      'json',
      APP_CONFIG.opa.queryPath,
    ]);

    const parsed = JSON.parse(stdout);
    const val = parsed?.result?.[0]?.expressions?.[0]?.value;

    if (!val) {
      throw new Error(`La consulta OPA '${APP_CONFIG.opa.queryPath}' no devolvió un resultado válido.`);
    }

    return mapOpaValueToDecision(val, 'OPA_REGO_V1_NATIVE', Date.now() - start);
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

function mapOpaValueToDecision(val: any, engine: string, elapsedMs: number): PolicyDecision {
  return {
    engine,
    evaluation_time_ms: elapsedMs,
    requiere_colegiacion_pba: Boolean(val.requiere_colegiacion_pba),
    requiere_consejo_nacional_caba: Boolean(val.requiere_consejo_nacional_caba),
    aplica_ley_defensa_consumidor: Boolean(val.aplica_ley_defensa_consumidor),
    infracciones_ejercicio: Array.isArray(val.infracciones_ejercicio) ? val.infracciones_ejercicio : [],
    clausulas_nulas: Array.isArray(val.clausulas_nulas) ? val.clausulas_nulas : [],
    conflictos_incumbencia: Array.isArray(val.conflictos_incumbencia) ? val.conflictos_incumbencia : [],
    directivas_defensa_consumidor: Array.isArray(val.directivas_defensa_consumidor)
      ? val.directivas_defensa_consumidor
      : [],
    evaluacion_plazos: val.evaluacion_plazos,
    prelacion_kelsen: Array.isArray(val.prelacion_kelsen) ? val.prelacion_kelsen : [],
    nodos_okf_obligatorios: Array.isArray(val.nodos_okf_obligatorios) ? val.nodos_okf_obligatorios : [],
    terminos_busqueda_obligatorios: Array.isArray(val.terminos_busqueda_obligatorios)
      ? val.terminos_busqueda_obligatorios
      : [],
    escenarios_contrafacticos: Array.isArray(val.escenarios_contrafacticos)
      ? val.escenarios_contrafacticos
      : [],
  };
}
