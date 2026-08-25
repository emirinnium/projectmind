import { loadReportJson } from '@/lib/report-cli';

export const dynamic = 'force-dynamic';

/**
 * Server-Sent Events stream for live dashboard updates.
 * Emits an SSE `report` event with fresh report JSON every 15 seconds;
 * `ping` events keep intermediaries from closing idle connections.
 */
export async function GET() {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = async (): Promise<void> => {
        if (busy) return; // never overlap slow CLI runs
        busy = true;
        try {
          const data = await loadReportJson();
          controller.enqueue(
            encoder.encode(`event: report\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          try {
            controller.enqueue(encoder.encode(`event: ping\ndata: {}\n\n`));
          } catch {
            /* client gone */
          }
        } finally {
          busy = false;
        }
      };

      await push();
      timer = setInterval(() => void push(), 15_000);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
