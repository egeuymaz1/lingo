const peer = new Peer();
let conn = null;
let isHost = false;
let myTeamObj = { id: null, name: '', score: 0 };

// DOM Elements
const joinScreen = document.getElementById('join-screen');
const gameScreen = document.getElementById('game-screen');
const hostBtn = document.getElementById('host-btn');
const joinBtn = document.getElementById('join-btn');
const teamNameInput = document.getElementById('team-name');
const roomCodeInput = document.getElementById('room-code-input');
const connStatus = document.getElementById('connection-status');
const startGameBtn = document.getElementById('start-game-btn');
const leaderboardDisplay = document.getElementById('leaderboard');
const gameBoard = document.getElementById('game-board');
const turnIndicator = document.getElementById('turn-indicator');
const timerDisplay = document.getElementById('timer');
const currentLengthDisplay = document.getElementById('current-length');
const systemMessage = document.getElementById('system-message');

// --- GAME LOGIC (HOST ONLY) ---
const ROUNDS = [4, 5, 6, 7, 8, 9];
const TURN_TIME_LIMIT = 45;
let wordLists = {}; 
let gameState = {
    teams: [],         
    currentTurn: 0,    
    currentRoundIndex: 0,
    currentWordLength: 4,
    targetWord: "",
    firstLetter: "",
    isPlaying: false,
    timeLeft: TURN_TIME_LIMIT,
    boardState: [],
};
let hostTimerInterval = null;
let peers = []; // array of data connections

async function loadWordsForHost() {
    connStatus.textContent = "Kelimeler yükleniyor... Lütfen bekleyin.";
    for (let len of ROUNDS) {
        try {
            // Fetch words from data folder
            const res = await fetch(`data/${len}_harfli_kelimeler.txt`);
            if (res.ok) {
                const text = await res.text();
                wordLists[len] = text.split('\n').map(w => w.trim()).filter(w => w.length > 0);
            } else {
                wordLists[len] = [];
            }
        } catch (e) {
            console.error("Failed to load word length", len);
            wordLists[len] = [];
        }
    }
    connStatus.textContent = "Kelimeler yüklendi!";
}

function generateTargetWord(len) {
    const list = wordLists[len];
    if (!list || list.length === 0) return "ELMA"; // Fallback
    return list[Math.floor(Math.random() * list.length)];
}

function hostBroadcast(type, payload) {
    const msg = { type, payload };
    // Send to self
    handleIncomingMessage(msg);
    // Send to all peers
    peers.forEach(p => p.send(msg));
}

function hostStartNextTurn(previousWordInfo = null) {
    gameState.boardState = [];
    
    if (gameState.teams.length === 0) {
        gameState.isPlaying = false;
        clearInterval(hostTimerInterval);
        return;
    }

    gameState.currentTurn++;
    if (gameState.currentTurn >= gameState.teams.length) {
        gameState.currentTurn = 0;
        gameState.currentRoundIndex++;
        
        if (gameState.currentRoundIndex >= ROUNDS.length) {
            gameState.isPlaying = false;
            clearInterval(hostTimerInterval);
            hostBroadcast('gameOver', { teams: gameState.teams });
            return;
        }
        gameState.currentWordLength = ROUNDS[gameState.currentRoundIndex];
    }

    gameState.targetWord = generateTargetWord(gameState.currentWordLength);
    gameState.firstLetter = gameState.targetWord.charAt(0).toUpperCase();
    
    gameState.timeLeft = TURN_TIME_LIMIT;
    clearInterval(hostTimerInterval);
    hostTimerInterval = setInterval(() => {
        gameState.timeLeft--;
        hostBroadcast('timerTick', gameState.timeLeft);
        if (gameState.timeLeft <= 0) {
            clearInterval(hostTimerInterval);
            const prevWordInfo = { word: gameState.targetWord, reason: "timeout" };
            hostStartNextTurn(prevWordInfo);
        }
    }, 1000);
    
    hostBroadcast('turnStarted', {
        currentTurnTeamId: gameState.teams[gameState.currentTurn].id,
        currentWordLength: gameState.currentWordLength,
        firstLetter: gameState.firstLetter,
        timeLeft: gameState.timeLeft,
        previousTarget: previousWordInfo,
        teams: gameState.teams // to update UI
    });
}

