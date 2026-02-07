const fs = require('fs');
const chalk = require('chalk');

// This pulls the Owner ID from Render/Env, or uses your default if not found
global.owner = [process.env.OWNER_ID || "2348054671458"]; 

global.xprefix = '.';
global.footer = 'Damini';

// Newsletter Settings
global.autoFollowNewsletters = ["120363377534493877@newsletter"]; 
global.autoReactNewsletterEmoji = "🔔";
global.newsletterFollowOnConnect = true;
global.forwardNewsletterToOwners = false;

// Telegram Token (Optional: added in case your anime.js needs it)
global.tgToken = process.env.TELEGRAM_BOT_TOKEN || '';

// File Update Logic
let file = require.resolve(__filename);
fs.watchFile(file, () => {
    fs.unwatchFile(file);
    console.log(chalk.redBright(`Update File 📁 : ${__filename}`));
    delete require.cache[file];
    require(file);
});
