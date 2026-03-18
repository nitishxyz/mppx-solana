import { Connection, Keypair } from "@solana/web3.js";
import { Receipt } from "mppx";
import { Mppx } from "mppx/client";
import bs58 from "bs58";
import { client as solanaClient, LOCALNET_RPC_URL } from "../../index";

const serverUrl = process.env.EXAMPLE_SERVER_URL ?? "http://localhost:3000/paid";
const cluster = process.env.EXAMPLE_CLUSTER ?? "localnet";
const rpcUrl = process.env.EXAMPLE_RPC_URL ?? defaultRpcUrl(cluster);
const payerSecretKey = parseSecretKey(requiredEnv("EXAMPLE_PAYER_SECRET_KEY"));
const payer = Keypair.fromSecretKey(payerSecretKey);
const connection = new Connection(rpcUrl);

const mppx = Mppx.create({
  methods: [
    solanaClient({
      connection,
      signer: payer,
    }),
  ],
  polyfill: false,
});

console.log(`Paying ${serverUrl} using ${payer.publicKey.toBase58()} on ${cluster}...`);
console.log(`RPC URL: ${rpcUrl}`);

const response = await mppx.fetch(serverUrl, {
  headers: {
    accept: "application/json",
  },
});

const receipt = Receipt.fromResponse(response);
const body = await response.json();

console.log("Response:");
console.log(JSON.stringify(body, null, 2));
console.log("Receipt:");
console.log(JSON.stringify(receipt, null, 2));

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
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
