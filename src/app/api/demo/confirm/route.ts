import { checkLaneConfirmation, isDemoLane } from '@/lib/demo-tx';
import { Hex } from 'viem';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

type ConfirmRouteRequestBody = {
  lane?: unknown;
  txHash?: unknown;
};

const isTransactionHash = (value: unknown): value is Hex => {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
};

export async function POST(request: NextRequest) {
  let body: ConfirmRouteRequestBody;

  try {
    body = (await request.json()) as ConfirmRouteRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { lane, txHash } = body;

  if (!isDemoLane(lane)) {
    return NextResponse.json(
      { error: 'lane must be "flashblocks" or "normal"' },
      { status: 400 },
    );
  }

  if (!isTransactionHash(txHash)) {
    return NextResponse.json(
      { error: 'txHash must be a 32-byte hex string' },
      { status: 400 },
    );
  }

  try {
    const result = await checkLaneConfirmation(lane, txHash);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to check lane confirmation', { lane, txHash, error });
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to check confirmation status';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
