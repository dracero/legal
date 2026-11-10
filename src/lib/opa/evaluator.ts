import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import { APP_CONFIG } from '../config.ts';
import { ensureAppOpaBinary } from './binary.js';
import type { OKFNode } from '../neo4j/client.ts';

const execFileAsync = promisify(execFile);

let cachedOpaLabel: string | null = null;

/**
 * Obtiene dinámicamente la etiqueta de versión/motor OPA configurado.
 */
export async function getOpaRuntimeLabel(): Promise<string> {
  if (cachedOpaLabel) return cachedOpaLabel;
  if (APP_CONFIG.opa.serverUrl) {
    cachedOpaLabel = 'OPA REST (Rego v1)';
    return cachedOpaLabel;
  }
  try {
    const bin = fsSync.existsSync(APP_CONFIG.opa.binPath)
      ? APP_CONFIG.opa.binPath
      : await ensureAppOpaBinary();
    const { stdout } = await execFileAsync(bin, ['version']);
    const match = stdout.match(/Version:\s*([0-9.]+)/i);
    cachedOpaLabel = match ? `OPA ${match[1]} (Rego v1)` : 'OPA Rego v1';
  } catch {
    cachedOpaLabel = 'OPA Rego v1';
  }
  return cachedOpaLabel;
}

export interface HechosCaso {
  sujetos_involucrados: string[];
  parte_evaluada: string;
  rol_o_condicion_juridica: string;
  conductas_relevantes: string[];
  omisiones_atribuidas: string[];
  danos_o_resultados: string[];
  clausulas_o_defensas_invocadas: string[];
  resumen_factico: string;
}

export interface ReglaDirectiva {
  codigo: string;
  veredicto_determinista: string;
  fundamento_okf_id: string;
  modalidad: string;
  sujeto_normado: string;
  conducta: string;
  consecuencia: string;
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
  incumplimientos_obligacion: ReglaDirectiva[];
  violaciones_prohibicion: ReglaDirectiva[];
  clausulas_invalidas: ReglaDirectiva[];
  permisiones_aplicables: ReglaDirectiva[];
  prelacion_kelsen: Array<{ rango: number; nivel: string; aplicacion: string }>;
  nodos_okf_obligatorios: string[];
  terminos_busqueda_obligatorios: string[];
  escenarios_contrafacticos: EscenarioContrafactico[];
}

export async function evaluarEnServidorOPA(
  hechos: HechosCaso,
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
      category: n.category,
      jurisdiction: n.jurisdiction,
      content: n.content,
      ontological_entities: n.ontological_entities || [],
      deontic_rules: n.deontic_rules || [],
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

  // 2. Evaluación directa en motor OPA local (Rego v1) sobre la política legal deóntica
  const tmpFile = path.join(
    os.tmpdir(),
    `opa_input_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
  );

  try {
    await fs.writeFile(tmpFile, JSON.stringify(inputPayload), 'utf-8');

    const policyFile = path.join(APP_CONFIG.opa.policyDir, 'legal_deontico.rego');
    const opaBin = fsSync.existsSync(APP_CONFIG.opa.binPath)
      ? APP_CONFIG.opa.binPath
      : await ensureAppOpaBinary();
    const { stdout } = await execFileAsync(opaBin, [
      'eval',
      '--data',
      policyFile,
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
    incumplimientos_obligacion: Array.isArray(val.incumplimientos_obligacion)
      ? val.incumplimientos_obligacion
      : [],
    violaciones_prohibicion: Array.isArray(val.violaciones_prohibicion)
      ? val.violaciones_prohibicion
      : [],
    clausulas_invalidas: Array.isArray(val.clausulas_invalidas) ? val.clausulas_invalidas : [],
    permisiones_aplicables: Array.isArray(val.permisiones_aplicables) ? val.permisiones_aplicables : [],
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
