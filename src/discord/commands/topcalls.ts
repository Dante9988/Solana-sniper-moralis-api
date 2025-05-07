import { SlashCommandBuilder } from '@discordjs/builders';
import { CommandInteraction, PermissionsBitField } from 'discord.js';
import { triggerTopTokensReport } from '../../services/dailyTopTokensService';
import { telegramBot } from '../../telegram/telegramBot';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('topcalls')
    .setDescription('Generate and send the daily top tokens report')
    .addIntegerOption(option => 
      option.setName('limit')
        .setDescription('Number of top tokens to include (default: 5)')
        .setRequired(false)
        .setMinValue(3)
        .setMaxValue(10)),

  async execute(interaction: CommandInteraction) {
    // Only allow admins to run this command
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.reply({
        content: 'You need administrator permission to use this command.',
        ephemeral: true
      });
      return;
    }
    
    try {
      // Defer the reply since this might take time
      await interaction.deferReply();
      
      // Get the limit option if provided (default to 5)
      const limit = interaction.options.get('limit')?.value as number || 5;
      
      await interaction.editReply(`🔄 Generating top ${limit} tokens report... Please wait.`);
      
      // Trigger the report with the provided limit
      await triggerTopTokensReport(interaction.client, telegramBot, limit);
      
      // Let the user know it was successful
      await interaction.editReply(`✅ Top ${limit} tokens report generated and sent to the configured channels!`);
    } catch (error) {
      console.error('Error executing topcalls command:', error);
      await interaction.editReply('❌ Failed to generate the top tokens report. Check logs for details.');
    }
  },
}; 