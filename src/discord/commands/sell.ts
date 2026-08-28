import { AttachmentBuilder, ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { createSellIntent, SolanaPayConfigError } from '../../services/solanaPayService';
import { renderQrPng } from '../../services/qrCode';
import { isDiscordAdmin, NOT_ADMIN_MESSAGE } from '../adminGuard';

export const data = new SlashCommandBuilder()
    .setName('sell')
    .setDescription('Get a Solana Pay link to approve a sell in your own wallet')
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

    if (!isDiscordAdmin(interaction.user.id)) {
        await interaction.editReply(NOT_ADMIN_MESSAGE);
        return;
    }

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

        const { url } = createSellIntent(tokenAddress, percentage);
        const qr = await renderQrPng(url);

        await interaction.editReply({
            content:
                `💱 **Sell ${percentage}% of** \`${tokenAddress}\`\n\n` +
                `Open this link in your Solana wallet app or scan the QR code to review and approve — ` +
                `this bot never sees or holds your private key.\n\n${url}`,
            files: [new AttachmentBuilder(qr, { name: 'solana-pay.png' })],
        });
    } catch (error) {
        console.error('Sell command error:', error);
        if (error instanceof SolanaPayConfigError) {
            await interaction.editReply('This bot is not configured to accept trades right now (missing SOLANA_PAY_BASE_URL).');
            return;
        }
        await interaction.editReply(error instanceof Error ? error.message : 'An error occurred while processing your request.');
    }
}
