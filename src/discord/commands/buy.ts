import { CommandInteraction, SlashCommandBuilder, ChatInputCommandInteraction, InteractionEditReplyOptions } from 'discord.js';
import { sniperooService } from '../../services/sniperooService';

export const data = new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Buy a token using Sniperoo')
    .addStringOption(option =>
        option
            .setName('token')
            .setDescription('Token address to buy')
            .setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const tokenAddress = interaction.options.getString('token');
        if (!tokenAddress) {
            await interaction.editReply('Token address is required.');
            return;
        }

        const success = await sniperooService.buyToken(
            tokenAddress,
            interaction.user.id
        );

        if (success) {
            const config = await sniperooService.getUserConfig(interaction.user.id);
            if (!config) {
                await interaction.editReply('Failed to get user configuration.');
                return;
            }

            await interaction.editReply({
                content: `✅ Buy order placed successfully!\n\n` +
                    `Token: \`${tokenAddress}\`\n` +
                    `Amount: ${config.buyAmount} SOL\n` +
                    `Auto-sell: ${config.autoSell ? 'Enabled' : 'Disabled'}\n` +
                    `Take Profit: ${config.takeProfit}%\n` +
                    `Stop Loss: ${config.stopLoss}%`
            });
        } else {
            await interaction.editReply('Failed to place buy order. Please try again.');
        }
    } catch (error) {
        console.error('Buy command error:', error);
        await interaction.editReply('An error occurred while processing your request.');
    }
} 