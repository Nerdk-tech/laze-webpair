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
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Laze Database: Connected"))
    .catch(err => console.error("❌ Database Error:", err));

const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    coins: { type: Number, default: 100 },
    lastClaim: { type: String, default: null }
}));

const activeSessions = new Set();

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
        if (connection === 'open') activeSessions.add(num);
        else if (connection === 'close') activeSessions.delete(num);
    });
    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            let mek = chatUpdate.messages[0];
            if (!mek.message || mek.key.remoteJid === 'status@broadcast') return;
            const m = smsg(conn, mek); 
            require("./anime.js")(conn, m, chatUpdate);
        } catch (e) { console.error(e); }
    });
}

app.get('/api/monitor', (req, res) => {
    res.json({ status: "Online", activeBots: activeSessions.size });
});

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
        }
        res.json({ user: dbUser.username, coins: dbUser.coins });
    } catch (e) { res.status(500).json({ error: "Auth Error" }); }
});

app.post('/api/claim', async (req, res) => {
    const { user } = req.body;
    const today = new Date().toDateString();
    try {
        let dbUser = await User.findOne({ username: user });
        if (!dbUser) return res.status(404).json({ error: "User not found. Login first." });
        if (dbUser.lastClaim === today) return res.status(400).json({ error: "Already claimed today" });
        
        dbUser.coins += 100;
        dbUser.lastClaim = today;
        await dbUser.save();
        res.json({ coins: dbUser.coins, message: "Claimed 100 coins!" });
    } catch (e) { res.status(500).json({ error: "Server error during claim" }); }
});

app.post('/api/get-pair', async (req, res) => {
    const { number, user } = req.body;
    try {
        let dbUser = await User.findOne({ username: user });
        if (!dbUser || dbUser.coins < 10) return res.status(403).json({ error: "Need 10 coins" });

        const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${number}`);
        const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome') });
        let code = await sock.requestPairingCode(number);
        
        dbUser.coins -= 10;
        await dbUser.save();
        res.json({ code, coins: dbUser.coins });
        setTimeout(() => startLazeInstance(number), 10000);
    } catch (e) { res.status(500).json({ error: "Pairing Error" }); }
});

app.listen(PORT, () => console.log(`♛ LAZE ACTIVE ON ${PORT}`));
