import type { APIRoute } from 'astro';
import { clearDatabaseAndOKFContent, getAllCatalogOKFNodes } from '../../../lib/neo4j/client.ts';

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
    const stats = await clearDatabaseAndOKFContent();
    return new Response(
      JSON.stringify({
        success: true,
        ...stats,
        message: `Base de datos borrada por completo (${stats.deletedNodes} nodos Neo4j y ${stats.deletedFiles} fichas eliminadas).`,
      }),
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
