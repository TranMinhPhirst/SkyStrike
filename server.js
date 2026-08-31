const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- Game State ---
const spGames = new Map();      // socketId -> 1P game state
const rooms = new Map();        // roomId -> roomState
const playerRoom = new Map();   // socketId -> roomId
let matchQueue = [];            // Array of socketIds waiting for random 2P match

// --- Helpers ---
function removeFromQueue(socketId) {
  matchQueue = matchQueue.filter(id => id !== socketId);
}

function genRoomId() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 5; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

// 8-Cell Airplane Footprint Offsets Relative to Head (0,0) for 4 Orientations
const AIRPLANE_OFFSETS = {
  UP: [
    { r: 0, c: 0, isHead: true },
    { r: 1, c: -1 }, { r: 1, c: 0 }, { r: 1, c: 1 }, // Wings (3)
    { r: 2, c: 0 },                                  // Fuselage (1)
    { r: 3, c: -1 }, { r: 3, c: 0 }, { r: 3, c: 1 }  // Tail (3)
  ],
  RIGHT: [
    { r: 0, c: 0, isHead: true },
    { r: -1, c: -1 }, { r: 0, c: -1 }, { r: 1, c: -1 }, // Wings (3)
    { r: 0, c: -2 },                                     // Fuselage (1)
    { r: -1, c: -3 }, { r: 0, c: -3 }, { r: 1, c: -3 }   // Tail (3)
  ],
  DOWN: [
    { r: 0, c: 0, isHead: true },
    { r: -1, c: -1 }, { r: -1, c: 0 }, { r: -1, c: 1 }, // Wings (3)
    { r: -2, c: 0 },                                    // Fuselage (1)
    { r: -3, c: -1 }, { r: -3, c: 0 }, { r: -3, c: 1 }  // Tail (3)
  ],
  LEFT: [
    { r: 0, c: 0, isHead: true },
    { r: -1, c: 1 }, { r: 0, c: 1 }, { r: 1, c: 1 },    // Wings (3)
    { r: 0, c: 2 },                                     // Fuselage (1)
    { r: -1, c: 3 }, { r: 0, c: 3 }, { r: 1, c: 3 }     // Tail (3)
  ]
};

// Calculate 8 cell indices on 10x10 grid for headPos & orientation
function getAirplaneCells(headIdx, orientation = 'UP') {
  const headR = Math.floor(headIdx / 10);
  const headC = headIdx % 10;
  const offsets = AIRPLANE_OFFSETS[orientation] || AIRPLANE_OFFSETS.UP;

  const cells = [];
  let headCell = null;

  for (const off of offsets) {
    const r = headR + off.r;
    const c = headC + off.c;
    if (r < 0 || r >= 10 || c < 0 || c >= 10) return null; // Out of bounds!
    const idx = r * 10 + c;
    cells.push(idx);
    if (off.isHead) headCell = idx;
  }

  return { cells, headCell, orientation };
}

// Generate 2 valid random airplanes on 10x10 grid
function genRandomAirplanes() {
  const grid = Array(100).fill(false);
  const planes = [];
  const orientations = ['UP', 'RIGHT', 'DOWN', 'LEFT'];

  for (let p = 0; p < 2; p++) {
    let placed = false;
    let attempts = 0;
    while (!placed && attempts < 500) {
      attempts++;
      const headIdx = Math.floor(Math.random() * 100);
      const orient = orientations[Math.floor(Math.random() * orientations.length)];
      const res = getAirplaneCells(headIdx, orient);

      if (res && res.cells) {
        let overlap = false;
        for (const cIdx of res.cells) {
          if (grid[cIdx]) { overlap = true; break; }
        }

        if (!overlap) {
          res.cells.forEach(cIdx => grid[cIdx] = true);
          planes.push({
            name: `Máy bay #${p + 1}`,
            cells: res.cells,
            headCell: res.headCell,
            orientation: res.orientation
          });
          placed = true;
        }
      }
    }
  }
  return planes;
}

// Validate airplane placement array (2 planes, 8 cells each, no overlap)
function validateAirplanePlacement(planes) {
  if (!Array.isArray(planes) || planes.length !== 2) return false;
  const grid = Array(100).fill(false);

  for (const plane of planes) {
    if (!plane || !Array.isArray(plane.cells) || plane.cells.length !== 8) return false;
    if (typeof plane.headCell !== 'number' || !plane.cells.includes(plane.headCell)) return false;

    for (const cIdx of plane.cells) {
      if (typeof cIdx !== 'number' || cIdx < 0 || cIdx >= 100) return false;
      if (grid[cIdx]) return false; // Overlap!
      grid[cIdx] = true;
    }
  }
  return true;
}

