# Flashblocks Mini App Plan

## Reference Docs

- Testing quick start: <https://docs.world.org/mini-apps/quick-start/testing>
- Commands quick start: <https://docs.world.org/mini-apps/quick-start/commands>

## Context

This repository currently contains the World Mini App quick start kit.  
Goal: turn it into a simple demo that compares normal transaction confirmations vs flashblocks-style confirmations.

## Product Goal

Build a mini app with a `Start` / `Stop` interaction that runs two confirmation flows in parallel for up to 5 seconds:

- Top lane: flashblocks confirmation flow (using `pending` tag behavior).
- Bottom lane: normal confirmation flow.

Each lane repeatedly does:

1. Send a transaction.
2. Play a very fast send animation (`<100ms`) from left to right (user -> chain).
3. Wait for confirmation.
4. Play a very fast confirmation animation (`<100ms`) from right to left (chain -> user).
5. Repeat until `Stop` is pressed or 5 seconds elapse.

Both lanes run simultaneously and independently.

## Clarified Behavior

- `Start` begins both loops at the same time.
- `Stop` halts new sends and ends both loops immediately.
- Auto-stop after 5 seconds if not stopped manually.
- On stop, do not wait for in-flight confirmations to finish rendering.
- UI should make lane distinction obvious (top = flashblocks, bottom = normal).

## Technical Decisions Captured

- Chain/network: Worldchain mainnet.
- RPC endpoints:
  - HTTP: `https://worldchain.worldcoin.org`
  - WebSocket: `wss://worldchain.worldcoin.org:8546`
- Transactions: real on-chain transactions in both lanes.
- Signing model: no per-transaction user prompt; transactions are signed by demo key(s) controlled by the app backend.
- Cost/contract constraints: use cheap transactions and avoid deploying or relying on custom contracts.
- Flashblocks confirmation lane: use `eth_getBlockByNumber` with `"pending"` and detect the sent tx as pending-confirmed for this lane.
- Normal lane: use first non-null `eth_getTransactionReceipt` as confirmation.
- Metrics: show minimal send-to-confirmation timing metrics in UI.
- Error handling: immediately retry failed sends/checks (optional lightweight error animation).
- Throughput: send next tx immediately after confirmation (no fixed interval cap).
- Rate limiting: no explicit tx-count cap; runtime cap remains 5 seconds.
- Nonce strategy: use one backend signer per lane (two demo wallets total) to avoid nonce contention and keep implementation simple.

## Suggested Implementation Shape

- Keep one loop controller per lane with shared app-level run state.
- Use an abort/cancel flag so stop is immediate and race-safe.
- Send requests from the mini app UI to backend endpoints that sign and broadcast transactions.
- Use a simple native transfer pattern (e.g., self-transfer) to avoid contract dependency.
- Track per-lane metrics:
  - sends attempted
  - confirmations observed
  - latest confirmation latency (ms)
  - average confirmation latency (ms)
- Use `value = 0` by default for cheapest transfer payload, and switch to `1 wei` only if provider/wallet constraints require it.
- Keep private keys server-side only (never shipped to client bundle).

## Remaining Prerequisites (Non-Product Decisions)

1. Funding and key management: confirm both demo wallets have enough mainnet gas balance for repeated real txs.
2. Visual error treatment: optional brief error pulse/flash on lane when retry happens.
3. Pending visibility check: validate `eth_getBlockByNumber("pending", true)` on the selected RPC consistently surfaces newly broadcast txs quickly enough for the top-lane demo.
