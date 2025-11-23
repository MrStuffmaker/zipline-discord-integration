import {
  Client,
  GatewayIntentBits,
  WebhookClient,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import FormData from 'form-data';
import chalk from 'chalk';
import os from 'os';

// Config and constants
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const ZIPLINE_BASE_URL = config.ziplineBaseUrl;

const DATA_DIR = './data';
const TOKENS_FILE = path.join(DATA_DIR, 'userTokens.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'userSettings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(TOKENS_FILE)) fs.writeFileSync(TOKENS_FILE, '{}');
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}');

let userTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
let userSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));

const webhook = config.errorWebhookUrl ? new WebhookClient({ url: config.errorWebhookUrl }) : null;

// Logging functions
function logInfo(msg) { console.log(chalk.blue('[INFO]'), msg); }
function logSuccess(msg) { console.log(chalk.green('[SUCCESS]'), msg); }
function logWarn(msg) { console.log(chalk.yellow('[WARN]'), msg); }
function logError(error, ctx = '') {
  console.error(chalk.red('[ERROR]'), ctx);
  if (error instanceof Error) console.error(chalk.red(error.stack));
  else console.error(chalk.red(error));
  if (webhook) {
    webhook.send({
      content: `❌ Error in ${ctx}\n\`\`\`${error.stack || error.message || error}\`\`\``
    }).catch(console.error);
  }
}

// Token and settings management
function saveTokens() { fs.writeFileSync(TOKENS_FILE, JSON.stringify(userTokens, null, 2)); }
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings, null, 2)); }

function getUserToken(userId) { return userTokens[userId] || null; }
function setUserToken(userId, token) { userTokens[userId] = token; saveTokens(); }
function deleteUserToken(userId) { delete userTokens[userId]; saveTokens(); }

function getUserSettings(userId) {
  return userSettings[userId] || { expiry: null, compression: null };
}

function setUserSettings(userId, settings) {
  userSettings[userId] = {
    expiry: settings.expiry?.trim() || null,
    compression: settings.compression?.trim() || null
  };
  saveSettings();
}

// User info API
async function ziplineGetMe(token) {
  const res = await fetch(`${ZIPLINE_BASE_URL}/api/user`, {
    headers: { Authorization: token }
  });
  if (!res.ok) throw new Error(`Zipline /api/user error ${res.status}`);
  return res.json();
}

