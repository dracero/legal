/**
 * Reconciliación compartida de restricciones, índices y persistencia OKF en Neo4j.
 * Utilizado tanto por el servidor Astro (client.ts) como por los scripts CLI (seed-neo4j.js, clear-db.js).
 */
export async function applyNeo4jSchemaAndIndexes(
  session,
  { vectorIndexName, fulltextIndexName, vectorDimensions }
) {
  await session.run(
    `CREATE CONSTRAINT legal_okf_id_unique IF NOT EXISTS FOR (n:LegalOKF) REQUIRE n.okf_id IS UNIQUE`
  );

  await session.run(
    `CREATE CONSTRAINT concepto_nombre_unique IF NOT EXISTS FOR (c:ConceptoOntologico) REQUIRE c.nombre IS UNIQUE`
  );

  await session.run(
    `CREATE CONSTRAINT regla_deontica_id_unique IF NOT EXISTS FOR (r:ReglaDeontica) REQUIRE r.id IS UNIQUE`
  );

  // En Neo4j, IF NOT EXISTS omite crear un índice nuevo si ya existe otro con distinto nombre sobre el mismo esquema
  const idxRes = await session.run(`SHOW INDEXES YIELD name, type, labelsOrTypes, properties, options`);
  for (const rec of idxRes.records) {
    const name = String(rec.get('name') || '');
    const type = String(rec.get('type') || '');
    const labels = rec.get('labelsOrTypes') || [];
    const props = rec.get('properties') || [];
    const options = rec.get('options') || {};

    if (!labels.includes('LegalOKF')) continue;

    const isConflictingVector =
      type === 'VECTOR' &&
      props.includes('embedding') &&
      (name !== vectorIndexName ||
        Number(options?.indexConfig?.['vector.dimensions']) !== vectorDimensions);

    const isConflictingFulltext = type === 'FULLTEXT' && name !== fulltextIndexName;

    if (isConflictingVector || isConflictingFulltext) {
      const safeName = name.replace(/[^a-zA-Z0-9_]/g, '');
      if (safeName) {
        console.log(`[Neo4j Schema] Eliminando índice obsoleto o incompatible: ${safeName} (${type})`);
        await session.run(`DROP INDEX ${safeName} IF EXISTS`);
      }
    }
  }

  await session.run(`
    CREATE FULLTEXT INDEX ${fulltextIndexName} IF NOT EXISTS
    FOR (n:LegalOKF) ON EACH [n.title, n.content, n.law_number, n.category, n.okf_id]
  `);

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

  try {
    await session.run(`CALL db.awaitIndexes(5)`);
  } catch {}
}

/**
 * Inserta o actualiza un nodo LegalOKF, limpiando vínculos previos y evitando
 * colisiones de IDs en ReglaDeontica mediante alcance por okf_id (<okf_id>::<regla.id>).
 */
export async function upsertOKFNodeInSession(session, node, embedding) {
  const safeLabel = (node.node_type || 'Articulo').replace(/[^a-zA-Z0-9_]/g, '') || 'Articulo';
  const ontologicalEntities = Array.isArray(node.ontological_entities) ? node.ontological_entities : [];
  const deonticRules = Array.isArray(node.deontic_rules) ? node.deontic_rules : [];
  const ontologicalEntitiesJson = JSON.stringify(ontologicalEntities);
  const deonticRulesJson = JSON.stringify(deonticRules);

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
      okf_id: node.okf_id,
      title: node.title,
      node_type: node.node_type || 'Articulo',
      law_number: node.law_number || '',
      article_number: node.article_number || '',
      hierarchy_level: node.hierarchy_level || '',
      domain: node.domain || 'Derecho_General',
      category: node.category || '',
      jurisdiction: node.jurisdiction || 'General',
      status: node.status || 'Vigente',
      last_updated: node.last_updated || '',
      content: node.content || '',
      embedding,
      ontologicalEntitiesJson,
      deonticRulesJson,
    }
  );

  // Limpiar reglas y relaciones de conceptos previas de este nodo para evitar huérfanos en re-ingesta
  await session.run(
    `
    MATCH (n:LegalOKF {okf_id: $okf_id})-[rel:ESTABLECE_DEBER]->(r:ReglaDeontica)
    DETACH DELETE r
    `,
    { okf_id: node.okf_id }
  );
  await session.run(
    `
    MATCH (n:LegalOKF {okf_id: $okf_id})-[rel:DEFINE_CONCEPTO]->(:ConceptoOntologico)
    DELETE rel
    `,
    { okf_id: node.okf_id }
  );

  for (const ent of ontologicalEntities) {
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

  for (const regla of deonticRules) {
    if (!regla.id) continue;
    const scopedRuleId = `${node.okf_id}::${regla.id}`;
    await session.run(
      `
      MATCH (n:LegalOKF {okf_id: $okf_id})
      MERGE (r:ReglaDeontica {id: $reglaId})
      SET r.rule_code = $ruleCode,
          r.okf_id = $okf_id,
          r.modalidad = $modalidad,
          r.sujeto_normado = $sujeto,
          r.conducta = $conducta,
          r.condicion = $condicion,
          r.consecuencia = $consecuencia
      MERGE (n)-[:ESTABLECE_DEBER]->(r)
      `,
      {
        okf_id: node.okf_id,
        reglaId: scopedRuleId,
        ruleCode: regla.id,
        modalidad: regla.modalidad,
        sujeto: regla.sujeto_normado || '',
        conducta: regla.conducta || '',
        condicion: regla.condicion || '',
        consecuencia: regla.consecuencia || '',
      }
    );
  }
}

/**
 * Reemplaza limpiamente las relaciones salientes entre nodos LegalOKF.
 */
export async function linkOKFRelationsInSession(session, nodes) {
  let edgeCount = 0;
  for (const node of nodes) {
    await session.run(
      `
      MATCH (a:LegalOKF {okf_id: $source})-[r]->(b:LegalOKF)
      DELETE r
      `,
      { source: node.okf_id }
    );

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
      edgeCount++;
    }
  }
  return edgeCount;
}
