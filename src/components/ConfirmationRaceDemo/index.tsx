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

type WalletRouteResponse = {
  address: `0x${string}` | null;
  balanceWei: string | null;
  balanceEth: string | null;
  spoofMode: boolean;
  available: boolean;
};

const MAX_RUNTIME_MS = 8_000;
const CONFIRM_POLL_MS = 90;
const LANE_PACKET_ANIMATION_MS: Record<DemoLane, number> = {
  flashblocks: 420,
  normal: 560,
};

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
    cardClassName:
      'relative overflow-hidden border-cyan-200/80 bg-gradient-to-br from-cyan-50 via-sky-50 to-cyan-100/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_12px_30px_-24px_rgba(14,116,144,0.75)]',
    packetClassName: 'lane-packet-flashblocks',
    packetEmoji: '🔥',
  },
  normal: {
    title: 'Normal lane',
    subtitle: 'Confirmation via transaction receipt',
    cardClassName:
      'relative overflow-hidden border-slate-200/80 bg-gradient-to-br from-slate-50 via-blue-50/60 to-slate-100/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_12px_30px_-24px_rgba(30,41,59,0.45)]',
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
  waiting: 'Checking chain',
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

const isInsufficientFundsError = (message: string) => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('insufficient funds') ||
    normalized.includes('exceeds the balance of the account') ||
    normalized.includes('gas * price + value')
  );
};

const isAbortError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error as { name: string }).name === 'AbortError';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const formatLatency = (value: number | null) =>
  value === null ? '--' : `${Math.round(value)}ms`;

const formatAddress = (address: `0x${string}` | null) =>
  address === null ? '--' : `${address.slice(0, 6)}...${address.slice(-4)}`;

const formatBalanceEth = (value: string | null) => {
  if (value === null) {
    return '--';
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return `${value} ETH`;
  }

  const decimals = parsed >= 1 ? 4 : 6;
  return `${parsed.toFixed(decimals)} ETH`;
};

