import type { APIRoute } from 'astro';
import { getAllCatalogOKFNodes } from '../../../lib/neo4j/client';

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

