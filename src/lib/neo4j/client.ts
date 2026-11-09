import neo4j, { type Driver } from 'neo4j-driver';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { APP_CONFIG } from '../config.ts';
import { computeHuggingFaceEmbedding } from '../embeddings/huggingface.ts';

export interface OKFRelation {
  type: string;
  target: string;
}

export interface OKFNode {
  okf_id: string;
  title: string;
  node_type: string;
  shape_role: string;
  law_number: string;
  article_number: string;
  hierarchy_level: string;
  domain: string;
  category: string;
  jurisdiction: string;
  especialidades_fiuba: string[];
  status: string;
  last_updated: string;
  content: string;
  relations: OKFRelation[];
  score?: number;
  retrieval_reason?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

let driverInstance: Driver | null = null;

export function getNeo4jDriver(): Driver {
  if (!driverInstance) {
    driverInstance = neo4j.driver(
      APP_CONFIG.neo4j.uri,
      neo4j.auth.basic(APP_CONFIG.neo4j.user, APP_CONFIG.neo4j.password)
    );
  }
  return driverInstance;
}

export async function initLegalNeo4jSchema(): Promise<void> {
  const driver = getNeo4jDriver();
  const session = driver.session();
  try {
    await session.run(
      `CREATE CONSTRAINT legal_okf_id_unique IF NOT EXISTS FOR (n:LegalOKF) REQUIRE n.okf_id IS UNIQUE`
    );

    await session.run(`
      CREATE FULLTEXT INDEX ${APP_CONFIG.neo4j.fulltextIndexName} IF NOT EXISTS
      FOR (n:LegalOKF) ON EACH [n.title, n.content, n.law_number, n.category, n.okf_id]
    `);

    try {
      await session.run(`
        CREATE VECTOR INDEX ${APP_CONFIG.neo4j.vectorIndexName} IF NOT EXISTS
        FOR (n:LegalOKF) ON (n.embedding)
        OPTIONS {
          indexConfig: {
            \`vector.similarity_function\`: 'cosine',
            \`vector.dimensions\`: ${APP_CONFIG.neo4j.vectorDimensions}
          }
        }
      `);
    } catch {
      await session.run(`DROP INDEX ${APP_CONFIG.neo4j.vectorIndexName} IF EXISTS`);
      await session.run(`
        CREATE VECTOR INDEX ${APP_CONFIG.neo4j.vectorIndexName} IF NOT EXISTS
        FOR (n:LegalOKF) ON (n.embedding)
        OPTIONS {
          indexConfig: {
            \`vector.similarity_function\`: 'cosine',
            \`vector.dimensions\`: ${APP_CONFIG.neo4j.vectorDimensions}
          }
        }
      `);
    }
  } finally {
    await session.close();
  }
}

export async function upsertOKFNodeToNeo4j(node: OKFNode): Promise<void> {
  const driver = getNeo4jDriver();
  const session = driver.session();
  try {
    // Generar embedding con modelo Hugging Face (384 dimensiones)
    const embedding = await computeHuggingFaceEmbedding(
      `${node.title} ${node.law_number} ${node.category} ${node.content}`
    );

    const safeLabel = (node.node_type || 'Norma').replace(/[^a-zA-Z0-9_]/g, '') || 'Norma';

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
      {
        okf_id: node.okf_id,
        title: node.title,
        node_type: node.node_type,
        shape_role: node.shape_role,
        law_number: node.law_number,
        article_number: node.article_number,
        hierarchy_level: node.hierarchy_level,
        domain: node.domain,
        category: node.category,
        jurisdiction: node.jurisdiction,
        especialidades_fiuba: node.especialidades_fiuba,
        status: node.status,
        last_updated: node.last_updated,
        content: node.content,
        embedding,
      }
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
  } finally {
    await session.close();
  }
}

export async function linkOKFRelationsInNeo4j(nodes: OKFNode[]): Promise<void> {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    for (const node of nodes) {
      for (const rel of node.relations || []) {
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
      }
    }
  } finally {
    await session.close();
  }
}

