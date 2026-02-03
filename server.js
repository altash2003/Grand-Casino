const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- DATABASE ---
const DB_FILE = 'database.json';
let users = {};
if (fs.existsSync(DB_FILE)) { 
    try { users = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { console.log("DB Reset"); }
}
function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }
function logHistory(username, message, balance) {
    if (!users[username].history) users[username].history = [];
    users[username].history.unshift(`[${new Date().toLocaleTimeString()}] ${message} | BAL: ${balance}`);
    if (users[username].history.length > 50) users[username].history.pop();
}

app.use(express.static(__dirname)); 
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/admin', (req, res) => { res.sendFile(__dirname + '/admin.html'); });

// --- GAME CONFIG ---
const DICE_COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
// American Roulette (0, 00)
const ROULETTE_NUMS = [
    {n:'0',c:'GREEN'},{n:'28',c:'BLACK'},{n:'9',c:'RED'},{n:'26',c:'BLACK'},{n:'30',c:'RED'},{n:'11',c:'BLACK'},
    {n:'7',c:'RED'},{n:'20',c:'BLACK'},{n:'32',c:'RED'},{n:'17',c:'BLACK'},{n:'5',c:'RED'},{n:'22',c:'BLACK'},
    {n:'34',c:'RED'},{n:'15',c:'BLACK'},{n:'3',c:'RED'},{n:'24',c:'BLACK'},{n:'36',c:'RED'},{n:'13',c:'BLACK'},
    {n:'1',c:'RED'},{n:'00',c:'GREEN'},{n:'27',c:'RED'},{n:'10',c:'BLACK'},{n:'25',c:'RED'},{n:'29',c:'BLACK'},
    {n:'12',c:'RED'},{n:'8',c:'BLACK'},{n:'19',c:'RED'},{n:'31',c:'BLACK'},{n:'18',c:'RED'},{n:'6',c:'BLACK'},
    {n:'21',c:'RED'},{n:'33',c:'BLACK'},{n:'16',c:'RED'},{n:'4',c:'BLACK'},{n:'23',c:'RED'},{n:'35',c:'BLACK'},
    {n:'14',c:'RED'},{n:'2',c:'BLACK'}
];

let timeLeft = 20; 
let activePlayers = {}; 
let musicState = { playing: false, trackUrl: '', title: 'Waiting...', artist: '', timestamp: 0, lastUpdate: Date.now() };
let bets = { color: [], roulette: [], baccarat: [] };
let history = { roulette: [] };

// --- MAIN LOOP ---
setInterval(() => {
    timeLeft--;
    if(timeLeft >= 0) io.emit('timer_update', timeLeft);

    if (timeLeft <= 0) {
        io.emit('game_rolling'); 

        // Generate Results
        const diceRes = [DICE_COLORS[Math.floor(Math.random()*6)], DICE_COLORS[Math.floor(Math.random()*6)], DICE_COLORS[Math.floor(Math.random()*6)]];
        const rIndex = Math.floor(Math.random()*ROULETTE_NUMS.length);
        const roulRes = ROULETTE_NUMS[rIndex];
        const baccRes = playBaccaratHand();

        // Update History
        history.roulette.unshift(roulRes);
        if(history.roulette.length > 10) history.roulette.pop();

        setTimeout(() => {
            // Broadcast Results
            io.emit('game_result', diceRes);
            processColorWinners(diceRes);

            io.emit('result_roulette', { result: roulRes, history: history.roulette });
            processRouletteWinners(roulRes);

            io.emit('result_baccarat', baccRes);
            processBaccaratWinners(baccRes);

            bets = { color: [], roulette: [], baccarat: [] };
            
            setTimeout(() => { 
                timeLeft = 20; 
                io.emit('game_reset'); 
            }, 5000);
        }, 3000);
    }
}, 1000);

// --- WIN LOGIC ---
function processColorWinners(res) {
    bets.color.forEach(b => {
        let matches = res.filter(c => c === b.color).length;
        if(matches > 0) addWin(b.username, b.socketId, b.amount * (matches + 1), "Color Game");
    });
}

