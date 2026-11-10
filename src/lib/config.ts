import path from 'path';
import dns from 'dns';
import dotenv from 'dotenv';
import { geminiRotator } from './gemini/key-rotator.ts';
import { resolveOpaBinary } from './opa/binary.js';

// Priorizar resolución IPv4 para compatibilidad de red inmediata
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

dotenv.config();

export function getGeminiApiKeys(): string[] {
  return geminiRotator.getAllKeys().map((k) => k.key);
}

export function getNextGeminiApiKey(): string {
  return geminiRotator.getNextActiveKey().key;
}

export const APP_CONFIG = {
  port: Number(process.env.PORT || 4321),
  gemini: {
    // Modelo único configurado (sin modelo fallback)
    model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 32768),
  },
  huggingface: {
    // Embeddings locales de Hugging Face (all-MiniLM-L6-v2 de 384 dimensiones)
    model:
      process.env.HUGGINGFACE_EMBEDDING_MODEL ||
      process.env.HF_EMBEDDING_MODEL ||
      'Xenova/all-MiniLM-L6-v2',
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
