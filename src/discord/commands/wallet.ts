import { SlashCommandBuilder, ChatInputCommandInteraction, InteractionEditReplyOptions } from 'discord.js';
import { sniperooService } from '../../services/sniperooService';

export const data = new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Manage your Sniperoo wallet')
    .addSubcommand(subcommand =>
        subcommand
            .setName('create')
            .setDescription('Create a new wallet'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('import')
            .setDescription('Import an existing wallet')
            .addStringOption(option =>
                option
                    .setName('private_key')
                    .setDescription('Your wallet private key')
                    .setRequired(true)));

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'create') {
            const wallet = await sniperooService.createWallet(interaction.user.id);
            if (wallet) {
                await interaction.editReply({
                    content: `✅ Wallet created successfully!\n\nPublic Key: \`${wallet.publicKey}\`\n\n⚠️ **IMPORTANT**: Save your private key securely! It will not be shown again.`
                });
            } else {
                await interaction.editReply('Failed to create wallet. Please try again.');
            }
        } else if (subcommand === 'import') {
            const privateKey = interaction.options.getString('private_key');
            if (!privateKey) {
                await interaction.editReply('Private key is required.');
                return;
            }

            const wallet = await sniperooService.importWallet(interaction.user.id, privateKey);
            if (wallet) {
                await interaction.editReply({
                    content: `✅ Wallet imported successfully!\n\nPublic Key: \`${wallet.publicKey}\``
                });
            } else {
                await interaction.editReply('Failed to import wallet. Please check your private key and try again.');
            }
        }
    } catch (error) {
        console.error('Wallet command error:', error);
        await interaction.editReply('An error occurred while processing your request.');
    }
} 
