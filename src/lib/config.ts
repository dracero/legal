import path from 'path';
import os from 'os';
import fs from 'fs';
import dns from 'dns';
import dotenv from 'dotenv';

// Priorizar resolución IPv4 para compatibilidad de red inmediata
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

dotenv.config();

function resolveOpaBinary(): string {
  if (process.env.OPA_BIN_PATH && process.env.OPA_BIN_PATH.trim() !== '') {
    return process.env.OPA_BIN_PATH.trim();
  }
  const localUserOpa = path.join(os.homedir(), '.local', 'bin', 'opa');
  if (fs.existsSync(localUserOpa)) {
    return localUserOpa;
  }
  return 'opa';
}

export function getGeminiApiKeys(): string[] {
  const keysRaw =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_API_KEYS ||
    '';
  return keysRaw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

let currentKeyIndex = 0;
export function getNextGeminiApiKey(): string {
  const keys = getGeminiApiKeys();
  if (keys.length === 0) {
    throw new Error(
      'Falta configurar GEMINI_API_KEY (o GOOGLE_API_KEY / GOOGLE_API_KEYS) en el archivo .env'
    );
  }
  const key = keys[currentKeyIndex % keys.length];
  currentKeyIndex = (currentKeyIndex + 1) % keys.length;
  return key;
}

export const APP_CONFIG = {
  port: Number(process.env.PORT || 4321),
  gemini: {
    // Modelo único configurado (sin modelo fallback)
    model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 32768),
  },
  huggingface: {
    // Embeddings Hugging Face (all-MiniLM-L6-v2 de 384 dimensiones)
    model:
      process.env.HUGGINGFACE_EMBEDDING_MODEL ||
      process.env.HF_EMBEDDING_MODEL ||
      'Xenova/all-MiniLM-L6-v2',
    token: process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || '',
    dimensions: Number(process.env.NEO4J_VECTOR_DIMENSIONS || 384),
  },
  neo4j: {
    uri: process.env.NEO4J_URI || 'bolt://localhost:7688',
    user: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || 'password',
    database: process.env.NEO4J_DATABASE || 'neo4j',
    vectorIndexName: process.env.NEO4J_VECTOR_INDEX || 'legal_normas_vector_index',
    fulltextIndexName: process.env.NEO4J_FULLTEXT_INDEX || 'legal_normas_fulltext_index',
    vectorDimensions: Number(process.env.NEO4J_VECTOR_DIMENSIONS || 384),
  },
  opa: {
    binPath: resolveOpaBinary(),
    serverUrl: process.env.OPA_SERVER_URL || '',
    policyDir: path.resolve(process.env.OPA_POLICY_DIR || './src/lib/opa/policies'),
    queryPath: process.env.OPA_QUERY_PATH || 'data.legal.deontico',
  },
  shacl: {
    shapesPath: path.resolve(process.env.SHACL_SHAPES_PATH || './src/lib/shacl/shapes.ttl'),
    ontologyNamespace: process.env.SHACL_ONTOLOGY_NS || 'http://antigravity.ai/ontologia/legal#',
  },
  okf: {
    contentDir: path.resolve(process.env.OKF_CONTENT_DIR || './src/content/okf'),
  },
};
