import { Connection, Keypair } from "@solana/web3.js";
import { Mppx } from "mppx/server";
import {
  createSponsorHandler,
  LOCALNET_RPC_URL,
  NATIVE_SOL_CURRENCY,
  server as solanaServer,
} from "../../index";

const port = Number(process.env.PORT ?? 3000);
const recipient = requiredEnv("EXAMPLE_RECIPIENT");
const secretKey = requiredEnv("MPP_SECRET_KEY");
const cluster = process.env.EXAMPLE_CLUSTER ?? "localnet";
const rpcUrl = process.env.EXAMPLE_RPC_URL ?? defaultRpcUrl(cluster);
const currency = process.env.EXAMPLE_CURRENCY ?? NATIVE_SOL_CURRENCY;
const decimals = Number(process.env.EXAMPLE_DECIMALS ?? defaultDecimals(currency));
const amount = process.env.EXAMPLE_AMOUNT ?? "1000000";
const memo = process.env.EXAMPLE_MEMO ?? `mppx-solana-sponsored:${Date.now()}`;
const feeTokenAmount = process.env.EXAMPLE_FEE_TOKEN_AMOUNT ?? "10000";

const sponsorKeypair = process.env.EXAMPLE_SPONSOR_SECRET_KEY
  ? Keypair.fromSecretKey(parseSecretKey(process.env.EXAMPLE_SPONSOR_SECRET_KEY))
  : Keypair.generate();

const connection = new Connection(rpcUrl, "confirmed");

const mppx = Mppx.create({
  methods: [
    solanaServer({
      amount,
      cluster,
      connection,
      commitment: "confirmed",
      currency,
      decimals,
      memo,
      recipient,
      sponsor: {
        feePayer: sponsorKeypair,
        feeTokenAmount,
        sponsorPath: "/sponsor",
      },
    }),
  ],
  realm: `localhost:${port}`,
  secretKey,
});

const handleSponsor = createSponsorHandler({
  feePayer: sponsorKeypair,
  feeTokenAmount,
  connection,
});

const app = Bun.serve({
  port,
  routes: {
    "/": new Response(
      JSON.stringify(
        {
          name: "mppx-solana sponsored example",
          paidRoute: `http://localhost:${port}/paid`,
          sponsorRoute: `http://localhost:${port}/sponsor`,
          amount,
          cluster,
          currency,
          decimals,
          feeTokenAmount,
          memo,
          recipient,
          feePayer: sponsorKeypair.publicKey.toBase58(),
          rpcUrl,
        },
        null,
        2,
      ),
      { headers: { "content-type": "application/json" } },
    ),
    "/paid": {
      GET: async (request: Request) => {
        const response = await mppx.charge({
          amount,
          cluster,
          commitment: "confirmed",
          currency,
          decimals,
          description: "Sponsored fee test",
          memo,
          recipient,
        })(request);

        if (response.status === 402) {
          return response.challenge;
        }

        const jokes = [
          "Why do programmers prefer dark mode? Because light attracts bugs.",
          "A SQL query walks into a bar, sees two tables, and asks... 'Can I JOIN you?'",
          "There are only 10 types of people in the world: those who understand binary and those who don't.",
          "Why did the blockchain developer quit? He lost his proof of work-life balance.",
          "What's a Solana validator's favorite meal? Proof of Steak.",
        ];
        const joke = jokes[Math.floor(Math.random() * jokes.length)]!;

        return response.withReceipt(
          Response.json({
            ok: true,
            paid: true,
            sponsored: true,
            joke,
            payment: { amount, cluster, currency, decimals, feeTokenAmount, memo, recipient },
          }),
        );
      },
    },
    "/sponsor": {
      POST: handleSponsor,
    },
  },
});

console.log(`Sponsored example server running at ${app.url}`);
console.log(`Paid route: ${app.url}paid`);
console.log(`Sponsor route: ${app.url}sponsor`);
console.log(`Recipient: ${recipient}`);
console.log(`Fee payer (sponsor): ${sponsorKeypair.publicKey.toBase58()}`);
console.log(`Fee token amount: ${feeTokenAmount}`);
console.log(`RPC URL: ${rpcUrl}`);
console.log(`Currency: ${currency}`);
console.log(`Amount: ${amount}`);
console.log(`Memo: ${memo}`);

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function defaultDecimals(currency: string) {
  return currency === NATIVE_SOL_CURRENCY ? "9" : "6";
}

function defaultRpcUrl(cluster: string) {
  if (cluster === "localnet" || cluster === "localhost") {
    return LOCALNET_RPC_URL;
  }

  return `https://api.${cluster}.solana.com`;
}

function parseSecretKey(value: string): Uint8Array {
  if (value.trim().startsWith("[")) {
    return Uint8Array.from(JSON.parse(value) as number[]);
  }

  const bs58 = require("bs58") as typeof import("bs58");
  return Uint8Array.from(bs58.default.decode(value));
}
