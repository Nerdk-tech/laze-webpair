require('./settings');
const express = require('express');
const mongoose = require('mongoose');
const { makeWASocket, useMultiFileAuthState, Browsers } = require("@whiskeysockets/baileys");
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const { smsg } = require("./queen/function");

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

// --- DATABASE ---
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Laze Database: Connected to Atlas"))
    .catch(err => console.error("❌ Database Error:", err));

const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    coins: { type: Number, default: 100 },
    lastClaim: { type: String, default: null }
}));

// --- ENGINE LOGIC ---
const activeSessions = new Set(); // Track live bots for the monitor

async function startLazeInstance(num) {
    const sessionPath = `./sessions/${num}`;
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
            console.log(`[LAZE] Session Active: ${num}`);
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
        } catch (e) { console.error("Message Error:", e); }
    });
}

// --- API ENDPOINTS ---

// Monitor API
app.get('/api/monitor', (req, res) => {
    res.json({
        status: "Online",
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
        uptime: Math.round(process.uptime()) + "s",
        activeBots: activeSessions.size,
        database: mongoose.connection.readyState === 1 ? "Connected" : "Disconnected"
    });
});

// Get Linked Numbers for Settings Page
app.get('/api/linked-numbers', (req, res) => {
    res.json({ numbers: Array.from(activeSessions) });
});

app.post('/api/auth', async (req, res) => {
    const { user, pass } = req.body;
    try {
        let dbUser = await User.findOne({ username: user });
        if (!dbUser) {
            dbUser = new User({ username: user, password: pass });
            await dbUser.save();
        } else if (dbUser.password !== pass) {
            return res.status(401).json({ error: "Wrong Password" });
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
        res.json({ coins: dbUser.coins });
    } catch (e) { res.status(500).json({ error: "Claim failed" }); }
});

app.post('/api/get-pair', async (req, res) => {
    const { number, user } = req.body;
    try {
        let dbUser = await User.findOne({ username: user });
        if (dbUser.coins < 10) return res.status(403).json({ error: "Need 10 coins" });

        const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${number}`);
        const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome') });
        
        let code = await sock.requestPairingCode(number);
        dbUser.coins -= 10;
        await dbUser.save();
        
        res.json({ code, coins: dbUser.coins });
        setTimeout(() => startLazeInstance(number), 15000);
    } catch (e) { res.status(500).json({ error: "Pairing Error" }); }
});

// Boot active sessions on start
if (fs.existsSync('./sessions')) {
    fs.readdirSync('./sessions').forEach(folder => {
        if (fs.existsSync(path.join('./sessions', folder, 'creds.json'))) {
            startLazeInstance(folder);
        }
    });
}

app.listen(PORT, () => console.log(`♛ LAZE ENGINE ACTIVE ON PORT ${PORT}`));
