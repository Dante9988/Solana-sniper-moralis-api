import bs58 from 'bs58';
import {
  EVENT_IX_DISCRIMINATOR,
  PUMP_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  PUMP_EVENT_DISCRIMINATORS,
  PUMPSWAP_EVENT_DISCRIMINATORS,
  findEventName,
} from './discriminators';
import { PUMPSWAP_BUY_DISCRIMINATOR, PUMPSWAP_SELL_DISCRIMINATOR } from './instructionAccounts';

/** Minimal shape this module needs from a `getTransaction` (encoding: "json") response. */
export interface RawInnerInstruction {
  programId: string;
  data: string; // base58
  stackHeight?: number;
  /**
   * Present when the transaction was fetched with encoding "jsonParsed":
   * for an unrecognized/custom program, the RPC resolves the instruction's
   * accounts into a flat pubkey-string array in the program's own IDL
   * order, even at inner-instruction depth — confirmed this session on a
   * real fixture (a PumpSwap self-CPI event instruction nested under an
   * outer Buy call came back with its own resolved `accounts`, not just
   * raw indices). This is what makes routed-call account resolution
   * possible without a second RPC round-trip.
   */
  accounts?: string[];
}
export interface RawInnerInstructionGroup {
  index: number; // outer instruction index this group belongs to
  instructions: RawInnerInstruction[];
}
export interface RawOuterInstruction {
  programId: string;
  data?: string; // base58, present for a raw (non-parsed) instruction
  accounts?: string[]; // present for a jsonParsed "partiallyDecoded" instruction (flat pubkey order)
}
export interface RawTransactionLike {
  slot: number;
  blockTime: number | null;
  transactionIndex?: number;
  transaction: { signatures: string[]; message: { instructions: RawOuterInstruction[] } };
  meta: {
    err: unknown;
    innerInstructions: RawInnerInstructionGroup[] | null;
  };
}

export interface DecodedEventEnvelope {
  eventName: string;
  emittingProgram: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  transactionIndex: number | null;
  outerInstructionIndex: number;
  /** -1 sentinel for a hypothetical non-self-CPI (direct sol_log_data) event — never null. Not observed in any fixture; both Pump.fun and PumpSwap use self-CPI throughout. */
  innerPosition: number;
  payload: Buffer;
  /** The accounts of the buy/sell call instruction that produced this event, when resolvable (see resolveEnclosingCallAccounts). Null for events with no associated trade call (CreateEvent, CompleteEvent, migration events). */
  callAccounts: string[] | null;
}

const EVENT_TABLES: Record<string, Record<string, Buffer>> = {
  [PUMP_PROGRAM_ID]: PUMP_EVENT_DISCRIMINATORS,
  [PUMPSWAP_PROGRAM_ID]: PUMPSWAP_EVENT_DISCRIMINATORS,
};

const CALL_DISCRIMINATORS = [PUMPSWAP_BUY_DISCRIMINATOR, PUMPSWAP_SELL_DISCRIMINATOR];

function isCallInstruction(programId: string, data: Buffer): boolean {
  if (programId !== PUMPSWAP_PROGRAM_ID) return false;
  return CALL_DISCRIMINATORS.some((d) => data.subarray(0, 8).equals(d));
}

/**
 * Decode every recognized Pump.fun/PumpSwap event in a transaction.
 *
 * Requires meta.err === null before inspecting anything — a failed
 * transaction can still show instruction-name logs without any event ever
 * having actually fired (verified this session against a real failed
 * PumpSwap sell fixture: "Instruction: Sell" appears in logs, but no
 * SellEvent discriminator is present anywhere in the transaction).
 *
 * Uses meta.innerInstructions' own stackHeight field to reconstruct the
 * call stack per outer instruction: when a self-CPI event instruction is
 * encountered, its enclosing call is whatever is on top of the
 * reconstructed stack at that point — this is exact (a direct structural
 * fact about how the runtime nests CPI calls), not a nearest-neighbor
 * heuristic.
 */
export function findEvents(tx: RawTransactionLike): DecodedEventEnvelope[] {
  if (tx.meta.err !== null && tx.meta.err !== undefined) return [];
  const signature = tx.transaction.signatures[0];
  const groups = tx.meta.innerInstructions ?? [];
  const results: DecodedEventEnvelope[] = [];

  for (const group of groups) {
    // stack[i] = { programId, accounts } for the call currently open at depth i+1 (stackHeight i+2 in RPC terms, which starts outer instructions at stackHeight 1)
    const stack: Array<{ programId: string; accounts: string[] | null }> = [];

    for (let pos = 0; pos < group.instructions.length; pos++) {
      const ix = group.instructions[pos];
      const stackHeight = ix.stackHeight ?? 1;
      // Pop frames that this instruction's depth has returned past.
      while (stack.length >= stackHeight) stack.pop();

      let data: Buffer;
      try {
        data = Buffer.from(bs58.decode(ix.data));
      } catch {
        stack.push({ programId: ix.programId, accounts: null });
        continue;
      }

      const table = EVENT_TABLES[ix.programId];
      if (
        table &&
        data.length >= 16 &&
        data.subarray(0, 8).equals(EVENT_IX_DISCRIMINATOR)
      ) {
        const eventDisc = data.subarray(8, 16);
        const eventName = findEventName(eventDisc, table);
        if (eventName) {
          const enclosing = stack[stack.length - 1];
          results.push({
            eventName,
            emittingProgram: ix.programId,
            signature,
            slot: tx.slot,
            blockTime: tx.blockTime,
            transactionIndex: tx.transactionIndex ?? null,
            outerInstructionIndex: group.index,
            innerPosition: pos,
            payload: data.subarray(16),
            callAccounts: enclosing?.accounts ?? null,
          });
        }
      }

      // A jsonParsed fetch resolves `accounts` on a call instruction at any
      // depth (inner or outer) — confirmed this session (see the interface
      // doc comment above). Capture them when this frame is itself a
      // buy/sell call, so a self-CPI event emitted inside it (top of stack
      // when found, below) can be traced back to the right accounts
      // whether the call was direct or routed through another program.
      const isCall = isCallInstruction(ix.programId, data);
      stack.push({ programId: ix.programId, accounts: isCall ? ix.accounts ?? null : null });
    }
  }

  return results;
}

/**
 * Fallback for DecodedEventEnvelope.callAccounts === null: resolves
 * base_mint/quote_mint/pool when the causing buy/sell call was itself a
 * direct OUTER instruction (confirmed on a real fixture: pumpswap_buy.json's
 * outer instruction 6 is the Buy call itself). findEvents' stack-based
 * resolution only walks meta.innerInstructions, so it can find a routed
 * (nested) call's accounts but not an outer one's — this function covers
 * the complementary case. Together they cover both shapes observed in this
 * session's fixtures: a direct top-level call (pumpswap_buy.json) and a
 * call routed through another program (pumpswap_sell_via_arb_route.json).
 */
export function resolveTopLevelCallAccounts(
  tx: RawTransactionLike,
  outerInstructionIndex: number,
): string[] | null {
  const ix = tx.transaction.message.instructions[outerInstructionIndex];
  if (!ix || ix.programId !== PUMPSWAP_PROGRAM_ID) return null;
  if (ix.accounts && ix.accounts.length > 0) return ix.accounts;
  return null;
}
