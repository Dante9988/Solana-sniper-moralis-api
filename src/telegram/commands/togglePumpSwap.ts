import { Context } from 'telegraf';
import { PrismaClient } from '@prisma/client';

// Create a Prisma client instance
const prisma = new PrismaClient();

export async function togglePumpSwap(ctx: Context): Promise<void> {
  try {
    const userId = String(ctx.from?.id);
    console.log(`[TogglePumpSwap] Command received from user: ${userId}`);
    
    if (!userId) {
      await ctx.reply('❌ Failed to identify user.');
      return;
    }

    // Get current user preference or create default
    let userPreference = await prisma.userPreference.findUnique({
      where: { userId }
    });

    // If no preference exists, create default (PumpSwap enabled)
    if (!userPreference) {
      userPreference = await prisma.userPreference.create({
        data: {
          userId,
          pumpSwapEnabled: true
        }
      });
      console.log(`[TogglePumpSwap] Created new user preference for user: ${userId}, pumpSwapEnabled: true`);
    }

    // Toggle the current setting
    const newSetting = !userPreference.pumpSwapEnabled;
    
    // Update the user preference
    await prisma.userPreference.update({
      where: { userId },
      data: { pumpSwapEnabled: newSetting }
    });
    console.log(`[TogglePumpSwap] Updated user preference for user: ${userId}, pumpSwapEnabled: ${newSetting}`);

    // Send confirmation message
    await ctx.reply(
      `✅ PumpSwap notifications ${newSetting ? 'enabled' : 'disabled'} successfully!\n\n` +
      `You will ${newSetting ? 'now' : 'no longer'} receive notifications for new PumpSwap tokens.`
    );
    console.log(`[TogglePumpSwap] Success reply sent to user: ${userId}`);
  } catch (error) {
    console.error(`[TogglePumpSwap] Error processing command:`, error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
} 
