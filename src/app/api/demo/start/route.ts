import { DemoRaceEvent, runDemoRace } from '@/lib/demo-tx';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

type StartRouteRequestBody = {
  durationSeconds?: unknown;
};

const MIN_DURATION_SECONDS = 1;
const MAX_DURATION_SECONDS = 60;

const parseDurationSeconds = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  if (value < MIN_DURATION_SECONDS || value > MAX_DURATION_SECONDS) {
    return null;
  }

  return value;
};

export async function POST(request: NextRequest) {
  let body: StartRouteRequestBody;

  try {
    body = (await request.json()) as StartRouteRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const durationSeconds = parseDurationSeconds(body.durationSeconds);
  if (durationSeconds === null) {
    return NextResponse.json(
      {
        error: `durationSeconds must be a number between ${MIN_DURATION_SECONDS} and ${MAX_DURATION_SECONDS}`,
      },
      { status: 400 },
    );
  }

  const durationMs = Math.round(durationSeconds * 1_000);
  const encoder = new TextEncoder();
  let runAbortController: AbortController | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      runAbortController = new AbortController();

      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        controller.close();
      };

      const pushEvent = (event: DemoRaceEvent) => {
        if (closed) {
          return;
        }

        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      const handleRequestAbort = () => {
        runAbortController?.abort();
        close();
      };

      request.signal.addEventListener('abort', handleRequestAbort, { once: true });

      void runDemoRace({
        durationMs,
        signal: runAbortController.signal,
        onEvent: pushEvent,
      })
        .catch(() => {
          if (closed) {
            return;
          }

          pushEvent({
            type: 'end',
            reason: 'error',
            endedAtMs: Date.now(),
          });
        })
        .finally(() => {
          request.signal.removeEventListener('abort', handleRequestAbort);
          close();
        });
    },
    cancel() {
      runAbortController?.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-content-type-options': 'nosniff',
    },
  });
}
