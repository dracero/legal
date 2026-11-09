import type { APIRoute } from 'astro';
import { ingestLawPDFFromFrontend } from '../../../lib/okf/pdf-ingestor';

export const POST: APIRoute = async ({ request }) => {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Formato inválido. Debe enviar un formulario multipart/form-data con un archivo PDF real.',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file || file.size === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Debe seleccionar un archivo PDF válido desde su equipo.',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const fileName = file.name;
    const lawNumber = String(formData.get('lawNumber') || file.name.replace(/\.pdf$/i, '')).trim();
    const jurisdiction = String(formData.get('jurisdiction') || '').trim();
    const category = String(formData.get('category') || '').trim();
    const shapeRole = String(formData.get('shapeRole') || '').trim();
    const status = String(formData.get('status') || '').trim();
    const espRaw = String(formData.get('especialidades') || '').trim();
    const especialidades = espRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const result = await ingestLawPDFFromFrontend(buffer, {
      fileName,
      lawNumber,
      jurisdiction,
      category,
      shapeRole,
      especialidades,
      status,
    });

    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 422,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[API /laws/upload] Error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'Error al procesar el PDF e ingestar en Neo4j.',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
