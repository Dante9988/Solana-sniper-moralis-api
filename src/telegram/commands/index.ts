import { Telegraf, Context } from 'telegraf';
import { buy } from './buy';
import { sell } from './sell';
import { wallet } from './wallet';
import { config } from './config';
import { togglePumpSwap } from './togglePumpSwap';
import { toggleJito } from './toggleJito';
import { start } from './start';
import { pumpSettings } from './pumpSettings';
import { service } from './service';
import { toggleChannel } from './toggleChannel';
import { getChannelId } from './get-channel-id';
import { testChannel } from './test-channel';
import { Message } from 'telegraf/typings/core/types/typegram';

export function registerCommands(bot: Telegraf): void {
  // Register command handlers
  bot.command('start', start);
  bot.command('buy', buy);
  bot.command('sell', sell);
  bot.command('wallet', wallet);
  bot.command('config', config);
  bot.command('togglepumpswap', togglePumpSwap);
  bot.command('togglejito', toggleJito);
  bot.command('pumpsettings', pumpSettings);
  bot.command('service', service);
  bot.command('togglechannel', toggleChannel);
  bot.command('getchannelid', getChannelId);
  bot.command('testchannel', testChannel);
  
  // Special handler for channel posts which might not trigger regular command handlers
  bot.on('channel_post', (ctx) => {
    const message = ctx.channelPost as Message.TextMessage;
    if (message && message.text && message.text.startsWith('/togglechannel')) {
      console.log("Caught togglechannel command from channel post");
      return toggleChannel(ctx);
    }
  });
} 