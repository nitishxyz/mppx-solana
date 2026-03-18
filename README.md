# mppx-solana

Solana payment method for the [Machine Payments Protocol](https://mpp.dev). Accept SOL and SPL token payments on any HTTP endpoint.

Built on top of [`mppx`](https://www.npmjs.com/package/mppx) — the official MPP SDK.

## Install

```bash
bun add mppx-solana mppx @solana/web3.js @solana/spl-token viem
```

```bash
npm install mppx-solana mppx @solana/web3.js @solana/spl-token viem
```

```bash
pnpm add mppx-solana mppx @solana/web3.js @solana/spl-token viem
```

## How it works

```
Client                          Server
  │                               │
  │  GET /api/resource            │
  │ ────────────────────────────► │
  │                               │
  │  402 + Challenge              │
  │  (amount, recipient, mint)    │
  │ ◄──────────────────────────── │
  │                               │
  │  Signs & sends Solana tx      │
  │  Retries with tx signature    │
  │ ────────────────────────────► │
  │                               │
  │  Verifies tx on-chain         │
  │  200 + Resource + Receipt     │
  │ ◄──────────────────────────── │
```

1. Client hits a paid endpoint → server returns `402` with a Solana payment challenge
2. Client builds, signs, and submits a Solana transaction
3. Client retries the request with the transaction signature as proof
4. Server verifies the transaction on-chain and returns the resource with a receipt

## Server

Gate any endpoint behind a Solana payment. Works with `Bun.serve`, Hono, Express, and Next.js.

### Bun

```ts
import { Mppx } from "mppx/server";
import { server as solanaServer, NATIVE_SOL_CURRENCY } from "mppx-solana";

const mppx = Mppx.create({
  methods: [
    solanaServer({
      recipient: "YourWalletPublicKeyBase58",
      currency: NATIVE_SOL_CURRENCY,
      cluster: "mainnet-beta",
      decimals: 9,
    }),
  ],
  secretKey: process.env.MPP_SECRET_KEY!,
});

Bun.serve({
  async fetch(request) {
    const result = await mppx.charge({
      amount: "1000000", // 0.001 SOL in lamports
      description: "API access",
    })(request);

    if (result.status === 402) return result.challenge;

    return result.withReceipt(
      Response.json({ data: "your paid content here" }),
    );
  },
});
```

### Hono

```ts
import { Hono } from "hono";
import { Mppx } from "mppx/hono";
import { server as solanaServer, NATIVE_SOL_CURRENCY } from "mppx-solana";

const app = new Hono();

const mppx = Mppx.create({
  methods: [
    solanaServer({
      recipient: "YourWalletPublicKeyBase58",
      currency: NATIVE_SOL_CURRENCY,
      cluster: "mainnet-beta",
      decimals: 9,
    }),
  ],
  secretKey: process.env.MPP_SECRET_KEY!,
});

app.get(
  "/api/resource",
  mppx.charge({ amount: "1000000", description: "API access" }),
  async (c) => c.json({ data: "your paid content here" }),
);
```

### Express

```ts
import express from "express";
import { Mppx } from "mppx/express";
import { server as solanaServer, NATIVE_SOL_CURRENCY } from "mppx-solana";

const app = express();

const mppx = Mppx.create({
  methods: [
    solanaServer({
      recipient: "YourWalletPublicKeyBase58",
      currency: NATIVE_SOL_CURRENCY,
      cluster: "mainnet-beta",
      decimals: 9,
    }),
  ],
  secretKey: process.env.MPP_SECRET_KEY!,
});

app.get(
  "/api/resource",
  mppx.charge({ amount: "1000000", description: "API access" }),
  async (req, res) => res.json({ data: "your paid content here" }),
);
```

### Next.js

```ts
// app/api/resource/route.ts
import { Mppx } from "mppx/nextjs";
import { server as solanaServer, NATIVE_SOL_CURRENCY } from "mppx-solana";

const mppx = Mppx.create({
  methods: [
    solanaServer({
      recipient: "YourWalletPublicKeyBase58",
      currency: NATIVE_SOL_CURRENCY,
      cluster: "mainnet-beta",
      decimals: 9,
    }),
  ],
  secretKey: process.env.MPP_SECRET_KEY!,
});

export const GET = mppx.charge({
  amount: "1000000",
  description: "API access",
})(async () => Response.json({ data: "your paid content here" }));
```

## Client

Pay for any MPP-gated endpoint automatically. The SDK handles the 402 → pay → retry flow.

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { Mppx } from "mppx/client";
import { client as solanaClient } from "mppx-solana";

const mppx = Mppx.create({
  methods: [
    solanaClient({
      connection: new Connection("https://api.mainnet-beta.solana.com"),
      signer: Keypair.fromSecretKey(/* your key */),
    }),
  ],
  polyfill: false,
});

// Automatically pays when the server returns 402
const response = await mppx.fetch("https://api.example.com/resource");
const data = await response.json();
```

### Custom signer

Any object with `publicKey` and `signTransaction` works — use this to integrate wallet adapters.

```ts
solanaClient({
  connection,
  signer: {
    publicKey: wallet.publicKey,
    signTransaction: (tx) => wallet.signTransaction(tx),
  },
});
```

### Dynamic connection

Use `getConnection` when you need per-request RPC routing:

```ts
solanaClient({
  signer: myKeypair,
  getConnection: (cluster) => {
    if (cluster === "devnet") return new Connection("https://api.devnet.solana.com");
    return new Connection("https://my-rpc.example.com");
  },
});
```

## Payment options

### Native SOL

```ts
solanaServer({
  currency: NATIVE_SOL_CURRENCY, // "solana:native"
  decimals: 9,
  recipient: "YourWalletPublicKeyBase58",
  cluster: "mainnet-beta",
})

// amount is in lamports: "1000000" = 0.001 SOL
```

### SPL tokens (USDC, USDT, etc.)

```ts
solanaServer({
  currency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mint
  decimals: 6,
  recipient: "YourWalletPublicKeyBase58",
  cluster: "mainnet-beta",
})

// amount is in smallest unit: "10000" = 0.01 USDC
```

The client automatically creates the recipient's associated token account if it doesn't exist.

### Memo verification

Attach a memo to bind payments to specific invoices or orders:

```ts
mppx.charge({
  amount: "1000000",
  memo: "invoice-abc-123",
})
```

The server will reject transactions that don't contain the expected memo.

## Server configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `recipient` | `string` | Yes | Wallet address receiving payments |
| `currency` | `string` | Yes | `"solana:native"` for SOL, or SPL mint address |
| `decimals` | `number` | Yes | Token decimals (9 for SOL, 6 for USDC) |
| `cluster` | `string` | No | `"mainnet-beta"`, `"devnet"`, `"testnet"`, `"localnet"` |
| `commitment` | `string` | No | `"confirmed"` (default) or `"finalized"` |
| `connection` | `Connection` | No | Custom RPC connection |
| `getConnection` | `function` | No | Dynamic connection factory |
| `memo` | `string` | No | Required memo string on transactions |
| `description` | `string` | No | Human-readable description |
| `externalId` | `string` | No | External reference ID for receipts |

## Client configuration

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signer` | `Keypair \| SolanaSigner` | Yes | Signs transactions |
| `connection` | `Connection` | No | RPC connection |
| `getConnection` | `function` | No | Dynamic connection factory |

## Running the example

A full end-to-end example using a local Solana validator is included. This project uses [Solforge](https://github.com/nitishxyz/solforge) as the local validator.

```bash
# Install solforge
bun add -g solforge

# Start the local validator (picks up sf.config.json automatically)
solforge

# In another terminal, run the e2e test
bun run example:e2e
```

Or run server and client separately:

```bash
# Terminal 1 — server
MPP_SECRET_KEY=dev-secret \
EXAMPLE_RECIPIENT=<wallet> \
EXAMPLE_CLUSTER=localnet \
bun run example:server

# Terminal 2 — client
EXAMPLE_PAYER_SECRET_KEY='[1,2,3,...]' \
EXAMPLE_CLUSTER=localnet \
bun run example:client
```

## Type checking

```bash
bun run check
```

## License

MIT
