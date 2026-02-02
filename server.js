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
function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }

// --- ROUTING ---
app.use(express.static(__dirname)); 
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/roulette', (req, res) => { res.sendFile(__dirname + '/roulette.html'); });
app.get('/blackjack', (req, res) => { res.sendFile(__dirname + '/blackjack.html'); });
app.get('/baccarat', (req, res) => { res.sendFile(__dirname + '/baccarat.html'); });
app.get('/admin', (req, res) => { res.sendFile(__dirname + '/admin.html'); }); // Added Admin Route

// --- SHARED STATE ---
let timeLeft = 20; 
let activePlayers = {}; 
let bets = { color: [], roulette: [], baccarat: [] };

// --- GLOBAL GAME LOOP ---
setInterval(() => {
    timeLeft--;
    if(timeLeft >= 0) io.emit('timer_update', timeLeft);

    if (timeLeft <= 0) {
        io.emit('status_update', "ROLLING");

        // Generate Results
        const diceRes = [rColor(), rColor(), rColor()];
        const roulRes = rRoulette();
        const baccRes = playBaccaratHand();

        setTimeout(() => {
            io.emit('result_color', diceRes);
            processColorWinners(diceRes);

            io.emit('result_roulette', roulRes);
            processRouletteWinners(roulRes);

            io.emit('result_baccarat', baccRes);
            processBaccaratWinners(baccRes);

            bets = { color: [], roulette: [], baccarat: [] };
            
            setTimeout(() => { 
                timeLeft = 20; 
                io.emit('reset_game'); 
            }, 5000);
        }, 2000);
    }
}, 1000);

// --- HELPERS ---
const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
function rColor() { return COLORS[Math.floor(Math.random()*6)]; }
const ROULETTE_NUMS = [
    {n:'0',c:'GREEN'},{n:'28',c:'BLACK'},{n:'9',c:'RED'},{n:'26',c:'BLACK'},{n:'30',c:'RED'},{n:'11',c:'BLACK'},
    {n:'7',c:'RED'},{n:'20',c:'BLACK'},{n:'32',c:'RED'},{n:'17',c:'BLACK'},{n:'5',c:'RED'},{n:'22',c:'BLACK'},
    {n:'34',c:'RED'},{n:'15',c:'BLACK'},{n:'3',c:'RED'},{n:'24',c:'BLACK'},{n:'36',c:'RED'},{n:'13',c:'BLACK'},
    {n:'1',c:'RED'},{n:'00',c:'GREEN'},{n:'27',c:'RED'},{n:'10',c:'BLACK'},{n:'25',c:'RED'},{n:'29',c:'BLACK'},
    {n:'12',c:'RED'},{n:'8',c:'BLACK'},{n:'19',c:'RED'},{n:'31',c:'BLACK'},{n:'18',c:'RED'},{n:'6',c:'BLACK'},
    {n:'21',c:'RED'},{n:'33',c:'BLACK'},{n:'16',c:'RED'},{n:'4',c:'BLACK'},{n:'23',c:'RED'},{n:'35',c:'BLACK'},
    {n:'14',c:'RED'},{n:'2',c:'BLACK'}
];
function rRoulette() { return ROULETTE_NUMS[Math.floor(Math.random()*ROULETTE_NUMS.length)]; }
function playBaccaratHand() {
    let p = (Math.floor(Math.random()*10) + Math.floor(Math.random()*10)) % 10;
    let b = (Math.floor(Math.random()*10) + Math.floor(Math.random()*10)) % 10;
    if(p <= 5) p = (p + Math.floor(Math.random()*10)) % 10;
    if(b <= 5) b = (b + Math.floor(Math.random()*10)) % 10;
    return { pScore: p, bScore: b, winner: p > b ? 'PLAYER' : (b > p ? 'BANKER' : 'TIE') };
}

