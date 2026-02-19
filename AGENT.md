# Flashblocks Mini App Status

## Reference Docs

- Testing quick start: <https://docs.world.org/mini-apps/quick-start/testing>
- Commands quick start: <https://docs.world.org/mini-apps/quick-start/commands>

## Current Product Behavior

- The app opens directly into the demo flow:
  - `/` redirects to `/home`.
  - No login/auth button is required for local browser testing.
- `/home` renders a two-lane confirmation race UI with `Start` and `Stop`.
- `/home` also shows the shared demo wallet address and ETH balance.
- Runtime behavior:
  - `Start` launches both lanes simultaneously.
  - `Stop` immediately aborts in-flight polling and halts new sends.
  - Auto-stop triggers at 8 seconds.
  - In real mode, an out-of-gas/insufficient-funds send error shows a popup and stops both lanes.
  - Both lanes loop send -> confirm until stop/timeout.
- Lanes:
  - Top lane: flashblocks lane, confirmation by `eth_getBlockByNumber("pending", false)` scan.
  - Bottom lane: normal lane, confirmation by `eth_getBlockByNumber("latest", false)` scan.
- Per-lane metrics shown:
  - sends attempted
  - confirmations observed
  - latest latency (ms)
  - average latency (ms)

## Implemented Architecture

- UI:
  - `src/components/ConfirmationRaceDemo/index.tsx`
  - two independent async lane loops with shared run-state token
  - circular send/confirm emoji animations (`420ms` flashblocks, `560ms` normal)
  - send visual triggers on send, but waits for an active receive animation to finish
- API:
  - `POST /api/demo/send` -> `src/app/api/demo/send/route.ts`
  - `POST /api/demo/confirm` -> `src/app/api/demo/confirm/route.ts`
  - `GET /api/demo/wallet` -> `src/app/api/demo/wallet/route.ts`
- Transaction/confirmation backend logic:
  - `src/lib/demo-tx.ts`
  - real mode sends value `0` self-transfer (`gas: 21000`) from lane signer
  - both lanes use `eth_getBlockByNumber(<lane tag>, false)` transaction hash matching
  - lane tags: flashblocks=`pending`, normal=`latest`

## Spoof Mode (Implemented)

- Purpose: local testing without spending gas or needing live wallet send success.
- Controlled by env vars:
  - `DEMO_SPOOF_TRANSACTIONS`
- Behavior:
  - `send` returns synthetic tx hashes and deterministic synthetic from-addresses.
  - `confirm` returns `confirmed: true` after lane-specific delays:
    - flashblocks: `800ms`
    - normal: `2500ms`
  - flashblocks lane reports method `pending`.
  - normal lane reports method `latest`.

## Environment Model

- RPC and lane mode:
  - `WORLDCHAIN_RPC_HTTP`
  - `WORLDCHAIN_RPC_WS` (configured but not currently used by server logic)
- Real transaction mode keys:
  - `DEMO_PRIVATE_KEY` (shared signer for both lanes)
- Spoof mode:
  - `DEMO_SPOOF_TRANSACTIONS`

## Auth State in Repo

- NextAuth configuration remains in the codebase (`src/auth/index.ts`) and is functional.
- `trustHost: true` is set to avoid local `UntrustedHost` errors.
- The current demo route flow does not require authentication to run.

## Notes

- The app currently favors easy browser testing and iteration speed.
- To switch back to real sends, set `DEMO_SPOOF_TRANSACTIONS='false'` and provide a funded demo key.
