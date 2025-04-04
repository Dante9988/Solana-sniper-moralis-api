import { Telegraf, Context } from 'telegraf';
import { buy } from './buy';
import { sell } from './sell';
import { wallet } from './wallet';
import { config } from './config';
import { togglePumpSwap } from './togglePumpSwap';
import { start } from './start';

export function registerCommands(bot: Telegraf): void {
  // Register command handlers
  bot.command('start', start);
  bot.command('buy', buy);
  bot.command('sell', sell);
  bot.command('wallet', wallet);
  bot.command('config', config);
  bot.command('togglepumpswap', togglePumpSwap);
} 