// --- WIN PROCESSING ---
function processColorWinners(res) {
    bets.color.forEach(b => {
        let matches = res.filter(c => c === b.bet).length;
        if(matches > 0) addWin(b.user, b.sock, b.amt * (matches + 1), "Color Game");
    });
}
function processRouletteWinners(res) {
    let num = parseInt(res.n);
    bets.roulette.forEach(b => {
        let win = 0;
        if(b.bet === res.n) win = b.amt * 36;
        else if(b.bet === res.c) win = b.amt * 2;
        else if(b.bet === 'EVEN' && num>0 && num%2===0) win = b.amt * 2;
        else if(b.bet === 'ODD' && num>0 && num%2!==0) win = b.amt * 2;
        if(win > 0) addWin(b.user, b.sock, win, "Roulette");
    });
}
function processBaccaratWinners(res) {
    bets.baccarat.forEach(b => {
        let win = 0;
        if(b.bet === res.winner) {
            if(res.winner === 'TIE') win = b.amt * 9;
            else if(res.winner === 'PLAYER') win = b.amt * 2;
            else if(res.winner === 'BANKER') win = b.amt * 1.95;
        }
        if(win > 0) addWin(b.user, b.sock, Math.floor(win), "Baccarat");
    });
}
function addWin(user, sock, amt, game) {
    if(users[user]) {
        users[user].balance += amt;
        io.to(sock).emit('update_balance', users[user].balance);
        io.to(sock).emit('win', { amt: amt, game: game });
    }
    saveDB();
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    // Auth
    socket.on('login', (d) => {
        if(users[d.u] && users[d.u].password === d.p) {
            activePlayers[socket.id] = d.u;
            socket.emit('login_ok', { u: d.u, b: users[d.u].balance });
        } else socket.emit('err', "Invalid Login");
    });
    socket.on('register', (d) => {
        if(!users[d.u]) {
            users[d.u] = { password: d.p, balance: 1000 };
            activePlayers[socket.id] = d.u;
            saveDB();
            socket.emit('login_ok', { u: d.u, b: 1000 });
        } else socket.emit('err', "Username Taken");
    });

    // Bets
    function placeBet(sock, game, d) {
        let u = activePlayers[sock.id];
        if(!u || timeLeft <= 0) return;
        if(users[u].balance >= d.amt) {
            users[u].balance -= d.amt;
            bets[game].push({ user: u, sock: sock.id, bet: d.bet, amt: d.amt });
            sock.emit('update_balance', users[u].balance);
        } else sock.emit('err', "No Funds");
    }
    socket.on('bet_color', (d) => placeBet(socket, 'color', d));
    socket.on('bet_roulette', (d) => placeBet(socket, 'roulette', d));
    socket.on('bet_baccarat', (d) => placeBet(socket, 'baccarat', d));

    // Blackjack
    socket.on('bj_deal', (amt) => {
        let u = activePlayers[socket.id];
        if(!u || users[u].balance < amt) return;
        users[u].balance -= amt;
        socket.emit('update_balance', users[u].balance);
        let deck = createDeck();
        let pHand = [draw(deck), draw(deck)];
        let dHand = [draw(deck), draw(deck)];
        socket.emit('bj_state', { pHand, dUp: dHand[0], dHide: dHand[1], deck, amt, turn: 'PLAYER' });
    });
    socket.on('bj_hit', (state) => {
        let card = draw(state.deck);
        state.pHand.push(card);
        if(handVal(state.pHand) > 21) socket.emit('bj_bust', state);
        else socket.emit('bj_update', { pHand: state.pHand });
    });
    socket.on('bj_stand', (state) => {
        let u = activePlayers[socket.id];
        let dHand = [state.dUp, state.dHide];
        let deck = state.deck;
        while(handVal(dHand) < 17) dHand.push(draw(deck));
        let pVal = handVal(state.pHand);
        let dVal = handVal(dHand);
        let win = 0;
        let res = "LOSE";
        if(dVal > 21 || pVal > dVal) { res = "WIN"; win = state.amt * 2; }
        else if (pVal === dVal) { res = "PUSH"; win = state.amt; }
        if(win > 0) {
            users[u].balance += win;
            socket.emit('update_balance', users[u].balance);
        }
        socket.emit('bj_end', { dHand, result: res, win });
        saveDB();
    });

    // --- ADMIN LOGIC ---
    socket.on('admin_req_data', () => {
        socket.emit('admin_data_resp', { users: users, active: activePlayers });
    });
    socket.on('admin_add_credits', (d) => {
        if(users[d.u]) {
            users[d.u].balance += parseInt(d.amt);
            saveDB();
            // Find player socket to update them live
            for(let [sid, name] of Object.entries(activePlayers)) {
                if(name === d.u) io.to(sid).emit('update_balance', users[d.u].balance);
            }
            socket.emit('admin_data_resp', { users: users, active: activePlayers });
        }
    });

    socket.on('disconnect', () => delete activePlayers[socket.id]);
});

// BJ Helpers
const SUITS = ['H','D','C','S']; const VALS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function createDeck() { let d=[]; SUITS.forEach(s=>VALS.forEach(v=>d.push({s,v}))); return d.sort(()=>Math.random()-.5); }
function draw(d) { return d.pop(); }
function handVal(h) {
    let v=0, a=0;
    h.forEach(c => { if(['J','Q','K'].includes(c.v)) v+=10; else if(c.v==='A') { a++; v+=11; } else v+=parseInt(c.v); });
    while(v>21 && a>0) { v-=10; a--; }
    return v;
}

// RAILWAY PORT FIX
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino Running on ${PORT}`));