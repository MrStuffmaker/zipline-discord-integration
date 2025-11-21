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

// Logging Funktionen
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

// Token und Settings speichern
function saveTokens() { fs.writeFileSync(TOKENS_FILE, JSON.stringify(userTokens, null, 2)); }
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings, null, 2)); }

function getUserToken(userId) { return userTokens[userId] || null; }
function setUserToken(userId, token) { userTokens[userId] = token; saveTokens(); }
function deleteUserToken(userId) { delete userTokens[userId]; saveTokens(); }

function getUserSettings(userId) { return userSettings[userId] || { expiry: null, compression: null }; }
function setUserSettings(userId, settings) { userSettings[userId] = settings; saveSettings(); }

// User Info API
async function ziplineGetMe(token) {
  const res = await fetch(`${ZIPLINE_BASE_URL}/api/user`, {
    headers: { Authorization: token }
  });
  if (!res.ok) throw new Error(`Zipline /api/user error ${res.status}`);
  return res.json();
}

// Einzelne Seite mit Dateien abrufen
async function ziplineFetchUserUploads(token, page = 1, perpage = 50) {
  const url = `${ZIPLINE_BASE_URL}/api/user/files?page=${page}&perpage=${perpage}&sortBy=createdAt&order=desc&filter=all`;
  const res = await fetch(url, { headers: { Authorization: token } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zipline /api/user/files error ${res.status}: ${text}`);
  return JSON.parse(text);
}

// Alle Seiten und Dateien sammeln
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

// Datei hochladen mit Settings
async function ziplineUploadFromUrl(token, fileUrl, filename, userId) {
  const settings = getUserSettings(userId);
  const params = new URLSearchParams();
  if (settings.expiry) params.append('expiry', settings.expiry);
  if (settings.compression) params.append('compression', settings.compression);
  const uploadUrl = params.toString() ? `${ZIPLINE_BASE_URL}/api/upload?${params.toString()}` : `${ZIPLINE_BASE_URL}/api/upload`;

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

  const resUpload = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: token },
    body: form
  });

  fs.unlinkSync(tmpPath);

  if (!resUpload.ok) throw new Error(`Zipline upload error ${resUpload.status}`);

  return resUpload.json();
}


const commands = [
  new SlashCommandBuilder()
    .setName('zipline')
    .setDescription('Zipline Befehle')
    .addSubcommand(sub =>
      sub.setName('settoken')
        .setDescription('Setze deinen Zipline API Token')
        .addStringOption(opt => opt.setName('token').setDescription('Dein Token').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('me').setDescription('Zeige deine Benutzerdaten'))
    .addSubcommand(sub => sub.setName('list').setDescription('Zeige deine Uploads'))
    .addSubcommand(sub =>
      sub.setName('upload')
        .setDescription('Lade eine Datei hoch')
        .addAttachmentOption(opt => opt.setName('file').setDescription('Datei hochladen').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('settings')
        .setDescription('Setze Standard Ablauf & Kompression')
        .addStringOption(opt => opt.setName('expiry').setDescription('Expiry in Tagen').setRequired(false))
        .addStringOption(opt => opt.setName('compression').setDescription('Kompressionsstufe').setRequired(false))
    )
    .addSubcommand(sub => sub.setName('logout').setDescription('Token löschen (Logout)'))
    .addSubcommand(sub => sub.setName('invite').setDescription('Bot Einladungslink anzeigen'))
    .addSubcommand(sub => sub.setName('about').setDescription('Über den Bot mit Commands'))
    .toJSON()
];

async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  try {
    logInfo('Slash-Befehle werden global registriert...');
    await rest.put(
      Routes.applicationCommands(config.clientId),
      { body: commands }
    );
    logSuccess('Slash-Befehle erfolgreich registriert.');
  } catch (err) {
    logError(err, 'Registrierung Slash-Befehle');
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  logSuccess(`Eingeloggt als ${client.user.tag}`);
});

async function paginateUploads(interaction, uploads) {
  const pageSize = 5;
  let page = 0;
  const totalPages = Math.ceil(uploads.length / pageSize);

  function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return 'unbekannt';
  const kb = 1024;
  const mb = kb * 1024;
  if (bytes < mb) return `${(bytes / kb).toFixed(1)} KB`;
  return `${(bytes / mb).toFixed(2)} MB`;
}

function createEmbed() {
  const embed = new EmbedBuilder()
    .setTitle('Deine Uploads')
    .setFooter({ text: `Seite ${page + 1} von ${totalPages}` });
  const slice = uploads.slice(page * pageSize, (page + 1) * pageSize);

  function trimString(str, maxLength = 15) {
  if (!str) return '';
  return str.length > maxLength ? str.slice(0, maxLength - 1) + '…' : str;
}
const descriptionLines = slice.map(f => {
const name = trimString(f.originalName || f.name || 'Unbenannt', 15);
  const url = f.url && f.url.startsWith('http') ? f.url : `${ZIPLINE_BASE_URL}${f.url || `/u/${f.id}`}`;
  const sizeStr = formatFileSize(f.size);
  const createdTimestamp = f.createdAt ? Math.floor(new Date(f.createdAt).getTime() / 1000) : null;
  const createdDiscordTime = createdTimestamp ? `<t:${createdTimestamp}:R>` : 'unbekannt';
  return `• [${name}](${url}) — ${sizeStr} — Erstellt: ${createdDiscordTime}`;
});



  embed.setDescription(descriptionLines.join('\n'));

  return embed;
}

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('prev')
        .setLabel('⬅️ Zurück')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId('next')
        .setLabel('➡️ Weiter')
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
      i.reply({ content: 'Nur du kannst die Seiten wechseln!', ephemeral: true });
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
              .setLabel('⬅️ Zurück')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(page === 0),
            new ButtonBuilder()
              .setCustomId('next')
              .setLabel('➡️ Weiter')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(page + 1 === totalPages)
          )
      ]
    });
  });

  collector.on('end', () => {
    message.edit({ components: [] }).catch(() => {});
  });
}


client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'zipline') return;

  const userId = interaction.user.id;

  try {
    const sub = interaction.options.getSubcommand(true);

    if (sub === 'settoken') {
      const token = interaction.options.getString('token', true);
      setUserToken(userId, token);
      await interaction.reply({ content: '🔐 Token gespeichert!', ephemeral: true });
      return;
    }

    if (sub === 'logout') {
      deleteUserToken(userId);
      await interaction.reply({ content: '🚪 Du wurdest ausgeloggt.', ephemeral: true });
      return;
    }

    if (sub === 'invite') {
      const inviteLink = `https://discord.com/oauth2/authorize?client_id=${config.clientId}&permissions=277025725920&scope=bot%20applications.commands`;
      await interaction.reply({ content: `🤖 Lade mich ein:\n${inviteLink}`, ephemeral: true });
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
      ].join('\n');

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setLabel('Support').setStyle(ButtonStyle.Link).setURL('https://discord.gg/support').setEmoji('🆘'),
          new ButtonBuilder().setLabel('GitHub').setStyle(ButtonStyle.Link).setURL('https://github.com/yourrepo').setEmoji('🐙')
        );

      await interaction.reply({ content: `💡 **Über den Bot**\n\n${commandsList}`, components: [row], ephemeral: true });
      return;
    }

    const token = getUserToken(userId);
    if (!token) {
      await interaction.reply({ content: '❗ Bitte zuerst Token mit /zipline settoken setzen.', ephemeral: true });
      return;
    }

    if (sub === 'me') {
      await interaction.deferReply({ ephemeral: true });
      const data = await ziplineGetMe(token);
      await interaction.editReply(`**Benutzername:** ${data.username}\n**Rolle:** ${data.role}\nSpeicher: ${data.quota?.used || 0}/${data.quota?.max || '∞'}`);
      return;
    }

    if (sub === 'list') {
      const uploads = await ziplineFetchAllUserUploads(token);
      if (!uploads.length) {
        await interaction.reply({ content: 'Keine Uploads gefunden.', ephemeral: true });
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
      await interaction.editReply(`✅ Upload erfolgreich:\n${urls}`);
      return;
    }

    if (sub === 'settings') {
      const expiry = interaction.options.getString('expiry');
      const compression = interaction.options.getString('compression');
      setUserSettings(userId, { expiry, compression });
      await interaction.reply({ content: '🛠 Einstellungen gespeichert.', ephemeral: true });
      return;
    }

  } catch (error) {
    logError(error, 'InteractionHandler');
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('❌ Fehler aufgetreten.');
    } else {
      await interaction.reply({ content: '❌ Fehler aufgetreten.', ephemeral: true });
    }
  }
});


deployCommands().then(() => client.login(config.discordToken));
