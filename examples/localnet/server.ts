import { Connection } from "@solana/web3.js";
import { Mppx } from "mppx/server";
import {
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
const amount = process.env.EXAMPLE_AMOUNT ?? process.env.EXAMPLE_SOL_AMOUNT_LAMPORTS ?? "1000000";
const memo = process.env.EXAMPLE_MEMO ?? `mppx-solana-example:${Date.now()}`;

const mppx = Mppx.create({
  methods: [
    solanaServer({
      amount,
      cluster,
      connection: new Connection(rpcUrl, "confirmed"),
      commitment: process.env.EXAMPLE_COMMITMENT ?? "confirmed",
      currency,
      decimals,
      memo,
      recipient,
    }),
  ],
  realm: `localhost:${port}`,
  secretKey,
});

const app = Bun.serve({
  port,
  routes: {
    "/": new Response(
      JSON.stringify(
        {
          name: "mppx-solana local example",
          paidRoute: `http://localhost:${port}/paid`,
          amount,
          cluster,
          currency,
          decimals,
          memo,
          recipient,
          rpcUrl,
        },
        null,
        2,
      ),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    ),
    "/paid": {
      GET: async (request: Request) => {
        const response = await mppx.charge({
          amount,
          cluster,
          commitment: process.env.EXAMPLE_COMMITMENT ?? "confirmed",
          currency,
          decimals,
          description: "Local test payment",
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
            joke,
            payment: { amount, cluster, currency, decimals, memo, recipient },
          }),
        );
      },
    },
  },
});

console.log(`Example server running at ${app.url}`);
console.log(`Paid route: ${app.url}paid`);
console.log(`Recipient: ${recipient}`);
console.log(`RPC URL: ${rpcUrl}`);
console.log(`Currency: ${currency}`);
console.log(`Amount: ${amount}`);
console.log(`Decimals: ${decimals}`);
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
