const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const WebSocket = require('ws');
const CryptoJS = require('crypto-js');
const { google } = require('googleapis');
const fs = require('fs');

// Install: npm install ws crypto-js googleapis

// ==================== GOOGLE SHEETS CONFIG ====================
const CREDENTIALS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/google-credentials.json';
const SPREADSHEET_ID = '1kLcrWsuXE5tezYl7mXisYTSH6vDcvz6YRm617E-ogFY';
const SHEET_NAME = 'GBcard';

const START_ROW = 1;
const END_ROW = 10;
const ACCOUNT_DELAY_MS = 10000;

// ==================== GAME CONFIG ====================
const SECRET = "JAXICRm0pI84jsY6iS2hRKfV/PvxRBufit2gwIDVWkc=";
const USERNAME = "MLgod";
const LANG = "en";
const UUID = '6647816cae0db5f791de1d73ee361501';
const MCUID = 'd4e55771e4927c1227e7df429cf3315d';

// ==================== MAP LIST (Fixed order cycling) ====================
const MAP_LISTS = [
    "61;43;6;55;9;3;40;32;",
    "61;51;56;2;49;54;42;46;",
    "61;51;56;2;49;54;42;46;"
];

let currentMapIndex = 0;

function getNextMapList() {
    const map = MAP_LISTS[currentMapIndex % MAP_LISTS.length];
    currentMapIndex++;
    return map;
}

function resetMapIndex() {
    currentMapIndex = 0;
}

// ==================== UTILITY FUNCTIONS ====================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== GOOGLE SHEETS FUNCTIONS ====================
async function authenticate() {
    const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(fs.readFileSync(CREDENTIALS_PATH)),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return await auth.getClient();
}

async function readTokensAndPhones() {
    const authClient = await authenticate();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const range = `${SHEET_NAME}!B${START_ROW}:C${END_ROW}`;
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
    const rows = res.data.values || [];
    const data = [];
    
    rows.forEach((row, idx) => {
        const accessToken = row[0]?.toString().trim();
        let phone = row[1]?.toString().trim();
        
        if (accessToken && phone) {
            phone = phone.replace(/[^\d]/g, '');
            if (!phone.startsWith('0') && phone.length > 0) phone = '0' + phone;
            data.push({
                rowNumber: START_ROW + idx,
                accessToken,
                phone,
            });
        }
    });
    
    console.log(`📋 Loaded ${data.length} valid rows (${START_ROW} – ${START_ROW + rows.length - 1})`);
    return data;
}

async function updateSheetResult(rowNumber, tickets, boxes, bananas, status, message = '') {
    try {
        const authClient = await authenticate();
        const sheets = google.sheets({ version: 'v4', auth: authClient });
        const range = `${SHEET_NAME}!F${rowNumber}:I${rowNumber}`;
        const values = [[tickets, boxes, bananas, `${status}${message ? ': ' + message : ''}`]];
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range,
            valueInputOption: 'RAW',
            requestBody: { values },
        });
        console.log(`✅ Row ${rowNumber} updated: Tickets=${tickets}, Boxes=${boxes}, Bananas=${bananas}, Status=${status}`);
    } catch (error) {
        console.error(`❌ Failed to update row ${rowNumber}: ${error.message}`);
    }
}

// ==================== ENCRYPTION/DECRYPTION ====================
function encryptTempleKong(data) {
    const keyBytes = Buffer.from(SECRET, 'utf8').slice(0, 32);
    const keyWA = CryptoJS.lib.WordArray.create(keyBytes);
    const iv = CryptoJS.lib.WordArray.random(16);
    const encrypted = CryptoJS.AES.encrypt(
        JSON.stringify(data),
        keyWA,
        { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
    );
    const combined = iv.concat(encrypted.ciphertext);
    return CryptoJS.enc.Base64.stringify(combined);
}

function decryptTempleKong(encryptedBase64) {
    const keyBytes = Buffer.from(SECRET, 'utf8').slice(0, 32);
    const keyWA = CryptoJS.lib.WordArray.create(keyBytes);
    const encryptedWA = CryptoJS.enc.Base64.parse(encryptedBase64);
    const iv = CryptoJS.lib.WordArray.create(encryptedWA.words.slice(0, 4), 16);
    const ciphertext = CryptoJS.lib.WordArray.create(
        encryptedWA.words.slice(4),
        encryptedWA.sigBytes - 16
    );
    const decrypted = CryptoJS.AES.decrypt(
        { ciphertext: ciphertext },
        keyWA,
        { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
    );
    return JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));
}

