import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Receipt } from "mppx";
import { Mppx } from "mppx/client";
import bs58 from "bs58";
import { client as solanaClient, LOCALNET_RPC_URL } from "../../index";

const port = Number(process.env.PORT ?? 3030);
const cluster = process.env.EXAMPLE_CLUSTER ?? "localnet";
const rpcUrl = process.env.EXAMPLE_RPC_URL ?? defaultRpcUrl(cluster);
const amountLamports = Number(process.env.EXAMPLE_AMOUNT ?? "1000000");
const feeTokenAmount = process.env.EXAMPLE_FEE_TOKEN_AMOUNT ?? "10000";
const memo = process.env.EXAMPLE_MEMO ?? `mppx-solana-sponsored-e2e:${Date.now()}`;
const serverUrl = `http://localhost:${port}/paid`;
const connection = new Connection(rpcUrl, "confirmed");

const payer = process.env.EXAMPLE_PAYER_SECRET_KEY
  ? Keypair.fromSecretKey(parseSecretKey(process.env.EXAMPLE_PAYER_SECRET_KEY))
  : Keypair.generate();
const recipient = Keypair.generate();
const sponsor = Keypair.generate();

console.log(`Using RPC: ${rpcUrl}`);
console.log(
  `${process.env.EXAMPLE_PAYER_SECRET_KEY ? "Using provided" : "Generated"} payer: ${payer.publicKey.toBase58()}`,
);
console.log(`Generated recipient: ${recipient.publicKey.toBase58()}`);
console.log(`Generated sponsor (fee payer): ${sponsor.publicKey.toBase58()}`);

if (!process.env.EXAMPLE_PAYER_SECRET_KEY) {
  const airdropSignature = await requestAirdropWithRetry(
    connection,
    payer.publicKey,
    2 * LAMPORTS_PER_SOL,
  );
  console.log(`Airdropped payer with signature: ${airdropSignature}`);
}

const sponsorAirdropSignature = await requestAirdropWithRetry(
  connection,
  sponsor.publicKey,
  1 * LAMPORTS_PER_SOL,
);
console.log(`Airdropped sponsor with signature: ${sponsorAirdropSignature}`);

const recipientBefore = await connection.getBalance(recipient.publicKey, "confirmed");
const sponsorBefore = await connection.getBalance(sponsor.publicKey, "confirmed");

const server = Bun.spawn({
  cmd: ["bun", "run", "examples/localnet/sponsored-server.ts"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    MPP_SECRET_KEY: process.env.MPP_SECRET_KEY ?? "dev-secret",
    EXAMPLE_CLUSTER: cluster,
    EXAMPLE_COMMITMENT: "confirmed",
    EXAMPLE_MEMO: memo,
    EXAMPLE_RECIPIENT: recipient.publicKey.toBase58(),
    EXAMPLE_AMOUNT: String(amountLamports),
    EXAMPLE_FEE_TOKEN_AMOUNT: feeTokenAmount,
    EXAMPLE_SPONSOR_SECRET_KEY: `[${Array.from(sponsor.secretKey).join(",")}]`,
  },
  stdout: "pipe",
  stderr: "pipe",
});

try {
  await waitForServer(serverUrl);
  console.log(`Sponsored example server is ready at ${serverUrl}`);

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
    sponsored?: boolean;
    [key: string]: unknown;
  };
  const recipientAfter = await connection.getBalance(recipient.publicKey, "confirmed");
  const sponsorAfter = await connection.getBalance(sponsor.publicKey, "confirmed");

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

  const sponsorFeeReimbursement = Number(feeTokenAmount);
  const sponsorNetChange = sponsorAfter - sponsorBefore;

  console.log("Sponsored end-to-end payment succeeded.");
  console.log(JSON.stringify({
    body,
    receipt,
    recipientBefore,
    recipientAfter,
    sponsorBefore,
    sponsorAfter,
    sponsorNetChange,
    sponsorFeeReimbursement,
  }, null, 2));
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
