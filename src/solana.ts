import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { Credential, Method, Receipt, z } from "mppx";

export const NATIVE_SOL_CURRENCY = "solana:native";
export const LOCALNET_RPC_URL = "http://127.0.0.1:8899";
export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

export type SolanaCluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";
export type SolanaMode = "push";

export type SolanaRequest = z.input<typeof charge.schema.request>;
export type SolanaCredential = z.output<typeof charge.schema.credential.payload>;

export type SolanaSigner = {
  publicKey: PublicKey;
  signTransaction(transaction: Transaction): Promise<Transaction>;
};

export type SolanaClientParameters = {
  connection?: Connection;
  getConnection?: (
    cluster?: string,
    request?: SolanaRequest,
  ) => Promise<Connection> | Connection;
  signer?: SolanaSigner | Keypair;
  mode?: SolanaMode;
};

export type SolanaServerParameters = {
  amount?: string;
  cluster?: string;
  commitment?: string;
  currency?: string;
  decimals?: number;
  description?: string;
  externalId?: string;
  memo?: string;
  recipient?: string;
  connection?: Connection;
  getConnection?: (
    cluster?: string,
    request?: SolanaRequest,
  ) => Promise<Connection> | Connection;
};

export const charge = Method.from({
  intent: "charge",
  name: "solana",
  schema: {
    credential: {
      payload: z.object({
        signature: z.string(),
        type: z.literal("hash"),
      }),
    },
    request: z.object({
      amount: z.string(),
      cluster: z.optional(z.string()),
      commitment: z.optional(z.string()),
      currency: z.string(),
      decimals: z.number(),
      description: z.optional(z.string()),
      externalId: z.optional(z.string()),
      memo: z.optional(z.string()),
      recipient: z.string(),
    }),
  },
});

export function client(parameters: SolanaClientParameters = {}) {
  return Method.toClient(charge, {
    context: z.object({
      connection: z.optional(z.custom<Connection>()),
      signer: z.optional(z.custom<SolanaSigner | Keypair>()),
    }),
    async createCredential({ challenge, context }) {
      const request = challenge.request;
      const signer = normalizeSigner(context?.signer ?? parameters.signer);
      const connection = await resolveConnection(
        context?.connection ?? parameters.connection,
        parameters.getConnection,
        request.cluster,
        request,
      );

      const transaction = await buildTransaction({
        connection,
        payer: signer.publicKey,
        request,
      });

      const signedTransaction = await signer.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(
        signedTransaction.serialize(),
      );

      await connection.confirmTransaction(
        {
          blockhash: transaction.recentBlockhash!,
          lastValidBlockHeight: transaction.lastValidBlockHeight!,
          signature,
        },
        normalizeCommitment(request.commitment),
      );

      return Credential.serialize({
        challenge,
        payload: {
          signature,
          type: "hash",
        },
        source: `did:pkh:solana:${request.cluster ?? "mainnet-beta"}:${signer.publicKey.toBase58()}`,
      });
    },
  });
}

export function server(parameters: SolanaServerParameters = {}) {
  return Method.toServer(charge, {
    defaults: {
      amount: parameters.amount,
      cluster: parameters.cluster,
      commitment: parameters.commitment,
      currency: parameters.currency,
      decimals: parameters.decimals,
      description: parameters.description,
      externalId: parameters.externalId,
      memo: parameters.memo,
      recipient: parameters.recipient,
    },
    async verify({ credential, request }) {
      const resolvedRequest = charge.schema.request.parse(request);
      const expires = credential.challenge.expires;

      if (expires && new Date(expires) < new Date()) {
        throw new Error(`Payment challenge expired at ${expires}.`);
      }

      const connection = await resolveConnection(
        parameters.connection,
        parameters.getConnection,
        resolvedRequest.cluster,
        resolvedRequest,
      );

      const transaction = await connection.getParsedTransaction(
        credential.payload.signature,
        {
          commitment: normalizeCommitment(resolvedRequest.commitment),
          maxSupportedTransactionVersion: 0,
        },
      );

      if (!transaction) {
        throw new Error(
          `Solana transaction ${credential.payload.signature} was not found.`,
        );
      }

      if (transaction.meta?.err) {
        throw new Error(
          `Solana transaction ${credential.payload.signature} failed on-chain.`,
        );
      }

      if (isNativeCurrency(resolvedRequest.currency)) {
        assertNativeTransfer(transaction, resolvedRequest);
      } else {
        await assertTokenTransfer(connection, transaction, resolvedRequest);
      }

      return Receipt.from({
        externalId: resolvedRequest.externalId,
        method: "solana",
        reference: credential.payload.signature,
        status: "success",
        timestamp: new Date().toISOString(),
      });
    },
  });
}