// ==================== HTTP REQUEST FUNCTION ====================
function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        const isHttps = urlObj.protocol === 'https:';
        const httpModule = isHttps ? https : http;
        
        const requestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            rejectUnauthorized: false
        };
        
        const req = httpModule.request(requestOptions, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const encoding = res.headers['content-encoding'];
                let decompressed = buffer;
                
                if (encoding === 'gzip' || encoding === 'deflate') {
                    try { decompressed = zlib.gunzipSync(buffer); } catch (e) {
                        try { decompressed = zlib.inflateSync(buffer); } catch (e2) {}
                    }
                } else if (encoding === 'br') {
                    try { decompressed = zlib.brotliDecompressSync(buffer); } catch (e) {}
                }
                
                const data = decompressed.toString('utf8');
                const response = { statusCode: res.statusCode, headers: res.headers, body: data };
                
                const contentType = res.headers['content-type'] || '';
                if (contentType.includes('application/json')) {
                    try { response.json = JSON.parse(data); } catch (e) {}
                }
                resolve(response);
            });
        });
        
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
        if (options.body) req.write(options.body);
        req.end();
    });
}

// ==================== LOGIN STEPS ====================
async function step1_InitialRequest(phoneNumber, accessToken) {
    const url = `http://telco-gw.mascom.vn/gateway-service/v1/game/super-app/login?game-code=KONG_ONLINE&uuid=${UUID}&mcuid=${MCUID}&mcapp=myid`;
    const response = await makeRequest(url, {
        headers: {
            'Host': 'telco-gw.mascom.vn',
            'User-Agent': 'Mozilla/5.0',
            'Accept': '*/*',
            'phone-number': phoneNumber,
            'access-token': accessToken,
            'avatar': '', 'lang': LANG, 'username': USERNAME,
            'X-Requested-With': 'com.myentertainment.oneid', 'Connection': 'keep-alive'
        }
    });
    if (response.statusCode === 302) {
        const location = response.headers.location;
        const redirectUrl = new URL(location);
        const token = redirectUrl.searchParams.get('token');
        return { token, redirectUrl: location, baseUrl: redirectUrl.origin };
    }
    throw new Error('No redirect received');
}

async function step2_FollowRedirect(redirectUrl, phoneNumber, accessToken) {
    await makeRequest(redirectUrl, {
        headers: {
            'Host': 'kong.mascom.vn',
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'text/html,application/xhtml+xml',
            'Phone-Number': phoneNumber, 'Access-Token': accessToken,
            'Avatar': '', 'Lang': LANG, 'Username': USERNAME,
            'X-Requested-With': 'com.myentertainment.oneid',
            'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en-US,en;q=0.9'
        }
    });
}

async function step3_HealthCheck(baseUrl) {
    await makeRequest(`${baseUrl}/api/health`, {
        headers: {
            'Host': new URL(baseUrl).hostname, 'Authorization': 'Bearer',
            'User-Agent': 'Mozilla/5.0', 'Accept': '*/*',
            'X-Requested-With': 'com.myentertainment.oneid', 'Referer': baseUrl
        }
    });
}

async function step4_LoginWithToken(baseUrl, token, phoneNumber, accessToken) {
    const decodedToken = decodeURIComponent(token);
    const postData = JSON.stringify({ token: decodedToken });
    const response = await makeRequest(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
            'Host': new URL(baseUrl).hostname,
            'Content-Length': Buffer.byteLength(postData), 'Authorization': 'Bearer',
            'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0',
            'Accept': '*/*', 'Origin': baseUrl,
            'X-Requested-With': 'com.myentertainment.oneid',
            'Referer': `${baseUrl}/?token=${encodeURIComponent(token)}&lang=en`
        },
        body: postData
    });
    if (response.json?.data?.accessToken) {
        return { success: true, gameToken: response.json.data.accessToken };
    }
    throw new Error('Failed to get game token');
}

async function getUserInfo(baseUrl, gameToken) {
    const response = await makeRequest(`${baseUrl}/api/user/info`, {
        headers: {
            'Host': new URL(baseUrl).hostname,
            'Authorization': `Bearer ${gameToken}`,
            'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0',
            'Accept': '*/*', 'X-Requested-With': 'com.myentertainment.oneid',
            'Referer': baseUrl
        }
    });
    if (response.json?.data) return response.json.data;
    return null;
}

