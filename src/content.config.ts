import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const okf = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/okf' }),
  schema: z.object({
    okf_id: z.string(),
    title: z.string(),
    node_type: z.string().optional(),
    law_number: z.string().optional(),
    article_number: z.string().optional(),
    hierarchy_level: z.string().optional(),
    domain: z.string().optional(),
    category: z.string().optional(),
    jurisdiction: z.string().optional(),
    status: z.string().optional(),
    last_updated: z.string().optional(),
    relations: z
      .array(
        z.object({
          type: z.string(),
          target: z.string(),
        })
      )
      .optional(),
    ontological_entities: z
      .array(
        z.object({
          nombre: z.string(),
          categoria: z.string(),
          descripcion: z.string(),
        })
      )
      .optional(),
    deontic_rules: z
      .array(
        z.object({
          id: z.string(),
          modalidad: z.enum(['OBLIGACION', 'PROHIBICION', 'PERMISION', 'SANCION_NULIDAD']),
          sujeto_normado: z.string(),
          conducta: z.string(),
          condicion: z.string(),
          consecuencia: z.string(),
          palabras_clave: z.array(z.string()).optional(),
        })
      )
      .optional(),
  }),
});

export const collections = { okf };
