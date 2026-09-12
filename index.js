const http = require("http");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const P = require("pino");
const fs = require("fs");
const axios = require("axios");
const googleTTS = require("google-tts-api");
const { Sticker, StickerTypes } = require("wa-sticker-formatter");

// -------------------------------------------------------------
// 1. RENDER HEALTH-CHECK SERVER (Port Binding to keep web service alive)
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("WhatsApp Userbot is Active & Running 24/7!");
}).listen(PORT, () => {
    console.log(`Web Server active on port ${PORT}`);
});

// -------------------------------------------------------------
// 2. CONFIGURATION MANAGEMENT
// -------------------------------------------------------------
const CONFIG_FILE = "./config.json";
let config = {
    forwardEnabled: false,
    sources: [],
    destinationNumber: ""
};

if (fs.existsSync(CONFIG_FILE)) {
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    } catch (e) {
        console.log("Config read error.");
    }
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

    if (msg.message.imageMessage) {
        type = "image";
        mediaObj = msg.message.imageMessage;
    } else if (msg.message.videoMessage) {
        type = "video";
        mediaObj = msg.message.videoMessage;
    } else {
        return null;
    }

    const stream = await downloadContentFromMessage(mediaObj, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
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
            console.log("\n=================================");
            console.log("SCAN THIS QR CODE IN RENDER LOGS");
            console.log("=================================\n");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
            console.log("\n✅ WhatsApp Connected Successfully!");
            console.log("🚀 Render Userbot Active...\n");
        }

        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log("Connection lost. Reconnecting in 5 seconds...");
                setTimeout(() => startBot(), 5000);
            } else {
                console.log("Session logged out. Delete auth folder and re-scan QR.");
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

        // -------------------------------------------------------------
        // AUTO-FORWARDING ENGINE (Multi-LID & Multi-Source Support)
        // -------------------------------------------------------------
        if (config.forwardEnabled && !isFromMe && !isGroup && config.sources && config.sources.length > 0) {
            
            const isMatch = config.sources.some(src => 
                senderClean.includes(src) || 
                src.includes(senderClean) || 
                (participantClean && participantClean.includes(src))
            );

            if (isMatch && config.destinationNumber) {
                console.log(`[FORWARD MATCH] Sender: ${senderClean} | Forwarding to ${config.destinationNumber}...`);
                const destJid = formatJid(config.destinationNumber);

                try {
                    await sock.sendMessage(destJid, { forward: msg });
                    console.log(`🚀 [SUCCESS] Forwarded to ${config.destinationNumber}`);
                } catch (err) {
                    try {
                        if (text) {
                            await sock.sendMessage(destJid, { text: `📥 *[FORWARDED]*\n\n${text}` });
                            console.log(`🚀 [SUCCESS] Text fallback forwarded.`);
                        }
                    } catch (e) {
                        console.error("❌ Forward failed:", e.message);
                    }
                }
            }
        }

        // -------------------------------------------------------------
        // COMMANDS SYSTEM
        // -------------------------------------------------------------
        const args = text.split(/\s+/);
        const command = args[0].toLowerCase();

        // HELP / MENU
        if (command === "!menu" || command === "!help") {
            const menuText = `🤖 *WhatsApp Render Userbot* 🤖\n\n` +
                `📌 *Utility Commands:*\n` +
                `• \`!ping\` - Bot speed check\n` +
                `• \`!alive\` - Server status check\n` +
                `• \`!getlid <number>\` - Target number ki LID nikalein\n` +
                `• \`!weather <city>\` - Mausam status\n` +
                `• \`!del\` - Delete replied message\n` +
                `• \`!react <emoji>\` - Message reaction\n\n` +
                `🤖 *AI Assistant:*\n` +
                `• \`!ai <question>\` - AI Chatbot\n\n` +
                `🎨 *Media Conversion:*\n` +
                `• \`!s\` or \`!sticker\` - Image/Video to Sticker\n` +
                `• \`!tts <text>\` - Text to Voice Note\n\n` +
                `🔄 *Forwarding Controls:*\n` +
                `• \`!setforward <Src1,Src2> <Dest>\` - Set Sources & Destination\n` +
                `• \`!addsource <Number/LID>\` - Add source to list\n` +
                `• \`!forwarding on/off\` - Toggle Forwarder\n` +
                `• \`!statusforward\` - View Forwarder Config`;

            await sock.sendMessage(jid, { text: menuText });
        }

        // BASIC TOOLS
        if (command === "!ping") await sock.sendMessage(jid, { text: "Pong! 🏓" });
        if (command === "!alive") await sock.sendMessage(jid, { text: "✅ Render Userbot active & running fine!" });

        // GET LID COMMAND
        if (command === "!getlid") {
            const targetNum = args[1]?.replace(/[^0-9]/g, "");
            if (!targetNum) {
                await sock.sendMessage(jid, { text: "❌ *Usage:* `!getlid 919876543210`" });
                return;
            }
            try {
                const results = await sock.onWhatsApp(targetNum);
                const result = results && results[0];
                if (result && result.exists) {
                    const cleanLid = result.lid ? extractCleanNumber(result.lid) : "Standard Number (No LID)";
                    await sock.sendMessage(jid, {
                        text: `📱 *Number Info*\n\n` +
                              `• *Phone:* ${targetNum}\n` +
                              `• *LID ID:* \`${cleanLid}\`\n` +
                              `• *Full JID:* \`${result.jid}\``
                    });
                } else {
                    await sock.sendMessage(jid, { text: "❌ Ye number WhatsApp par registered nahi hai." });
                }
            } catch (err) {
                await sock.sendMessage(jid, { text: "❌ LID fetch nahi ho payi." });
            }
        }

        // AI CHATBOT
        if (command === "!ai") {
            const prompt = text.replace(/^!ai\s*/i, "").trim();
            if (!prompt) {
                await sock.sendMessage(jid, { text: "❌ *Usage:* `!ai <Aapka Sawaal>`" });
                return;
            }
            try {
                const response = await axios.post("https://text.pollinations.ai/", {
                    messages: [{ role: "user", content: prompt }],
                    model: "openai"
                }, { timeout: 20000 });

                await sock.sendMessage(jid, { text: `🤖 *AI Reply:*\n\n${response.data}` });
            } catch (err) {
                await sock.sendMessage(jid, { text: "❌ AI service busy hai." });
            }
        }

        // STICKER MAKER
        if (command === "!s" || command === "!sticker") {
            try {
                let targetMsg = msg;
                if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                    targetMsg = { message: msg.message.extendedTextMessage.contextInfo.quotedMessage };
                }

                const mediaBuffer = await getMediaBuffer(targetMsg);
                if (!mediaBuffer) {
                    await sock.sendMessage(jid, { text: "❌ Photo ya Video par reply karke `!s` bhejey." });
                    return;
                }

                const sticker = new Sticker(mediaBuffer, {
                    pack: "My Userbot",
                    author: "Render Bot",
                    type: StickerTypes.FULL,
                    quality: 70
                });

                const stickerBuffer = await sticker.build();
                await sock.sendMessage(jid, { sticker: stickerBuffer });
            } catch (err) {
                await sock.sendMessage(jid, { text: "❌ Sticker conversion fail ho gaya." });
            }
        }

        // TEXT TO SPEECH
        if (command === "!tts") {
            const ttsText = text.replace(/^!tts\s*/i, "").trim();
            if (!ttsText) {
                await sock.sendMessage(jid, { text: "❌ *Usage:* `!tts Hello kaise ho`" });
                return;
            }
            try {
                const audioUrl = googleTTS.getAudioUrl(ttsText, {
                    lang: "hi",
                    slow: false,
                    host: "https://translate.google.com",
                });
                await sock.sendMessage(jid, {
                    audio: { url: audioUrl },
                    mimetype: "audio/mp4",
                    ptt: true
                });
            } catch (err) {
                await sock.sendMessage(jid, { text: "❌ TTS Generate nahi ho paya." });
            }
        }

        // WEATHER
        if (command === "!weather") {
            const city = args[1];
            if (!city) {
                await sock.sendMessage(jid, { text: "❌ *Usage:* `!weather Delhi`" });
                return;
            }
            try {
                const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
                await sock.sendMessage(jid, { text: `🌤️ *Weather:* ${res.data}` });
            } catch (err) {
                await sock.sendMessage(jid, { text: "❌ Data load nahi hua." });
            }
        }

        // REACTION
        if (command === "!react") {
            const emoji = args[1] || "👍";
            const quotedKey = msg.message.extendedTextMessage?.contextInfo?.stanzaId;
            if (quotedKey) {
                await sock.sendMessage(jid, {
                    react: { text: emoji, key: { remoteJid: jid, id: quotedKey, fromMe: false } }
                });
            } else {
                await sock.sendMessage(jid, { text: "❌ Message reply par `!react 🔥` likhein." });
            }
        }

        // DELETE
        if (command === "!del") {
            const contextInfo = msg.message.extendedTextMessage?.contextInfo;
            if (contextInfo && contextInfo.stanzaId) {
                await sock.sendMessage(jid, {
                    delete: {
                        remoteJid: jid,
                        fromMe: contextInfo.participant ? false : true,
                        id: contextInfo.stanzaId,
                        participant: contextInfo.participant
                    }
                });
            } else {
                await sock.sendMessage(jid, { text: "❌ Message reply par `!del` likhein." });
            }
        }

        // AUTO FORWARD COMMANDS
        if (command === "!setforward") {
            if (args.length < 3) {
                await sock.sendMessage(jid, {
                    text: "❌ *Usage:* `!setforward <Source1,Source2_Or_LID> <Destination_Number>`"
                });
                return;
            }

            const rawSources = args[1].split(",");
            config.sources = rawSources.map(s => s.replace(/[^0-9]/g, "")).filter(Boolean);
            config.destinationNumber = args[2].replace(/[^0-9]/g, "");
            config.forwardEnabled = true;
            saveConfig();

            await sock.sendMessage(jid, {
                text: `✅ *Forwarding Active!*\n\n📥 *Sources List:* ${config.sources.join(", ")}\n📤 *Destination:* ${config.destinationNumber}`
            });
        }

        if (command === "!addsource") {
            const newSource = args[1]?.replace(/[^0-9]/g, "");
            if (!newSource) {
                await sock.sendMessage(jid, { text: "❌ *Usage:* `!addsource <Number_Or_LID>`" });
                return;
            }
            if (!config.sources.includes(newSource)) {
                config.sources.push(newSource);
                saveConfig();
            }
            await sock.sendMessage(jid, {
                text: `✅ *Source Added!*\n📥 Active Sources: ${config.sources.join(", ")}`
            });
        }

        if (command === "!forwarding") {
            const statusArg = args[1]?.toLowerCase();
            if (statusArg === "on") {
                config.forwardEnabled = true;
                saveConfig();
                await sock.sendMessage(jid, { text: "✅ Forwarding *ENABLED*" });
            } else if (statusArg === "off") {
                config.forwardEnabled = false;
                saveConfig();
                await sock.sendMessage(jid, { text: "⚠️ Forwarding *DISABLED*" });
            }
        }

        if (command === "!statusforward") {
            await sock.sendMessage(jid, {
                text: `📊 *Forwarding Status*\n\n• *Status:* ${config.forwardEnabled ? "ENABLED ✅" : "DISABLED ❌"}\n• *Sources:* ${config.sources.join(", ") || "None"}\n• *Destination:* ${config.destinationNumber || "Not Set"}`
            });
        }
    });
}

startBot();