export const ConfirmationRaceDemo = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [lanes, setLanes] = useState<LaneMap>(INITIAL_LANES);
  const [remainingMs, setRemainingMs] = useState(MAX_RUNTIME_MS);
  const [fatalErrorMessage, setFatalErrorMessage] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<`0x${string}` | null>(null);
  const [walletBalanceEth, setWalletBalanceEth] = useState<string | null>(null);
  const [walletSnapshotAvailable, setWalletSnapshotAvailable] = useState(false);
  const [walletSpoofMode, setWalletSpoofMode] = useState(false);
  const [walletSnapshotError, setWalletSnapshotError] = useState<string | null>(null);

  const runTokenRef = useRef(0);
  const runDeadlineRef = useRef<number | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const confirmAnimationUntilRef = useRef<Record<DemoLane, number>>({
    flashblocks: 0,
    normal: 0,
  });
  const animationTimersRef = useRef<Set<number>>(new Set());
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

  const clearAnimationTimers = useCallback(() => {
    animationTimersRef.current.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    animationTimersRef.current.clear();
  }, []);

  const scheduleLaneSendAnimation = useCallback(
    (lane: DemoLane, token: number, delayMs: number) => {
      const timerId = window.setTimeout(() => {
        animationTimersRef.current.delete(timerId);
        if (!isActiveRun(token)) {
          return;
        }

        updateLane(lane, (current) => ({
          ...current,
          sendAnimationTick: current.sendAnimationTick + 1,
        }));
      }, delayMs);

      animationTimersRef.current.add(timerId);
    },
    [isActiveRun, updateLane],
  );

  const triggerLaneSendAnimation = useCallback(
    (lane: DemoLane, token: number) => {
      const blockedUntil = confirmAnimationUntilRef.current[lane];
      const delayMs = Math.max(0, blockedUntil - performance.now());
      scheduleLaneSendAnimation(lane, token, delayMs);
    },
    [scheduleLaneSendAnimation],
  );

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
    confirmAnimationUntilRef.current = { flashblocks: 0, normal: 0 };
    abortInFlightRequests();
    clearAnimationTimers();
    setIsRunning(false);
    setRemainingMs(0);
    setStoppedStatuses();
  }, [abortInFlightRequests, clearAnimationTimers, setStoppedStatuses]);

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

  const refreshWalletSnapshot = useCallback(async () => {
    try {
      const response = await fetch('/api/demo/wallet', { cache: 'no-store' });
      const payload = (await response.json()) as WalletRouteResponse & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? 'Failed to fetch wallet snapshot');
      }

      setWalletAddress(payload.address);
      setWalletBalanceEth(payload.balanceEth);
      setWalletSnapshotAvailable(payload.available);
      setWalletSpoofMode(payload.spoofMode);
      setWalletSnapshotError(
        payload.available
          ? null
          : 'Demo wallet not configured. Set DEMO_PRIVATE_KEY for live balance.',
      );
    } catch (error) {
      setWalletSnapshotError(asErrorMessage(error));
    }
  }, []);

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

          triggerLaneSendAnimation(lane, token);

          updateLane(lane, (current) => ({
            ...current,
            status: 'waiting',
          }));
        } catch (error) {
          if (!isActiveRun(token) || isAbortError(error)) {
            return;
          }

          const message = asErrorMessage(error);

          if (isInsufficientFundsError(message)) {
            updateLane(lane, (current) => ({
              ...current,
              status: 'error',
              lastError: message,
            }));
            setFatalErrorMessage(
              `Demo wallet is out of gas funds (${lane} lane send failed). Fund the wallet and try again.`,
            );
            stopRun();
            return;
          }

          updateLane(lane, (current) => ({
            ...current,
            status: 'error',
            lastError: message,
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
        confirmAnimationUntilRef.current[lane] =
          performance.now() + LANE_PACKET_ANIMATION_MS[lane];

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
    [isActiveRun, postJson, stopRun, triggerLaneSendAnimation, updateLane],
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
    confirmAnimationUntilRef.current = { flashblocks: 0, normal: 0 };

    setLanes(INITIAL_LANES());
    setFatalErrorMessage(null);
    setIsRunning(true);
    setRemainingMs(MAX_RUNTIME_MS);

    stopTimerRef.current = window.setTimeout(() => {
      stopRun();
    }, MAX_RUNTIME_MS);

    void runLaneLoop('flashblocks', token);
    void runLaneLoop('normal', token);
  }, [isRunning, runLaneLoop, stopRun]);

  useEffect(() => {
    void refreshWalletSnapshot();
    const intervalId = window.setInterval(() => {
      void refreshWalletSnapshot();
    }, isRunning ? 2_000 : 5_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isRunning, refreshWalletSnapshot]);

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
      clearAnimationTimers();
    };
  }, [abortInFlightRequests, clearAnimationTimers]);

  const laneEntries = useMemo(
    () => [
      { lane: 'flashblocks' as const, state: lanes.flashblocks },
      { lane: 'normal' as const, state: lanes.normal },
    ],
    [lanes],
  );

  return (
    <section className="relative mx-auto w-full max-w-3xl overflow-hidden rounded-3xl border border-slate-200/80 bg-gradient-to-br from-white via-slate-50 to-cyan-50/40 p-4 shadow-[0_20px_55px_-36px_rgba(15,23,42,0.55)] sm:p-6">
      {fatalErrorMessage ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            className="w-full max-w-md rounded-2xl border border-rose-200 bg-white p-5 shadow-2xl"
          >
            <h2 className="text-base font-semibold text-rose-700">Out of gas</h2>
            <p className="mt-2 text-sm text-slate-700">{fatalErrorMessage}</p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setFatalErrorMessage(null)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-16 -top-24 h-56 w-56 rounded-full bg-cyan-200/50 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-24 -right-14 h-56 w-56 rounded-full bg-blue-200/40 blur-3xl"
      />

      <header className="relative mb-5">
        <h1 className="text-xl font-semibold text-slate-900">
          Flashblocks vs Normal Confirmation
        </h1>
        <p className="text-sm text-slate-600">
          Both lanes run in parallel for up to 8 seconds with immediate retry on
          send/check failures.
        </p>
      </header>

      <div className="relative mb-4 flex items-center gap-2 rounded-2xl border border-white/80 bg-white/75 px-3 py-2 shadow-sm backdrop-blur">
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

      <div className="relative grid gap-4">
        {laneEntries.map(({ lane, state }) => {
          const meta = LANE_META[lane];
          return (
            <article
              key={lane}
              className={`rounded-xl border p-4 ${meta.cardClassName}`}
            >
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-white/50 to-transparent"
              />
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

      <div className="relative mt-4 grid grid-cols-1 gap-2 rounded-2xl border border-white/80 bg-white/70 px-3 py-2 text-xs text-slate-700 shadow-sm backdrop-blur sm:grid-cols-3">
        <p>
          <span className="font-semibold text-slate-900">Wallet:</span>{' '}
          {formatAddress(walletAddress)}
        </p>
        <p>
          <span className="font-semibold text-slate-900">Balance:</span>{' '}
          {formatBalanceEth(walletBalanceEth)}
        </p>
        <p>
          <span className="font-semibold text-slate-900">Mode:</span>{' '}
          {walletSpoofMode ? 'Spoof' : 'Live'} /{' '}
          {walletSnapshotAvailable ? 'Configured' : 'Missing key'}
        </p>
      </div>

      {walletSnapshotError ? (
        <p className="relative mt-2 text-xs text-amber-700">{walletSnapshotError}</p>
      ) : null}
    </section>
  );
};
