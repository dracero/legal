import type { APIRoute } from 'astro';
import { executeNeuroSymbolicPipeline } from '../../../lib/gemini/agent';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const casoPlanteado = String(body.casoPlanteado || '').trim();
    const especialidadIngenieria = String(body.especialidadIngenieria || 'Civil').trim();

    if (!casoPlanteado || casoPlanteado.length < 10) {
      return new Response(
        JSON.stringify({ error: 'Por favor describa el caso de ingeniería con al menos 10 caracteres.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const sendEvent = (type: string, data: any) => {
          const line = JSON.stringify({ type, data, timestamp: new Date().toISOString() }) + '\n';
          controller.enqueue(encoder.encode(line));
        };

        try {
          const result = await executeNeuroSymbolicPipeline(
            casoPlanteado,
            especialidadIngenieria,
            (stepEvent) => {
              sendEvent('step', stepEvent);
            }
          );

          sendEvent('complete', result);
        } catch (err: any) {
          console.error('[Stream Pipeline Error]:', err);
          sendEvent('error', { message: err.message || 'Error interno en el flujo neuro-simbólico.' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