async function buildTransaction(parameters: {
  connection: Connection;
  payer: PublicKey;
  request: SolanaRequest;
}) {
  const { connection, payer, request } = parameters;
  const recipient = new PublicKey(request.recipient);
  const transaction = new Transaction();
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(normalizeCommitment(request.commitment));

  transaction.feePayer = payer;
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;

  if (isNativeCurrency(request.currency)) {
    const lamports = toSafeInteger(request.amount, "amount");
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        lamports,
        toPubkey: recipient,
      }),
    );
  } else {
    const mint = new PublicKey(request.currency);
    const sourceAta = getAssociatedTokenAddressSync(mint, payer, false);
    const destinationAta = getAssociatedTokenAddressSync(mint, recipient, false);

    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        destinationAta,
        recipient,
        mint,
        TOKEN_PROGRAM_ID,
      ),
      createTransferCheckedInstruction(
        sourceAta,
        mint,
        destinationAta,
        payer,
        BigInt(request.amount),
        request.decimals,
        [],
        TOKEN_PROGRAM_ID,
      ),
    );
  }

  if (request.memo) {
    transaction.add(
      new TransactionInstruction({
        data: Buffer.from(request.memo, "utf8"),
        keys: [],
        programId: MEMO_PROGRAM_ID,
      }),
    );
  }

  return transaction;
}

function assertNativeTransfer(
  transaction: NonNullable<
    Awaited<ReturnType<Connection["getParsedTransaction"]>>
  >,
  request: SolanaRequest,
) {
  const lamports = BigInt(request.amount);
  const recipient = request.recipient;

  const matched = transaction.transaction.message.instructions.some((instruction) => {
    if (!("program" in instruction) || instruction.program !== "system") {
      return false;
    }

    if (!("parsed" in instruction)) {
      return false;
    }

    const parsed = instruction.parsed;
    if (!parsed || typeof parsed !== "object") {
      return false;
    }

    if ((parsed as { type?: string }).type !== "transfer") {
      return false;
    }

    const info = (parsed as { info?: Record<string, unknown> }).info;
    return (
      info?.destination === recipient &&
      BigInt(String(info?.lamports ?? "0")) === lamports
    );
  });

  if (!matched) {
    throw new Error(
      `Transaction did not contain the required native SOL transfer to ${recipient}.`,
    );
  }

  assertMemo(transaction, request.memo);
}