// Evaluate shot against airplane fleet (Head-shot instant destruction rule)
function evaluateShot(shotIdx, planes, previousShots = []) {
  let hit = false;
  let isHeadHit = false;
  let hitPlane = null;

  for (const plane of planes) {
    if (plane.cells.includes(shotIdx)) {
      hit = true;
      hitPlane = plane;
      if (shotIdx === plane.headCell) {
        isHeadHit = true;
      }
      break;
    }
  }

  const allShots = [...previousShots, shotIdx];

  // A plane is SUNK if its HEAD is hit!
  let newlySunkPlane = null;
  planes.forEach(plane => {
    const headHit = allShots.includes(plane.headCell);
    if (headHit) {
      plane.isSunk = true;
      if (hitPlane && hitPlane.headCell === plane.headCell && isHeadHit) {
        newlySunkPlane = plane;
      }
    }
  });

  // Calculate active (un-sunk) plane cells
  const activeCells = [];
  planes.forEach(plane => {
    if (!allShots.includes(plane.headCell)) {
      plane.cells.forEach(c => {
        if (!allShots.includes(c)) activeCells.push(c);
      });
    }
  });

  // All sunk if both 2 plane heads are hit
  const allSunk = planes.every(p => allShots.includes(p.headCell));

  // Manhattan Distance to nearest active plane cell
  let radarDistance = 99;
  const sR = Math.floor(shotIdx / 10);
  const sC = shotIdx % 10;

  activeCells.forEach(cIdx => {
    const r = Math.floor(cIdx / 10);
    const c = cIdx % 10;
    const dist = Math.abs(sR - r) + Math.abs(sC - c);
    if (dist < radarDistance) radarDistance = dist;
  });

  return {
    hit,
    isHeadHit,
    sunkPlane: newlySunkPlane ? { name: newlySunkPlane.name, headCell: newlySunkPlane.headCell, cells: newlySunkPlane.cells } : null,
    allSunk,
    radarDistance: radarDistance === 99 ? 0 : radarDistance
  };
}

// AI Bot shot selector for 1P mode on 10x10 grid
function getAIShot(aiShots, playerPlanes) {
  const unshot = [];
  for (let i = 0; i < 100; i++) {
    if (!aiShots.includes(i)) unshot.push(i);
  }
  if (unshot.length === 0) return 0;

  // Hunt mode: check hits that didn't sink plane yet
  const hitShots = aiShots.filter(idx => {
    return playerPlanes.some(p => p.cells.includes(idx) && !aiShots.includes(p.headCell));
  });

  for (const hitIdx of hitShots) {
    const r = Math.floor(hitIdx / 10);
    const c = hitIdx % 10;
    const neighbors = [
      r > 0 ? (r - 1) * 10 + c : null,
      r < 9 ? (r + 1) * 10 + c : null,
      c > 0 ? r * 10 + (c - 1) : null,
      c < 9 ? r * 10 + (c + 1) : null
    ].filter(idx => idx !== null && !aiShots.includes(idx));

    if (neighbors.length > 0) {
      return neighbors[Math.floor(Math.random() * neighbors.length)];
    }
  }

  // Random unshot cell
  return unshot[Math.floor(Math.random() * unshot.length)];
}

// --- Server Turn Timer (30s) ---
function clearTurnTimer(room) {
  if (room && room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  if (!room || room.phase !== 'playing') return;

  const duration = 30;
  room.turnDuration = duration;
  room.turnStartTime = Date.now();

  room.turnTimer = setTimeout(() => {
    handleTurnTimeout(room.id);
  }, duration * 1000);
}

function handleTurnTimeout(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== 'playing') return;

  const currentP = room.players[room.turn];
  if (!currentP) return;

  io.to(roomId).emit('turn-timeout-notice', {
    playerNumber: currentP.number,
    message: `Người chơi ${currentP.number} đã hết 30s lượt!`
  });

  room.turn = 1 - room.turn;
  if (room.turn === 0) room.round++;
  const nextP = room.players[room.turn];

  io.to(roomId).emit('turn-update', {
    currentTurn: nextP.number,
    round: room.round,
    turnDuration: 30
  });

  startTurnTimer(room);
}

