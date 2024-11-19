import express from 'express';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
app.use(express.static(path.join(__dirname, 'build')));
app.use(cors());
const io = new Server(server, { 
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
      }
});

const rooms = {}; 
const watchers = new Set(); 
const idSocketCompare = {};
const delayLeaving = {};

app.use(express.json());

function updateRoomList() {
    watchers.forEach(socket => socket.emit('list', { rooms: Object.values(rooms) }));
}

function createRoom(socket, { name, password, player, number }) {
    if (rooms[name]) {
        return socket.emit('error', { message: 'Комната уже существует' });
    }

    rooms[name] = {
        name,
        password,
        number,
        players: {[player.id]: player},
        game: null
    };
    updateRoomList();
}

function leaveDelay(socket, { name, id }) {
    if (!rooms[name]) return
    if (!rooms[name].players[id]) return
    rooms[name].players[id].waiting = true
    delayLeaving[id] = {
        room: name,
        timeout: setTimeout(() => {
            leaveRoom(socket, { name, id })
        }, 20*1000)
    }
    broadcastRoomState(name)
}

function leaveRoom(socket, { name, id }) {
    if (!rooms[name]) return socket.emit('error', { message: 'Комната не найдена' });

    const game = rooms[name].game
    if (game) {
        game.players = game.players.filter(p => p.id !== id);
    }

    delete rooms[name].players[id]
    delete delayLeaving[id]
    broadcastRoomState(name);

    if (!Object.keys(rooms[name].players).length) {
        delete rooms[name]
    } else if (game && rooms[name].game.players.length === 1) 
        endGame(name, rooms[name].game.players[0])

    updateRoomList();
}

function joinRoom(socket, { name, password, player }) {
    const room = rooms[name];
    if (!room) return socket.emit('error', { message: 'Комната не найдена' });
    if (room.password && room.password !== password) {
        return socket.emit('forbidden');
    }
    
    if ((delayLeaving[player.id]?.room !== name) && delayLeaving[player.id]?.room) {
        clearTimeout(delayLeaving[player.id].timeout)
        leaveRoom(socket, { name: delayLeaving[player.id].room, id: player.id })
    }
    if (delayLeaving[player.id]?.room === name) {
        rooms[name].players[player.id].waiting = false
        clearTimeout(delayLeaving[player.id].timeout)
        broadcastRoomState(name)
    } else {
        room.players[player.id] = player;
        updateRoomList();
        broadcastRoomState(name)
    
        if (Object.keys(room.players).length === room.number) {
            broadcastRoomState(name, 'prestart')
            setTimeout(() => startGame(name), 5000);
        }
    }

    delete delayLeaving[player.id]
}

function startGame(roomName, restart=false) {
    const room = rooms[roomName];
    
    if (!room || Object.keys(room.players).length < room.number) return;

    room.game = {
        currentPlayer: 0,
        currentBid: null,
        players: Object.keys(room.players).map(player => ({
            name: room.players[player].name,
            id: room.players[player].id,
            dices: Array(5).fill().map(() => Math.floor(Math.random() * 6) + 1),
            diceCount: 5
        }))
    };
    
    if (restart) broadcastRoomState(roomName, 'restart', { room })
    else broadcastRoomState(roomName);
}

function broadcastRoomState(roomName, eventName, eventArgument) {
    const room = rooms[roomName]
    Object.values(room.players).forEach(player => {
        const socket = idSocketCompare[player.id];
        if (socket?.connected) {
            if (eventName) socket.emit(eventName, eventArgument)
            else socket.emit('room', { room });
        }
    });
}

function raiseBid(socket, { roomName, bid }) {
    const room = rooms[roomName];
    const game = room.game;
    
    game.currentBid = bid;
    game.currentPlayer = (game.currentPlayer + 1) % game.players.length;
    broadcastRoomState(roomName, 'raised', { bid, nextPlayer: game.players[game.currentPlayer] })
    broadcastRoomState(roomName);
}

