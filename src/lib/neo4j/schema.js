/**
 * Reconciliación compartida de restricciones e índices de Neo4j (FULLTEXT y VECTOR).
 * Detecta y elimina índices heredados o incompatibles antes de crear los configurados.
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

