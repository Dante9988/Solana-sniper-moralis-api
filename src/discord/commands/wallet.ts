import { SlashCommandBuilder, ChatInputCommandInteraction, InteractionEditReplyOptions } from 'discord.js';
import { sniperooService, isWalletData } from '../../services/sniperooService';

export const data = new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Manage your Sniperoo wallet')
    .addSubcommand(subcommand =>
        subcommand
            .setName('create')
            .setDescription('Create a new wallet')
            .addStringOption(option =>
                option
                    .setName('name')
                    .setDescription('Name for your new wallet')
                    .setRequired(true)))
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
            const name = interaction.options.getString('name', true);
            const result = await sniperooService.createWallet(interaction.user.id, name);
            
            if (isWalletData(result)) {
                await interaction.editReply({
                    content: `✅ Wallet "${name}" created successfully!\n\n` +
                        `⚠️ **CRITICAL SECURITY WARNING**\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `🔑 **Public Key:** \`${result.walletAddress}\`\n` +
                        `🔐 **Private Key:** ||${result.walletPk}||\n\n` +
                        `⚠️ **PLEASE READ CAREFULLY:**\n` +
                        `• Never share your private key with anyone\n` +
                        `• Store these details securely offline\n` +
                        `• This is the ONLY time you'll see the private key\n` +
                        `• Anyone with your private key can access your funds\n` +
                        `• For maximum security, store these details in a secure password manager\n\n` +
                        `💡 **Tip:** Take a screenshot or copy these details NOW!`
                });
            } else {
                await interaction.editReply({
                    content: `❌ ${result.error}`
                });
            }
        } else if (subcommand === 'import') {
            const privateKey = interaction.options.getString('private_key');
            if (!privateKey) {
                await interaction.editReply('Private key is required.');
                return;
            }

            const result = await sniperooService.importWallet(interaction.user.id, privateKey);
            if (isWalletData(result)) {
                await interaction.editReply({
                    content: `✅ Wallet imported successfully!\n\nPublic Key: \`${result.walletAddress}\``
                });
            } else {
                await interaction.editReply({
                    content: `❌ ${result.error}\nPlease try again or contact support if the issue persists.`
                });
            }
        }
    } catch (error) {
        console.error('Wallet command error:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
        await interaction.editReply({
            content: `❌ Error: ${errorMessage}\nPlease try again or contact support if the issue persists.`
        });
    }
} 
