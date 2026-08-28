/**
 * Restricts trading-adjacent Telegram commands to an explicit allowlist
 * (see ARCHITECTURE.md §8.6). Fails CLOSED: if TELEGRAM_ADMIN_IDS is unset
 * or empty, nobody is allowed — this bot is meant for personal/allowlisted
 * use, not public trading, and an unset allowlist should not silently mean
 * "everyone."
 */

export function getTelegramAdminIds(): string[] {
  return (process.env.TELEGRAM_ADMIN_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export function isTelegramAdmin(userId: string | undefined): boolean {
  if (!userId) return false;
  const admins = getTelegramAdminIds();
  return admins.length > 0 && admins.includes(userId);
}

export const NOT_ADMIN_MESSAGE =
  '🔒 This command is restricted to allowlisted users. Ask the bot operator to add your Telegram user ID to TELEGRAM_ADMIN_IDS.';
