/**
 * Restricts trading-adjacent Discord commands to an explicit allowlist
 * (see ARCHITECTURE.md §8.6). Fails CLOSED: if DISCORD_ADMIN_IDS is unset
 * or empty, nobody is allowed — mirrors src/telegram/adminGuard.ts.
 */

export function getDiscordAdminIds(): string[] {
  return (process.env.DISCORD_ADMIN_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export function isDiscordAdmin(userId: string | undefined): boolean {
  if (!userId) return false;
  const admins = getDiscordAdminIds();
  return admins.length > 0 && admins.includes(userId);
}

export const NOT_ADMIN_MESSAGE =
  '🔒 This command is restricted to allowlisted users. Ask the bot operator to add your Discord user ID to DISCORD_ADMIN_IDS.';