function deleteRoom(rid) {
  const room = rooms.get(rid);
  if (room) {
    clearTurnTimer(room);
    room.players.forEach(p => {
      playerRoom.delete(p.id);
      const s = io.sockets.sockets.get(p.id);
      if (s) s.leave(rid);
    });
    rooms.delete(rid);
  }
}

function leaveCurrentRoom(socket) {
  const rid = playerRoom.get(socket.id);
  if (rid) {
    const room = rooms.get(rid);
    if (room) {
      io.to(rid).emit('opponent-disconnected', { message: 'Đối thủ đã thoát phòng! Phòng đấu đã bị hủy.' });
      deleteRoom(rid);
    }
    playerRoom.delete(socket.id);
  }
}

function broadcastRoomUpdate(room) {
  const playerList = room.players.map(p => ({ number: p.number, isHost: p.id === room.host }));
  const canStart = room.players.length === 2;

  room.players.forEach(p => {
    io.to(p.id).emit('room-updated', {
      roomId: room.id,
      playerNumber: p.number,
      isHost: p.id === room.host,
      players: playerList,
      canStart
    });
  });
}

// --- Socket.IO Handlers ---
io.on('connection', (socket) => {

  // ===== 1P MODE =====
  socket.on('start-1p', ({ planes }) => {
    removeFromQueue(socket.id);
    leaveCurrentRoom(socket);

    const playerPlanes = validateAirplanePlacement(planes) ? planes : genRandomAirplanes();
    const aiPlanes = genRandomAirplanes();

    spGames.set(socket.id, {
      playerPlanes,
      aiPlanes,
      playerShots: [],
      aiShots: [],
      turn: 'player'
    });

    socket.emit('game-started-1p', { playerPlanes });
  });

  socket.on('fire-1p', ({ shotIndex }) => {
    const game = spGames.get(socket.id);
    if (!game || game.turn !== 'player') return;
    if (typeof shotIndex !== 'number' || shotIndex < 0 || shotIndex >= 100) return;
    if (game.playerShots.includes(shotIndex)) return;

    // Player shoots AI
    const evalRes = evaluateShot(shotIndex, game.aiPlanes, game.playerShots);
    game.playerShots.push(shotIndex);

    if (evalRes.allSunk) {
      spGames.delete(socket.id);
      return socket.emit('fire-result-1p', {
        playerShot: { shotIndex, ...evalRes },
        aiShot: null,
        gameOver: true,
        won: true
      });
    }

    // AI shoots Player
    const aiShotIdx = getAIShot(game.aiShots, game.playerPlanes);
    const aiEval = evaluateShot(aiShotIdx, game.playerPlanes, game.aiShots);
    game.aiShots.push(aiShotIdx);

    const playerLost = aiEval.allSunk;
    if (playerLost) spGames.delete(socket.id);

    socket.emit('fire-result-1p', {
      playerShot: { shotIndex, ...evalRes },
      aiShot: { shotIndex: aiShotIdx, ...aiEval },
      gameOver: playerLost,
      won: false
    });
  });

  // ===== 2P MULTIPLAYER & ROOMS =====
  socket.on('find-random-match', () => {
    removeFromQueue(socket.id);
    leaveCurrentRoom(socket);

    matchQueue = matchQueue.filter(id => io.sockets.sockets.has(id));

    if (matchQueue.length > 0) {
      const oppId = matchQueue.shift();

      let id; do { id = genRoomId(); } while (rooms.has(id));
      const room = {
        id, host: oppId,
        players: [{ id: oppId, number: 1 }, { id: socket.id, number: 2 }],
        planes: {}, shots: { [oppId]: [], [socket.id]: [] },
        turn: 0, round: 1, phase: 'placing', createdAt: Date.now()
      };

      rooms.set(id, room);
      playerRoom.set(oppId, id);
      playerRoom.set(socket.id, id);

      const oppSocket = io.sockets.sockets.get(oppId);
      if (oppSocket) oppSocket.join(id);
      socket.join(id);

      io.to(oppId).emit('your-info', { playerNumber: 1 });
      io.to(socket.id).emit('your-info', { playerNumber: 2 });
      io.to(id).emit('room-ready');
    } else {
      matchQueue.push(socket.id);
      socket.emit('searching-match');
    }
  });

  socket.on('cancel-random-match', () => {
    removeFromQueue(socket.id);
    socket.emit('match-cancelled');
  });

  socket.on('create-room', () => {
    removeFromQueue(socket.id);
    leaveCurrentRoom(socket);

    let id; do { id = genRoomId(); } while (rooms.has(id));
    const room = {
      id, host: socket.id,
      players: [{ id: socket.id, number: 1 }],
      planes: {}, shots: { [socket.id]: [] },
      turn: 0, round: 1, phase: 'waiting', createdAt: Date.now()
    };

    rooms.set(id, room);
    playerRoom.set(socket.id, id);
    socket.join(id);

    broadcastRoomUpdate(room);
  });

  socket.on('join-room', ({ roomId }) => {
    removeFromQueue(socket.id);
    leaveCurrentRoom(socket);

    const rid = (roomId || '').toUpperCase().trim();
    const room = rooms.get(rid);
    if (!room) return socket.emit('error-msg', { message: 'Không tìm thấy phòng!' });
    if (room.players.length >= 2) return socket.emit('error-msg', { message: 'Phòng đã đầy!' });
    if (room.phase !== 'waiting') return socket.emit('error-msg', { message: 'Game đã bắt đầu!' });

    room.players.push({ id: socket.id, number: 2 });
    room.shots[socket.id] = [];
    playerRoom.set(socket.id, rid);
    socket.join(rid);

    broadcastRoomUpdate(room);
  });

  socket.on('start-game-host', () => {
    const rid = playerRoom.get(socket.id);
    const room = rid && rooms.get(rid);
    if (!room || room.host !== socket.id || room.phase !== 'waiting') return;
    if (room.players.length !== 2) return socket.emit('error-msg', { message: 'Cần đúng 2 người chơi!' });

    room.phase = 'placing';
    room.players.forEach(p => io.to(p.id).emit('your-info', { playerNumber: p.number }));
    io.to(rid).emit('room-ready');
  });

  socket.on('set-planes-2p', ({ planes }) => {
    const rid = playerRoom.get(socket.id);
    const room = rid && rooms.get(rid);
    if (!room || room.phase !== 'placing') return;

    const validPlanes = validateAirplanePlacement(planes) ? planes : genRandomAirplanes();
    room.planes[socket.id] = validPlanes;
    socket.emit('planes-confirmed', { planes: validPlanes });

    if (Object.keys(room.planes).length === 2) {
      room.phase = 'playing';
      room.turn = 0;
      room.round = 1;

      io.to(rid).emit('game-started-2p', {
        currentTurn: 1,
        round: 1,
        turnDuration: 30
      });
      startTurnTimer(room);
    }
  });

  socket.on('fire-2p', ({ shotIndex }) => {
    const rid = playerRoom.get(socket.id);
    const room = rid && rooms.get(rid);
    if (!room || room.phase !== 'playing') return;

    const currentP = room.players[room.turn];
    if (!currentP || currentP.id !== socket.id) return;
    if (typeof shotIndex !== 'number' || shotIndex < 0 || shotIndex >= 100) return;

    const oppP = room.players[1 - room.turn];
    const oppPlanes = room.planes[oppP.id];
    const myShots = room.shots[socket.id];

    if (myShots.includes(shotIndex)) return;

    const evalRes = evaluateShot(shotIndex, oppPlanes, myShots);
    myShots.push(shotIndex);

    // Broadcast shot to both players
    io.to(rid).emit('fire-broadcast-2p', {
      shooterNumber: currentP.number,
      shotIndex,
      ...evalRes
    });

    if (evalRes.allSunk) {
      room.phase = 'finished';
      clearTurnTimer(room);

      room.players.forEach(p => {
        io.to(p.id).emit('game-over-2p', {
          result: p.id === socket.id ? 'win' : 'lose',
          winnerNumber: currentP.number,
          planes: room.planes
        });
      });

      setTimeout(() => deleteRoom(rid), 60000);
      return;
    }

    // Switch turn
    room.turn = 1 - room.turn;
    if (room.turn === 0) room.round++;
    const nextP = room.players[room.turn];

    io.to(rid).emit('turn-update', {
      currentTurn: nextP.number,
      round: room.round,
      turnDuration: 30
    });

    startTurnTimer(room);
  });

  socket.on('leave-room', () => {
    removeFromQueue(socket.id);
    leaveCurrentRoom(socket);
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    spGames.delete(socket.id);
    leaveCurrentRoom(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SkyStrike Air Strike Server: http://localhost:${PORT}`));
