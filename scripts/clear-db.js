import neo4j from 'neo4j-driver';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { applyNeo4jSchemaAndIndexes } from '../src/lib/neo4j/schema.js';

dotenv.config();

const OKF_DIR = path.resolve(process.env.OKF_CONTENT_DIR || './src/content/okf');
const uri = process.env.NEO4J_URI || 'bolt://localhost:7688';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'password';
const vectorIndexName = process.env.NEO4J_VECTOR_INDEX || 'legal_normas_vector_index';
const fulltextIndexName = process.env.NEO4J_FULLTEXT_INDEX || 'legal_normas_fulltext_index';
const vectorDimensions = Number(process.env.NEO4J_VECTOR_DIMENSIONS || 384);

async function clearDatabase() {
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session();

  try {
    const countRes = await session.run(`MATCH (n) RETURN count(n) AS total`);
    const totalNodes = countRes.records[0]?.get('total')?.toNumber?.() ?? 0;

    await session.run(`MATCH (n) DETACH DELETE n`);
    await applyNeo4jSchemaAndIndexes(session, {
      vectorIndexName,
      fulltextIndexName,
      vectorDimensions,
    });

    let deletedFiles = 0;
    try {
      await fs.mkdir(OKF_DIR, { recursive: true });
      const files = await fs.readdir(OKF_DIR);
      for (const file of files) {
        if (file.endsWith('.md')) {
          await fs.unlink(path.join(OKF_DIR, file));
          deletedFiles++;
        }
      }
    } catch {}

    console.log(
      `[Clear DB] ✓ Base de datos borrada y dejada en blanco (${totalNodes} nodos Neo4j y ${deletedFiles} fichas OKF eliminadas).`
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

clearDatabase().catch((err) => {
  console.error('[Clear DB Error]:', err);
  process.exit(1);
});

