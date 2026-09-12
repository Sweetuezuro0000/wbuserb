const http = require("http");
const fs = require("fs");
const P = require("pino");
const axios = require("axios");
const QRCode = require("qrcode");
const googleTTS = require("google-tts-api");
const { Sticker, StickerTypes } = require("wa-sticker-formatter");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys");

// Global QR Store
let currentQR = "";
let isConnected = false;

// -------------------------------------------------------------
// 1. MOBILE-FRIENDLY WEB QR SERVER
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
http.createServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });

    if (isConnected) {
        res.end(`
            <div style="text-align:center;padding:50px;font-family:sans-serif;">
                <h1 style="color:green;">✅ WhatsApp Connected Successfully!</h1>
                <p>Userbot active hai aur background me chal raha hai.</p>
            </div>
        `);
        return;
    }

    if (currentQR) {
        try {
            const qrImageURL = await QRCode.toDataURL(currentQR);
            res.end(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Scan WhatsApp QR</title>
                </head>
                <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;background:#f0f2f5;">
                    <div style="background:white;padding:25px;border-radius:15px;box-shadow:0 4px 12px rgba(0,0,0,0.1);text-align:center;max-width:90%;">
                        <h2>📱 Scan WhatsApp QR Code</h2>
                        <p style="color:#666;font-size:14px;">WhatsApp -> Linked Devices -> Link a Device</p>
                        <img src="${qrImageURL}" style="width:260px;height:260px;margin:15px 0;border:2px solid #25D366;border-radius:10px;"/>
                        <p style="font-size:12px;color:#888;">Page automatic refresh hoga 15 second me...</p>
                    </div>
                    <script>setTimeout(() => location.reload(), 15000);</script>
                </body>
                </html>
            `);
        } catch (e) {
            res.end("<h3>QR Render karne me issue aaya, page refresh karein.</h3>");
        }
    } else {
        res.end(`
            <div style="text-align:center;padding:50px;font-family:sans-serif;">
                <h2>⏳ QR Code generating...</h2>
                <p>Kripya 5 second baad page refresh karein.</p>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </div>
        `);
    }
}).listen(PORT, () => {
    console.log(`[HTTP Server] Web Server running on port ${PORT}`);
});

// -------------------------------------------------------------
// 2. CONFIG & HELPERS
// -------------------------------------------------------------
const CONFIG_FILE = "./config.json";
let config = { forwardEnabled: false, sources: [], destinationNumber: "" };

if (fs.existsSync(CONFIG_FILE)) {
    try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); } catch (e) {}
}

function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function formatJid(number) {
    let clean = number.replace(/[^0-9]/g, "");
    if (!clean.endsWith("@s.whatsapp.net")) clean += "@s.whatsapp.net";
    return clean;
}

function extractCleanNumber(jid) {
    if (!jid) return "";
    return jid.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
}

async function getMediaBuffer(msg) {
    let type;
    let mediaObj;
    if (msg.message?.imageMessage) { type = "image"; mediaObj = msg.message.imageMessage; }
    else if (msg.message?.videoMessage) { type = "video"; mediaObj = msg.message.videoMessage; }
    else return null;

    const stream = await downloadContentFromMessage(mediaObj, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    return buffer;
}

// -------------------------------------------------------------
// 3. MAIN BOT ENGINE
// -------------------------------------------------------------
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");

    const sock = makeWASocket({
        auth: state,
        logger: P({ level: "silent" }),
        printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            console.log("\n[QR GENERATED] Open your Render Web URL in browser to scan QR Code!\n");
        }

        if (connection === "open") {
            isConnected = true;
            currentQR = "";
            console.log("\n✅ WhatsApp Connected Successfully!\n");
        }

        if (connection === "close") {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log("Reconnecting in 5s...");
                setTimeout(() => startBot(), 5000);
            } else {
                console.log("Logged out.");
            }
        }
    });

    sock.ev.on("messages.upsert", async (data) => {
        const messages = data.messages;
        if (!messages || !messages.length) return;

        const msg = messages[0];
        if (!msg.message) return;

        const jid = msg.key.remoteJid;
        const participant = msg.key.participant;
        const isFromMe = msg.key.fromMe;
        const isGroup = jid.endsWith("@g.us");

        const text = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            ""
        ).trim();

        const senderClean = extractCleanNumber(jid);
        const participantClean = extractCleanNumber(participant);

        // AUTO-FORWARDER
        if (config.forwardEnabled && !isFromMe && !isGroup && config.sources?.length > 0) {
            const isMatch = config.sources.some(src => 
                senderClean.includes(src) || 
                src.includes(senderClean) || 
                (participantClean && participantClean.includes(src))
            );

            if (isMatch && config.destinationNumber) {
                const destJid = formatJid(config.destinationNumber);
                try {
                    await sock.sendMessage(destJid, { forward: msg });
                } catch (err) {
                    if (text) await sock.sendMessage(destJid, { text: `📥 *[FORWARDED]*\n\n${text}` });
                }
            }
        }

        // COMMANDS
        if (!text.startsWith("!")) return;
        const args = text.split(/\s+/);
        const command = args[0].toLowerCase();

        if (command === "!menu" || command === "!help") {
            const menuText = `🤖 *WhatsApp Userbot Menu* 🤖\n\n` +
                `• \`!ping\` - Check speed\n` +
                `• \`!alive\` - Check status\n` +
                `• \`!getlid <number>\` - Extract WhatsApp LID\n` +
                `• \`!weather <city>\` - Weather update\n` +
                `• \`!del\` - Delete message\n` +
                `• \`!react <emoji>\` - React message\n` +
                `• \`!ai <question>\` - AI Chatbot\n` +
                `• \`!s\` - Convert Sticker\n` +
                `• \`!tts <text>\` - Text to Voice\n` +
                `• \`!setforward <Src1,Src2> <Dest>\` - Set Forwarder\n` +
                `• \`!addsource <Number/LID>\` - Add Source\n` +
                `• \`!forwarding on/off\` - Toggle Forwarder\n` +
                `• \`!statusforward\` - Status Check`;

            await sock.sendMessage(jid, { text: menuText });
        }

        if (command === "!ping") await sock.sendMessage(jid, { text: "Pong! 🏓" });
        if (command === "!alive") await sock.sendMessage(jid, { text: "✅ Server Active!" });

        if (command === "!getlid") {
            const targetNum = args[1]?.replace(/[^0-9]/g, "");
            if (!targetNum) return await sock.sendMessage(jid, { text: "❌ Usage: `!getlid 919876543210`" });
            try {
                const results = await sock.onWhatsApp(targetNum);
                const res = results?.[0];
                if (res?.exists) {
                    const cleanLid = res.lid ? extractCleanNumber(res.lid) : "No LID Found";
                    await sock.sendMessage(jid, { text: `📱 *Number:* ${targetNum}\n• LID: \`${cleanLid}\`\n• JID: \`${res.jid}\`` });
                } else await sock.sendMessage(jid, { text: "❌ Number not on WhatsApp." });
            } catch (e) { await sock.sendMessage(jid, { text: "❌ Error fetching LID." }); }
        }

        if (command === "!ai") {
            const prompt = text.replace(/^!ai\s*/i, "").trim();
            if (!prompt) return await sock.sendMessage(jid, { text: "❌ Usage: `!ai Question`" });
            try {
                const response = await axios.post("https://text.pollinations.ai/", {
                    messages: [{ role: "user", content: prompt }], model: "openai"
                }, { timeout: 20000 });
                await sock.sendMessage(jid, { text: `🤖 *AI:* ${response.data}` });
            } catch (err) { await sock.sendMessage(jid, { text: "❌ AI Busy." }); }
        }

        if (command === "!s" || command === "!sticker") {
            try {
                let targetMsg = msg;
                if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                    targetMsg = { message: msg.message.extendedTextMessage.contextInfo.quotedMessage };
                }
                const mediaBuffer = await getMediaBuffer(targetMsg);
                if (!mediaBuffer) return await sock.sendMessage(jid, { text: "❌ Photo/Video reply required." });

                const sticker = new Sticker(mediaBuffer, { pack: "Bot", author: "WA", type: StickerTypes.FULL, quality: 70 });
                const stickerBuffer = await sticker.build();
                await sock.sendMessage(jid, { sticker: stickerBuffer });
            } catch (err) { await sock.sendMessage(jid, { text: "❌ Sticker fail." }); }
        }

        if (command === "!tts") {
            const ttsText = text.replace(/^!tts\s*/i, "").trim();
            if (!ttsText) return await sock.sendMessage(jid, { text: "❌ Usage: `!tts Hello`" });
            try {
                const audioUrl = googleTTS.getAudioUrl(ttsText, { lang: "hi", slow: false });
                await sock.sendMessage(jid, { audio: { url: audioUrl }, mimetype: "audio/mp4", ptt: true });
            } catch (err) { await sock.sendMessage(jid, { text: "❌ Voice note fail." }); }
        }

        if (command === "!weather") {
            const city = args[1];
            if (!city) return await sock.sendMessage(jid, { text: "❌ Usage: `!weather Delhi`" });
            try {
                const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
                await sock.sendMessage(jid, { text: `🌤️ ${res.data}` });
            } catch (e) { await sock.sendMessage(jid, { text: "❌ Weather error." }); }
        }

        if (command === "!react") {
            const emoji = args[1] || "👍";
            const quotedKey = msg.message.extendedTextMessage?.contextInfo?.stanzaId;
            if (quotedKey) await sock.sendMessage(jid, { react: { text: emoji, key: { remoteJid: jid, id: quotedKey, fromMe: false } } });
        }

        if (command === "!del") {
            const contextInfo = msg.message.extendedTextMessage?.contextInfo;
            if (contextInfo?.stanzaId) {
                await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: contextInfo.stanzaId, participant: contextInfo.participant } });
            }
        }

        if (command === "!setforward") {
            if (args.length < 3) return await sock.sendMessage(jid, { text: "❌ Usage: `!setforward 9198111,9198222 91983333`" });
            config.sources = args[1].split(",").map(s => s.replace(/[^0-9]/g, "")).filter(Boolean);
            config.destinationNumber = args[2].replace(/[^0-9]/g, "");
            config.forwardEnabled = true;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ *Forwarder Active!*\n📥 Sources: ${config.sources.join(", ")}\n📤 Dest: ${config.destinationNumber}` });
        }

        if (command === "!addsource") {
            const num = args[1]?.replace(/[^0-9]/g, "");
            if (num && !config.sources.includes(num)) {
                config.sources.push(num);
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Added source: ${num}` });
            }
        }

        if (command === "!forwarding") {
            const mode = args[1]?.toLowerCase();
            if (mode === "on") config.forwardEnabled = true;
            if (mode === "off") config.forwardEnabled = false;
            saveConfig();
            await sock.sendMessage(jid, { text: `Forwarder state: *${config.forwardEnabled ? "ON" : "OFF"}*` });
        }

        if (command === "!statusforward") {
            await sock.sendMessage(jid, { text: `📊 *Forward Status:*\n• Active: ${config.forwardEnabled}\n• Sources: ${config.sources.join(", ")}\n• Destination: ${config.destinationNumber}` });
        }
    });
}

startBot();
