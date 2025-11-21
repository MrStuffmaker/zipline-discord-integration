import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import config from './config.json' assert { type: 'json' };

const commands = [
  new SlashCommandBuilder()
    .setName('zipline')
    .setDescription('Zipline Commands')
    .addSubcommand(sub =>
      sub.setName('settoken')
         .setDescription('Set your Zipline API token')
         .addStringOption(opt =>
            opt.setName('token').setDescription('Zipline API token').setRequired(true)
         )
    )
    .addSubcommand(sub => sub.setName('me').setDescription('Show your Zipline user info'))
    .addSubcommand(sub => sub.setName('list').setDescription('List your recent uploads'))
    .addSubcommand(sub =>
      sub.setName('upload')
         .setDescription('Upload a file to Zipline')
         .addAttachmentOption(opt =>
           opt.setName('file').setDescription('File to upload').setRequired(true)
         )
    )
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(config.discordToken);

(async () => {
  try {
    console.log('Registering commands...');
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands }
    );
    console.log('Commands registered successfully.');
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
})();
