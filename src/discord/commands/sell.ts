import { SlashCommandBuilder, ChatInputCommandInteraction, InteractionEditReplyOptions } from 'discord.js';
import { sniperooService } from '../../services/sniperooService';

export const data = new SlashCommandBuilder()
    .setName('sell')
    .setDescription('Sell a token using Sniperoo')
    .addStringOption(option =>
        option
            .setName('token')
            .setDescription('Token address to sell')
            .setRequired(true))
    .addNumberOption(option =>
        option
            .setName('percentage')
            .setDescription('Percentage of tokens to sell (1-100)')
            .setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const tokenAddress = interaction.options.getString('token');
        const percentage = interaction.options.getNumber('percentage');

        if (!tokenAddress || !percentage) {
            await interaction.editReply('Token address and percentage are required.');
            return;
        }

        if (percentage < 1 || percentage > 100) {
            await interaction.editReply('Percentage must be between 1 and 100.');
            return;
        }

        const success = await sniperooService.sellToken(
            tokenAddress,
            percentage,
            interaction.user.id
        );

        if (success) {
            await interaction.editReply({
                content: `✅ Sell order placed successfully!\n\nToken: \`${tokenAddress}\`\nPercentage: ${percentage}%`
            });
        } else {
            await interaction.editReply('Failed to place sell order. Please try again.');
        }
    } catch (error) {
        console.error('Sell command error:', error);
        await interaction.editReply('An error occurred while processing your request.');
    }
} 