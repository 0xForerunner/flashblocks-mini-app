import { getDemoWalletSnapshot } from '@/lib/demo-tx';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const snapshot = await getDemoWalletSnapshot();
    return NextResponse.json(snapshot);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to fetch demo wallet snapshot';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
