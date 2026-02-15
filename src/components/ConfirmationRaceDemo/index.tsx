'use client';

import { Button } from '@worldcoin/mini-apps-ui-kit-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type DemoLane = 'flashblocks' | 'normal';
type ConfirmationMethod = 'pending' | 'latest' | 'receipt' | 'none';
type LaneStatus = 'idle' | 'sending' | 'waiting' | 'confirmed' | 'error' | 'stopped';

type LaneState = {
  status: LaneStatus;
  sendsAttempted: number;
  confirmationsObserved: number;
  latestLatencyMs: number | null;
  averageLatencyMs: number | null;
  lastConfirmationMethod: Exclude<ConfirmationMethod, 'none'> | null;
  lastError: string | null;
  sendAnimationTick: number;
  confirmAnimationTick: number;
};

type LaneMap = Record<DemoLane, LaneState>;

type SendRouteResponse = {
  txHash: `0x${string}`;
  from: `0x${string}`;
};

type ConfirmRouteResponse = {
  confirmed: boolean;
  method: ConfirmationMethod;
  blockNumber: number | null;
};

const MAX_RUNTIME_MS = 5_000;
const CONFIRM_POLL_MS = 90;

const LANE_META: Record<
  DemoLane,
  {
    title: string;
    subtitle: string;
    cardClassName: string;
    packetClassName: string;
    packetEmoji: string;
  }
> = {
  flashblocks: {
    title: 'Flashblocks lane',
    subtitle: 'Confirmation via block tag scan (pending/latest)',
    cardClassName: 'border-cyan-200 bg-cyan-50',
    packetClassName: 'lane-packet-flashblocks',
    packetEmoji: '🔥',
  },
  normal: {
    title: 'Normal lane',
    subtitle: 'Confirmation via transaction receipt',
    cardClassName: 'border-slate-200 bg-slate-50',
    packetClassName: 'lane-packet-normal',
    packetEmoji: '🧊',
  },
};

const INITIAL_LANES = (): LaneMap => ({
  flashblocks: {
    status: 'idle',
    sendsAttempted: 0,
    confirmationsObserved: 0,
    latestLatencyMs: null,
    averageLatencyMs: null,
    lastConfirmationMethod: null,
    lastError: null,
    sendAnimationTick: 0,
    confirmAnimationTick: 0,
  },
  normal: {
    status: 'idle',
    sendsAttempted: 0,
    confirmationsObserved: 0,
    latestLatencyMs: null,
    averageLatencyMs: null,
    lastConfirmationMethod: null,
    lastError: null,
    sendAnimationTick: 0,
    confirmAnimationTick: 0,
  },
});

const laneStatusLabel: Record<LaneStatus, string> = {
  idle: 'Idle',
  sending: 'Sending',
  waiting: 'Awaiting confirmation',
  confirmed: 'Confirmed',
  error: 'Retrying',
  stopped: 'Stopped',
};

const asErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unexpected request failure';
};

const isAbortError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error as { name: string }).name === 'AbortError';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const formatLatency = (value: number | null) =>
  value === null ? '--' : `${Math.round(value)}ms`;

