import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Receipt } from "mppx";
import { Mppx } from "mppx/client";
import bs58 from "bs58";
import { client as solanaClient, LOCALNET_RPC_URL } from "../../index";

const port = Number(process.env.PORT ?? 3020);
const cluster = process.env.EXAMPLE_CLUSTER ?? "localnet";
const rpcUrl = process.env.EXAMPLE_RPC_URL ?? defaultRpcUrl(cluster);
const amountLamports = Number(process.env.EXAMPLE_AMOUNT ?? process.env.EXAMPLE_SOL_AMOUNT_LAMPORTS ?? "1000000");
const memo = process.env.EXAMPLE_MEMO ?? `mppx-solana-e2e:${Date.now()}`;
const serverUrl = `http://localhost:${port}/paid`;
const connection = new Connection(rpcUrl, "confirmed");

const payer = process.env.EXAMPLE_PAYER_SECRET_KEY
  ? Keypair.fromSecretKey(parseSecretKey(process.env.EXAMPLE_PAYER_SECRET_KEY))
  : Keypair.generate();
const recipient = Keypair.generate();

console.log(`Using RPC: ${rpcUrl}`);
console.log(
  `${process.env.EXAMPLE_PAYER_SECRET_KEY ? "Using provided" : "Generated"} payer: ${payer.publicKey.toBase58()}`,
);
console.log(`Generated recipient: ${recipient.publicKey.toBase58()}`);

if (!process.env.EXAMPLE_PAYER_SECRET_KEY) {
  const airdropSignature = await requestAirdropWithRetry(
    connection,
    payer.publicKey,
    2 * LAMPORTS_PER_SOL,
  );
  console.log(`Airdropped payer with signature: ${airdropSignature}`);
} else {
  console.log("Skipping airdrop because EXAMPLE_PAYER_SECRET_KEY was provided.");
}

const recipientBefore = await connection.getBalance(recipient.publicKey, "confirmed");

const server = Bun.spawn({
  cmd: ["bun", "run", "examples/localnet/server.ts"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    MPP_SECRET_KEY: process.env.MPP_SECRET_KEY ?? "dev-secret",
    EXAMPLE_CLUSTER: cluster,
    EXAMPLE_COMMITMENT: "confirmed",
    EXAMPLE_MEMO: memo,
    EXAMPLE_RECIPIENT: recipient.publicKey.toBase58(),
    EXAMPLE_SOL_AMOUNT_LAMPORTS: String(amountLamports),
  },
  stdout: "pipe",
  stderr: "pipe",
});

try {
  await waitForServer(serverUrl);
  console.log(`Example server is ready at ${serverUrl}`);

  const mppx = Mppx.create({
    methods: [
      solanaClient({
        connection,
        signer: payer,
      }),
    ],
    polyfill: false,
  });

  const response = await mppx.fetch(serverUrl, {
    headers: {
      accept: "application/json",
    },
  });

  const receipt = Receipt.fromResponse(response);
  const body = (await response.json()) as {
    ok?: boolean;
    paid?: boolean;
    [key: string]: unknown;
  };
  const recipientAfter = await connection.getBalance(recipient.publicKey, "confirmed");

  if (!body.ok || !body.paid) {
    throw new Error(`Unexpected response body: ${JSON.stringify(body)}`);
  }

  if (receipt.method !== "solana") {
    throw new Error(`Unexpected receipt method: ${receipt.method}`);
  }

  if (recipientAfter - recipientBefore < amountLamports) {
    throw new Error(
      `Recipient balance did not increase by expected amount. Before=${recipientBefore}, After=${recipientAfter}, Expected=${amountLamports}`,
    );
  }

  console.log("End-to-end payment succeeded.");
  console.log(JSON.stringify({ body, receipt, recipientBefore, recipientAfter }, null, 2));
} finally {
  server.kill();
  await server.exited;

  const stdout = await new Response(server.stdout).text();
  const stderr = await new Response(server.stderr).text();

  if (stdout.trim()) {
    console.log("\n--- server stdout ---");
    console.log(stdout.trim());
  }

  if (stderr.trim()) {
    console.error("\n--- server stderr ---");
    console.error(stderr.trim());
  }
}

async function waitForServer(url: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(url.replace(/\/paid$/, "/"));
      if (response.ok) {
        return;
      }
    } catch {}

    await Bun.sleep(500);
  }

  throw new Error(`Timed out waiting for example server at ${url}`);
}

async function requestAirdropWithRetry(
  connection: Connection,
  publicKey: Keypair["publicKey"],
  lamports: number,
) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const signature = await connection.requestAirdrop(publicKey, lamports);
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");

      await connection.confirmTransaction(
        {
          ...latestBlockhash,
          signature,
        },
        "confirmed",
      );

      return signature;
    } catch (error) {
      lastError = error;
      await Bun.sleep(1500 * (attempt + 1));
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);

  throw new Error(
    [
      `Failed to airdrop ${lamports} lamports to ${publicKey.toBase58()}.`,
      "If you are using Solforge localnet, make sure it is running on the RPC URL above.",
      "If you are using devnet, faucet limits are often hit. In that case set EXAMPLE_PAYER_SECRET_KEY to a pre-funded wallet and rerun bun run example:e2e.",
      `Last error: ${message}`,
    ].join(" "),
  );
}

function parseSecretKey(value: string) {
  if (value.trim().startsWith("[")) {
    return Uint8Array.from(JSON.parse(value) as number[]);
  }

  return Uint8Array.from(bs58.decode(value));
}

function defaultRpcUrl(cluster: string) {
  if (cluster === "localnet" || cluster === "localhost") {
    return LOCALNET_RPC_URL;
  }

  return `https://api.${cluster}.solana.com`;
}
