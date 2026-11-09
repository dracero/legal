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
const vectorIndexName = process.env.NEO4J_VECTOR_INDEX || 'legal_normas_vector_index';
const fulltextIndexName = process.env.NEO4J_FULLTEXT_INDEX || 'legal_normas_fulltext_index';
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
    // 1. Restricciones e índices
    await session.run(
      `CREATE CONSTRAINT legal_okf_id_unique IF NOT EXISTS FOR (n:LegalOKF) REQUIRE n.okf_id IS UNIQUE`
    );

    await session.run(
      `CREATE CONSTRAINT concepto_nombre_unique IF NOT EXISTS FOR (c:ConceptoOntologico) REQUIRE c.nombre IS UNIQUE`
    );

    await session.run(
      `CREATE CONSTRAINT regla_deontica_id_unique IF NOT EXISTS FOR (r:ReglaDeontica) REQUIRE r.id IS UNIQUE`
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
        law_number: String(data.law_number || ''),
        article_number: String(data.article_number || ''),
        hierarchy_level: String(data.hierarchy_level || ''),
        domain: String(data.domain || 'Derecho_General'),
        category: String(data.category || ''),
        jurisdiction: String(data.jurisdiction || 'General'),
        status: String(data.status || 'Vigente'),
        last_updated: String(data.last_updated || ''),
        content: content.trim(),
        relations: Array.isArray(data.relations) ? data.relations : [],
        ontological_entities: Array.isArray(data.ontological_entities) ? data.ontological_entities : [],
        deontic_rules: Array.isArray(data.deontic_rules) ? data.deontic_rules : [],
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
            n.law_number = $law_number,
            n.article_number = $article_number,
            n.hierarchy_level = $hierarchy_level,
            n.domain = $domain,
            n.category = $category,
            n.jurisdiction = $jurisdiction,
            n.status = $status,
            n.last_updated = $last_updated,
            n.content = $content,
            n.embedding = $embedding,
            n.ontological_entities_json = $ontologicalEntitiesJson,
            n.deontic_rules_json = $deonticRulesJson
        `,
        {
          ...node,
          embedding,
          ontologicalEntitiesJson: JSON.stringify(node.ontological_entities),
          deonticRulesJson: JSON.stringify(node.deontic_rules),
        }
      );

      for (const ent of node.ontological_entities) {
        if (!ent.nombre) continue;
        await session.run(
          `
          MATCH (n:LegalOKF {okf_id: $okf_id})
          MERGE (c:ConceptoOntologico {nombre: $nombre})
          SET c.categoria = $categoria, c.descripcion = $descripcion
          MERGE (n)-[:DEFINE_CONCEPTO]->(c)
          `,
          {
            okf_id: node.okf_id,
            nombre: ent.nombre,
            categoria: ent.categoria || 'ConceptoJuridico',
            descripcion: ent.descripcion || '',
          }
        );
      }

      for (const regla of node.deontic_rules) {
        if (!regla.id) continue;
        await session.run(
          `
          MATCH (n:LegalOKF {okf_id: $okf_id})
          MERGE (r:ReglaDeontica {id: $reglaId})
          SET r.modalidad = $modalidad,
              r.sujeto_normado = $sujeto,
              r.conducta = $conducta,
              r.condicion = $condicion,
              r.consecuencia = $consecuencia
          MERGE (n)-[:ESTABLECE_DEBER]->(r)
          `,
          {
            okf_id: node.okf_id,
            reglaId: regla.id,
            modalidad: regla.modalidad,
            sujeto: regla.sujeto_normado,
            conducta: regla.conducta,
            condicion: regla.condicion,
            consecuencia: regla.consecuencia,
          }
        );
      }

      parsedNodes.push(node);
    }

    let edgeCount = 0;
    for (const node of parsedNodes) {
      for (const rel of node.relations) {
        const sanitizedRelType =
          (rel.type || 'CONCUERDA_CON').replace(/[^A-Z0-9_]/gi, '_').toUpperCase() ||
          'CONCUERDA_CON';
        await session.run(
          `
          MATCH (a:LegalOKF {okf_id: $source})
          MATCH (b:LegalOKF {okf_id: $target})
          MERGE (a)-[:${sanitizedRelType}]->(b)
          `,
          { source: node.okf_id, target: rel.target }
        );
        edgeCount++;
      }
    }

    console.log(`[Neo4j] Sincronización exitosa: ${parsedNodes.length} nodos y ${edgeCount} relaciones.`);
  } finally {
    await session.close();
    await driver.close();
  }
}

if (process.argv[1]?.endsWith('seed-neo4j.js')) {
  seedDatabase().catch((err) => {
    console.error('[Neo4j Seed Error]:', err);
    process.exit(1);
  });
}