// Fetch one page of uploads
async function ziplineFetchUserUploads(token, page = 1, perpage = 50) {
  const url = `${ZIPLINE_BASE_URL}/api/user/files?page=${page}&perpage=${perpage}&sortBy=createdAt&order=desc&filter=all`;
  const res = await fetch(url, { headers: { Authorization: token } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zipline /api/user/files error ${res.status}: ${text}`);
  return JSON.parse(text);
}

// Fetch all uploads
async function ziplineFetchAllUserUploads(token) {
  let allUploads = [];
  let page = 1;
  const perpage = 50;

  while (true) {
    const resp = await ziplineFetchUserUploads(token, page, perpage);
    if (!resp.page || resp.page.length === 0) break;
    allUploads.push(...resp.page);
    if (page >= resp.pages) break;
    page++;
  }
  return allUploads;
}

// Upload file (with user settings)
async function ziplineUploadFromUrl(token, fileUrl, filename, userId) {
  const settings = getUserSettings(userId);

  const tmpPath = path.join('./', `tmp_${Date.now()}_${filename}`);
  const dlRes = await fetch(fileUrl);
  if (!dlRes.ok) throw new Error('Failed to download attachment');

  const fileStream = fs.createWriteStream(tmpPath);
  await new Promise((res, rej) => {
    dlRes.body.pipe(fileStream);
    dlRes.body.on('error', rej);
    fileStream.on('finish', res);
  });

  const form = new FormData();
  form.append('file', fs.createReadStream(tmpPath));

  const headers = {
    Authorization: token,
    ...form.getHeaders()
  };

  // Apply expiry header if set
  if (settings.expiry && settings.expiry !== '') {
    headers['x-zipline-deletes-at'] = settings.expiry;
  }

  // Apply compression header if needed
  if (settings.compression && settings.compression !== '') {
    headers['x-zipline-compression'] = settings.compression;
  }

  const resUpload = await fetch(`${ZIPLINE_BASE_URL}/api/upload`, {
    method: 'POST',
    headers,
    body: form
  });

  fs.unlinkSync(tmpPath);
  if (!resUpload.ok) throw new Error(`Zipline upload error ${resUpload.status}`);

  return resUpload.json();
}

const commands = [
  new SlashCommandBuilder()
    .setName('zipline')
    .setDescription('Zipline commands')
    .addSubcommand(sub =>
      sub.setName('settoken')
        .setDescription('Set your Zipline API token')
        .addStringOption(opt => opt.setName('token').setDescription('Your token').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('me').setDescription('Show your account info'))
    .addSubcommand(sub => sub.setName('list').setDescription('List your uploads'))
    .addSubcommand(sub =>
      sub.setName('upload')
        .setDescription('Upload a file')
        .addAttachmentOption(opt => opt.setName('file').setDescription('File to upload').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('settings')
        .setDescription('Set default expiry & compression')
        .addStringOption(opt => opt.setName('expiry').setDescription('Expiry in days or date').setRequired(false))
        .addStringOption(opt => opt.setName('compression').setDescription('Compression level').setRequired(false))
    )
    .addSubcommand(sub => sub.setName('logout').setDescription('Delete token (logout)'))
    .addSubcommand(sub => sub.setName('invite').setDescription('Show bot invite link'))
    .addSubcommand(sub => sub.setName('about').setDescription('Info about the bot and its commands'))
    .addSubcommand(sub =>
      sub.setName('stats')
        .setDescription('Show host/server resource usage, Zipline stats, and your storage usage')
    )
    .toJSON()
];

async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  try {
    logInfo('Registering global slash commands...');
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    logSuccess('Slash commands registered successfully.');
  } catch (err) {
    logError(err, 'Registering slash commands');
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  logSuccess(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    status: 'online',
    activities: [{
      name: 'www.stuffmaker.net',
      type: 4
    }]
  });
});

async function paginateUploads(interaction, uploads) {
  const pageSize = 5;
  let page = 0;
  const totalPages = Math.ceil(uploads.length / pageSize);

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return 'unknown';
    const kb = 1024;
    const mb = kb * 1024;
    if (bytes < mb) return `${(bytes / kb).toFixed(1)} KB`;
    return `${(bytes / mb).toFixed(2)} MB`;
  }

  function createEmbed() {
    const embed = new EmbedBuilder()
      .setTitle('Your Uploads')
      .setFooter({ text: `Page ${page + 1} of ${totalPages}` });
    const slice = uploads.slice(page * pageSize, (page + 1) * pageSize);

    function trimString(str, maxLength = 15) {
      if (!str) return '';
      return str.length > maxLength ? str.slice(0, maxLength - 1) + '…' : str;
    }

    const descriptionLines = slice.map(f => {
      const name = trimString(f.originalName || f.name || 'Unnamed', 15);
      const url = f.url && f.url.startsWith('http') ? f.url : `${ZIPLINE_BASE_URL}${f.url || `/u/${f.id}`}`;
      const sizeStr = formatFileSize(f.size);
      const createdTimestamp = f.createdAt ? Math.floor(new Date(f.createdAt).getTime() / 1000) : null;
      const createdDiscordTime = createdTimestamp ? `<t:${createdTimestamp}:R>` : 'unknown';
      return `• [${name}](${url}) — ${sizeStr} — Created: ${createdDiscordTime}`;
    });

    embed.setDescription(descriptionLines.join('\n'));
    return embed;
  }

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('prev')
        .setLabel('⬅️ Back')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId('next')
        .setLabel('➡️ Next')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page + 1 === totalPages)
    );

  const message = await interaction.reply({
    embeds: [createEmbed()],
    components: [row],
    ephemeral: true,
    fetchReply: true
  });

  const collector = message.createMessageComponentCollector({ time: 60000 });

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) {
      i.reply({ content: 'Only you can navigate pages!', ephemeral: true });
      return;
    }
    if (i.customId === 'prev' && page > 0) page--;
    if (i.customId === 'next' && page < totalPages - 1) page++;

    await i.update({
      embeds: [createEmbed()],
      components: [
        new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('prev')
              .setLabel('⬅️ Back')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(page === 0),
            new ButtonBuilder()
              .setCustomId('next')
              .setLabel('➡️ Next')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(page + 1 === totalPages)
          )
      ]
    });
  });

  collector.on('end', () => {
    message.edit({ components: [] }).catch(() => { });
  });
}

// Helper: get human-readable OS name
function getReadableOSName() {
  const platform = os.platform();
  const release = os.release();

  if (platform === 'win32') {
    if (release.startsWith('10.0')) return 'Windows Server 2016/2019/2022';
    if (release.startsWith('6.3')) return 'Windows Server 2012 R2';
    if (release.startsWith('6.2')) return 'Windows Server 2012';
    if (release.startsWith('6.1')) return 'Windows Server 2008 R2';
    return `Windows (Release ${release})`;
  }

  if (platform === 'linux') {
    try {
      const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
      const match = osRelease.match(/^PRETTY_NAME="(.+)"$/m);
      if (match) return match[1];
    } catch {
    }
    return `Linux kernel ${release}`;
  }

  if (platform === 'darwin') {
    return 'macOS ' + release;
  }

  return `${platform} ${release}`;
}

// Zipline stats API
async function ziplineGetStats() {
  const res = await fetch(`${ZIPLINE_BASE_URL}/api/stats`);
  if (!res.ok) throw new Error(`Zipline /api/stats error ${res.status}`);
  return res.json();
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'zipline') return;

  const userId = interaction.user.id;

  try {
    const sub = interaction.options.getSubcommand(true);

    if (sub === 'settoken') {
      const token = interaction.options.getString('token', true);
      setUserToken(userId, token);
      await interaction.reply({ content: '🔐 Token saved!', ephemeral: true });
      return;
    }

    if (sub === 'logout') {
      deleteUserToken(userId);
      await interaction.reply({ content: '🚪 You have been logged out.', ephemeral: true });
      return;
    }

    if (sub === 'invite') {
      const inviteLink = `https://discord.com/oauth2/authorize?client_id=${config.clientId}`;
      await interaction.reply({ content: `🤖 Invite me using this link:\n${inviteLink}`, ephemeral: true });
      return;
    }

    if (sub === 'about') {
      const commandsList = [
        'settoken 🔐 `/zipline settoken <token>`',
        'logout 🚪 `/zipline logout`',
        'me 👤 `/zipline me`',
        'list 📂 `/zipline list`',
        'upload 📤 `/zipline upload <file>`',
        'settings ⚙️ `/zipline settings [expiry] [compression]`',
        'invite 🤖 `/zipline invite`',
        'about ℹ️ `/zipline about`',
        'stats 📊 `/zipline stats`'
      ].join('\n');

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setLabel('Support').setStyle(ButtonStyle.Link).setURL('https://discord.gg/support').setEmoji('🆘'),
          new ButtonBuilder().setLabel('GitHub').setStyle(ButtonStyle.Link).setURL('https://github.com/yourrepo').setEmoji('🐙')
        );

      await interaction.reply({ content: `💡 **About the Bot**\n\n${commandsList}`, components: [row], ephemeral: true });
      return;
    }

    const token = getUserToken(userId);
    if (!token) {
      await interaction.reply({ content: '❗ Please set your token first using /zipline settoken.', ephemeral: true });
      return;
    }

    if (sub === 'me') {
      await interaction.deferReply({ ephemeral: true });
      const data = await ziplineGetMe(token);
      await interaction.editReply(`**Username:** ${data.username}\n**Role:** ${data.role}\nStorage: ${data.quota?.used || 0}/${data.quota?.max || '∞'}`);
      return;
    }

    if (sub === 'list') {
      const uploads = await ziplineFetchAllUserUploads(token);
      if (!uploads.length) {
        await interaction.reply({ content: 'No uploads found.', ephemeral: true });
        return;
      }
      await paginateUploads(interaction, uploads);
      return;
    }

    if (sub === 'upload') {
      const attachment = interaction.options.getAttachment('file', true);
      await interaction.deferReply({ ephemeral: true });
      const uploadResp = await ziplineUploadFromUrl(token, attachment.url, attachment.name, userId);
      const urls = (uploadResp.files || []).map(f => f.url || `${ZIPLINE_BASE_URL}/u/${f.id}`).join('\n');
      await interaction.editReply(`✅ Upload successful:\n${urls}`);
      return;
    }

    if (sub === 'settings') {
      const expiry = interaction.options.getString('expiry');
      const compression = interaction.options.getString('compression');
      setUserSettings(userId, { expiry, compression });
      await interaction.reply({ content: '🛠 Settings saved.', ephemeral: true });
      return;
    }

    if (sub === 'stats') {
      await interaction.deferReply({ ephemeral: true });

      // Host system stats
      const hostStats = {
        os: getReadableOSName(),
        uptime: os.uptime(),
        loadAvg: os.loadavg(),
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        usedMem: process.memoryUsage().rss,
        cpuCount: os.cpus().length
      };

      // Zipline stats
      let zipStats;
      try {
        zipStats = await ziplineGetStats();
      } catch (err) {
        zipStats = { error: 'Unavailable' };
      }

      // User stats
      let userMe;
      try {
        userMe = await ziplineGetMe(token);
      } catch (err) {
        userMe = { username: 'Unknown', quota: { used: 0, max: 0 } };
      }

      const content = [
        `**Host System**`,
        `• OS: ${hostStats.os}`,
        `• Uptime: ${(hostStats.uptime / 3600).toFixed(2)} hours`,
        `• CPUs: ${hostStats.cpuCount}`,
        `• Load Avg (1m): ${hostStats.loadAvg[0].toFixed(2)}`,
        `• RAM used: ${(hostStats.usedMem / (1024 ** 2)).toFixed(2)} MB`,
        `• RAM free: ${(hostStats.freeMem / (1024 ** 2)).toFixed(2)} MB`,
        ``,
        `**Zipline Stats**`,
        zipStats.error
          ? `• Error: ${zipStats.error}`
          : [
            `• Users: ${zipStats.users ?? '?'}`,
            `• Files: ${zipStats.files ?? '?'}`,
            `• Total Size: ${zipStats.size ? (zipStats.size / (1024 ** 3)).toFixed(2) + " GB" : '?'}`,
          ].join('\n'),
        ``,
        `**Your Storage**`,
        `• Username: ${userMe.username ?? '?'}`,
        `• Used: ${((userMe.quota?.used ?? 0) / (1024 ** 2)).toFixed(2)} MB`,
        `• Max: ${userMe.quota?.max ? ((userMe.quota.max) / (1024 ** 2)).toFixed(2) + " MB" : '∞'}`
      ].join('\n');

      await interaction.editReply({ content });
      return;
    }
  } catch (error) {
    logError(error, 'InteractionHandler');
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('❌ An error occurred.');
    } else {
      await interaction.reply({ content: '❌ An error occurred.', ephemeral: true });
    }
  }
});

deployCommands().then(() => client.login(config.discordToken));
