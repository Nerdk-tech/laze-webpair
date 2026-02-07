require('./settings');
const express = require('express');
const mongoose = require('mongoose');
const { makeWASocket, useMultiFileAuthState, Browsers, delay } = require("@whiskeysockets/baileys");
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const { smsg } = require("./queen/function");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

// FORCE DIRECTORY CREATION
const sessionsDir = path.join(__dirname, 'sessions');
fs.ensureDirSync(sessionsDir); 

let serverLogs = [];
const logToBuffer = (msg) => {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    serverLogs.push(entry);
    if (serverLogs.length > 100) serverLogs.shift();
    console.log(entry);
};

mongoose.connect(MONGO_URI)
    .then(() => logToBuffer("✅ Laze Database: Connected"))
    .catch(err => console.error("❌ Database Error:", err));

const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    coins: { type: Number, default: 100 },
    lastClaim: { type: String, default: null }
}));

const activeSessions = new Set();

async function startLazeInstance(num) {
    const sessionPath = path.join(sessionsDir, num);
    if (!fs.existsSync(path.join(sessionPath, 'creds.json'))) return;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const conn = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'), 
            printQRInTerminal: false
        });

        conn.ev.on('creds.update', saveCreds);
        conn.ev.on('connection.update', (update) => {
            const { connection } = update;
            if (connection === 'open') {
                logToBuffer(`✅ Bot Online: ${num}`);
                activeSessions.add(num);
            } else if (connection === 'close') {
                activeSessions.delete(num);
            }
        });

        conn.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                let mek = chatUpdate.messages[0];
                if (!mek.message || mek.key.remoteJid === 'status@broadcast') return;
                const m = smsg(conn, mek); 
                require("./anime.js")(conn, m, chatUpdate);
            } catch (e) { console.error(e); }
        });
    } catch (e) { logToBuffer(`❌ Failed to start ${num}: ${e.message}`); }
}

app.get('/api/logs', (req, res) => res.json({ logs: serverLogs }));
app.get('/api/monitor', (req, res) => res.json({ status: "Online", activeBots: activeSessions.size }));

app.get('/api/linked-numbers', (req, res) => {
    // Also include numbers that have folders but aren't "active" in RAM
    const folders = fs.readdirSync(sessionsDir);
    res.json({ numbers: Array.from(new Set([...activeSessions, ...folders])) });
});

app.post('/api/delete-session', async (req, res) => {
    const { number } = req.body;
    try {
        activeSessions.delete(number);
        const sessionPath = path.join(sessionsDir, number);
        await fs.remove(sessionPath);
        logToBuffer(`🗑️ Session Wiped: ${number}`);
        res.json({ message: "Session wiped successfully" });
    } catch (e) { res.status(500).json({ error: "Failed to delete" }); }
});

app.post('/api/auth', async (req, res) => {
    const { user, pass } = req.body;
    try {
        let dbUser = await User.findOne({ username: user });
        if (!dbUser) {
            dbUser = new User({ username: user, password: pass });
            await dbUser.save();
        }
        res.json({ user: dbUser.username, coins: dbUser.coins });
    } catch (e) { res.status(500).json({ error: "Auth Error" }); }
});

app.post('/api/claim', async (req, res) => {
    const { user } = req.body;
    const today = new Date().toDateString();
    try {
        let dbUser = await User.findOne({ username: user });
        if (dbUser.lastClaim === today) return res.status(400).json({ error: "Already claimed today" });
        dbUser.coins += 100;
        dbUser.lastClaim = today;
        await dbUser.save();
        res.json({ coins: dbUser.coins, message: "Claimed 100 coins!" });
    } catch (e) { res.status(500).json({ error: "Claim failed" }); }
});

app.post('/api/get-pair', async (req, res) => {
    let { number, user } = req.body;
    number = number.replace(/[^0-9]/g, '');
    try {
        let dbUser = await User.findOne({ username: user });
        if (!dbUser || dbUser.coins < 10) return res.status(403).json({ error: "Need 10 coins" });

        const sessionPath = path.join(sessionsDir, number);
        await fs.remove(sessionPath); // Clean start
        await fs.ensureDir(sessionPath); // Force folder creation

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome')
        });

        await delay(5000);
        let code = await sock.requestPairingCode(number);
        
        dbUser.coins -= 10;
        await dbUser.save();
        logToBuffer(`🔑 Code [${code}] for ${number}`);
        
        res.json({ code, coins: dbUser.coins });
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', (u) => { if(u.connection === 'open') startLazeInstance(number); });
    } catch (e) {
        logToBuffer(`❌ Pairing Failed: ${e.message}`);
        res.status(500).json({ error: "Pairing failed. Ensure number is correct." });
    }
});

// Boot
fs.readdirSync(sessionsDir).forEach(f => startLazeInstance(f));
app.listen(PORT, () => logToBuffer(`♛ LAZE ON PORT ${PORT}`));