function processRouletteWinners(res) {
    // res = { n: "17", c: "BLACK" }
    let winNumString = res.n; 
    
    bets.roulette.forEach(b => {
        let win = 0;
        // b.numbers is an array of strings e.g. ["1", "2"] for a split
        // If the winning number is in the covered array, they win.
        // EXCEPTION: Outside bets lose on 0/00 (unless the bet was ON 0 or 00 specifically)
        
        let isZero = (winNumString === '0' || winNumString === '00');
        let isHit = b.numbers.includes(winNumString);

        if (isHit) {
            // Check Outside Bet Rule (Even/Odd, Red/Black, Dozens, Cols)
            // If the bet covered more than 6 numbers, it's an outside bet.
            // If result is 0/00, outside bets lose.
            if (isZero && b.numbers.length > 6) {
                // LOST (House edge)
                win = 0;
            } else {
                // WIN
                // Total Return = Bet + (Bet * Payout)
                // b.payout is the ratio (e.g., 35 for straight, 1 for red/black)
                let profit = b.amount * b.payout;
                win = b.amount + profit; 
            }
        }

        if(win > 0) addWin(b.username, b.socketId, win, "Roulette");
    });
}

function processBaccaratWinners(res) {
    bets.baccarat.forEach(b => {
        let win = 0;
        if(b.bet === res.winner) {
            if(res.winner === 'TIE') win = b.amount * 9;
            else if(res.winner === 'PLAYER') win = b.amount * 2;
            else if(res.winner === 'BANKER') win = b.amount * 1.95;
        }
        if(win > 0) addWin(b.username, b.socketId, Math.floor(win), "Baccarat");
    });
}

function addWin(username, socketId, amount, game) {
    if(users[username]) {
        users[username].balance += amount;
        logHistory(username, `WIN +${amount} (${game})`, users[username].balance);
        io.to(socketId).emit('update_balance', users[username].balance);
        io.to(socketId).emit('notification', { msg: `WIN +${amount}`, duration: 3000 });
        saveDatabase();
    }
}

