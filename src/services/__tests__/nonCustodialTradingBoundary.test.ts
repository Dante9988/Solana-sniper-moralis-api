import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for phase7.txt §2/§5: the trading/API/chat surfaces
 * (Telegram, Discord, the `main2` HTTP API, and the trading services they
 * call) must never generate, import, receive, log, return, persist, or
 * transmit a private key or seed phrase, and must never write to or return
 * `Wallet.walletPk`. Mirrors the grep-based pattern used by the other
 * `executionBoundary.test.ts` files in this repo, but scoped to the surfaces
 * those tests explicitly say they do NOT cover (see ARCHITECTURE.md §6
 * Phase 6 notes: "This test only covers those two directories").
 */

const SURFACE_ROOTS = ['src/telegram', 'src/discord', 'src/api', 'src/apiServerGate.ts'];

function collectSourceFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return path.endsWith('.ts') ? [path] : [];
  const files: string[] = [];
  for (const entry of readdirSync(path)) {
    if (entry === '__tests__') continue;
    const full = join(path, entry);
    const s = statSync(full);
    if (s.isDirectory()) files.push(...collectSourceFiles(full));
    else if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

const TRADING_SERVICE_FILES = [
  'src/services/jupiterService.ts',
  'src/services/pumpswapService.ts',
  'src/services/solanaPayService.ts',
  'src/services/qrCode.ts',
];

const ALL_FILES = [...SURFACE_ROOTS.flatMap(collectSourceFiles), ...TRADING_SERVICE_FILES];

describe('trading/API/chat surfaces never handle a private key (phase7.txt §2/§5)', () => {
  it('scanned a non-trivial number of files', () => {
    expect(ALL_FILES.length).toBeGreaterThan(20);
  });

  it('sniperooService.ts (the removed third-party custodial backend) no longer exists', () => {
    expect(existsSync('src/services/sniperooService.ts')).toBe(false);
  });

  it('has no import of, or call into, sniperooService anywhere in the trading/chat surfaces', () => {
    for (const file of ALL_FILES) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from ['"][^'"]*sniperooService['"]/);
      expect(source, file).not.toMatch(/\bsniperooService\s*\./);
    }
  });

  it('never generates or imports a key: no Keypair.generate/fromSecretKey/fromSeed, bip39, or mnemonic handling', () => {
    for (const file of ALL_FILES) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\bKeypair\.(generate|fromSecretKey|fromSeed)\b/);
      expect(source, file).not.toMatch(/bip39|mnemonic/i);
    }
  });

  it('never reads, logs, or returns a raw private/secret key value', () => {
    for (const file of ALL_FILES) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\bprivateKey\b/);
      expect(source, file).not.toMatch(/\bsecretKey\b/);
      expect(source, file).not.toMatch(/\bgetWalletPrivateKey\b/);
      expect(source, file).not.toMatch(/PRIV_KEY_WALLET|RUGCHECK_PRIVATE_KEY|SNIPEROO_API_KEY/);
    }
  });

  it('never writes to or returns Wallet.walletPk', () => {
    for (const file of ALL_FILES) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\bwalletPk\s*:/); // object-literal key (Prisma write, JSON response)
      expect(source, file).not.toMatch(/\.walletPk\s*=/); // direct property assignment
    }
  });

  it('never signs or submits a transaction — every builder returns an unsigned, base64-encoded transaction for the caller to sign themselves', () => {
    for (const file of TRADING_SERVICE_FILES) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\bsignTransaction\b/);
      expect(source, file).not.toMatch(/\bsendTransaction\b/);
      expect(source, file).not.toMatch(/\bsendRawTransaction\b/);
    }
  });

  it('src/api/index.ts does not register /api/wallet/create or /api/wallet/import', () => {
    const source = readFileSync('src/api/index.ts', 'utf8');
    expect(source).not.toMatch(/['"]\/api\/wallet\/create['"]/);
    expect(source).not.toMatch(/['"]\/api\/wallet\/import['"]/);
  });

  it('config.ts has no sniperoo block (the removed third-party custodial SaaS config)', () => {
    const source = readFileSync('src/config.ts', 'utf8');
    expect(source).not.toMatch(/\bsniperoo\s*:/);
    expect(source).not.toMatch(/SNIPEROO_API_KEY/);
  });
});
