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

/**
 * Genera embeddings vectoriales en lote para múltiples textos usando el mismo pipeline ONNX,
 * reduciendo drásticamente la sobrecarga por artículo.
 */
export async function computeHuggingFaceEmbeddingsBatch(
  texts: string[],
  chunkSize = 16
): Promise<number[][]> {
  const targetDim = APP_CONFIG.huggingface.dimensions;
  if (texts.length === 0) return [];

  const results: number[][] = new Array(texts.length);
  const extractor = await getLocalExtractor();

  for (let start = 0; start < texts.length; start += chunkSize) {
    const slice = texts.slice(start, start + chunkSize);
    const nonEmptyIndices: number[] = [];
    const nonEmptyTexts: string[] = [];

    slice.forEach((raw, offset) => {
      const clean = (raw || '').trim();
      if (!clean) {
        results[start + offset] = new Array(targetDim).fill(0);
      } else {
        nonEmptyIndices.push(start + offset);
        nonEmptyTexts.push(clean);
      }
    });

    if (nonEmptyTexts.length === 0) continue;

    try {
      const output = await extractor(nonEmptyTexts, { pooling: 'mean', normalize: true });
      const rawData = Array.from(output.data as Float32Array | number[]);
      const stride =
        Array.isArray(output.dims) && output.dims.length >= 2
          ? Number(output.dims[output.dims.length - 1])
          : Math.floor(rawData.length / nonEmptyTexts.length) || targetDim;

      nonEmptyIndices.forEach((globalIdx, i) => {
        const vec = rawData.slice(i * stride, (i + 1) * stride);
        results[globalIdx] = normalizeVector(vec, targetDim);
      });
    } catch (localErr: any) {
      throw new Error(`[Hugging Face Embeddings Error] Fallo en lote local: ${localErr.message}`);
    }
  }

  return results;
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
