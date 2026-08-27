/**
 * Phase 5C — launch transaction analysis.
 *
 * Reconstructs launch-time facts from the discovery transaction only:
 * fee payer, program IDs, mint init/mint-to/burn instructions, launch
 * acquirers (via pre/post token balance deltas — already decoded by the RPC
 * node, never hand-parsed from instruction data), and creator candidates.
 * Source is derived strictly from on-chain program-ID evidence, never from a
 * config label (phase5c.txt §5).
 *
 * A positive balance delta proves acquisition/receipt, NOT purchase
 * (phase5d.txt §1). Every acquirer is classified against evidence before any
 * caller may treat it as a "buyer" — pool/vault funding and mint
 * destinations are never counted as bundled buyer acquisition, and only
 * `VERIFIED_BUY` satisfies sniper-percentage evidence requirements.
 */

import { CoverageStatus, ForensicEvidence, LaunchInfo } from "./types";
import { GetTransactionResult, Instruction, isParsedInstruction } from "./rpcSchemas";
import { ForensicsRpcClient } from "./solanaForensicsClient";
import { classifyAccount } from "./accountClassifier";
import {
  KNOWN_LAUNCH_PROGRAM_IDS,
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_RAYDIUM_MIGRATION,
  PUMPSWAP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./wellKnownAccounts";

export interface LaunchAnalysisInput {
  mint: string;
  discoverySignature?: string;
  discoverySource: LaunchInfo["source"];
  discoveredAt?: Date;
  receivedAt?: Date;
  rawDiscoveryEvidence?: unknown;
}

export type LaunchAcquisitionClassification =
  | "VERIFIED_BUY"
  | "TOKEN_RECEIPT"
  | "INITIAL_DISTRIBUTION"
  | "POOL_OR_VAULT_FUNDING"
  | "MINT_DESTINATION"
  | "UNKNOWN_ACQUISITION";

export interface LaunchAcquirer {
  owner?: string;
  tokenAccount: string;
  acquiredAmountRaw: string;
  classification: LaunchAcquisitionClassification;
  evidence: ForensicEvidence[];
}

/** Classifications that are never counted as bundled/sniper buyer acquisition. */
export const NON_BUYER_ACQUISITION_CLASSIFICATIONS: ReadonlySet<LaunchAcquisitionClassification> = new Set([
  "POOL_OR_VAULT_FUNDING",
  "MINT_DESTINATION",
]);

export interface CreatorCandidate {
  wallet: string;
  source: "LAUNCH_TX_FEE_PAYER" | "MINT_AUTHORITY";
  evidence: ForensicEvidence[];
}

export interface LaunchSupplyReconstruction {
  status: "COMPLETE" | "UNAVAILABLE";
  rawSupply?: bigint;
  formula: string;
  limitation?: string;
}

export interface LaunchTransactionAnalysisResult {
  coverage: CoverageStatus;
  signature?: string;
  slot?: number;
  blockTime?: Date;
  feePayer?: string;
  programIds: string[];
  accountKeys: { pubkey: string; signer: boolean; writable: boolean }[];
  mintInitializationFound: boolean;
  mintToInstructionsFound: number;
  burnInstructionsFound: number;
  acquirers: LaunchAcquirer[];
  possiblePoolOrVaultAccounts: string[];
  creatorCandidates: CreatorCandidate[];
  derivedSource: LaunchInfo["source"];
  launchSupply: LaunchSupplyReconstruction;
  evidence: ForensicEvidence[];
  warnings: string[];
}

function empty(coverage: CoverageStatus, warnings: string[]): LaunchTransactionAnalysisResult {
  return {
    coverage,
    programIds: [],
    accountKeys: [],
    mintInitializationFound: false,
    mintToInstructionsFound: 0,
    burnInstructionsFound: 0,
    acquirers: [],
    possiblePoolOrVaultAccounts: [],
    creatorCandidates: [],
    derivedSource: "UNKNOWN",
    launchSupply: { status: "UNAVAILABLE", formula: "sum(mintTo/mintToChecked amounts in the launch transaction)" },
    evidence: [],
    warnings,
  };
}

function collectAllInstructions(tx: NonNullable<GetTransactionResult>): Instruction[] {
  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions);
  return [...outer, ...inner];
}

function isTokenProgramInstruction(instr: Instruction): boolean {
  return instr.programId === TOKEN_PROGRAM_ID || instr.programId === TOKEN_2022_PROGRAM_ID;
}

function deriveSource(programIds: string[]): LaunchInfo["source"] {
  if (programIds.includes(PUMPSWAP_PROGRAM_ID)) return "PUMPSWAP";
  if (programIds.includes(PUMP_FUN_RAYDIUM_MIGRATION)) return "MIGRATION";
  if (programIds.includes(PUMP_FUN_PROGRAM_ID)) return "PUMPFUN";
  return "UNKNOWN";
}

