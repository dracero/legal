import neo4j from 'neo4j-driver';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { pipeline } from '@xenova/transformers';
import dotenv from 'dotenv';

dotenv.config();

const OKF_DIR = path.resolve(process.env.OKF_CONTENT_DIR || './src/content/okf');
const uri = process.env.NEO4J_URI || 'bolt://localhost:7688';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'password';
const vectorIndexName = process.env.NEO4J_VECTOR_INDEX || 'fiuba_legal_okf_vector_index';
const fulltextIndexName = process.env.NEO4J_FULLTEXT_INDEX || 'fiuba_legal_okf_fulltext_index';
const vectorDimensions = Number(process.env.NEO4J_VECTOR_DIMENSIONS || 384);
const hfModel = process.env.HUGGINGFACE_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';

let extractorInstance = null;
async function getExtractor() {
  if (!extractorInstance) {
    extractorInstance = await pipeline('feature-extraction', hfModel);
  }
  return extractorInstance;
}

async function computeHfEmbedding(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  const rawArray = Array.from(output.data);
  let adjusted = rawArray;
  if (rawArray.length !== vectorDimensions) {
    adjusted = new Array(vectorDimensions).fill(0);
    for (let i = 0; i < rawArray.length; i++) {
      adjusted[i % vectorDimensions] += rawArray[i];
    }
  }
  const norm = Math.sqrt(adjusted.reduce((acc, v) => acc + v * v, 0)) || 1;
  return adjusted.map((v) => Number((v / norm).toFixed(6)));
}

export async function seedDatabase() {
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

  let connected = false;
  for (let attempt = 1; attempt <= 20; attempt++) {
    const testSession = driver.session();
    try {
      await testSession.run('RETURN 1');
      connected = true;
      await testSession.close();
      break;
    } catch {
      await testSession.close();
      console.log(`[Neo4j] Esperando conexión Bolt en ${uri} (intento ${attempt}/20)...`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  if (!connected) {
    await driver.close();
    throw new Error(`No se pudo conectar a Neo4j en ${uri}`);
  }

  const session = driver.session();
  try {
    // 1. Asegurar restricciones e índices limpios
    await session.run(
      `CREATE CONSTRAINT legal_okf_id_unique IF NOT EXISTS FOR (n:LegalOKF) REQUIRE n.okf_id IS UNIQUE`
    );

    await session.run(`
      CREATE FULLTEXT INDEX ${fulltextIndexName} IF NOT EXISTS
      FOR (n:LegalOKF) ON EACH [n.title, n.content, n.law_number, n.category, n.okf_id]
    `);

    try {
      await session.run(`
        CREATE VECTOR INDEX ${vectorIndexName} IF NOT EXISTS
        FOR (n:LegalOKF) ON (n.embedding)
        OPTIONS {
          indexConfig: {
            \`vector.similarity_function\`: 'cosine',
            \`vector.dimensions\`: ${vectorDimensions}
          }
        }
      `);
    } catch {
      await session.run(`DROP INDEX ${vectorIndexName} IF EXISTS`);
      await session.run(`
        CREATE VECTOR INDEX ${vectorIndexName} IF NOT EXISTS
        FOR (n:LegalOKF) ON (n.embedding)
        OPTIONS {
          indexConfig: {
            \`vector.similarity_function\`: 'cosine',
            \`vector.dimensions\`: ${vectorDimensions}
          }
        }
      `);
    }

    // 2. Sincronizar ÚNICAMENTE los archivos subidos por el usuario que existan en el directorio OKF
    await fs.mkdir(OKF_DIR, { recursive: true });
    const files = (await fs.readdir(OKF_DIR)).filter((f) => f.endsWith('.md'));

    if (files.length === 0) {
      console.log(`[Neo4j] Base de conocimiento inicializada vacía (0 normas). Se indexarán solo los PDFs que subas desde el frontend.`);
      return;
    }

    console.log(`[Neo4j] Sincronizando ${files.length} normas cargadas por el usuario...`);
    const parsedNodes = [];

    for (const file of files) {
      const raw = await fs.readFile(path.join(OKF_DIR, file), 'utf-8');
      const { data, content } = matter(raw);
      if (!data.okf_id) continue;

      const node = {
        okf_id: String(data.okf_id),
        title: String(data.title || data.okf_id),
        node_type: String(data.node_type || 'Articulo'),
        shape_role: String(data.shape_role || 'NormaFondo'),
        law_number: String(data.law_number || ''),
        article_number: String(data.article_number || ''),
        hierarchy_level: String(data.hierarchy_level || ''),
        domain: String(data.domain || ''),
        category: String(data.category || ''),
        jurisdiction: String(data.jurisdiction || ''),
        especialidades_fiuba: Array.isArray(data.especialidades_fiuba) ? data.especialidades_fiuba : [],
        status: String(data.status || 'Vigente'),
        last_updated: String(data.last_updated || ''),
        content: content.trim(),
        relations: Array.isArray(data.relations) ? data.relations : [],
      };

      const embedding = await computeHfEmbedding(
        `${node.title} ${node.law_number} ${node.category} ${node.content}`
      );

      const safeLabel = node.node_type.replace(/[^a-zA-Z0-9_]/g, '') || 'Norma';

      await session.run(
        `
        MERGE (n:LegalOKF {okf_id: $okf_id})
        SET n:${safeLabel},
            n.title = $title,
            n.node_type = $node_type,
            n.shape_role = $shape_role,
            n.law_number = $law_number,
            n.article_number = $article_number,
            n.hierarchy_level = $hierarchy_level,
            n.domain = $domain,
            n.category = $category,
            n.jurisdiction = $jurisdiction,
            n.especialidades_fiuba = $especialidades_fiuba,
            n.status = $status,
            n.last_updated = $last_updated,
            n.content = $content,
            n.embedding = $embedding
        `,
        { ...node, embedding }
      );

      for (const esp of node.especialidades_fiuba) {
        await session.run(
          `
          MATCH (n:LegalOKF {okf_id: $okf_id})
          MERGE (e:EspecialidadFIUBA {nombre: $esp})
          MERGE (n)-[:APLICA_A_ESPECIALIDAD]->(e)
          `,
          { okf_id: node.okf_id, esp }
        );
      }

      parsedNodes.push(node);
    }

    let edgeCount = 0;
    for (const node of parsedNodes) {
      for (const rel of node.relations) {
        const relType =
          (rel.type || 'CONCUERDA_CON').replace(/[^A-Z0-9_]/gi, '_').toUpperCase() ||
          'CONCUERDA_CON';
        await session.run(
          `
          MATCH (a:LegalOKF {okf_id: $source})
          MATCH (b:LegalOKF {okf_id: $target})
          MERGE (a)-[:${relType}]->(b)
          `,
          { source: node.okf_id, target: rel.target }
        );
        edgeCount++;
      }
    }

    console.log(
      `[Neo4j] ✓ Sincronizados ${parsedNodes.length} nodos OKF y ${edgeCount} aristas normativas cargadas por el usuario.`
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedDatabase().catch((err) => {
    console.error('[Neo4j Seed] Error:', err);
    process.exit(1);
  });
}
