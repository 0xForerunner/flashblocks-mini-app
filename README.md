## Create a Mini App

[Mini apps](https://docs.worldcoin.org/mini-apps) enable third-party developers to create native-like applications within World App.

This project is configured as a Flashblocks confirmation demo. The `/home` screen runs two parallel transaction loops:

- Top lane: flashblocks-style confirmation based on `eth_getBlockByNumber("pending", false)`.
- Bottom lane: normal confirmation based on first non-null `eth_getTransactionReceipt`.

## Getting Started

1. `cp .env.sample .env.local`
2. Fill required vars in `.env.local`:
3. `AUTH_SECRET` (generate with `npx auth secret`)
4. `HMAC_SECRET_KEY` (generate with `openssl rand -base64 32`)
5. `NEXT_PUBLIC_APP_ID`
6. `DEMO_PRIVATE_KEY` (one funded mainnet demo wallet shared by both lanes)
7. RPC defaults are Worldchain mainnet (`https://worldchain.worldcoin.org`, `wss://worldchain.worldcoin.org:8546`)
8. Set `FLASHBLOCKS_BLOCK_TAG` (`pending` by default, or `latest` as fallback)
9. (Optional for local laptop testing) set `DEMO_SPOOF_TRANSACTIONS='true'` (spoof timings are fixed at `800ms` for flashblocks and `2500ms` for normal lane)
10. Run `npm run dev`
11. Run `ngrok http 3000`
12. Set `AUTH_URL` to your ngrok URL
13. Add your domain to `allowedDevOrigins` in `next.config.ts`
14. Verify the app URL mapping in developer.worldcoin.org

## Authentication

This starter kit uses [Minikit's](https://github.com/worldcoin/minikit-js) wallet auth to authenticate users, and [next-auth](https://authjs.dev/getting-started) to manage sessions.

## UI Library

This starter kit uses [Mini Apps UI Kit](https://github.com/worldcoin/mini-apps-ui-kit) to style the app. We recommend using the UI kit to make sure you are compliant with [World App's design system](https://docs.world.org/mini-apps/design/app-guidelines).

## Eruda

[Eruda](https://github.com/liriliri/eruda) is a tool that allows you to inspect the console while building as a mini app. You should disable this in production.

## Demo Behavior

- `Start` kicks off both lanes simultaneously.
- `Stop` aborts in-flight checks and immediately halts new sends.
- Auto-stop occurs after 8 seconds.
- Confirmation metrics shown per lane:
- Sends attempted
- Confirmations observed
- Latest latency (ms)
- Average latency (ms)

## Contributing

This template was made with help from the amazing [supercorp-ai](https://github.com/supercorp-ai) team.
