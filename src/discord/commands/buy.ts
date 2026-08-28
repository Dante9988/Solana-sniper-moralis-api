import { AttachmentBuilder, ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { jupiterService } from '../../services/jupiterService';
import { createBuyIntent, SolanaPayConfigError } from '../../services/solanaPayService';
import { renderQrPng } from '../../services/qrCode';
import { isDiscordAdmin, NOT_ADMIN_MESSAGE } from '../adminGuard';

export const data = new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Get a Solana Pay link to approve a buy in your own wallet')
    .addStringOption(option =>
        option
            .setName('token')
            .setDescription('Token address to buy')
            .setRequired(true))
    .addNumberOption(option =>
        option
            .setName('amount')
            .setDescription('Amount of SOL to spend (defaults to your configured buy amount)')
            .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    if (!isDiscordAdmin(interaction.user.id)) {
        await interaction.editReply(NOT_ADMIN_MESSAGE);
        return;
    }

    try {
        const tokenAddress = interaction.options.getString('token');
        if (!tokenAddress) {
            await interaction.editReply('Token address is required.');
            return;
        }

        let solAmount = interaction.options.getNumber('amount');
        if (!solAmount || solAmount <= 0) {
            const userConfig = await jupiterService.getUserConfig(interaction.user.id);
            if (!userConfig) {
                await interaction.editReply('No configuration found and no amount given. Provide an amount, or set a default with `/config set`.');
                return;
            }
            solAmount = userConfig.buyAmount;
        }

        const { url } = createBuyIntent(tokenAddress, solAmount);
        const qr = await renderQrPng(url);

        await interaction.editReply({
            content:
                `💰 **Buy ${solAmount} SOL of** \`${tokenAddress}\`\n\n` +
                `Open this link in your Solana wallet app or scan the QR code to review and approve — ` +
                `this bot never sees or holds your private key.\n\n${url}`,
            files: [new AttachmentBuilder(qr, { name: 'solana-pay.png' })],
        });
    } catch (error) {
        console.error('Buy command error:', error);
        if (error instanceof SolanaPayConfigError) {
            await interaction.editReply('This bot is not configured to accept trades right now (missing SOLANA_PAY_BASE_URL).');
            return;
        }
        await interaction.editReply(error instanceof Error ? error.message : 'An error occurred while processing your request.');
    }
}
