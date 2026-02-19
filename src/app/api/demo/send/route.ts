import { isDemoLane, sendLaneTransaction } from "@/lib/demo-tx";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type SendRouteRequestBody = {
  lane?: unknown;
};

export async function POST(request: NextRequest) {
  let body: SendRouteRequestBody;

  try {
    body = (await request.json()) as SendRouteRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { lane } = body;

  if (!isDemoLane(lane)) {
    return NextResponse.json(
      { error: 'lane must be "flashblocks" or "normal"' },
      { status: 400 },
    );
  }

  try {
    const result = await sendLaneTransaction(lane);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to send lane transaction", { lane, error });
    const message =
      error instanceof Error ? error.message : "Failed to send transaction";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