function hostHandleGuess(teamId, guessWord) {
    if (!gameState.isPlaying) return;
    
    const activeTeam = gameState.teams[gameState.currentTurn];
    if (!activeTeam || activeTeam.id !== teamId) return; // Not their turn

    if (guessWord.length !== gameState.currentWordLength) return;

    const guessUpper = guessWord.toLocaleUpperCase('tr-TR');
    const targetUpper = gameState.targetWord.toLocaleUpperCase('tr-TR');

    const result = [];
    const targetCounts = {};
    for (let i = 0; i < targetUpper.length; i++) {
        targetCounts[targetUpper[i]] = (targetCounts[targetUpper[i]] || 0) + 1;
    }

    for (let i = 0; i < guessUpper.length; i++) {
        if (guessUpper[i] === targetUpper[i]) {
            result.push({ char: guessUpper[i], status: 'correct' });
            targetCounts[guessUpper[i]]--;
        } else {
            result.push({ char: guessUpper[i], status: 'absent' });
        }
    }
    for (let i = 0; i < guessUpper.length; i++) {
        if (result[i].status !== 'correct' && targetCounts[guessUpper[i]] > 0) {
            result[i].status = 'present';
            targetCounts[guessUpper[i]]--;
        }
    }

    gameState.boardState.push({ teamId, result });
    const isWin = guessUpper === targetUpper;

    if (isWin) {
        clearInterval(hostTimerInterval);
        const scoreGained = (gameState.currentWordLength * 10) + gameState.timeLeft;
        gameState.teams.find(t => t.id === teamId).score += scoreGained;
        
        hostBroadcast('guessResult', {
              boardState: gameState.boardState,
              isWin: true,
              scoreAdded: scoreGained,
              teamId: teamId,
              correctWord: targetUpper,
              teams: gameState.teams
        });
        
        setTimeout(() => hostStartNextTurn({ word: targetUpper, reason: "win" }), 4000);
    } else {
        const maxGuesses = gameState.currentWordLength + 1;
        if (gameState.boardState.length >= maxGuesses) {
            clearInterval(hostTimerInterval);
            hostBroadcast('guessResult', {
                boardState: gameState.boardState,
                isWin: false,
                teamId: teamId,
                correctWord: targetUpper,
                teams: gameState.teams
            });
            setTimeout(() => hostStartNextTurn({ word: targetUpper, reason: "max_guesses" }), 4000);
        } else {
            hostBroadcast('guessResult', {
               boardState: gameState.boardState,
               isWin: false,
               teamId: teamId
            });
        }
    }
}


// --- PEERJS SETUP ---

peer.on('open', (id) => {
    myTeamObj.id = id;
    console.log('My peer ID is: ' + id);
});

// Becoming a Host
hostBtn.addEventListener('click', async () => {
    const name = teamNameInput.value.trim() || 'Ev Sahibi';
    myTeamObj.name = name;
    isHost = true;
    
    // Load words
    await loadWordsForHost();

    // Add self to teams
    gameState.teams.push(myTeamObj);
    
    connStatus.innerHTML = `Oda Kuruldu! Arkadaşlarına Oda Kodunu Gönder: <br><span style="font-size:2em; letter-spacing: 2px;">${myTeamObj.id}</span>`;
    setTimeout(() => {
        joinScreen.classList.add('hidden');
        gameScreen.classList.remove('hidden');
        hostBroadcast('gameStateUpdate', gameState); // Update self UI
    }, 2000);
});

// Listening for incoming connections (Only Host does this usually)
peer.on('connection', (connection) => {
    if (!isHost) return;
    
    connection.on('open', () => {
        peers.push(connection);
    });

    connection.on('data', (data) => {
        if (data.type === 'joinTeam') {
            gameState.teams.push({ id: connection.peer, name: data.payload, score: 0 });
            hostBroadcast('gameStateUpdate', gameState);
        } else if (data.type === 'startGame' && !gameState.isPlaying) {
            gameState.isPlaying = true;
            gameState.currentTurn = -1;
            gameState.currentRoundIndex = 0;
            gameState.boardState = [];
            gameState.currentWordLength = ROUNDS[0];
            hostStartNextTurn();
        } else if (data.type === 'submitGuess') {
            hostHandleGuess(connection.peer, data.payload);
        }
    });

    connection.on('close', () => {
        peers = peers.filter(p => p.peer !== connection.peer);
        gameState.teams = gameState.teams.filter(t => t.id !== connection.peer);
        hostBroadcast('gameStateUpdate', gameState);
    });
});

