import { REST, Routes } from 'discord.js';
import fs from 'fs';
import path from 'path';

/**
 * Registers all slash commands with the Discord API
 */
export async function registerCommands(clientId: string, token: string) {
  try {
    console.log('Started refreshing application (/) commands.');
    
    // Get all command files from the commands directory
    const commandsPath = path.join(__dirname, 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.ts') || file.endsWith('.js'));
    
    // Array to hold all command data
    const commands = [];
    
    // Loop through each command file
    for (const file of commandFiles) {
      // Import the command module
      const filePath = path.join(commandsPath, file);
      console.log(`Loading command from ${filePath}`);
      
      const command = require(filePath);
      
      // Check if it has the required properties
      if ('data' in command && 'execute' in command) {
        commands.push(command.data.toJSON());
        console.log(`Added command: ${command.data.name}`);
      } else {
        console.log(`The command at ${filePath} is missing required "data" or "execute" properties.`);
      }
    }
    
    // Initialize REST API client
    const rest = new REST({ version: '10' }).setToken(token);
    
    // Register commands with Discord API
    const result = await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands },
    );
    
    console.log(`Successfully reloaded ${Array.isArray(result) ? result.length : 0} application (/) commands.`);
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

/**
 * Handles the execution of commands when they are used
 */
export function setupCommandExecution(client: any) {
  const commandsPath = path.join(__dirname, 'commands');
  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.ts') || file.endsWith('.js'));
  
  // Create a collection to store commands
  const commands = new Map();
  
  // Load all commands
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    
    // Set a new item in the collection with the key as the command name and the value as the command module
    if ('data' in command && 'execute' in command) {
      commands.set(command.data.name, command);
      console.log(`Command loaded: ${command.data.name}`);
    } else {
      console.log(`The command at ${filePath} is missing required properties.`);
    }
  }
  
  // Set up interaction handling
  client.on('interactionCreate', async (interaction: any) => {
    if (!interaction.isChatInputCommand()) return;
    
    const command = commands.get(interaction.commandName);
    
    if (!command) {
      console.error(`No command matching ${interaction.commandName} was found.`);
      return;
    }
    
    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`Error executing command ${interaction.commandName}:`, error);
      
      // Reply with error message if the interaction can be replied to
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ 
          content: 'There was an error while executing this command!', 
          ephemeral: true 
        });
      } else {
        await interaction.reply({ 
          content: 'There was an error while executing this command!', 
          ephemeral: true 
        });
      }
    }
  });
} 