export const ConfirmationRaceDemo = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [lanes, setLanes] = useState<LaneMap>(INITIAL_LANES);
  const [remainingMs, setRemainingMs] = useState(MAX_RUNTIME_MS);

  const runTokenRef = useRef(0);
  const runDeadlineRef = useRef<number | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const inFlightRequestsRef = useRef<Set<AbortController>>(new Set());

  const updateLane = useCallback(
    (lane: DemoLane, updater: (laneState: LaneState) => LaneState) => {
      setLanes((current) => ({
        ...current,
        [lane]: updater(current[lane]),
      }));
    },
    [],
  );

  const isActiveRun = useCallback((token: number) => {
    const deadline = runDeadlineRef.current;
    return runTokenRef.current === token && deadline !== null && Date.now() < deadline;
  }, []);

  const abortInFlightRequests = useCallback(() => {
    inFlightRequestsRef.current.forEach((controller) => controller.abort());
    inFlightRequestsRef.current.clear();
  }, []);

  const setStoppedStatuses = useCallback(() => {
    setLanes((current) => ({
      flashblocks: { ...current.flashblocks, status: 'stopped' },
      normal: { ...current.normal, status: 'stopped' },
    }));
  }, []);

  const stopRun = useCallback(() => {
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }

    runTokenRef.current += 1;
    runDeadlineRef.current = null;
    abortInFlightRequests();
    setIsRunning(false);
    setRemainingMs(0);
    setStoppedStatuses();
  }, [abortInFlightRequests, setStoppedStatuses]);

  const postJson = useCallback(
    async <T,>(url: string, body: object): Promise<T> => {
      const controller = new AbortController();
      inFlightRequestsRef.current.add(controller);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const payload = (await response.json()) as T & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? 'Request failed');
        }

        return payload;
      } finally {
        inFlightRequestsRef.current.delete(controller);
      }
    },
    [],
  );

  const runLaneLoop = useCallback(
    async (lane: DemoLane, token: number) => {
      while (isActiveRun(token)) {
        const sendStartAt = performance.now();

        updateLane(lane, (current) => ({
          ...current,
          status: 'sending',
          sendsAttempted: current.sendsAttempted + 1,
          lastError: null,
        }));

        let txHash: `0x${string}`;
        try {
          const sendResult = await postJson<SendRouteResponse>('/api/demo/send', {
            lane,
          });

          txHash = sendResult.txHash;
          if (!isActiveRun(token)) {
            return;
          }

          updateLane(lane, (current) => ({
            ...current,
            status: 'waiting',
            sendAnimationTick: current.sendAnimationTick + 1,
          }));
        } catch (error) {
          if (!isActiveRun(token) || isAbortError(error)) {
            return;
          }

          updateLane(lane, (current) => ({
            ...current,
            status: 'error',
            lastError: asErrorMessage(error),
          }));
          await sleep(40);
          continue;
        }

        let confirmed = false;
        let confirmationMethod: ConfirmationMethod = 'none';

        while (isActiveRun(token) && !confirmed) {
          try {
            const confirmationResult = await postJson<ConfirmRouteResponse>(
              '/api/demo/confirm',
              { lane, txHash },
            );

            confirmed = confirmationResult.confirmed;
            confirmationMethod = confirmationResult.method;
          } catch (error) {
            if (!isActiveRun(token) || isAbortError(error)) {
              return;
            }
          }

          if (!confirmed && isActiveRun(token)) {
            await sleep(CONFIRM_POLL_MS);
          }
        }

        if (!confirmed || !isActiveRun(token)) {
          continue;
        }

        const latencyMs = performance.now() - sendStartAt;

        updateLane(lane, (current) => {
          const nextConfirmations = current.confirmationsObserved + 1;
          const totalLatency =
            (current.averageLatencyMs ?? 0) * current.confirmationsObserved +
            latencyMs;

          return {
            ...current,
            status: 'confirmed',
            confirmationsObserved: nextConfirmations,
            latestLatencyMs: latencyMs,
            averageLatencyMs: totalLatency / nextConfirmations,
            confirmAnimationTick: current.confirmAnimationTick + 1,
            lastConfirmationMethod:
              confirmationMethod === 'none' ? null : confirmationMethod,
          };
        });
      }
    },
    [isActiveRun, postJson, updateLane],
  );

  const startRun = useCallback(() => {
    if (isRunning) {
      return;
    }

    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }

    runTokenRef.current += 1;
    const token = runTokenRef.current;
    const deadline = Date.now() + MAX_RUNTIME_MS;
    runDeadlineRef.current = deadline;

    setLanes(INITIAL_LANES());
    setIsRunning(true);
    setRemainingMs(MAX_RUNTIME_MS);

    stopTimerRef.current = window.setTimeout(() => {
      stopRun();
    }, MAX_RUNTIME_MS);

    void runLaneLoop('flashblocks', token);
    void runLaneLoop('normal', token);
  }, [isRunning, runLaneLoop, stopRun]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const deadline = runDeadlineRef.current;
      if (!deadline) {
        setRemainingMs(0);
        return;
      }

      setRemainingMs(Math.max(0, deadline - Date.now()));
    }, 50);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isRunning]);

  useEffect(() => {
    return () => {
      if (stopTimerRef.current !== null) {
        window.clearTimeout(stopTimerRef.current);
      }
      runTokenRef.current += 1;
      abortInFlightRequests();
    };
  }, [abortInFlightRequests]);

  const laneEntries = useMemo(
    () => [
      { lane: 'flashblocks' as const, state: lanes.flashblocks },
      { lane: 'normal' as const, state: lanes.normal },
    ],
    [lanes],
  );

  return (
    <section className="w-full max-w-2xl mx-auto rounded-2xl border border-slate-200 bg-white p-4 sm:p-6 shadow-sm">
      <header className="mb-4">
        <h1 className="text-xl font-semibold text-slate-900">
          Flashblocks vs Normal Confirmation
        </h1>
        <p className="text-sm text-slate-600">
          Both lanes run in parallel for up to 5 seconds with immediate retry on
          send/check failures.
        </p>
      </header>

      <div className="mb-4 flex items-center gap-2">
        <Button
          onClick={startRun}
          disabled={isRunning}
          size="lg"
          variant="primary"
        >
          Start
        </Button>
        <Button
          onClick={stopRun}
          disabled={!isRunning}
          size="lg"
          variant="tertiary"
        >
          Stop
        </Button>
        <span className="ml-auto text-xs font-medium text-slate-500">
          {isRunning
            ? `Auto-stop in ${(remainingMs / 1000).toFixed(1)}s`
            : 'Stopped'}
        </span>
      </div>

      <div className="grid gap-4">
        {laneEntries.map(({ lane, state }) => {
          const meta = LANE_META[lane];
          return (
            <article
              key={lane}
              className={`rounded-xl border p-4 ${meta.cardClassName}`}
            >
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-900">
                    {meta.title}
                  </h2>
                  <p className="text-xs text-slate-600">{meta.subtitle}</p>
                </div>
                <span className="text-xs font-medium text-slate-700">
                  {laneStatusLabel[state.status]}
                </span>
              </div>

              <div className="lane-track mb-3">
                <span className="lane-node lane-node-left">
                  <span className="lane-node-icon" aria-hidden="true">
                    👤
                  </span>
                  <span>User</span>
                </span>
                <span className="lane-node lane-node-right">
                  <span className="lane-node-icon" aria-hidden="true">
                    ⛓️
                  </span>
                  <span>Chain</span>
                </span>
                {state.sendAnimationTick > 0 ? (
                  <span
                    key={`${lane}-send-${state.sendAnimationTick}`}
                    className={`lane-packet lane-packet-send ${meta.packetClassName}`}
                    aria-hidden="true"
                  >
                    {meta.packetEmoji}
                  </span>
                ) : null}
                {state.confirmAnimationTick > 0 ? (
                  <span
                    key={`${lane}-confirm-${state.confirmAnimationTick}`}
                    className={`lane-packet lane-packet-confirm ${meta.packetClassName}`}
                    aria-hidden="true"
                  >
                    {meta.packetEmoji}
                  </span>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-y-1 text-xs text-slate-700">
                <p>Sends: {state.sendsAttempted}</p>
                <p>Confirms: {state.confirmationsObserved}</p>
                <p>Latest: {formatLatency(state.latestLatencyMs)}</p>
                <p>Average: {formatLatency(state.averageLatencyMs)}</p>
              </div>

              <p className="mt-2 text-xs text-slate-600">
                Last method:{' '}
                {state.lastConfirmationMethod === null
                  ? '--'
                  : state.lastConfirmationMethod}
              </p>

              {state.lastError ? (
                <p className="mt-2 text-xs text-rose-700">
                  Error detected, retrying: {state.lastError}
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
};