// Joining a Room
joinBtn.addEventListener('click', () => {
    const name = teamNameInput.value.trim() || `Oyuncu-${Math.floor(Math.random()*100)}`;
    const roomCode = roomCodeInput.value.trim();
    if (!roomCode) {
        alert("Oda Kodu gerekli!");
        return;
    }
    
    myTeamObj.name = name;
    connStatus.textContent = "Bağlanıyor...";
    
    conn = peer.connect(roomCode);
    
    conn.on('open', () => {
        connStatus.textContent = "Bağlandı!";
        conn.send({ type: 'joinTeam', payload: name });
        setTimeout(() => {
            joinScreen.classList.add('hidden');
            gameScreen.classList.remove('hidden');
        }, 1000);
    });

    conn.on('data', (data) => {
        handleIncomingMessage(data);
    });

    conn.on('error', (err) => {
        connStatus.textContent = "Bağlantı hatası: " + err.message;
    });
});

// UI Control via Client Messages
startGameBtn.addEventListener('click', () => {
    if (isHost) {
        if (gameState.teams.length === 0) return;
        gameState.isPlaying = true;
        gameState.currentTurn = -1;
        gameState.currentRoundIndex = 0;
        gameState.boardState = [];
        gameState.currentWordLength = ROUNDS[0];
        hostStartNextTurn();
    } else if (conn) {
        conn.send({ type: 'startGame' });
    }
});

let currentWordLength = 4;
let isMyTurn = false;
let currentRowIndex = 0;
let currentGuess = "";

window.addEventListener('keydown', (e) => {
    if (!isMyTurn || !gameScreen.classList.contains('hidden') === false) return;

    if (e.key === 'Enter') {
        if (currentGuess.length === currentWordLength) {
            if (isHost) hostHandleGuess(myTeamObj.id, currentGuess);
            else if (conn) conn.send({ type: 'submitGuess', payload: currentGuess });
            
            isMyTurn = false; 
        } else {
            showMessage('Kelime eksik!', 'error');
        }
    } else if (e.key === 'Backspace') {
        currentGuess = currentGuess.slice(0, -1);
        updateCurrentRowPreview();
    } else if (/^[a-zçğıöşüA-ZÇĞIİÖŞÜ]$/.test(e.key) && currentGuess.length < currentWordLength) {
        currentGuess += e.key.toLocaleUpperCase('tr-TR');
        updateCurrentRowPreview();
    }
});

function updateCurrentRowPreview() {
    for (let i = 0; i < currentWordLength; i++) {
        const tile = document.getElementById(`tile-${currentRowIndex}-${i}`);
        if (tile) {
            tile.textContent = currentGuess[i] || '';
            if (currentGuess[i]) tile.classList.add('filled');
            else tile.classList.remove('filled');
        }
    }
}

function buildEmptyBoard(length, maxGuesses) {
    gameBoard.innerHTML = '';
    for (let r = 0; r < maxGuesses; r++) {
        const row = document.createElement('div');
        row.className = 'word-row';
        for (let c = 0; c < length; c++) {
            const tile = document.createElement('div');
            tile.className = 'tile';
            tile.id = `tile-${r}-${c}`;
            row.appendChild(tile);
        }
        gameBoard.appendChild(row);
    }
}

function updateBoard(boardState, firstLetter) {
    document.querySelectorAll('.tile').forEach(t => {
        t.textContent = '';
        t.removeAttribute('data-state');
        t.classList.remove('filled');
    });

    boardState.forEach((guess, rIndex) => {
        guess.result.forEach((letterObj, cIndex) => {
            const tile = document.getElementById(`tile-${rIndex}-${cIndex}`);
            if (tile) {
                tile.style.animationDelay = `${cIndex * 100}ms`;
                tile.textContent = letterObj.char;
                tile.setAttribute('data-state', letterObj.status);
            }
        });
    });

    currentRowIndex = boardState.length;
    const nextRowTile = document.getElementById(`tile-${currentRowIndex}-0`);
    if (nextRowTile && firstLetter) {
        nextRowTile.textContent = firstLetter;
        nextRowTile.classList.add('filled');
    }
}