// ==================== WEBSOCKET GAME - ENDLESS MODE ====================
function playEndlessGame(baseUrl, gameToken, gameMode = { level: 1, story: 0, mode: 'ENDLESS' }) {
    return new Promise((resolve) => {
        const urlObj = new URL(baseUrl);
        const wsUrl = `wss://${urlObj.hostname}/api/ws/game?authToken=${encodeURIComponent(gameToken)}`;
        
        const ws = new WebSocket(wsUrl, {
            headers: {
                'Host': urlObj.hostname, 'Connection': 'Upgrade',
                'Pragma': 'no-cache', 'Cache-Control': 'no-cache',
                'User-Agent': 'Mozilla/5.0',
                'Upgrade': 'websocket', 'Origin': baseUrl,
                'Sec-WebSocket-Version': '13',
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept-Language': 'en,en-US;q=0.9'
            },
            rejectUnauthorized: false
        });
        
        let gameStats = {
            bananaCount: 0, maxBanana: 0, boxesCollected: 0,
            gameEnded: false, gameStarted: false, targetReached: false,
            boxScheduled: false, bananaCollectionStarted: false,
            stopBoxCollection: null, onBoxGiftReceived: null,
            wsClosed: false, groundSelected: false,
            collectingExtraBananas: false, extraBananasTarget: 0
        };
        
        let gameTimeout = null;
        let resolved = false;
        
        function safeResolve(result) {
            if (!resolved) {
                resolved = true;
                if (gameTimeout) clearTimeout(gameTimeout);
                try { ws.close(); } catch (e) {}
                resolve(result);
            }
        }
        
        ws.on('open', () => {
            const encryptedData = encryptTempleKong(gameMode);
            const startGameMsg = { type: 'START_GAME', payload: { data: encryptedData } };
            ws.send(JSON.stringify(startGameMsg));
            
            gameTimeout = setTimeout(() => {
                if (!gameStats.gameEnded) {
                    gameStats.wsClosed = true;
                    gameStats.gameEnded = true;
                    safeResolve({ gameStats, forcedEnd: true });
                }
            }, 300000);
        });
        
        ws.on('message', (data) => {
            if (gameStats.gameEnded && resolved) return;
            const message = data.toString();
            
            try {
                const parsed = JSON.parse(message);
                
                if (parsed.action === 'START_GAME' && parsed.status === 'success') {
                    gameStats.gameStarted = true;
                    sendGroundSelected(ws, gameStats);
                } else if (parsed.action === 'GROUND_SELECTED' && parsed.status === 'success') {
                    gameStats.groundSelected = true;
                    if (!gameStats.bananaCollectionStarted) {
                        gameStats.bananaCollectionStarted = true;
                        startCollectingBananas(ws, gameStats);
                    }
                    if (!gameStats.boxScheduled && gameStats.maxBanana > 0) {
                        gameStats.boxScheduled = true;
                        scheduleBoxCollectionEndless(ws, gameStats);
                    }
                } else if (parsed.action === 'BANANA_COLLECTED') {
                    gameStats.bananaCount = parsed.total;
                    gameStats.maxBanana = parsed.max;
                    if (!gameStats.boxScheduled && gameStats.maxBanana > 0) {
                        gameStats.boxScheduled = true;
                        scheduleBoxCollectionEndless(ws, gameStats);
                    }
                } else if (parsed.action === 'BOX_COLLECTED') {
                    gameStats.boxesCollected = parsed.total || gameStats.boxesCollected + 1;
                    if (parsed.boxType === 'BOX_GIFT' && gameStats.onBoxGiftReceived) {
                        gameStats.onBoxGiftReceived();
                    }
                } else if (parsed.action === 'END_GAME') {
                    gameStats.gameEnded = true;
                    safeResolve({ gameStats });
                } else if (parsed.status === 'error' || parsed.action === 'ERROR') {
                    gameStats.gameEnded = true;
                    safeResolve({ gameStats, error: parsed });
                }
            } catch (e) {}
        });
        
        ws.on('error', (error) => {
            if (!gameStats.gameEnded) {
                gameStats.gameEnded = true;
                safeResolve({ gameStats, error: error.message });
            }
        });
        
        ws.on('close', (code) => {
            if (!gameStats.gameEnded) {
                gameStats.wsClosed = true;
                gameStats.gameEnded = true;
                safeResolve({ gameStats, disconnected: true });
            }
        });
    });
}

function sendGroundSelected(ws, gameStats) {
    const mapList = getNextMapList();
    const mapNumber = currentMapIndex;
    ws.send(JSON.stringify({
        type: 'GROUND_SELECTED',
        payload: { mapList: mapList, timestamp: Math.floor(Date.now() / 1000) }
    }));
}