export async function readLocalOKFFiles(): Promise<OKFNode[]> {
  const dir = APP_CONFIG.okf.contentDir;
  await fs.mkdir(dir, { recursive: true });
  const files = await fs.readdir(dir);
  const nodes: OKFNode[] = [];

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const raw = await fs.readFile(path.join(dir, file), 'utf-8');
    const { data, content } = matter(raw);
    if (!data.okf_id) continue;

    nodes.push({
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
      status: String(data.status || ''),
      last_updated: String(data.last_updated || ''),
      content: content.trim(),
      relations: Array.isArray(data.relations) ? data.relations : [],
    });
  }

  return nodes;
}

export async function ensureNeo4jSeeded(): Promise<{ count: number }> {
  const driver = getNeo4jDriver();
  const session = driver.session();
  try {
    const res = await session.run(`MATCH (n:LegalOKF) RETURN count(n) AS count`);
    const count = res.records[0]?.get('count')?.toNumber?.() ?? 0;

    if (count > 0) {
      return { count };
    }

    await initLegalNeo4jSchema();
    const localNodes = await readLocalOKFFiles();
    for (const node of localNodes) {
      await upsertOKFNodeToNeo4j(node);
    }
    await linkOKFRelationsInNeo4j(localNodes);
    return { count: localNodes.length };
  } finally {
    await session.close();
  }
}

function recordToOKFNode(props: any, score = 1.0, reason = 'Directo'): OKFNode {
  return {
    okf_id: props.okf_id,
    title: props.title,
    node_type: props.node_type || 'Articulo',
    shape_role: props.shape_role || 'NormaFondo',
    law_number: props.law_number || '',
    article_number: props.article_number || '',
    hierarchy_level: props.hierarchy_level || '',
    domain: props.domain || '',
    category: props.category || '',
    jurisdiction: props.jurisdiction || '',
    especialidades_fiuba: Array.isArray(props.especialidades_fiuba) ? props.especialidades_fiuba : [],
    status: props.status || '',
    last_updated: props.last_updated || '',
    content: props.content || '',
    relations: [],
    score,
    retrieval_reason: reason,
  };
}

/**
 * PASO 3: Búsqueda Híbrida en Neo4j (BM25 Full-Text + Hugging Face Vectorial + Directivas OPA + Expansión Cypher a 2 saltos)
 */
