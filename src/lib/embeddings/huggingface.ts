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
 * (ej. Xenova/all-MiniLM-L6-v2 de 384 dimensiones) ejecutados localmente
 * mediante @xenova/transformers (ONNX Runtime), sin consumo de créditos remotos.
 */
export async function computeHuggingFaceEmbedding(text: string): Promise<number[]> {
  const targetDim = APP_CONFIG.huggingface.dimensions;
  const cleanText = (text || '').trim();
  if (!cleanText) {
    return new Array(targetDim).fill(0);
  }

  try {
    const extractor = await getLocalExtractor();
    const output = await extractor(cleanText, { pooling: 'mean', normalize: true });
    const rawArray = Array.from(output.data as Float32Array | number[]);
    return normalizeVector(rawArray, targetDim);
  } catch (localErr: any) {
    throw new Error(`[Hugging Face Embeddings Error] No se pudo generar embedding local: ${localErr.message}`);
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
