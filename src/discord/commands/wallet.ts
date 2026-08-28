import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { jupiterService } from '../../services/jupiterService';
import { isDiscordAdmin, NOT_ADMIN_MESSAGE } from '../adminGuard';

export const data = new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Connect your wallet (public address only — never a private key)')
    .addSubcommand(subcommand =>
        subcommand
            .setName('connect')
            .setDescription('Connect your wallet\'s public address')
            .addStringOption(option =>
                option
                    .setName('address')
                    .setDescription('Your wallet\'s public address')
                    .setRequired(true)))
    .addSubcommand(subcommand =>
        subcommand
            .setName('disconnect')
            .setDescription('Forget your connected wallet address'));

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    if (!isDiscordAdmin(interaction.user.id)) {
        await interaction.editReply(NOT_ADMIN_MESSAGE);
        return;
    }

    try {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'connect') {
            const address = interaction.options.getString('address', true);
            const result = await jupiterService.connectWallet(interaction.user.id, address);

            if ('error' in result) {
                await interaction.editReply({ content: `❌ ${result.error}` });
                return;
            }

            await interaction.editReply({
                content:
                    `✅ Wallet connected.\n\nAddress: \`${result.walletAddress}\`\n\n` +
                    `This only lets the bot show your balance/positions — it never grants signing access. ` +
                    `Every /buy or /sell still requires you to approve the transaction yourself in your own wallet app.`
            });
        } else if (subcommand === 'disconnect') {
            await jupiterService.disconnectWallet(interaction.user.id);
            await interaction.editReply({
                content: '✅ Wallet disconnected. This only forgot your public address — the bot never held signing access to begin with.'
            });
        }
    } catch (error) {
        console.error('Wallet command error:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
        await interaction.editReply({ content: `❌ Error: ${errorMessage}` });
    }
}