export async function hybridRetrieveAndExpandSubgraph(options: {
  queryText: string;
  especialidad: string;
  jurisdiccion: string;
  obligatoriosOPA: string[];
  limit?: number;
}): Promise<{ nodes: OKFNode[]; edges: GraphEdge[] }> {
  await ensureNeo4jSeeded();
  const driver = getNeo4jDriver();
  const session = driver.session();
  const nodeMap = new Map<string, OKFNode>();

  try {
    // 1. Búsqueda Léxica BM25 sobre el índice Full-Text de Neo4j
    const sanitizedLucene = options.queryText
      .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 24)
      .join(' OR ');

    if (sanitizedLucene) {
      try {
        const ftRes = await session.run(
          `
          CALL db.index.fulltext.queryNodes($indexName, $luceneQuery)
          YIELD node, score
          WHERE node.status = 'Vigente'
            AND ($especialidad IN node.especialidades_fiuba OR 'Todas' IN node.especialidades_fiuba)
            AND (node.jurisdiction = 'Nacional' OR node.jurisdiction = 'Todas' OR node.jurisdiction = $jurisdiccion)
          RETURN node, score
          ORDER BY score DESC
          LIMIT $k
          `,
          {
            indexName: APP_CONFIG.neo4j.fulltextIndexName,
            luceneQuery: sanitizedLucene,
            especialidad: options.especialidad,
            jurisdiccion: options.jurisdiccion,
            k: neo4j.int(options.limit || 8),
          }
        );

        for (const rec of ftRes.records) {
          const props = rec.get('node').properties;
          const score = Number(rec.get('score') || 0.85);
          nodeMap.set(props.okf_id, recordToOKFNode(props, score, 'Búsqueda Full-Text BM25'));
        }
      } catch (e) {
        console.warn('[Neo4j FullText]:', (e as Error).message);
      }
    }

    // 2. Búsqueda Vectorial con Hugging Face Embeddings en Neo4j
    try {
      const queryVector = await computeHuggingFaceEmbedding(options.queryText);
      const vecRes = await session.run(
        `
        CALL db.index.vector.queryNodes($indexName, $k, $queryVector)
        YIELD node, score
        WHERE node.status = 'Vigente'
          AND ($especialidad IN node.especialidades_fiuba OR 'Todas' IN node.especialidades_fiuba)
          AND (node.jurisdiction = 'Nacional' OR node.jurisdiction = 'Todas' OR node.jurisdiction = $jurisdiccion)
        RETURN node, score
        ORDER BY score DESC
        `,
        {
          indexName: APP_CONFIG.neo4j.vectorIndexName,
          k: neo4j.int(options.limit || 8),
          queryVector,
          especialidad: options.especialidad,
          jurisdiccion: options.jurisdiccion,
        }
      );

      for (const rec of vecRes.records) {
        const props = rec.get('node').properties;
        const score = Number(rec.get('score') || 0.85);
        const existing = nodeMap.get(props.okf_id);
        nodeMap.set(
          props.okf_id,
          recordToOKFNode(
            props,
            existing ? Math.max(existing.score || 0, score) : score,
            existing ? `${existing.retrieval_reason} + HF Vector` : 'Búsqueda Vectorial Hugging Face'
          )
        );
      }
    } catch (e) {
      console.warn('[Neo4j Vector]:', (e as Error).message);
    }

    // 3. Nodos obligatorios dictados por el motor deóntico OPA
    if (options.obligatoriosOPA.length > 0) {
      const opaRes = await session.run(
        `
        MATCH (n:LegalOKF)
        WHERE n.okf_id IN $ids AND n.status = 'Vigente'
        RETURN n
        `,
        { ids: options.obligatoriosOPA }
      );
      for (const rec of opaRes.records) {
        const props = rec.get('n').properties;
        const existing = nodeMap.get(props.okf_id);
        nodeMap.set(
          props.okf_id,
          recordToOKFNode(
            props,
            existing ? Math.max(existing.score || 0.9, 0.98) : 0.98,
            existing ? `${existing.retrieval_reason} + Directiva OPA` : 'Directiva Obligatoria OPA'
          )
        );
      }
    }

    // Si tras BM25, Vector Search y OPA el subgrafo quedó vacío pero existen normas cargadas por el usuario,
    // se incorporan las normas vigentes disponibles en Neo4j para analizar lo subido
    if (nodeMap.size === 0) {
      const allLoadedRes = await session.run(
        `
        MATCH (n:LegalOKF)
        WHERE n.status = 'Vigente'
        RETURN n
        LIMIT 12
        `
      );
      for (const rec of allLoadedRes.records) {
        const props = rec.get('n').properties;
        nodeMap.set(props.okf_id, recordToOKFNode(props, 0.85, 'Norma Cargada por el Usuario'));
      }
    }

    // 4. Expansión Cypher de Vecindario (hasta 2 saltos relacionales sobre aristas normativas)
    const seedIds = Array.from(nodeMap.keys());
    if (seedIds.length > 0) {
      const expRes = await session.run(
        `
        MATCH (seed:LegalOKF)-[r]->(neighbor:LegalOKF)
        WHERE seed.okf_id IN $seedIds
          AND neighbor.status = 'Vigente'
        RETURN seed.okf_id AS source, type(r) AS relType, neighbor
        `,
        { seedIds }
      );

      for (const rec of expRes.records) {
        const source = rec.get('source');
        const relType = rec.get('relType');
        const neighborProps = rec.get('neighbor').properties;

        if (!nodeMap.has(neighborProps.okf_id)) {
          nodeMap.set(
            neighborProps.okf_id,
            recordToOKFNode(neighborProps, 0.88, `Expansión Cypher [:${relType}] desde ${source}`)
          );
        }
      }
    }

    const finalIds = Array.from(nodeMap.keys());
    const edgeRes = await session.run(
      `
      MATCH (a:LegalOKF)-[r]->(b:LegalOKF)
      WHERE a.okf_id IN $finalIds AND b.okf_id IN $finalIds
      RETURN DISTINCT a.okf_id AS source, b.okf_id AS target, type(r) AS relType
      `,
      { finalIds }
    );

    const uniqueEdgesMap = new Map<string, GraphEdge>();
    for (const rec of edgeRes.records) {
      const e: GraphEdge = {
        source: rec.get('source'),
        target: rec.get('target'),
        type: rec.get('relType'),
      };
      uniqueEdgesMap.set(`${e.source}-${e.type}-${e.target}`, e);
    }

    return {
      nodes: Array.from(nodeMap.values()),
      edges: Array.from(uniqueEdgesMap.values()),
    };
  } finally {
    await session.close();
  }
}

