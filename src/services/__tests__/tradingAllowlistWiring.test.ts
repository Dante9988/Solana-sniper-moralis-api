import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for phase7.txt §4: the allowlist guard functions
 * (src/telegram/adminGuard.ts, src/discord/adminGuard.ts — unit-tested for
 * fail-closed behavior in their own __tests__) must actually be called from
 * every trading-adjacent entrypoint. This test does not re-verify the guard
 * logic itself; it verifies the guard is wired in, so a future edit that
 * deletes the call site (while leaving the guard function and its unit
 * tests untouched) still fails CI.
 */

const TELEGRAM_GATED_FILES = [
  'src/telegram/commands/buy.ts',
  'src/telegram/commands/sell.ts',
  'src/telegram/commands/wallet.ts',
  'src/telegram/scenes.ts', // connect_wallet_scene's enter handler
];

const DISCORD_GATED_FILES = ['src/discord/commands/buy.ts', 'src/discord/commands/sell.ts', 'src/discord/commands/wallet.ts'];

describe('trading-command allowlist guards are actually wired in (phase7.txt §4)', () => {
  it('every trading-adjacent Telegram entrypoint imports and calls isTelegramAdmin', () => {
    for (const file of TELEGRAM_GATED_FILES) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toMatch(/import\s*\{[^}]*isTelegramAdmin[^}]*\}\s*from\s*['"][^'"]*adminGuard['"]/);
      expect(source, file).toMatch(/isTelegramAdmin\(/);
    }
  });

  it('every trading-adjacent Discord entrypoint imports and calls isDiscordAdmin', () => {
    for (const file of DISCORD_GATED_FILES) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toMatch(/import\s*\{[^}]*isDiscordAdmin[^}]*\}\s*from\s*['"][^'"]*adminGuard['"]/);
      expect(source, file).toMatch(/isDiscordAdmin\(/);
    }
  });

  it('discord.ts DM/text-command handler gates the trading commands (wallet/buy/sell) with isDiscordAdmin', () => {
    const source = readFileSync('src/discord/discord.ts', 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*isDiscordAdmin[^}]*\}\s*from\s*['"][^'"]*adminGuard['"]/);
    expect(source).toMatch(/isDiscordAdmin\(/);
    expect(source).toMatch(/\[['"]wallet['"],\s*['"]buy['"],\s*['"]sell['"]\]/);
  });
});
