import { HfInference } from '@huggingface/inference';
import { APP_CONFIG } from '../config.ts';

let localExtractorPromise: Promise<any> | null = null;

async function getLocalExtractor() {
  if (!localExtractorPromise) {
    const { pipeline } = await import('@xenova/transformers');
    localExtractorPromise = pipeline('feature-extraction', APP_CONFIG.huggingface.model);
  }
  return localExtractorPromise;
}

/**
 * Genera embeddings vectoriales utilizando modelos de Hugging Face
 * (ej. Xenova/all-MiniLM-L6-v2 de 384 dimensiones).
 *
 * Prioridad:
 * 1. Si HF_TOKEN está presente y se puede invocar la API de Hugging Face, la utiliza.
 * 2. Si no, o si falla la red, ejecuta el modelo localmente mediante @xenova/transformers.
 */
export async function computeHuggingFaceEmbedding(text: string): Promise<number[]> {
  const targetDim = APP_CONFIG.huggingface.dimensions;
  const cleanText = (text || '').trim();
  if (!cleanText) {
    return new Array(targetDim).fill(0);
  }

  // 1. Intento vía Hugging Face Inference API si se configuró un token
  if (APP_CONFIG.huggingface.token) {
    try {
      const hf = new HfInference(APP_CONFIG.huggingface.token);
      const remoteModel = APP_CONFIG.huggingface.model.replace(/^Xenova\//, 'sentence-transformers/');
      const result = await hf.featureExtraction({
        model: remoteModel,
        inputs: cleanText,
      });

      if (Array.isArray(result) && typeof result[0] === 'number') {
        return normalizeVector(result as number[], targetDim);
      }
      if (Array.isArray(result) && Array.isArray(result[0])) {
        return normalizeVector(result[0] as number[], targetDim);
      }
    } catch (err: any) {
      console.warn('[HuggingFace API] Intento remoto falló, conmutando a extractor local:', err.message);
    }
  }

  // 2. Extractor local de alta velocidad con @xenova/transformers
  try {
    const extractor = await getLocalExtractor();
    const output = await extractor(cleanText, { pooling: 'mean', normalize: true });
    const rawArray = Array.from(output.data as Float32Array | number[]);
    return normalizeVector(rawArray, targetDim);
  } catch (localErr: any) {
    throw new Error(`[Hugging Face Embeddings Error] No se pudo generar embedding: ${localErr.message}`);
  }
}

function normalizeVector(vec: number[], targetDim: number): number[] {
  let adjusted = vec;
  if (vec.length !== targetDim) {
    adjusted = new Array(targetDim).fill(0);
    for (let i = 0; i < vec.length; i++) {
      adjusted[i % targetDim] += vec[i];
    }
  }
  const norm = Math.sqrt(adjusted.reduce((acc, v) => acc + v * v, 0)) || 1;
  return adjusted.map((v) => Number((v / norm).toFixed(6)));
}