function startCollectingBananas(ws, gameStats) {
    function collectBanana() {
        if (gameStats.gameEnded || gameStats.wsClosed) return;
        if (ws.readyState !== WebSocket.OPEN) { gameStats.gameEnded = true; return; }
        
        if (gameStats.collectingExtraBananas && gameStats.extraBananasTarget) {
            if (gameStats.bananaCount >= gameStats.extraBananasTarget) {
                if (!gameStats.targetReached) {
                    gameStats.targetReached = true;
                    setTimeout(() => endGame(ws), 2000);
                }
                return;
            }
        }
        
        if (!gameStats.collectingExtraBananas && gameStats.maxBanana > 0 && gameStats.bananaCount >= gameStats.maxBanana - 10) {
            if (!gameStats.targetReached) {
                gameStats.targetReached = true;
                setTimeout(() => endGame(ws), 2000);
            }
            return;
        }
        
        try { ws.send(JSON.stringify({ type: 'BANANA_COLLECTED', timestamp: Math.floor(Date.now() / 1000) })); }
        catch (e) { gameStats.gameEnded = true; return; }
        
        if (!gameStats.gameEnded) setTimeout(collectBanana, 500 + Math.random() * 1000);
    }
    setTimeout(collectBanana, 500);
}

function scheduleBoxCollectionEndless(ws, gameStats) {
    const maxBoxesPerMap = 100;
    const targetGiftBoxes = 3;
    const targetBananas = gameStats.maxBanana - 10;
    const extraBananasAfterGifts = 5 + Math.floor(Math.random() * 6);
    
    let boxesSentOnMap = 0;
    let giftBoxesReceived = 0;
    let allGiftsReceived = false;
    let boxCheckInterval = null;
    
    function startBoxCollectionForMap() {
        boxesSentOnMap = 0;
        if (boxCheckInterval) clearInterval(boxCheckInterval);
        
        const remainingBananas = targetBananas - gameStats.bananaCount;
        const boxesToSend = Math.min(maxBoxesPerMap, remainingBananas - 1);
        if (boxesToSend <= 0) return;
        
        const boxInterval = Math.max(200, (remainingBananas * 1000) / boxesToSend * 0.5);
        
        boxCheckInterval = setInterval(() => {
            if (gameStats.gameEnded || allGiftsReceived) { clearInterval(boxCheckInterval); return; }
            if (boxesSentOnMap >= maxBoxesPerMap) { clearInterval(boxCheckInterval); return; }
            if (ws.readyState !== WebSocket.OPEN) return;
            
            boxesSentOnMap++;
            try { ws.send(JSON.stringify({ type: 'BOX_COLLECTED', timestamp: Date.now() })); }
            catch (e) { clearInterval(boxCheckInterval); }
        }, boxInterval);
    }
    
    gameStats.onBoxGiftReceived = function() {
        giftBoxesReceived++;
        
        if (giftBoxesReceived < targetGiftBoxes) {
            if (boxCheckInterval) clearInterval(boxCheckInterval);
            sendGroundSelected(ws, gameStats);
            setTimeout(() => startBoxCollectionForMap(), 2000);
        } else {
            allGiftsReceived = true;
            if (boxCheckInterval) clearInterval(boxCheckInterval);
            gameStats.extraBananasTarget = gameStats.bananaCount + extraBananasAfterGifts;
            gameStats.collectingExtraBananas = true;
        }
    };
    
    setTimeout(() => startBoxCollectionForMap(), 2000);
}

function endGame(ws) {
    try { ws.send(JSON.stringify({ type: 'END_GAME', payload: { complete: true } })); }
    catch (e) {}
}

// ==================== PROCESS SINGLE ACCOUNT ====================
const BATCH_SIZE = 10;
const STAGGER_MS = 3000;

