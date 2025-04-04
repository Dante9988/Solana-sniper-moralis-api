import { Context } from 'telegraf';
import { PrismaClient } from '@prisma/client';

// Create a Prisma client instance
const prisma = new PrismaClient();

// Interface for user preferences
interface UserPreference {
  userId: string;
  pumpSwapEnabled: boolean;
}

export async function togglePumpSwap(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id.toString();
    
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
    }

    // Toggle the current setting
    const newSetting = !userPreference.pumpSwapEnabled;
    
    // Update the user preference
    await prisma.userPreference.update({
      where: { userId },
      data: { pumpSwapEnabled: newSetting }
    });

    // Send confirmation message
    await ctx.reply(
      `✅ PumpSwap notifications ${newSetting ? 'enabled' : 'disabled'} successfully!\n\n` +
      `You will ${newSetting ? 'now' : 'no longer'} receive notifications for new PumpSwap tokens.`
    );
  } catch (error) {
    console.error('Toggle PumpSwap command error:', error);
    await ctx.reply('❌ An error occurred while processing your request.');
  }
} 