function playBaccaratHand() {
    let p = (Math.floor(Math.random()*10) + Math.floor(Math.random()*10)) % 10;
    let b = (Math.floor(Math.random()*10) + Math.floor(Math.random()*10)) % 10;
    if(p <= 5) p = (p + Math.floor(Math.random()*10)) % 10;
    if(b <= 5) b = (b + Math.floor(Math.random()*10)) % 10;
    return { pScore: p, bScore: b, winner: p > b ? 'PLAYER' : (b > p ? 'BANKER' : 'TIE') };
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    let currentSeek = musicState.playing ? musicState.timestamp + (Date.now() - musicState.lastUpdate)/1000 : musicState.timestamp;
    socket.emit('music_sync', { ...musicState, seek: currentSeek });
    socket.emit('active_players_list', Object.values(activePlayers));

    // AUTH 
    socket.on('register', (d) => {
        let u = d.username || d.u;
        let p = d.password || d.p;
        if(!u || !p) return socket.emit('login_error', "Missing Fields");
        if(users[u]) { socket.emit('login_error', "Username Taken"); }
        else { users[u] = { password: p, balance: 1000, history: [] }; saveDatabase(); doLogin(socket, u); }
    });

    socket.on('login', (d) => {
        let u = d.username || d.u;
        let p = d.password || d.p;
        if(users[u] && users[u].password === p) { doLogin(socket, u); }
        else { socket.emit('login_error', "Invalid Credentials"); }
    });

    function doLogin(sock, u) {
        activePlayers[sock.id] = u;
        sock.join('players');
        sock.emit('login_success', { username: u, balance: users[u].balance });
        io.emit('active_players_list', Object.values(activePlayers));
    }

    // BETS
    function placeBet(sock, game, data) {
        let u = activePlayers[sock.id];
        if(!u || timeLeft <= 0) return;
        let amt = parseInt(data.amount || data.amt);
        
        if(users[u].balance >= amt) {
            users[u].balance -= amt;
            sock.emit('update_balance', users[u].balance);
            if(game === 'color') bets.color.push({ username: u, socketId: sock.id, color: data.color, amount: amt });
            
            // Roulette now receives { numbers: [], payout: X }
            if(game === 'roulette') bets.roulette.push({ username: u, socketId: sock.id, numbers: data.numbers, payout: data.payout, amount: amt });
            
            if(game === 'baccarat') bets.baccarat.push({ username: u, socketId: sock.id, bet: data.bet, amount: amt });
        } else { sock.emit('bet_error', "Insufficient Funds"); }
    }

    socket.on('place_bet', (d) => placeBet(socket, 'color', d));
    socket.on('bet_roulette', (d) => placeBet(socket, 'roulette', d));
    socket.on('bet_baccarat', (d) => placeBet(socket, 'baccarat', d));

    // BLACKJACK
    socket.on('bj_deal', (amt) => {
        let u = activePlayers[socket.id];
        if(!u || users[u].balance < amt) return;
        users[u].balance -= amt;
        socket.emit('update_balance', users[u].balance);
        let deck = createDeck();
        socket.emit('bj_state', { pHand: [draw(deck), draw(deck)], dUp: draw(deck), dHide: draw(deck), deck, amt });
    });
    socket.on('bj_hit', (state) => {
        let card = draw(state.deck); state.pHand.push(card);
        if(handVal(state.pHand) > 21) socket.emit('bj_bust', state); else socket.emit('bj_update', { pHand: state.pHand });
    });
    socket.on('bj_stand', (state) => {
        let u = activePlayers[socket.id];
        let dHand = [state.dUp, state.dHide];
        while(handVal(dHand) < 17) dHand.push(draw(state.deck));
        let pVal = handVal(state.pHand), dVal = handVal(dHand), win = 0, res = "LOSE";
        if(dVal > 21 || pVal > dVal) { res = "WIN"; win = state.amt * 2; } else if (pVal === dVal) { res = "PUSH"; win = state.amt; }
        if(win > 0) { users[u].balance += win; socket.emit('update_balance', users[u].balance); saveDatabase(); }
        socket.emit('bj_end', { dHand, result: res, win });
    });

    // CHAT & ADMIN
    socket.on('chat_msg', (msg) => { let u = activePlayers[socket.id]; if(u) io.emit('chat_broadcast', { user: u, msg, type: 'public' }); });
    socket.on('support_msg', (msg) => { let u = activePlayers[socket.id]; if(u) { supportHistory.push({user:u, msg, time:Date.now()}); io.emit('admin_data_resp', {users, active:activePlayers, support:supportHistory}); socket.emit('chat_broadcast', {user:"YOU", msg, type:'support_sent'}); } });
    socket.on('admin_req_data', () => socket.emit('admin_data_resp', { users, active: activePlayers, support: supportHistory }));
    socket.on('admin_add', (d) => { if(users[d.u]) { users[d.u].balance += parseInt(d.amt); saveDatabase(); socket.emit('admin_data_resp', { users, active: activePlayers, support: supportHistory }); } });

    socket.on('disconnect', () => { delete activePlayers[socket.id]; io.emit('active_players_list', Object.values(activePlayers)); });
});

// BJ Helpers
const SUITS = ['H','D','C','S']; const VALS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function createDeck() { let d=[]; SUITS.forEach(s=>VALS.forEach(v=>d.push({s,v}))); return d.sort(()=>Math.random()-.5); }
function draw(d) { return d.pop(); }
function handVal(h) { let v=0,a=0; h.forEach(c=>{if(['J','Q','K'].includes(c.v))v+=10;else if(c.v==='A'){a++;v+=11;}else v+=parseInt(c.v);}); while(v>21&&a>0){v-=10;a--;} return v; }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino Running on ${PORT}`));