async function processSingleAccount(user) {
    const { rowNumber, accessToken, phone } = user;
    
    try {
        // Login
        const step1 = await step1_InitialRequest(phone, accessToken);
        await step2_FollowRedirect(step1.redirectUrl, phone, accessToken);
        await step3_HealthCheck(step1.baseUrl);
        const step4 = await step4_LoginWithToken(step1.baseUrl, step1.token, phone, accessToken);
        
        let userInfo = await getUserInfo(step1.baseUrl, step4.gameToken);
        let totalTickets = userInfo?.gameData?.totalTicket || 0;
        let totalBoxes = userInfo?.gameData?.totalBox || 0;
        
        console.log(`  [${phone}] 🎫 Tickets: ${totalTickets} | 📦 Boxes: ${totalBoxes}`);
        
        if (totalTickets <= 0) {
            if (totalBoxes > 0) await openBoxes(step1.baseUrl, step4.gameToken, totalBoxes);
            await updateSheetResult(rowNumber, 0, totalBoxes, 0, 'NO_TICKETS');
            return { success: true, rowNumber, gamesPlayed: 0 };
        }
        
        let gamesPlayed = 0;
        let totalBananasCollected = 0;
        let consecutiveErrors = 0;
        
        while (totalTickets > 0) {
            gamesPlayed++;
            resetMapIndex();  // Reset maps for each new game
            
            // Re-login every 20 games
            if (gamesPlayed % 20 === 1 && gamesPlayed > 1) {
                try {
                    const ns1 = await step1_InitialRequest(phone, accessToken);
                    const ns4 = await step4_LoginWithToken(ns1.baseUrl, ns1.token, phone, accessToken);
                    if (ns4.success) { step1.baseUrl = ns1.baseUrl; step4.gameToken = ns4.gameToken; }
                } catch (e) {}
            }
            
            try {
                // USE playEndlessGame FOR ENDLESS MODE
                const gameResult = await playEndlessGame(step1.baseUrl, step4.gameToken, {
                    level: 1, story: 0, mode: 'ENDLESS'
                });
                
                const bananas = gameResult.gameStats.bananaCount || 0;
                totalBananasCollected += bananas;
                totalTickets--;
                consecutiveErrors = 0;
                
                console.log(`  [${phone}] 🎮 Game #${gamesPlayed}: ${bananas}🍌 (Tickets: ${totalTickets})`);
                
                if (gamesPlayed % 10 === 0) {
                    userInfo = await getUserInfo(step1.baseUrl, step4.gameToken);
                    if (userInfo) {
                        totalTickets = userInfo.gameData?.totalTicket || 0;
                        totalBoxes = userInfo.gameData?.totalBox || 0;
                        console.log(`  [${phone}] 📊 Sync: ${totalTickets}🎫 ${totalBoxes}📦 (Game #${gamesPlayed})`);
                    }
                }
                
            } catch (error) {
                console.log(`  [${phone}] ❌ Game #${gamesPlayed}: ${error.message}`);
                totalTickets--;
                consecutiveErrors++;
                if (consecutiveErrors >= 5) break;
            }
            
            if (totalTickets > 0) await sleep(1500);
        }
        
        userInfo = await getUserInfo(step1.baseUrl, step4.gameToken);
        totalBoxes = userInfo?.gameData?.totalBox || 0;
        
        console.log(`  [${phone}] ✅ ${gamesPlayed} games, ${totalBananasCollected}🍌`);
        
        
        await updateSheetResult(rowNumber, 0, totalBoxes, totalBananasCollected, 'DONE');
        
        return { success: true, rowNumber, gamesPlayed, totalBananasCollected, totalBoxes };
        
    } catch (error) {
        console.error(`  [${phone}] ❌ ${error.message}`);
        await updateSheetResult(rowNumber, 0, 0, 0, 'FAILED', error.message);
        return { success: false, rowNumber, error: error.message };
    }
}


// ==================== MAIN ====================
async function main() {
    console.log('🎮 KONG ONLINE - ENDLESS MODE - PARALLEL BATCH');
    console.log('══════════════════════════════════════════════\n');
    console.log(`📊 Sheets: ${SHEET_NAME} | Rows: ${START_ROW}-${END_ROW}`);
    console.log(`📦 Batch Size: ${BATCH_SIZE} | Stagger: ${STAGGER_MS}ms`);
    console.log(`👤 Username: ${USERNAME}\n`);
    
    const users = await readTokensAndPhones();
    
    if (users.length === 0) {
        console.log('No users found.');
        return;
    }
    
    // Split into batches
    const batches = [];
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
        batches.push(users.slice(i, i + BATCH_SIZE));
    }
    
    console.log(`📦 Split into ${batches.length} batches\n`);
    
    // Process batches sequentially, accounts within batch run PARALLEL
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        console.log(`\n🚀 Starting Batch #${batchIdx + 1} with ${batch.length} rows (PARALLEL)`);
        
        const promises = batch.map((row, index) => {
            return new Promise(async (resolve) => {
                await sleep(index * STAGGER_MS);
                const result = await processSingleAccount(row);
                resolve(result);
            });
        });
        
        const results = await Promise.all(promises);
        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        
        console.log(`\n✅ Batch #${batchIdx + 1} completed: ${successful} success, ${failed} failed`);
        
        if (batchIdx < batches.length - 1) {
            console.log(`\n⏸️  Waiting 30 seconds before next batch...`);
            await sleep(30000);
        }
    }
    
    console.log('\n🎉 All batches processed!');
}

main().catch(console.error);

process.on('SIGINT', () => {
    console.log('\n\n👋 Script stopped by user.');
    process.exit(0);
});