function endGame(roomName, winner, totalCount) {
    const room = rooms[roomName]

    if (Object.keys(room.players).length === room.number) {
        broadcastRoomState(roomName, 'win', { user: winner, totalCount })
        room.game = null;
        setTimeout(() => {
            broadcastRoomState(roomName);
            broadcastRoomState(roomName, 'prestart')
        }, 10*1000);
        setTimeout(() => startGame(roomName, true), 15*1000);
    } else {
        room.game = null;
        broadcastRoomState(roomName);
    }
}

function doubt(socket, { roomName }) {
    const room = rooms[roomName];
    const game = room.game;
    const currentBid = game.currentBid;
    const allDice = game.players.flatMap(player => player.dices);
    const totalDiceCount = allDice.filter(dice => dice === currentBid.value || dice === 1).length;

    const playerLosesDice = totalDiceCount >= currentBid.count
        ? game.currentPlayer
        : (game.currentPlayer + game.players.length - 1) % game.players.length

    game.players[playerLosesDice].diceCount -= 1;

    if (game.players[playerLosesDice].diceCount === 0) {
        broadcastRoomState(roomName, 'loose', { 
            user: game.players[playerLosesDice], 
            nextPlayer: game.players[totalDiceCount >= currentBid.count ? (game.currentPlayer + 1) % game.players.length : game.currentPlayer],
            totalCount: room.game.players.reduce((acc, player) => acc + player.dices.filter(dice => dice === currentBid.value || dice === 1).length, 0)
        })
        game.players = game.players.filter(p => p.diceCount > 0);
    } else {
        broadcastRoomState(roomName, 'endRound', { 
            user: game.players[playerLosesDice], 
            nextPlayer: game.players[totalDiceCount >= currentBid.count ? (game.currentPlayer + 1) % game.players.length : game.currentPlayer],
            totalCount: room.game.players.reduce((acc, player) => acc + player.dices.filter(dice => dice === currentBid.value || dice === 1).length, 0)
        })
    }

    if (game.players.length === 1) {
        return endGame(roomName, game.players[0], totalDiceCount)
    }
    
    for (const player of Object.keys(game.players)) {
        game.players[player].dices = Array(game.players[player].diceCount).fill().map(() => Math.floor(Math.random() * 6) + 1)
    }
        
    if (totalDiceCount >= currentBid.count) 
        game.currentPlayer = (game.currentPlayer + 1) % game.players.length;
    game.currentBid = null
    broadcastRoomState(roomName);
}

function unmountUser(socket) {
    watchers.delete(socket);

    let playerId;
    for (let id of Object.keys(idSocketCompare)) {
        if (socket.id === idSocketCompare[id].id) {
            playerId = id
            delete idSocketCompare[id]
            break
        }
    }

    for (let room of Object.values(rooms)) {
        if (Object.keys(room.players).includes(playerId))
            leaveDelay(socket, { name: room.name, id: playerId })
    }
}

io.on('connection', (socket) => {
    socket.on('createRoom', (data) => {
        createRoom(socket, data);
    });

    socket.on('joinRoom', (data) => {
        idSocketCompare[data.player.id] = socket
        joinRoom(socket, data);
    });

    socket.on('leaveDelay', (data) => {
        leaveDelay(socket, data);
    });

    socket.on('leaveImmediate', (data) => {
        leaveRoom(socket, data);
    });

    socket.on('raiseBid', (data) => {
        raiseBid(socket, data);
    });

    socket.on('doubt', (data) => {
        doubt(socket, data);
    });

    socket.on('watch', (id) => {
        idSocketCompare[id] = socket
        watchers.add(socket);
        updateRoomList();
    });

    socket.on('disconnect', () => {
        unmountUser(socket)
    });
});

app.get('/*', function (req, res) {
    res.sendFile(path.join(__dirname, 'build', 'index.html'))
});  

server.listen(3000, () => {
    console.log(`Server listening on ${3000}`);
});