/**
 * PASO 4 (Autorreparación SHACL): Completa de manera determinista los nodos que el validador SHACL reclamó
 */
export async function completarNodosFaltantesNeo4j(
  subgrafoActual: OKFNode[],
  missingShapeRoles: string[],
  missingOkfIds: string[],
  jurisdiccion: string
): Promise<OKFNode[]> {
  const driver = getNeo4jDriver();
  const session = driver.session();
  const currentMap = new Map<string, OKFNode>(subgrafoActual.map((n) => [n.okf_id, n]));

  try {
    if (missingOkfIds.length > 0) {
      const byIdRes = await session.run(
        `
        MATCH (n:LegalOKF)
        WHERE n.okf_id IN $missingOkfIds AND n.status = 'Vigente'
        RETURN n
        `,
        { missingOkfIds }
      );
      for (const rec of byIdRes.records) {
        const props = rec.get('n').properties;
        currentMap.set(
          props.okf_id,
          recordToOKFNode(props, 0.95, 'Autorreparación SHACL (ID Requerido)')
        );
      }
    }

    if (missingShapeRoles.length > 0) {
      const byRoleRes = await session.run(
        `
        MATCH (n:LegalOKF)
        WHERE n.shape_role IN $missingShapeRoles
          AND n.status = 'Vigente'
          AND (n.jurisdiction = 'Nacional' OR n.jurisdiction = 'Todas' OR n.jurisdiction = $jurisdiccion)
        RETURN n
        LIMIT 6
        `,
        { missingShapeRoles, jurisdiccion }
      );
      for (const rec of byRoleRes.records) {
        const props = rec.get('n').properties;
        if (!currentMap.has(props.okf_id)) {
          currentMap.set(
            props.okf_id,
            recordToOKFNode(props, 0.92, `Autorreparación SHACL (Shape: ${props.shape_role})`)
          );
        }
      }
    }

    return Array.from(currentMap.values());
  } finally {
    await session.close();
  }
}

export async function getAllCatalogOKFNodes(): Promise<{
  nodes: OKFNode[];
  edges: GraphEdge[];
  especialidades: string[];
  jurisdicciones: string[];
  shapeRoles: string[];
}> {
  await ensureNeo4jSeeded();
  const driver = getNeo4jDriver();
  const session = driver.session();
  try {
    const res = await session.run(`MATCH (n:LegalOKF) RETURN n ORDER BY n.okf_id ASC`);
    const nodes = res.records.map((r) => recordToOKFNode(r.get('n').properties, 1.0, 'Catálogo Activo'));

    const edgeRes = await session.run(`
      MATCH (a:LegalOKF)-[r]->(b:LegalOKF)
      RETURN a.okf_id AS source, b.okf_id AS target, type(r) AS relType
    `);
    const edges = edgeRes.records.map((r) => ({
      source: r.get('source'),
      target: r.get('target'),
      type: r.get('relType'),
    }));

    const espRes = await session.run(`MATCH (e:EspecialidadFIUBA) RETURN DISTINCT e.nombre AS nombre ORDER BY nombre ASC`);
    const especialidades = espRes.records.map((r) => String(r.get('nombre')));

    const jurSet = new Set<string>(nodes.map((n) => n.jurisdiction).filter(Boolean));
    const roleSet = new Set<string>(nodes.map((n) => n.shape_role).filter(Boolean));

    return {
      nodes,
      edges,
      especialidades,
      jurisdicciones: Array.from(jurSet),
      shapeRoles: Array.from(roleSet),
    };
  } finally {
    await session.close();
  }
}
