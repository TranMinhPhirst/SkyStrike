document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // Helper DOM selectors
  const $ = selector => document.querySelector(selector);
  const $$ = selector => document.querySelectorAll(selector);

  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }

  function showScreen(id) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    const target = $(`#${id}`);
    if (target) target.classList.add('active');
  }

  function showError(sel, msg) {
    const el = $(sel);
    if (el) {
      el.textContent = msg;
      show(el);
      setTimeout(() => hide(el), 4000);
    }
  }

  // --- Game State ---
  let mode = '1p';                 // Default mode '1p'
  let playerNumber = 1;            // 1 or 2
  let isHost = false;
  let roomId = null;
  let gameActive = false;
  let isMyTurn = false;
  let currentRound = 1;
  let isSubmitting = false;

  // Turn Timer
  let timerInterval = null;
  let turnTimerSec = 30;

  // Airplane Placement State
  const AIRPLANE_OFFSETS = {
    UP: [
      { r: 0, c: 0, isHead: true },
      { r: 1, c: -1 }, { r: 1, c: 0 }, { r: 1, c: 1 },
      { r: 2, c: 0 },
      { r: 3, c: -1 }, { r: 3, c: 0 }, { r: 3, c: 1 }
    ],
    RIGHT: [
      { r: 0, c: 0, isHead: true },
      { r: -1, c: -1 }, { r: 0, c: -1 }, { r: 1, c: -1 },
      { r: 0, c: -2 },
      { r: -1, c: -3 }, { r: 0, c: -3 }, { r: 1, c: -3 }
    ],
    DOWN: [
      { r: 0, c: 0, isHead: true },
      { r: -1, c: -1 }, { r: -1, c: 0 }, { r: -1, c: 1 },
      { r: -2, c: 0 },
      { r: -3, c: -1 }, { r: -3, c: 0 }, { r: -3, c: 1 }
    ],
    LEFT: [
      { r: 0, c: 0, isHead: true },
      { r: -1, c: 1 }, { r: 0, c: 1 }, { r: 1, c: 1 },
      { r: 0, c: 2 },
      { r: -1, c: 3 }, { r: 0, c: 3 }, { r: 1, c: 3 }
    ]
  };

  let selectedPlaneIdx = 0;             // Active slot: 0 (Máy Bay #1) or 1 (Máy Bay #2)
  let currentOrient = 'UP';             // 'UP', 'RIGHT', 'DOWN', 'LEFT'
  let myPlanes = [null, null];          // Independent slots: [planeObj, planeObj]

  // Shot Trackers
  let myShots = [];                     // Array of shot objects
  let enemyShotsOnMe = [];              // Array of shot objects from enemy

  // ===== INITIALIZE PLACEMENT GRID (10x10) =====
  function initPlacementBoard() {
    const gridEl = $('#placement-grid');
    gridEl.innerHTML = '';

    for (let i = 0; i < 100; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.index = i;

      cell.addEventListener('mouseenter', () => handlePlacementHover(i));
      cell.addEventListener('mouseleave', () => handlePlacementLeave());
      cell.addEventListener('click', () => handlePlacementClick(i));

      gridEl.appendChild(cell);
    }
    renderPlacementGrid();
    updatePlaneSelectorUI();
  }

  function getAirplaneCellsForHead(headIdx, orient) {
    const headR = Math.floor(headIdx / 10);
    const headC = headIdx % 10;
    const offsets = AIRPLANE_OFFSETS[orient] || AIRPLANE_OFFSETS.UP;

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
    return { cells, headCell };
  }

  // Check overlap against the OTHER placed plane slot (1 - selectedPlaneIdx)
  function isOverlapWithOtherPlane(cells) {
    const otherPlane = myPlanes[1 - selectedPlaneIdx];
    if (!otherPlane || !otherPlane.cells) return false;
    return cells.some(c => otherPlane.cells.includes(c));
  }

  function handlePlacementHover(headIdx) {
    const res = getAirplaneCellsForHead(headIdx, currentOrient);

    const gridEl = $('#placement-grid');
    const allCells = gridEl.querySelectorAll('.cell');

    allCells.forEach(c => c.classList.remove('cell-preview-head', 'cell-preview-body', 'cell-preview-invalid'));

    if (!res || isOverlapWithOtherPlane(res.cells)) {
      if (res && res.cells) {
        res.cells.forEach(idx => allCells[idx]?.classList.add('cell-preview-invalid'));
      }
    } else {
      res.cells.forEach(idx => {
        if (idx === res.headCell) {
          allCells[idx]?.classList.add('cell-preview-head');
        } else {
          allCells[idx]?.classList.add('cell-preview-body');
        }
      });
    }
  }

  function handlePlacementLeave() {
    const gridEl = $('#placement-grid');
    gridEl.querySelectorAll('.cell').forEach(c => c.classList.remove('cell-preview-head', 'cell-preview-body', 'cell-preview-invalid'));
  }

  function handlePlacementClick(headIdx) {
    const res = getAirplaneCellsForHead(headIdx, currentOrient);

    if (!res || isOverlapWithOtherPlane(res.cells)) return;

    // Place or update plane independently at selectedPlaneIdx slot!
    myPlanes[selectedPlaneIdx] = {
      name: `Máy bay #${selectedPlaneIdx + 1}`,
      cells: res.cells,
      headCell: res.headCell,
      orientation: currentOrient
    };

    // If the other slot is empty, auto toggle to the other slot for quick placement
    if (myPlanes[1 - selectedPlaneIdx] === null) {
      selectedPlaneIdx = 1 - selectedPlaneIdx;
    }

    updatePlaneSelectorUI();
    renderPlacementGrid();
    checkConfirmButtonState();
  }

  function updatePlaneSelectorUI() {
    $$('.plane-slot-item').forEach((el, idx) => {
      el.classList.remove('active', 'placed');
      const badge = $(`#slot-badge-${idx}`);

      if (myPlanes[idx] !== null) {
        el.classList.add('placed');
        if (badge) badge.textContent = 'Đã đặt 8 Ô';
      } else {
        if (badge) badge.textContent = 'Chưa đặt';
      }

      if (idx === selectedPlaneIdx) {
        el.classList.add('active');
      }
    });
  }

  function checkConfirmButtonState() {
    const bothPlaced = myPlanes[0] !== null && myPlanes[1] !== null;
    $('#btn-confirm-ships').disabled = !bothPlaced;
  }

  function renderPlacementGrid() {
    const gridEl = $('#placement-grid');
    if (!gridEl) return;
    const allCells = gridEl.querySelectorAll('.cell');

    allCells.forEach(c => c.className = 'cell');

    myPlanes.forEach(plane => {
      if (plane && plane.cells) {
        plane.cells.forEach(idx => {
          if (allCells[idx]) {
            if (idx === plane.headCell) {
              allCells[idx].classList.add('cell-plane-head');
            } else {
              allCells[idx].classList.add('cell-plane-body');
            }
          }
        });
      }
    });
  }

  function autoPlaceAirplanes() {
    const grid = Array(100).fill(false);
    const newPlanes = [];
    const orientations = ['UP', 'RIGHT', 'DOWN', 'LEFT'];

    for (let p = 0; p < 2; p++) {
      let placed = false;
      let attempts = 0;
      while (!placed && attempts < 500) {
        attempts++;
        const headIdx = Math.floor(Math.random() * 100);
        const orient = orientations[Math.floor(Math.random() * orientations.length)];
        const res = getAirplaneCellsForHead(headIdx, orient);

        if (res && res.cells) {
          let overlap = false;
          for (const cIdx of res.cells) {
            if (grid[cIdx]) { overlap = true; break; }
          }

          if (!overlap) {
            res.cells.forEach(cIdx => grid[cIdx] = true);
            newPlanes.push({
              name: `Máy bay #${p + 1}`,
              cells: res.cells,
              headCell: res.headCell,
              orientation: orient
            });
            placed = true;
          }
        }
      }
    }

    myPlanes = newPlanes;
    selectedPlaneIdx = 0;
    updatePlaneSelectorUI();
    renderPlacementGrid();
    checkConfirmButtonState();
  }

  // ===== BATTLE BOARDS INITIALIZATION & RENDER (10x10) =====
  function initBattleBoards() {
    // 1. Render My Fleet Board
    const myGrid = $('#my-fleet-grid');
    myGrid.innerHTML = '';
    for (let i = 0; i < 100; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.index = i;
      myGrid.appendChild(cell);
    }
    renderMyFleetGrid();

    // 2. Render Radar Attack Board
    const atkGrid = $('#attack-grid');
    atkGrid.innerHTML = '';
    for (let i = 0; i < 100; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.index = i;
      cell.addEventListener('click', () => handleAttackCellClick(i));
      atkGrid.appendChild(cell);
    }
    renderAttackGrid();
  }

  function renderMyFleetGrid() {
    const myGrid = $('#my-fleet-grid');
    if (!myGrid) return;
    const cells = myGrid.querySelectorAll('.cell');

    cells.forEach(c => c.className = 'cell');

    // Show my airplanes
    myPlanes.forEach(plane => {
      if (plane && plane.cells) {
        plane.cells.forEach(idx => {
          if (cells[idx]) {
            if (idx === plane.headCell) {
              cells[idx].classList.add('cell-plane-head');
            } else {
              cells[idx].classList.add('cell-plane-body');
            }
          }
        });
      }
    });

    // Show enemy shots on my fleet
    enemyShotsOnMe.forEach(shot => {
      const c = cells[shot.shotIndex];
      if (c) {
        if (shot.isHeadHit) {
          c.classList.add('cell-head-hit');
        } else if (shot.hit) {
          c.classList.add('cell-hit');
        } else {
          c.classList.add('cell-miss');
        }
      }
    });

    // Mark entire sunk planes
    myPlanes.forEach(plane => {
      if (plane && plane.cells) {
        const headDestroyed = enemyShotsOnMe.some(s => s.shotIndex === plane.headCell && s.isHeadHit);
        if (headDestroyed) {
          plane.cells.forEach(idx => {
            if (cells[idx]) cells[idx].classList.add('cell-sunk');
          });
        }
      }
    });

    // Update status badge
    const sunkCount = myPlanes.filter(p => p && enemyShotsOnMe.some(s => s.shotIndex === p.headCell && s.isHeadHit)).length;
    $('#my-fleet-status').textContent = `${2 - sunkCount}/2 Sống`;
  }

  function renderAttackGrid() {
    const atkGrid = $('#attack-grid');
    if (!atkGrid) return;
    const cells = atkGrid.querySelectorAll('.cell');

    cells.forEach(c => {
      c.className = 'cell';
      c.innerHTML = '';
    });

    myShots.forEach(shot => {
      const c = cells[shot.shotIndex];
      if (c) {
        if (shot.isHeadHit) {
          c.classList.add('cell-head-hit');
        } else if (shot.hit) {
          c.classList.add('cell-hit');
        } else {
          c.classList.add('cell-miss');
          if (shot.radarDistance > 0) {
            const badge = document.createElement('span');
            badge.className = 'cell-radar-badge';
            badge.textContent = `d:${shot.radarDistance}`;
            c.appendChild(badge);
          }
        }
      }

      // Mark all cells of a sunk plane if newly sunk
      if (shot.sunkPlane && shot.sunkPlane.cells) {
        shot.sunkPlane.cells.forEach(cIdx => {
          if (cells[cIdx]) cells[cIdx].classList.add('cell-sunk');
        });
      }
    });
  }

  function handleAttackCellClick(shotIndex) {
    if (!gameActive || !isMyTurn || isSubmitting) return;
    if (myShots.some(s => s.shotIndex === shotIndex)) {
      return showError('#game-error', 'Bạn đã bắn ô này rồi!');
    }

    isSubmitting = true;
    if (mode === '1p') {
      socket.emit('fire-1p', { shotIndex });
    } else {
      socket.emit('fire-2p', { shotIndex });
    }
  }

  // ===== TURN TIMER LOGIC =====
  function startTurnTimer(duration = 30) {
    stopTurnTimer();
    turnTimerSec = duration;

    const timerBadge = $('#timer-label');
    const timerSecEl = $('#timer-sec');
    const turnCountEl = $('#turn-timer-count');

    if (timerSecEl) timerSecEl.textContent = turnTimerSec;
    if (turnCountEl) turnCountEl.textContent = turnTimerSec;
    if (timerBadge) {
      show(timerBadge);
      timerBadge.classList.remove('pulse-red');
    }

    timerInterval = setInterval(() => {
      turnTimerSec--;
      if (timerSecEl) timerSecEl.textContent = turnTimerSec;
      if (turnCountEl) turnCountEl.textContent = turnTimerSec;

      if (turnTimerSec <= 5 && timerBadge) {
        timerBadge.classList.add('pulse-red');
      }

      if (turnTimerSec <= 0) {
        stopTurnTimer();
      }
    }, 1000);
  }

  function stopTurnTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    const timerBadge = $('#timer-label');
    if (timerBadge) timerBadge.classList.remove('pulse-red');
  }

  function updateTurnUI() {
    const textEl = $('#turn-text');
    const atkGrid = $('#attack-grid');

    if (isMyTurn) {
      if (textEl) textEl.textContent = 'Lượt của bạn - Click Radar để ngắm bắn vào ĐẦU máy bay!';
      if (atkGrid) atkGrid.classList.add('interactive');
    } else {
      if (textEl) textEl.textContent = mode === '1p' ? 'AI đang quét radar tìm máy bay bạn...' : `Lượt của Người chơi ${3 - playerNumber}...`;
      if (atkGrid) atkGrid.classList.remove('interactive');
    }
  }

  function updateRoundLabel() {
    $('#round-label').textContent = `LƯỢT ${currentRound}`;
  }

  function resetGame() {
    stopTurnTimer();
    mode = '1p'; playerNumber = 1; isHost = false; roomId = null;
    gameActive = false; isMyTurn = false; currentRound = 1; isSubmitting = false;

    selectedPlaneIdx = 0;
    currentOrient = 'UP';
    myPlanes = [null, null];
    myShots = [];
    enemyShotsOnMe = [];

    $$('.btn-orient').forEach(b => b.classList.remove('active'));
    $(`.btn-orient[data-orient="UP"]`)?.classList.add('active');
    $('#btn-confirm-ships').disabled = true;

    show($('#lobby-options'));
    hide($('#room-info'));
    hide($('#matchmaking-info'));
    hide($('#waiting-opponent-ships'));
  }

  // ===== UI LISTENERS =====
  // 1. Menu Submode Selectors
  $('#btn-1p').addEventListener('click', () => {
    mode = '1p';
    $('#btn-1p').classList.add('active');
    $('#btn-2p').classList.remove('active');
  });

  $('#btn-2p').addEventListener('click', () => {
    mode = '2p';
    $('#btn-2p').classList.add('active');
    $('#btn-1p').classList.remove('active');
  });

  $('#btn-start-quick').addEventListener('click', () => {
    if (mode === '1p') {
      playerNumber = 1;
      selectedPlaneIdx = 0;
      myPlanes = [null, null];
      myShots = [];
      enemyShotsOnMe = [];

      initPlacementBoard();
      showScreen('placement-screen');
    } else {
      showScreen('lobby-screen');
    }
  });

  // 2. Independent Plane Slot Selection (Máy Bay #1 & Máy Bay #2)
  $$('.plane-slot-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.idx, 10);
      if (!isNaN(idx)) {
        selectedPlaneIdx = idx;
        updatePlaneSelectorUI();
      }
    });
  });

  // 3. Airplane Rotation Buttons (4 Directions: UP, RIGHT, DOWN, LEFT)
  $$('.btn-orient').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.btn-orient').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentOrient = btn.dataset.orient;
    });
  });

  $('#btn-auto-place').addEventListener('click', () => {
    autoPlaceAirplanes();
  });

  $('#btn-confirm-ships').addEventListener('click', () => {
    if (myPlanes[0] === null || myPlanes[1] === null) return;

    if (mode === '1p') {
      socket.emit('start-1p', { planes: myPlanes });
    } else {
      socket.emit('set-planes-2p', { planes: myPlanes });
      hide($('#btn-confirm-ships'));
      show($('#waiting-opponent-ships'));
    }
  });

  // 4. Back Buttons (Lobby, Placement, Game)
  $('#btn-back-lobby').addEventListener('click', () => {
    socket.emit('leave-room');
    resetGame();
    showScreen('menu-screen');
  });

  $('#btn-back-placement').addEventListener('click', () => {
    if (mode === '2p') {
      socket.emit('leave-room');
      resetGame();
      showScreen('lobby-screen');
    } else {
      resetGame();
      showScreen('menu-screen');
    }
  });

  $('#btn-back-game').addEventListener('click', () => {
    socket.emit('leave-room');
    resetGame();
    showScreen('menu-screen');
  });

  // 5. Lobby Controls
  $('#btn-random-match').addEventListener('click', () => {
    socket.emit('find-random-match');
  });

  $('#btn-cancel-match').addEventListener('click', () => {
    socket.emit('cancel-random-match');
  });

  $('#btn-create-room').addEventListener('click', () => {
    socket.emit('create-room');
  });

  $('#btn-join-room').addEventListener('click', () => {
    const code = $('#input-room-code').value.trim();
    if (!code) return showError('#lobby-error', 'Vui lòng nhập mã phòng!');
    socket.emit('join-room', { roomId: code });
  });

  $('#btn-start-host').addEventListener('click', () => {
    socket.emit('start-game-host');
  });

  $('#btn-play-again').addEventListener('click', () => {
    socket.emit('leave-room');
    resetGame();
    hide($('#result-modal'));
    showScreen('menu-screen');
  });

  // ===== SOCKET EVENT HANDLERS =====
  socket.on('searching-match', () => {
    hide($('#lobby-options'));
    show($('#matchmaking-info'));
  });

  socket.on('match-cancelled', () => {
    show($('#lobby-options'));
    hide($('#matchmaking-info'));
  });

  socket.on('your-info', (data) => {
    playerNumber = data.playerNumber;
  });

  socket.on('room-updated', (data) => {
    roomId = data.roomId;
    playerNumber = data.playerNumber;
    isHost = data.isHost;

    hide($('#lobby-options')); hide($('#matchmaking-info')); show($('#room-info'));
    $('#room-code-display').textContent = data.roomId;

    const listBox = $('#players-list-box');
    listBox.innerHTML = '';
    data.players.forEach(p => {
      const div = document.createElement('div');
      div.className = `player-badge-item ${p.number === playerNumber ? 'is-me' : ''}`;
      div.innerHTML = `
        <span><i class="fa-solid fa-user" style="margin-right: 6px;"></i>Người chơi ${p.number} ${p.number === playerNumber ? '(Bạn)' : ''}</span>
        ${p.isHost ? '<span class="player-host-tag"><i class="fa-solid fa-crown"></i> Chủ phòng</span>' : ''}
      `;
      listBox.appendChild(div);
    });

    if (isHost) {
      show($('#host-controls'));
      hide($('#waiting-host-start'));
      $('#btn-start-host').disabled = !data.canStart;
      $('#btn-start-host').innerHTML = data.canStart
        ? `<i class="fa-solid fa-rocket"></i> Bắt đầu trận đấu (2 người)`
        : `<i class="fa-solid fa-users"></i> Đang chờ người chơi thứ 2...`;
    } else {
      hide($('#host-controls'));
      show($('#waiting-host-start'));
    }
  });

  socket.on('room-ready', () => {
    selectedPlaneIdx = 0;
    myPlanes = [null, null];
    myShots = [];
    enemyShotsOnMe = [];

    initPlacementBoard();
    show($('#btn-confirm-ships'));
    hide($('#waiting-opponent-ships'));
    showScreen('placement-screen');
  });

  socket.on('planes-confirmed', (data) => {
    if (data && data.planes) myPlanes = data.planes;
  });

  // ===== 1P GAME STARTED =====
  socket.on('game-started-1p', (data) => {
    if (data && data.playerPlanes) myPlanes = data.playerPlanes;
    gameActive = true;
    isMyTurn = true;
    currentRound = 1;
    isSubmitting = false;

    $('#mode-label').textContent = 'CHƠI ĐƠN (AI)';
    updateRoundLabel();
    initBattleBoards();
    updateTurnUI();
    showScreen('game-screen');
  });

  socket.on('fire-result-1p', (data) => {
    isSubmitting = false;
    if (data.playerShot) {
      myShots.push(data.playerShot);
      renderAttackGrid();
    }

    if (data.aiShot) {
      enemyShotsOnMe.push(data.aiShot);
      renderMyFleetGrid();
    }

    currentRound++;
    updateRoundLabel();

    if (data.gameOver) {
      gameActive = false;
      setTimeout(() => showResultModal(data.won ? 'win' : 'lose', data.won ? 'BẠN ĐÃ BẮN HẠ TOÀN BỘ MÁY BAY AI!' : 'ĐỘI MÁY BAY CỦA BẠN ĐÃ BỊ TIÊU DIỆT!'), 600);
    } else {
      isMyTurn = true;
      updateTurnUI();
    }
  });

  // ===== 2P GAME STARTED =====
  socket.on('game-started-2p', (data) => {
    gameActive = true;
    currentRound = data.round || 1;
    isMyTurn = (playerNumber === data.currentTurn);
    isSubmitting = false;

    $('#mode-label').textContent = `NGƯỜI CHƠI ${playerNumber}`;
    updateRoundLabel();
    initBattleBoards();
    updateTurnUI();
    showScreen('game-screen');
    startTurnTimer(data.turnDuration || 30);
  });

  socket.on('fire-broadcast-2p', (data) => {
    isSubmitting = false;
    if (data.shooterNumber === playerNumber) {
      myShots.push({
        shotIndex: data.shotIndex,
        hit: data.hit,
        isHeadHit: data.isHeadHit,
        sunkPlane: data.sunkPlane,
        allSunk: data.allSunk,
        radarDistance: data.radarDistance
      });
      renderAttackGrid();
    } else {
      enemyShotsOnMe.push({
        shotIndex: data.shotIndex,
        hit: data.hit,
        isHeadHit: data.isHeadHit,
        sunkPlane: data.sunkPlane
      });
      renderMyFleetGrid();
    }
  });

  socket.on('turn-update', (data) => {
    currentRound = data.round;
    isMyTurn = (playerNumber === data.currentTurn);
    isSubmitting = false;

    updateRoundLabel();
    updateTurnUI();
    startTurnTimer(data.turnDuration || 30);
  });

  socket.on('turn-timeout-notice', (data) => {
    showError('#game-error', data.message || 'Hết thời gian lượt!');
  });

  socket.on('game-over-2p', (data) => {
    gameActive = false;
    stopTurnTimer();

    const isWin = (data.result === 'win');
    setTimeout(() => {
      showResultModal(isWin ? 'win' : 'lose', isWin ? 'BẠN ĐÃ TIÊU DIỆT HẠM ĐỘI MÁY BAY ĐỐI THỦ!' : 'ĐỘI MÁY BAY CỦA BẠN ĐÃ BỊ TIÊU DIỆT!');
    }, 600);
  });

  socket.on('host-left-room', (data) => {
    alert(data.message || 'Chủ phòng đã thoát, phòng bị hủy!');
    resetGame();
    showScreen('menu-screen');
  });

  socket.on('opponent-disconnected', (data) => {
    alert(data?.message || 'Đối thủ đã thoát phòng! Phòng đấu đã bị hủy.');
    resetGame();
    showScreen('menu-screen');
  });

  socket.on('error-msg', (data) => {
    showError('#lobby-error', data.message);
  });

  function showResultModal(type, message) {
    const box = $('#result-icon-box');
    const title = $('#result-title');
    const msg = $('#result-message');

    if (type === 'win') {
      box.className = 'result-emoji result-win';
      box.innerHTML = '<i class="fa-solid fa-trophy"></i>';
      title.textContent = 'CHIẾN THẮNG!';
    } else {
      box.className = 'result-emoji result-lose';
      box.innerHTML = '<i class="fa-solid fa-skull"></i>';
      title.textContent = 'THẤT BẠI!';
    }

    msg.textContent = message;
    show($('#result-modal'));
  }
});
