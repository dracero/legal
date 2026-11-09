import type { APIRoute } from 'astro';
import { ingestLawPDFFromFrontend } from '../../../lib/okf/pdf-ingestor.ts';

export const POST: APIRoute = async ({ request }) => {
  try {
    const contentType = request.headers.get('content-type') || '';

    let buffer: Buffer;
    let fileName = 'norma.pdf';
    let lawNumber = 'Documento Normativo';
    let jurisdiction = 'General';
    let category = 'Normativa_Cargada';
    let status = 'Vigente';

    if (contentType.includes('multipart/form-data')) {
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
      buffer = Buffer.from(arrayBuffer);
      fileName = file.name;
      lawNumber = String(formData.get('lawNumber') || file.name.replace(/\.pdf$/i, '')).trim();
      jurisdiction = String(formData.get('jurisdiction') || 'General').trim();
      category = String(formData.get('category') || 'Normativa_Cargada').trim();
      status = String(formData.get('status') || 'Vigente').trim();
    } else {
      const body = await request.json();
      fileName = body.fileName || 'norma.pdf';
      lawNumber = body.lawNumber || 'Documento Normativo';
      jurisdiction = body.jurisdiction || 'General';
      category = body.category || 'Normativa_Cargada';
      status = body.status || 'Vigente';

      if (body.fileBase64) {
        buffer = Buffer.from(body.fileBase64, 'base64');
      } else if (body.rawPdfText) {
        buffer = Buffer.from(body.rawPdfText, 'utf-8');
      } else {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Debe enviar un archivo PDF o contenido normativo.',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    const result = await ingestLawPDFFromFrontend(buffer, {
      fileName,
      lawNumber,
      jurisdiction,
      category,
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