async function assertTokenTransfer(
  connection: Connection,
  transaction: NonNullable<
    Awaited<ReturnType<Connection["getParsedTransaction"]>>
  >,
  request: SolanaRequest,
) {
  const amount = BigInt(request.amount);
  const mint = request.currency;
  const recipient = request.recipient;

  const parsedInstructions = transaction.transaction.message.instructions.filter(
    (instruction): instruction is Extract<
      typeof instruction,
      { parsed: unknown; program: string }
    > => "program" in instruction && "parsed" in instruction,
  );

  for (const instruction of parsedInstructions) {
    if (instruction.program !== "spl-token") {
      continue;
    }

    const parsed = instruction.parsed;
    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    const type = (parsed as { type?: string }).type;
    if (type !== "transferChecked" && type !== "transfer") {
      continue;
    }

    const info = (parsed as { info?: Record<string, unknown> }).info;
    const destination = String(info?.destination ?? "");
    const parsedMint = String(info?.mint ?? mint);
    const rawAmount = info?.tokenAmount && typeof info.tokenAmount === "object"
      ? String((info.tokenAmount as { amount?: string }).amount ?? "0")
      : String(info?.amount ?? "0");

    if (parsedMint !== mint || BigInt(rawAmount) !== amount) {
      continue;
    }

    const destinationAccount = await getAccount(connection, new PublicKey(destination));
    if (destinationAccount.owner.toBase58() !== recipient) {
      continue;
    }

    assertMemo(transaction, request.memo);
    return;
  }

  throw new Error(
    `Transaction did not contain the required SPL token transfer of ${amount} for mint ${mint}.`,
  );
}

function assertMemo(
  transaction: NonNullable<
    Awaited<ReturnType<Connection["getParsedTransaction"]>>
  >,
  expectedMemo?: string,
) {
  if (!expectedMemo) {
    return;
  }

  const matched = transaction.transaction.message.instructions.some((instruction) => {
    if ("program" in instruction && instruction.program === "spl-memo") {
      if (!("parsed" in instruction)) {
        return false;
      }

      const parsed = instruction.parsed;

      if (typeof parsed === "string") {
        return parsed === expectedMemo;
      }

      if (!parsed || typeof parsed !== "object") {
        return false;
      }

      const info = (parsed as { info?: { memo?: string } }).info;

      return info?.memo === expectedMemo;
    }

    if (!("programId" in instruction) || !("data" in instruction)) {
      return false;
    }

    if (instruction.programId.toBase58() !== MEMO_PROGRAM_ID.toBase58()) {
      return false;
    }

    try {
      return Buffer.from(bs58.decode(instruction.data)).toString("utf8") === expectedMemo;
    } catch {
      return false;
    }
  });

  if (!matched) {
    throw new Error(`Transaction memo did not match expected memo \"${expectedMemo}\".`);
  }
}

function isNativeCurrency(currency: string) {
  return currency === NATIVE_SOL_CURRENCY || currency === "native" || currency === "sol";
}

async function resolveConnection(
  connection: Connection | undefined,
  getConnection: SolanaClientParameters["getConnection"] | SolanaServerParameters["getConnection"],
  cluster: string | undefined,
  request: SolanaRequest,
) {
  if (connection) {
    return connection;
  }

  if (getConnection) {
    return await getConnection(cluster, request);
  }

  return new Connection(resolveEndpoint(cluster));
}

function resolveEndpoint(cluster?: string) {
  if (!cluster || cluster === "mainnet-beta" || cluster === "devnet" || cluster === "testnet") {
    const resolvedCluster: "mainnet-beta" | "devnet" | "testnet" = !cluster
      ? "mainnet-beta"
      : cluster === "mainnet-beta" || cluster === "devnet" || cluster === "testnet"
        ? cluster
        : "mainnet-beta";

    return clusterApiUrl(resolvedCluster);
  }

  if (cluster === "localnet" || cluster === "localhost") {
    return LOCALNET_RPC_URL;
  }

  return cluster;
}

function normalizeSigner(signer?: SolanaSigner | Keypair): SolanaSigner {
  if (!signer) {
    throw new Error("A Solana signer or Keypair is required to create credentials.");
  }

  if (signer instanceof Keypair) {
    return {
      publicKey: signer.publicKey,
      async signTransaction(transaction) {
        transaction.partialSign(signer);
        return transaction;
      },
    };
  }

  return signer;
}

function normalizeCommitment(commitment?: string) {
  switch (commitment) {
    case "confirmed":
    case "finalized":
      return commitment;
    default:
      return "confirmed" as const;
  }
}

function toSafeInteger(value: string, fieldName: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer string.`);
  }

  return parsed;
}
