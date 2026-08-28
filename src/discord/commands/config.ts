import { SlashCommandBuilder, ChatInputCommandInteraction, InteractionEditReplyOptions } from 'discord.js';
import { jupiterService } from '../../services/jupiterService';
import { UserConfig } from '@prisma/client';

export const data = new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure your trading settings')
    .addSubcommand(subcommand =>
        subcommand
            .setName('view')
            .setDescription('View your current configuration'))
    .addSubcommand(subcommand =>
        subcommand
            .setName('set')
            .setDescription('Set your trading configuration')
            .addBooleanOption(option =>
                option
                    .setName('autobuy')
                    .setDescription('Enable/disable auto-buy on new pools')
                    .setRequired(false))
            .addNumberOption(option =>
                option
                    .setName('amount')
                    .setDescription('Amount of SOL to spend on buys')
                    .setRequired(false))
            .addNumberOption(option =>
                option
                    .setName('takeprofit')
                    .setDescription('Take profit percentage')
                    .setRequired(false))
            .addNumberOption(option =>
                option
                    .setName('stoploss')
                    .setDescription('Stop loss percentage')
                    .setRequired(false))
            .addBooleanOption(option =>
                option
                    .setName('autosell')
                    .setDescription('Enable/disable auto-sell')
                    .setRequired(false)));

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const subcommand = interaction.options.getSubcommand();

    try {
        if (subcommand === 'set') {
            const autoBuy = interaction.options.getBoolean('autobuy');
            const autoSell = interaction.options.getBoolean('autosell');
            const takeProfit = interaction.options.getNumber('takeprofit');
            const stopLoss = interaction.options.getNumber('stoploss');

            if (autoBuy === null || autoSell === null || takeProfit === null || stopLoss === null) {
                await interaction.editReply('All fields are required.');
                return;
            }

            const configUpdate: Partial<UserConfig> = {
                userId: interaction.user.id,
                autoBuy,
                autoSell,
                takeProfit,
                stopLoss,
                buyAmount: 0 // This will be set by the default value in the database
            };

            const success = await jupiterService.updateUserConfig(interaction.user.id, configUpdate);

            if (!success) {
                await interaction.editReply('Failed to update configuration. Please try again.');
                return;
            }

            const config = await jupiterService.getUserConfig(interaction.user.id);
            if (!config) {
                await interaction.editReply('Failed to retrieve updated configuration. Please try again.');
                return;
            }

            await interaction.editReply({
                content: `✅ Configuration updated successfully!\n\nAuto Buy: ${config.autoBuy ? '✅' : '❌'}\nAuto Sell: ${config.autoSell ? '✅' : '❌'}\nTake Profit: ${config.takeProfit}%\nStop Loss: ${config.stopLoss}%`
            });
        } else if (subcommand === 'view') {
            const config = await jupiterService.getUserConfig(interaction.user.id);
            if (!config) {
                await interaction.editReply('No configuration found. Use `/config set` to configure your settings.');
                return;
            }

            await interaction.editReply({
                content: `📊 Your Configuration:\n\nAuto Buy: ${config.autoBuy ? '✅' : '❌'}\nAuto Sell: ${config.autoSell ? '✅' : '❌'}\nTake Profit: ${config.takeProfit}%\nStop Loss: ${config.stopLoss}%`
            });
        }
    } catch (error) {
        console.error('Config command error:', error);
        await interaction.editReply('An error occurred while processing your request.');
    }
} 