function showMessage(msg, type='normal') {
    systemMessage.textContent = msg;
    systemMessage.style.color = type === 'error' ? '#f85149' : (type === 'success' ? '#3fb950' : '#8b949e');
    setTimeout(() => { if (systemMessage.textContent === msg) systemMessage.textContent = ''; }, 4000);
}

function renderLeaderboard(teams, activeTeamId, isPlaying) {
    leaderboardDisplay.innerHTML = '';
    teams.forEach(team => {
        const li = document.createElement('li');
        li.textContent = `${team.name} - ${team.score} Puan`;
        if (activeTeamId === team.id && isPlaying) {
            li.classList.add('active-turn');
        }
        if (team.id === myTeamObj.id) {
            li.style.color = '#58a6ff';
        }
        leaderboardDisplay.appendChild(li);
    });
}

function handleIncomingMessage(msg) {
    const { type, payload } = msg;

    if (type === 'gameStateUpdate') {
        const state = payload;
        
        // Ensure START GAME button is visible to HOST before game starts
        if (!state.isPlaying && isHost && state.teams.length > 0) {
            startGameBtn.classList.remove('hidden');
        } else {
            startGameBtn.classList.add('hidden');
        }
        
        renderLeaderboard(state.teams, null, state.isPlaying);
    } 
    else if (type === 'timerTick') {
        timerDisplay.textContent = payload;
        timerDisplay.style.color = payload <= 10 ? '#f85149' : '#58a6ff';
    } 
    else if (type === 'turnStarted') {
        currentWordLength = payload.currentWordLength;
        currentLengthDisplay.textContent = currentWordLength;
        timerDisplay.textContent = payload.timeLeft;
        isMyTurn = (payload.currentTurnTeamId === myTeamObj.id);
        
        renderLeaderboard(payload.teams, payload.currentTurnTeamId, true);
        
        if (payload.previousTarget) {
            if (payload.previousTarget.reason === 'win') showMessage(`Önceki takım bildi! Kelime: ${payload.previousTarget.word}`, 'success');
            else if (payload.previousTarget.reason === 'timeout') showMessage(`Süre Bitti! Kelime: ${payload.previousTarget.word}`, 'error');
            else showMessage(`Bilemediler! Kelime: ${payload.previousTarget.word}`, 'error');
        }

        if (isMyTurn) {
            turnIndicator.textContent = "🎮 SENİN SIRAN! Klavyeden Yaz.";
            turnIndicator.className = 'turn-banner';
            currentGuess = ""; 
        } else {
            const actTeam = payload.teams.find(t => t.id === payload.currentTurnTeamId);
            turnIndicator.textContent = `📍 Sıra ${actTeam ? actTeam.name : 'Bekleniyor'} takımında...`;
            turnIndicator.className = 'turn-banner wait';
        }

        const maxGuesses = currentWordLength + 1;
        buildEmptyBoard(currentWordLength, maxGuesses);
        updateBoard([], payload.firstLetter);
    } 
    else if (type === 'guessResult') {
        updateBoard(payload.boardState, '');

        if (payload.teams) renderLeaderboard(payload.teams, payload.teamId, true);

        if (payload.isWin) {
            showMessage(`Tebrikler Bildiniz! +${payload.scoreAdded} Puan`, 'success');
            turnIndicator.textContent = "✅ Doğru Tahmin!";
            turnIndicator.className = 'turn-banner';
        } else if (payload.correctWord) {
            showMessage(`Olamaz, bilemediniz... Kelime: ${payload.correctWord}`, 'error');
            turnIndicator.textContent = "❌ Başarısız!";
            turnIndicator.className = 'turn-banner error';
        } else {
            if (payload.teamId === myTeamObj.id) {
                 isMyTurn = true;
                 currentGuess = "";
            }
        }
    } 
    else if (type === 'gameOver') {
        gameBoard.innerHTML = '<h2>Oyun Bitti!</h2>';
        const sorted = payload.teams.sort((a,b) => b.score - a.score);
        if(sorted.length > 0) {
            gameBoard.innerHTML += `<p>Kazanan: ${sorted[0].name} (${sorted[0].score} Puan)</p>`;
        }
        if (isHost) startGameBtn.classList.remove('hidden');
        turnIndicator.textContent = "Oyun Bitti";
    }
}
