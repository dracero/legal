import type { APIRoute } from 'astro';
import {
  ingestLawPDFFromFrontend,
  type PDFIngestionResult,
} from '../../../lib/okf/pdf-ingestor.ts';

export const POST: APIRoute = async ({ request }) => {
  try {
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const rawFiles = [
        ...formData.getAll('file'),
        ...formData.getAll('files'),
      ].filter((item): item is File => item instanceof File && item.size > 0);

      if (rawFiles.length === 0) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Debe seleccionar al menos un archivo PDF válido desde su equipo.',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const jurisdiction = String(formData.get('jurisdiction') || 'General').trim();
      const category = String(formData.get('category') || 'Normativa_Cargada').trim();
      const status = String(formData.get('status') || 'Vigente').trim();
      const explicitLawNumber = String(formData.get('lawNumber') || '').trim();

      if (rawFiles.length === 1) {
        const file = rawFiles[0];
        const buffer = Buffer.from(await file.arrayBuffer());
        const lawNumber = explicitLawNumber || file.name.replace(/\.pdf$/i, '').trim() || 'Documento Normativo';

        const result = await ingestLawPDFFromFrontend(buffer, {
          fileName: file.name,
          lawNumber,
          jurisdiction,
          category,
          status,
        });

        return new Response(JSON.stringify(result), {
          status: result.success ? 200 : 422,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Ingesta múltiple secuencial para habilitar referencias cruzadas entre documentos cargados
      const results: Array<PDFIngestionResult & { error?: string }> = [];
      let succeededCount = 0;

      for (const file of rawFiles) {
        const fileLawNumber = file.name.replace(/\.pdf$/i, '').trim() || 'Documento Normativo';
        try {
          const buffer = Buffer.from(await file.arrayBuffer());
          const res = await ingestLawPDFFromFrontend(buffer, {
            fileName: file.name,
            lawNumber: fileLawNumber,
            jurisdiction,
            category,
            status,
          });
          if (res.success) succeededCount++;
          results.push(res);
        } catch (fileErr: any) {
          results.push({
            success: false,
            fileName: file.name,
            extractedCharacters: 0,
            atomicArticlesCreated: 0,
            nodesIngested: [],
            shaclReports: [],
            rejectedCount: 1,
            error: fileErr.message || 'Error al procesar archivo PDF.',
          });
        }
      }

      return new Response(
        JSON.stringify({
          success: succeededCount > 0,
          multiple: true,
          totalFiles: rawFiles.length,
          succeededCount,
          failedCount: rawFiles.length - succeededCount,
          results,
        }),
        {
          status: succeededCount > 0 ? 200 : 422,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const body = await request.json();
    const fileName = body.fileName || 'norma.pdf';
    const lawNumber = body.lawNumber || 'Documento Normativo';
    const jurisdiction = body.jurisdiction || 'General';
    const category = body.category || 'Normativa_Cargada';
    const status = body.status || 'Vigente';

    let buffer: Buffer;
    if (body.fileBase64) {
      buffer = Buffer.from(body.fileBase64, 'base64');
    } else if (body.rawPdfText) {
      buffer = Buffer.from(body.rawPdfText, 'utf-8');
    } else {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Debe enviar uno o más archivos PDF o contenido normativo.',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
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
