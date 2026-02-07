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

// --- LOG SYSTEM ---
let serverLogs = [];
const logToBuffer = (msg) => {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
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
    const sessionPath = path.join(__dirname, 'sessions', num);
    if (!fs.existsSync(path.join(sessionPath, 'creds.json'))) return;

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
            logToBuffer(`📩 Message from ${m.sender.split('@')[0]} on bot ${num}`);
            require("./anime.js")(conn, m, chatUpdate);
        } catch (e) { console.error("Message Error:", e); }
    });
}

// --- APIs ---
app.get('/api/logs', (req, res) => res.json({ logs: serverLogs }));

app.get('/api/monitor', (req, res) => {
    res.json({ 
        status: "Online", 
        activeBots: activeSessions.size,
        uptime: process.uptime()
    });
});

app.get('/api/linked-numbers', (req, res) => {
    res.json({ numbers: Array.from(activeSessions) });
});

app.post('/api/delete-session', async (req, res) => {
    const { number } = req.body;
    try {
        activeSessions.delete(number);
        const sessionPath = path.join(__dirname, 'sessions', number);
        if (fs.existsSync(sessionPath)) {
            await fs.remove(sessionPath);
            logToBuffer(`🗑️ Session Deleted: ${number}`);
            return res.json({ message: "Session wiped successfully" });
        }
        res.status(404).json({ error: "Session folder not found" });
    } catch (e) { res.status(500).json({ error: "Failed to delete" }); }
});

app.post('/api/auth', async (req, res) => {
    const { user, pass } = req.body;
    try {
        let dbUser = await User.findOne({ username: user });
        if (!dbUser) {
            dbUser = new User({ username: user, password: pass });
            await dbUser.save();
            logToBuffer(`👤 New User Registered: ${user}`);
        }
        res.json({ user: dbUser.username, coins: dbUser.coins });
    } catch (e) { res.status(500).json({ error: "Auth Error" }); }
});

app.post('/api/claim', async (req, res) => {
    const { user } = req.body;
    const today = new Date().toDateString();
    try {
        let dbUser = await User.findOne({ username: user });
        if (!dbUser) return res.status(404).json({ error: "User not found" });
        if (dbUser.lastClaim === today) return res.status(400).json({ error: "Daily coins already claimed!" });
        
        dbUser.coins += 100;
        dbUser.lastClaim = today;
        await dbUser.save();
        logToBuffer(`💰 ${user} claimed 100 daily coins`);
        res.json({ coins: dbUser.coins, message: "100 coins added to your balance!" });
    } catch (e) { res.status(500).json({ error: "Claim process failed" }); }
});

app.post('/api/get-pair', async (req, res) => {
    let { number, user } = req.body;
    if (!number) return res.status(400).json({ error: "Number required" });
    number = number.replace(/[^0-9]/g, '');

    try {
        let dbUser = await User.findOne({ username: user });
        if (!dbUser || dbUser.coins < 10) return res.status(403).json({ error: "Insufficient coins (10 required)" });

        const sessionPath = path.join(__dirname, 'sessions', number);
        if (fs.existsSync(sessionPath)) await fs.remove(sessionPath);

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome')
        });

        await delay(3000);
        let code = await sock.requestPairingCode(number);
        
        dbUser.coins -= 10;
        await dbUser.save();
        logToBuffer(`🔑 Code [${code}] generated for ${number}`);
        
        res.json({ code, coins: dbUser.coins });
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', (u) => { if(u.connection === 'open') startLazeInstance(number); });

    } catch (e) {
        logToBuffer(`❌ Pairing Failed for ${number}`);
        res.status(500).json({ error: "Pairing process failed" });
    }
});

// Boot existing sessions on start
if (fs.existsSync('./sessions')) {
    fs.readdirSync('./sessions').forEach(f => startLazeInstance(f));
}

app.listen(PORT, () => logToBuffer(`♛ LAZE ENGINE ACTIVE ON PORT ${PORT}`));
