import { PublicKey } from '@solana/web3.js';

/**
 * Minimal sequential Borsh field reader for Anchor event payloads.
 *
 * Every integer is returned as a decimal string, never a JS number — u64
 * fields observed in real Pump.fun/PumpSwap events (token_total_supply,
 * cumulative volume accumulators) already sit close to or above
 * Number.MAX_SAFE_INTEGER in real mainnet data (e.g. a real CreateEvent's
 * token_total_supply was 1_000_000_000_000_000 in this project's own
 * fixture set), so bigint is used throughout and only stringified at the
 * boundary — never round-tripped through `number`.
 */
export class BorshReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  u8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  u64(): string {
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v.toString();
  }

  i64(): string {
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v.toString();
  }

  /** Signed 128-bit little-endian, two's complement. */
  i128(): string {
    const lo = this.buf.readBigUInt64LE(this.offset);
    const hi = this.buf.readBigInt64LE(this.offset + 8);
    this.offset += 16;
    const magnitude = (hi << 64n) | lo;
    return magnitude.toString();
  }

  pubkey(): string {
    const bytes = this.buf.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return new PublicKey(bytes).toBase58();
  }

  string(): string {
    const len = this.u32();
    const s = this.buf.toString('utf8', this.offset, this.offset + len);
    this.offset += len;
    return s;
  }
}
