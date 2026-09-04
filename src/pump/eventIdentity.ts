import { DecodedEventEnvelope } from './eventWalker';

/**
 * Canonical, all-non-null event identity (Phase 7B.3A0 round 2, item 4).
 * innerPosition uses -1 as a sentinel rather than null specifically because
 * a Postgres UNIQUE constraint treats multiple NULLs as distinct, silently
 * defeating a dedup constraint that used a nullable column — never null
 * this field.
 */
export interface EventIdentity {
  signature: string;
  outerInstructionIndex: number;
  innerPosition: number;
  emittingProgram: string;
}

export function eventIdentityOf(env: DecodedEventEnvelope): EventIdentity {
  return {
    signature: env.signature,
    outerInstructionIndex: env.outerInstructionIndex,
    innerPosition: env.innerPosition,
    emittingProgram: env.emittingProgram,
  };
}

export function eventIdentityKey(id: EventIdentity): string {
  return `${id.signature}:${id.outerInstructionIndex}:${id.innerPosition}:${id.emittingProgram}`;
}