export async function analyzeLaunchTransaction(
  client: ForensicsRpcClient,
  input: LaunchAnalysisInput,
  opts: { evidenceId: () => string; now: () => Date }
): Promise<LaunchTransactionAnalysisResult> {
  if (!input.discoverySignature) {
    return empty("UNAVAILABLE", ["no discovery signature available for this token"]);
  }

  const txResult = await client.getTransaction(input.discoverySignature, {});
  if (txResult.status === "UNAVAILABLE") {
    return empty("UNAVAILABLE", [`launch transaction fetch failed: ${txResult.code}: ${txResult.reason}`]);
  }
  if (!txResult.data) {
    return empty("UNAVAILABLE", ["launch transaction was not found by RPC"]);
  }

  const tx = txResult.data;
  const accountKeys = tx.transaction.message.accountKeys;
  const feePayer = accountKeys[0]?.pubkey;
  const allInstructions = collectAllInstructions(tx);
  const programIds = Array.from(new Set(allInstructions.map((i) => i.programId)));

  let mintInitializationFound = false;
  let mintToCount = 0;
  let burnCount = 0;
  const creatorCandidates: CreatorCandidate[] = [];
  const possiblePoolOrVaultAccounts = new Set<string>();
  const evidence: ForensicEvidence[] = [];
  let mintedTotal = 0n;
  let sawMintForThisToken = false;

  // Token accounts (for this mint) that were mintTo destinations, and
  // token accounts whose incoming transfer was authorized by the fee payer
  // or a mint-authority candidate — both are direct instruction-level
  // evidence, not inferred from balance deltas alone.
  const mintToDestinationAccounts = new Set<string>();
  const transferAuthorityByDestination = new Map<string, string>();

  for (const instr of allInstructions) {
    if (KNOWN_LAUNCH_PROGRAM_IDS.has(instr.programId) && "accounts" in instr) {
      for (const account of instr.accounts) possiblePoolOrVaultAccounts.add(account);
    }
    if (!isParsedInstruction(instr) || !isTokenProgramInstruction(instr)) continue;
    const { type, info } = instr.parsed;

    if (type === "transfer" || type === "transferChecked") {
      const destination = typeof info.destination === "string" ? info.destination : undefined;
      const authority = typeof info.authority === "string" ? info.authority : undefined;
      if (destination && authority) transferAuthorityByDestination.set(destination, authority);
    }

    const infoMint = typeof info.mint === "string" ? info.mint : undefined;
    if (infoMint !== input.mint) continue;

    if (type === "initializeMint" || type === "initializeMint2") {
      mintInitializationFound = true;
      const mintAuthority = typeof info.mintAuthority === "string" ? info.mintAuthority : undefined;
      if (mintAuthority) {
        creatorCandidates.push({
          wallet: mintAuthority,
          source: "MINT_AUTHORITY",
          evidence: [
            {
              id: opts.evidenceId(),
              category: "CREATOR_CANDIDATE",
              description: `mintAuthority recorded on initializeMint for ${input.mint}`,
              reasonCode: "MINT_INITIALIZATION_AUTHORITY",
              source: "SOLANA_STANDARD_RPC",
              signature: input.discoverySignature,
              slot: tx.slot,
              wallets: [mintAuthority],
              retrievedAt: opts.now(),
            },
          ],
        });
      }
    }
    if (type === "mintTo" || type === "mintToChecked") {
      mintToCount += 1;
      sawMintForThisToken = true;
      const destinationAccount = typeof info.account === "string" ? info.account : undefined;
      if (destinationAccount) mintToDestinationAccounts.add(destinationAccount);
      const amountRaw = typeof info.amount === "string" ? info.amount : undefined;
      const checkedAmount =
        info.tokenAmount && typeof info.tokenAmount === "object" && info.tokenAmount !== null
          ? (info.tokenAmount as { amount?: unknown }).amount
          : undefined;
      const amount = amountRaw ?? (typeof checkedAmount === "string" ? checkedAmount : undefined);
      if (amount !== undefined) {
        try {
          mintedTotal += BigInt(amount);
        } catch {
          sawMintForThisToken = false;
        }
      } else {
        sawMintForThisToken = false;
      }
    }
    if (type === "burn" || type === "burnChecked") burnCount += 1;
  }

  if (feePayer) {
    creatorCandidates.push({
      wallet: feePayer,
      source: "LAUNCH_TX_FEE_PAYER",
      evidence: [
        {
          id: opts.evidenceId(),
          category: "CREATOR_CANDIDATE",
          description: `${feePayer} paid the launch transaction fee`,
          reasonCode: "LAUNCH_TX_FEE_PAYER",
          source: "SOLANA_STANDARD_RPC",
          signature: input.discoverySignature,
          slot: tx.slot,
          wallets: [feePayer],
          retrievedAt: opts.now(),
        },
      ],
    });
  }
  evidence.push(...creatorCandidates.flatMap((c) => c.evidence));

  const mintAuthorityCandidateWallets = new Set(
    creatorCandidates.filter((c) => c.source === "MINT_AUTHORITY").map((c) => c.wallet)
  );
  const privilegedAuthorities = new Set([...(feePayer ? [feePayer] : []), ...mintAuthorityCandidateWallets]);

  const preByIndex = new Map(
    (tx.meta?.preTokenBalances ?? []).filter((b) => b.mint === input.mint).map((b) => [b.accountIndex, b])
  );

  const acquirers: LaunchAcquirer[] = [];
  for (const post of (tx.meta?.postTokenBalances ?? []).filter((b) => b.mint === input.mint)) {
    const before = preByIndex.get(post.accountIndex);
    const beforeAmount = before ? BigInt(before.uiTokenAmount.amount) : 0n;
    const afterAmount = BigInt(post.uiTokenAmount.amount);
    const delta = afterAmount - beforeAmount;
    if (delta <= 0n) continue;

    const tokenAccountAddress = accountKeys[post.accountIndex]?.pubkey ?? `index:${post.accountIndex}`;
    const owner = post.owner;
    const evidenceRecord: ForensicEvidence = {
      id: opts.evidenceId(),
      category: "LAUNCH_ACQUISITION",
      description: `token account ${tokenAccountAddress} gained ${delta.toString()} of ${input.mint} in the launch transaction`,
      reasonCode: "PRE_POST_TOKEN_BALANCE_DELTA",
      source: "SOLANA_STANDARD_RPC",
      signature: input.discoverySignature,
      slot: tx.slot,
      wallets: owner ? [owner] : [],
      amounts: { [tokenAccountAddress]: delta.toString() },
      retrievedAt: opts.now(),
    };
    evidence.push(evidenceRecord);

    let classification: LaunchAcquisitionClassification;
    if (!owner) {
      classification = "UNKNOWN_ACQUISITION";
    } else {
      const ownerClassification = classifyAccount({ address: owner, mint: input.mint, evidenceId: opts.evidenceId, now: opts.now });
      const isPoolLikeOwner =
        ownerClassification.classification === "POOL_VAULT" ||
        ownerClassification.classification === "BONDING_CURVE" ||
        ownerClassification.classification === "SYSTEM_ACCOUNT" ||
        ownerClassification.classification === "PROGRAM_ACCOUNT";
      const ownerIdx = accountKeys.findIndex((a) => a.pubkey === owner);
      const ownerPreBalance = ownerIdx >= 0 ? tx.meta?.preBalances?.[ownerIdx] : undefined;
      const ownerPostBalance = ownerIdx >= 0 ? tx.meta?.postBalances?.[ownerIdx] : undefined;
      const solDecreased =
        ownerPreBalance !== undefined && ownerPostBalance !== undefined && ownerPostBalance < ownerPreBalance;
      const distributionAuthority = transferAuthorityByDestination.get(tokenAccountAddress);

      if (isPoolLikeOwner) {
        classification = "POOL_OR_VAULT_FUNDING";
      } else if (mintToDestinationAccounts.has(tokenAccountAddress)) {
        classification = "MINT_DESTINATION";
      } else if (solDecreased) {
        classification = "VERIFIED_BUY";
      } else if (distributionAuthority && privilegedAuthorities.has(distributionAuthority)) {
        classification = "INITIAL_DISTRIBUTION";
      } else {
        classification = "TOKEN_RECEIPT";
      }
    }

    acquirers.push({
      owner,
      tokenAccount: tokenAccountAddress,
      acquiredAmountRaw: delta.toString(),
      classification,
      evidence: [evidenceRecord],
    });
  }

  const launchSupply: LaunchSupplyReconstruction =
    mintInitializationFound && sawMintForThisToken && mintedTotal > 0n
      ? {
          status: "COMPLETE",
          rawSupply: mintedTotal,
          formula: "sum(mintTo/mintToChecked amounts for this mint within the launch transaction)",
        }
      : {
          status: "UNAVAILABLE",
          formula: "sum(mintTo/mintToChecked amounts for this mint within the launch transaction)",
          limitation:
            "the launch transaction did not contain a fully-decoded mint-to instruction accounting for this mint's initial supply",
        };

  return {
    coverage: "COMPLETE",
    signature: input.discoverySignature,
    slot: tx.slot,
    blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : undefined,
    feePayer,
    programIds,
    accountKeys: accountKeys.map((a) => ({ pubkey: a.pubkey, signer: a.signer, writable: a.writable })),
    mintInitializationFound,
    mintToInstructionsFound: mintToCount,
    burnInstructionsFound: burnCount,
    acquirers,
    possiblePoolOrVaultAccounts: Array.from(possiblePoolOrVaultAccounts),
    creatorCandidates,
    derivedSource: deriveSource(programIds),
    launchSupply,
    evidence,
    warnings: [],
  };
}
