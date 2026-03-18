import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Receipt } from "mppx";
import { Mppx } from "mppx/client";
import bs58 from "bs58";
import { client as solanaClient, LOCALNET_RPC_URL } from "../../index";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLFORGE_GUI = "http://127.0.0.1:42069";

const port = Number(process.env.PORT ?? 3040);
const cluster = process.env.EXAMPLE_CLUSTER ?? "localnet";
const rpcUrl = process.env.EXAMPLE_RPC_URL ?? defaultRpcUrl(cluster);
const decimals = 6;
const amount = process.env.EXAMPLE_AMOUNT ?? "100000";
const feeTokenAmount = process.env.EXAMPLE_FEE_TOKEN_AMOUNT ?? "10000";
const memo = process.env.EXAMPLE_MEMO ?? `mppx-solana-sponsored-usdc-e2e:${Date.now()}`;
const serverUrl = `http://localhost:${port}/paid`;
const connection = new Connection(rpcUrl, "confirmed");

const payer = Keypair.generate();
const recipient = Keypair.generate();
const sponsor = Keypair.generate();

console.log(`Using RPC: ${rpcUrl}`);
console.log(`Generated payer: ${payer.publicKey.toBase58()}`);
console.log(`Generated recipient: ${recipient.publicKey.toBase58()}`);
console.log(`Generated sponsor (fee payer): ${sponsor.publicKey.toBase58()}`);
console.log(`USDC mint: ${USDC_MINT}`);

console.log("\n--- Setup: Airdropping SOL ---");
await Promise.all([
  requestAirdropWithRetry(connection, payer.publicKey, 1 * LAMPORTS_PER_SOL),
  requestAirdropWithRetry(connection, sponsor.publicKey, 1 * LAMPORTS_PER_SOL),
]);
console.log("Airdropped SOL to payer and sponsor.");

console.log("\n--- Setup: Minting USDC to payer via Solforge ---");
const mintAmount = 1_000_000;
await solforgeMint(USDC_MINT, payer.publicKey.toBase58(), String(mintAmount));
console.log(`Minted ${mintAmount / 10 ** decimals} USDC to payer`);

await Bun.sleep(1000);

const { PublicKey } = await import("@solana/web3.js");
const usdcMint = new PublicKey(USDC_MINT);
const payerAta = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);

const payerSolBefore = await connection.getBalance(payer.publicKey, "confirmed");
const sponsorSolBefore = await connection.getBalance(sponsor.publicKey, "confirmed");
const payerTokenBefore = (await connection.getTokenAccountBalance(payerAta, "confirmed")).value.amount;

console.log(`\nPayer SOL before: ${payerSolBefore}`);
console.log(`Sponsor SOL before: ${sponsorSolBefore}`);
console.log(`Payer USDC before: ${payerTokenBefore}`);

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
    EXAMPLE_AMOUNT: amount,
    EXAMPLE_CURRENCY: USDC_MINT,
    EXAMPLE_DECIMALS: String(decimals),
    EXAMPLE_FEE_TOKEN_AMOUNT: feeTokenAmount,
    EXAMPLE_SPONSOR_SECRET_KEY: `[${Array.from(sponsor.secretKey).join(",")}]`,
  },
  stdout: "pipe",
  stderr: "pipe",
});

try {
  await waitForServer(serverUrl);
  console.log(`\nSponsored USDC example server is ready at ${serverUrl}`);

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
    headers: { accept: "application/json" },
  });

  const receipt = Receipt.fromResponse(response);
  const body = (await response.json()) as {
    ok?: boolean;
    paid?: boolean;
    sponsored?: boolean;
    joke?: string;
    [key: string]: unknown;
  };

  const payerSolAfter = await connection.getBalance(payer.publicKey, "confirmed");
  const sponsorSolAfter = await connection.getBalance(sponsor.publicKey, "confirmed");
  const payerTokenAfter = (await connection.getTokenAccountBalance(payerAta, "confirmed")).value.amount;

  let sponsorTokenBalance = "0";
  try {
    const sponsorAta = getAssociatedTokenAddressSync(usdcMint, sponsor.publicKey);
    sponsorTokenBalance = (await connection.getTokenAccountBalance(sponsorAta, "confirmed")).value.amount;
  } catch {}

  let recipientTokenBalance = "0";
  try {
    const recipientAta = getAssociatedTokenAddressSync(usdcMint, recipient.publicKey);
    recipientTokenBalance = (await connection.getTokenAccountBalance(recipientAta, "confirmed")).value.amount;
  } catch {}

  if (!body.ok || !body.paid) {
    throw new Error(`Unexpected response body: ${JSON.stringify(body)}`);
  }

  console.log("\n=== Sponsored USDC E2E Results ===");
  console.log(`Payer SOL:     ${payerSolBefore} → ${payerSolAfter} (change: ${payerSolAfter - payerSolBefore})`);
  console.log(`Sponsor SOL:   ${sponsorSolBefore} → ${sponsorSolAfter} (change: ${sponsorSolAfter - sponsorSolBefore})`);
  console.log(`Payer USDC:    ${payerTokenBefore} → ${payerTokenAfter} (change: ${Number(payerTokenAfter) - Number(payerTokenBefore)})`);
  console.log(`Sponsor USDC received: ${sponsorTokenBalance}`);
  console.log(`Recipient USDC received: ${recipientTokenBalance}`);
  console.log(`\nJoke: ${body.joke}`);

  console.log("\nSponsored USDC end-to-end succeeded.");
  console.log(JSON.stringify({ body, receipt }, null, 2));
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

async function solforgeMint(mint: string, owner: string, amountRaw: string) {
  const res = await fetch(`${SOLFORGE_GUI}/api/mint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mint, owner, amountRaw }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Solforge mint failed: ${text}`);
  }
  return (await res.json()) as { ok: boolean; signature: string };
}

async function waitForServer(url: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(url.replace(/\/paid$/, "/"));
      if (response.ok) return;
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
      await connection.confirmTransaction({ ...latestBlockhash, signature }, "confirmed");
      return signature;
    } catch (error) {
      lastError = error;
      await Bun.sleep(1500 * (attempt + 1));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed to airdrop ${lamports} lamports to ${publicKey.toBase58()}. Last error: ${message}`);
}

function defaultRpcUrl(cluster: string) {
  if (cluster === "localnet" || cluster === "localhost") return LOCALNET_RPC_URL;
  return `https://api.${cluster}.solana.com`;
}
