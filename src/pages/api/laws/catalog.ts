import type { APIRoute } from 'astro';
import fs from 'fs/promises';
import path from 'path';
import { getAllCatalogOKFNodes, getNeo4jDriver } from '../../../lib/neo4j/client.ts';
import { APP_CONFIG } from '../../../lib/config.ts';

export const GET: APIRoute = async () => {
  try {
    const catalog = await getAllCatalogOKFNodes();
    return new Response(JSON.stringify(catalog), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[API /laws/catalog] Error:', error);
    return new Response(
      JSON.stringify({ nodes: [], edges: [], error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

export const DELETE: APIRoute = async () => {
  try {
    const driver = getNeo4jDriver();
    const session = driver.session();
    try {
      await session.run(`MATCH (n:LegalOKF) DETACH DELETE n`);
      await session.run(`MATCH (c:ConceptoOntologico) DETACH DELETE c`);
      await session.run(`MATCH (r:ReglaDeontica) DETACH DELETE r`);
    } finally {
      await session.close();
    }

    const okfDir = APP_CONFIG.okf.contentDir;
    try {
      const files = await fs.readdir(okfDir);
      for (const file of files) {
        if (file.endsWith('.md')) {
          await fs.unlink(path.join(okfDir, file)).catch(() => {});
        }
      }
    } catch {}

    return new Response(
      JSON.stringify({ success: true, message: 'Base de conocimiento vaciada por completo.' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('[API /laws/catalog DELETE] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
