const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const DEFAULT_AVATARS = [
  "👨‍🌾", "👩‍🌾", "🤠", "🧙‍♂️", "🐱", "🦊", "🐶", "🐰", "🐯", "🐼"
];

const FARMS_DIR = path.join(__dirname, "farms_data");
if (!fs.existsSync(FARMS_DIR)) {
  try { fs.mkdirSync(FARMS_DIR, { recursive: true }); } catch (e) {}
}

const farmStates = new Map(); // farmId -> { farmState, bumpkin, name, avatar, updatedAt }

// =========================================================================
// QUẢN LÝ SESSION NGƯỜI CHƠI BẰNG MAP VỚI KEY CỐ ĐỊNH (CHỐNG GHOST SOCKETS)
// =========================================================================
// onlinePlayers: Map<userId, PlayerRecord>
// socketToUser:  Map<ws, userId>
const onlinePlayers = new Map();
const socketToUser = new Map();

function getCanonicalUserId(params) {
  if (!params) return null;
  const raw =
    params.userId ||
    (params.farmId ? `farm_${params.farmId}` : null) ||
    params.username ||
    params.name;
  if (!raw) return null;
  return String(raw).trim().toLowerCase();
}

function getFarmState(farmId) {
  const fId = String(farmId || "").replace("farm_", "");
  if (!fId) return null;

  if (farmStates.has(fId)) return farmStates.get(fId);
  if (farmStates.has(`farm_${fId}`)) return farmStates.get(`farm_${fId}`);

  const fPath = path.join(FARMS_DIR, `farm_${fId}.json`);
  if (fs.existsSync(fPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(fPath, "utf-8"));
      farmStates.set(fId, data);
      return data;
    } catch (e) {}
  }

  // Kiểm tra người chơi đang online có farmId này không
  for (const info of onlinePlayers.values()) {
    if (String(info.farmId) === fId && info.farmState) {
      return {
        farmId: fId,
        farmState: info.farmState,
        bumpkin: info.bumpkin,
        name: info.name,
        avatar: info.avatar,
        x: info.x || 0,
        y: info.y !== undefined ? info.y : -1,
        updatedAt: Date.now(),
      };
    }
  }

  // Fallback đọc từ farm_save.json gần nhất của làng
  const saveFile = path.join(__dirname, "..", "farm_save.json");
  if (fs.existsSync(saveFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(saveFile, "utf-8"));
      return {
        farmId: fId,
        farmState: saved,
        bumpkin: saved.bumpkin?.equipped || null,
        name: saved.username || "Chủ Vườn",
        avatar: "👨‍🌾",
        x: 0,
        y: -1,
        updatedAt: Date.now(),
      };
    } catch (e) {}
  }

  return null;
}

function saveFarmState(farmId, data) {
  const fId = String(farmId || "").replace("farm_", "");
  if (!fId) return;
  farmStates.set(fId, data);
  farmStates.set(`farm_${fId}`, data);
  const fPath = path.join(FARMS_DIR, `farm_${fId}.json`);
  try {
    fs.writeFileSync(fPath, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.warn("[FarmSync] Lỗi ghi farm disk:", e.message);
  }
}

function setupMultiplayerHub(httpServer) {
  if (!httpServer) return;

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(
        request.url,
        `http://${request.headers.host || "localhost"}`
      );
      if (url.pathname === "/ws/chat") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      }
    } catch (e) {
      // Bỏ qua lỗi parse URL
    }
  });

  const recentMessages = []; // last 50 chat messages

  function broadcast(data, excludeWs = null) {
    const payload = JSON.stringify(data);
    for (const player of onlinePlayers.values()) {
      if (player.ws && player.ws !== excludeWs && player.ws.readyState === 1 /* OPEN */) {
        player.ws.send(payload);
      }
    }
  }

  function broadcastToRoom(roomId, data, excludeWs = null) {
    if (!roomId) return;
    const payload = JSON.stringify(data);
    const targetFarmId = roomId.startsWith("farm_") ? roomId.replace("farm_", "") : null;

    for (const player of onlinePlayers.values()) {
      const isTarget =
        player.roomId === roomId ||
        player.currentRoom === roomId ||
        (targetFarmId && String(player.farmId) === targetFarmId);

      if (
        isTarget &&
        player.ws &&
        player.ws !== excludeWs &&
        player.ws.readyState === 1 /* OPEN */
      ) {
        player.ws.send(payload);
      }
    }
  }

  function getOnlinePlayersList() {
    return Array.from(onlinePlayers.values()).map((p) => ({
      id: p.id,
      userId: p.userId,
      name: p.username || p.name,
      username: p.username || p.name,
      gender: p.gender || "male",
      avatar: p.avatar || "👨‍🌾",
      farmId: p.farmId,
      roomId: p.roomId || p.currentRoom,
      currentRoom: p.currentRoom || p.roomId,
      level: p.level || 1,
      ripeCrops: p.ripeCrops || 0,
      ripeCropsCount: p.ripeCrops || 0,
      isMicOn: !!p.isMicOn,
      isMicActive: !!p.isMicOn,
      isSpeaking: !!p.isSpeaking,
      bumpkin: p.bumpkin || null,
      x: p.x || 0,
      y: p.y || 0,
    }));
  }

  function broadcastOnlineFarms() {
    const uniqueList = getOnlinePlayersList();
    const count = uniqueList.length;

    broadcast({
      type: "players_update",
      players: uniqueList,
      onlineCount: count,
    });

    broadcast({
      type: "onlineFarmsUpdated",
      farms: uniqueList,
      players: uniqueList,
      onlineCount: count,
    });
  }

  function getPeersInRoom(roomId, excludeWs = null, callerUserId = null) {
    const list = [];
    const targetFarmId = roomId.startsWith("farm_") ? roomId.replace("farm_", "") : null;
    let foundOwner = false;

    // Nếu người gọi chính là chủ nông trại đang xem phòng này
    if (callerUserId) {
      const caller = onlinePlayers.get(callerUserId);
      if (caller && targetFarmId && String(caller.farmId) === String(targetFarmId)) {
        foundOwner = true;
      }
    }

    for (const player of onlinePlayers.values()) {
      // Tuyệt đối không trả về chính client đang gọi
      if (player.ws === excludeWs || (callerUserId && player.userId === callerUserId)) {
        if (targetFarmId && String(player.farmId) === targetFarmId) {
          foundOwner = true;
        }
        continue;
      }

      const isOwner = targetFarmId ? String(player.farmId) === targetFarmId : false;
      const isTarget =
        player.roomId === roomId ||
        player.currentRoom === roomId ||
        (targetFarmId && String(player.farmId) === targetFarmId);

      if (isTarget && player.ws && player.ws.readyState === 1 /* OPEN */) {
        if (isOwner) foundOwner = true;
        list.push({
          id: player.id,
          userId: player.userId,
          name: player.username || player.name,
          username: player.username || player.name,
          gender: player.gender || "male",
          avatar: player.avatar || "👨‍🌾",
          farmId: player.farmId,
          roomId: player.roomId || player.currentRoom,
          level: player.level || 1,
          ripeCrops: player.ripeCrops || 0,
          isMicOn: !!player.isMicOn,
          isSpeaking: !!player.isSpeaking,
          x: player.x || 0,
          y: player.y || 0,
          facingLeft: !!player.facingLeft,
          bumpkin: player.bumpkin || null,
          isOwner,
        });
      }
    }

    // Nếu người chơi đang ghé thăm một nông trại cụ thể (farm_xxx) mà chủ vườn chưa online hoặc ở phòng khác,
    // đưa nhân vật Chủ Vườn ảo (NPC) vào phòng
    if (targetFarmId && !foundOwner) {
      const savedFarm = getFarmState(targetFarmId);
      let ownerName = savedFarm?.username || savedFarm?.name || "";
      if (!ownerName || /^Nông Dân\s+\d+$/.test(ownerName) || ownerName.startsWith("Chủ Vườn #")) {
        for (const p of onlinePlayers.values()) {
          if (String(p.farmId) === String(targetFarmId) && (p.username || p.name) && !/^Nông Dân\s+\d+$/.test(p.username || p.name)) {
            ownerName = p.username || p.name;
            break;
          }
        }
      }
      if (!ownerName || /^Nông Dân\s+\d+$/.test(ownerName)) {
        ownerName = "Chủ Vườn";
      }

      list.push({
        id: `host_${targetFarmId}`,
        userId: `farm_${targetFarmId}`,
        name: ownerName,
        username: ownerName,
        avatar: savedFarm?.avatar || "👨‍🌾",
        farmId: targetFarmId,
        roomId: roomId,
        level: 1,
        ripeCrops: 0,
        isMicOn: false,
        isSpeaking: false,
        x: savedFarm?.x || 0,
        y: savedFarm?.y !== undefined ? savedFarm.y : -1,
        facingLeft: false,
        bumpkin: savedFarm?.bumpkin || null,
        isOwner: true,
      });
    }

    return list;
  }

  wss.on("connection", (ws, req) => {
    let playerId = "p_" + Math.random().toString(36).substring(2, 9);
    let playerName = "";
    let defaultFarmId = Math.floor(Math.random() * 8000 + 1000);
    let defaultRoomId = "lang_mieuthien";
    let defaultAvatar = DEFAULT_AVATARS[Math.floor(Math.random() * DEFAULT_AVATARS.length)];
    let playerGender = "male";
    let clientUserId = null;

    try {
      const parsedUrl = new URL(
        req.url,
        `http://${req.headers?.host || "localhost"}`
      );
      const qUserId = parsedUrl.searchParams.get("userId");
      const qUsername = parsedUrl.searchParams.get("username") || parsedUrl.searchParams.get("name");
      const qAvatar = parsedUrl.searchParams.get("avatar");
      const qFarmId = parsedUrl.searchParams.get("farmId");
      const qGender = parsedUrl.searchParams.get("gender");

      if (qUsername && qUsername.trim()) {
        playerName = decodeURIComponent(qUsername).trim().substring(0, 24);
      }
      if (qGender && qGender.trim()) {
        playerGender = decodeURIComponent(qGender).trim();
      }
      if (qAvatar && qAvatar.trim()) {
        defaultAvatar = decodeURIComponent(qAvatar).trim().substring(0, 100);
      }
      if (qFarmId && qFarmId.trim()) {
        defaultFarmId = qFarmId.trim();
        defaultRoomId = `farm_${defaultFarmId}`;
      }

      clientUserId = getCanonicalUserId({
        userId: qUserId,
        farmId: defaultFarmId,
        username: playerName,
      });
    } catch (e) {}

    if (!playerName || playerName.trim() === "") {
      playerName = `Nông Dân ${playerId.slice(2, 6)}`;
    }

    if (!clientUserId) {
      clientUserId = `usr_${playerId}`;
    }

    // 1. KIỂM TRA VÀ NGẮT KẾT NỐI MA (KICK CŨ NẾU ĐÃ TỒN TẠI PHIÊN CỦA USER ID NÀY)
    if (onlinePlayers.has(clientUserId)) {
      const oldSession = onlinePlayers.get(clientUserId);
      if (oldSession && oldSession.ws && oldSession.ws !== ws) {
        console.log(`[Multiplayer Hub] Phát hiện phiên cũ của ${clientUserId}, ngắt socket ma: ${oldSession.id}`);
        try {
          oldSession.ws.send(
            JSON.stringify({
              type: "forceDisconnect",
              reason: "Tài khoản vừa kết nối từ thiết bị hoặc tab khác",
            })
          );
          oldSession.ws.close(4001, "Replaced by newer session");
        } catch (e) {}
        socketToUser.delete(oldSession.ws);
      }
    }

    // 2. GHI ĐÈ SESSION MỚI VÀO MAP
    const playerRecord = {
      userId: clientUserId,
      id: playerId,
      ws: ws,
      name: playerName,
      username: playerName,
      gender: playerGender,
      avatar: defaultAvatar,
      farmId: defaultFarmId,
      roomId: defaultRoomId,
      currentRoom: defaultRoomId,
      level: 1,
      ripeCrops: Math.floor(Math.random() * 5 + 2),
      isMicOn: false,
      isSpeaking: false,
      x: 0,
      y: 0,
      facingLeft: false,
      bumpkin: null,
      lastActive: Date.now(),
    };

    onlinePlayers.set(clientUserId, playerRecord);
    socketToUser.set(ws, clientUserId);

    ws.userId = clientUserId;
    ws.username = playerName;
    ws.gender = playerGender;

    // Gửi dữ liệu khởi tạo cho client
    ws.send(
      JSON.stringify({
        type: "init",
        userId: clientUserId,
        selfId: playerId,
        name: playerName,
        username: playerName,
        gender: playerGender,
        avatar: defaultAvatar,
        farmId: defaultFarmId,
        roomId: defaultRoomId,
        players: getOnlinePlayersList(),
        recentMessages: recentMessages.slice(-30),
      })
    );

    // Gửi danh sách người chơi trong phòng cho người mới
    ws.send(
      JSON.stringify({
        type: "room_peers",
        roomId: defaultRoomId,
        peers: getPeersInRoom(defaultRoomId, ws, clientUserId),
      })
    );

    // Báo cho các người chơi khác trong phòng
    broadcastToRoom(
      defaultRoomId,
      {
        type: "peer_joined_room",
        player: {
          id: playerId,
          userId: clientUserId,
          name: playerName,
          username: playerName,
          gender: playerGender,
          avatar: defaultAvatar,
          farmId: defaultFarmId,
          roomId: defaultRoomId,
          level: playerRecord.level,
          ripeCrops: playerRecord.ripeCrops,
          isMicOn: false,
          bumpkin: null,
          x: 0,
          y: 0,
        },
      },
      ws
    );

    // Broadcast danh sách cập nhật mới nhất cho toàn server
    broadcastOnlineFarms();

    // Tin nhắn hệ thống chào mừng
    const welcomeMsg = {
      id: "sys_" + Date.now(),
      name: "🌾 Làng Miêu Thiện",
      avatar: "🌾",
      text: `${defaultAvatar} ${playerName} vừa bước chân vào làng! Chúc bạn mùa màng bội thu!`,
      time: Date.now(),
      isSystem: true,
    };
    recentMessages.push(welcomeMsg);
    if (recentMessages.length > 50) recentMessages.shift();
    broadcast({ type: "chat", ...welcomeMsg });

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const curUserId = socketToUser.get(ws);
        const playerInfo = curUserId ? onlinePlayers.get(curUserId) : null;
        if (!playerInfo) return;

        playerInfo.lastActive = Date.now();

        if (data.type === "joinGame" || data.type === "join") {
          const newUserId = getCanonicalUserId(data) || curUserId;

          // Nếu client gửi userId định danh cụ thể khác với temp userId ban đầu
          if (newUserId && newUserId !== curUserId) {
            // Kick phiên cũ nếu có
            if (onlinePlayers.has(newUserId)) {
              const old = onlinePlayers.get(newUserId);
              if (old && old.ws && old.ws !== ws) {
                try {
                  old.ws.send(
                    JSON.stringify({
                      type: "forceDisconnect",
                      reason: "Tài khoản vừa kết nối từ tab khác",
                    })
                  );
                  old.ws.close(4001, "Replaced by newer session");
                } catch (e) {}
                socketToUser.delete(old.ws);
              }
            }
            onlinePlayers.delete(curUserId);
            playerInfo.userId = newUserId;
            onlinePlayers.set(newUserId, playerInfo);
            socketToUser.set(ws, newUserId);
            ws.userId = newUserId;
          }

          const reqName = data.username || data.name;
          if (reqName && typeof reqName === "string" && reqName.trim() !== "") {
            playerInfo.name = reqName.trim().substring(0, 24);
            playerInfo.username = playerInfo.name;
            ws.username = playerInfo.name;
          }
          if (data.gender) {
            playerInfo.gender = data.gender;
            ws.gender = data.gender;
          }
          if (data.avatar) playerInfo.avatar = String(data.avatar);
          if (data.bumpkin) playerInfo.bumpkin = data.bumpkin;
          if (data.farmId) {
            playerInfo.farmId = data.farmId;
            playerInfo.roomId = `farm_${data.farmId}`;
            playerInfo.currentRoom = playerInfo.roomId;
            const curFarm = getFarmState(playerInfo.farmId);
            if (curFarm) {
              curFarm.name = playerInfo.name;
              curFarm.username = playerInfo.username;
              saveFarmState(playerInfo.farmId, curFarm);
            }
          }
          if (data.level) playerInfo.level = Number(data.level) || 1;
          if (typeof data.ripeCrops === "number") playerInfo.ripeCrops = data.ripeCrops;

          broadcastOnlineFarms();
        } else if (data.type === "visitFarm") {
          const targetFarmId = String(data.targetFarmId || data.farmId || "").replace("farm_", "");
          const visitorName = data.visitorName || data.username || data.name;
          if (visitorName && typeof visitorName === "string" && visitorName.trim() !== "") {
            playerInfo.name = visitorName.trim().substring(0, 24);
            playerInfo.username = playerInfo.name;
            ws.username = playerInfo.name;
          }
          if (data.gender) playerInfo.gender = data.gender;
          if (data.avatar) playerInfo.avatar = String(data.avatar);
          if (data.bumpkin) playerInfo.bumpkin = data.bumpkin;

          const oldRoom = playerInfo.roomId;
          const newRoom = `farm_${targetFarmId}`;

          if (oldRoom && newRoom !== oldRoom) {
            broadcastToRoom(
              oldRoom,
              {
                type: "peer_left_room",
                playerId: playerInfo.id,
                userId: playerInfo.userId,
                name: playerInfo.name,
                username: playerInfo.username,
              },
              ws
            );
          }

          playerInfo.roomId = newRoom;
          playerInfo.currentRoom = newRoom;

          broadcastToRoom(
            newRoom,
            {
              type: "peer_joined_room",
              player: {
                id: playerInfo.id,
                userId: playerInfo.userId,
                name: playerInfo.name,
                username: playerInfo.username,
                avatar: playerInfo.avatar || "👨‍🌾",
                gender: playerInfo.gender || "male",
                farmId: playerInfo.farmId,
                roomId: playerInfo.roomId,
                level: playerInfo.level,
                ripeCrops: playerInfo.ripeCrops,
                isMicOn: !!playerInfo.isMicOn,
                bumpkin: playerInfo.bumpkin || null,
                x: playerInfo.x,
                y: playerInfo.y,
              },
            },
            ws
          );

          ws.send(
            JSON.stringify({
              type: "room_peers",
              roomId: newRoom,
              peers: getPeersInRoom(newRoom, ws, playerInfo.userId),
            })
          );

          broadcastOnlineFarms();
        } else if (data.type === "set_avatar") {
          if (data.avatar) {
            playerInfo.avatar = String(data.avatar);
            broadcastOnlineFarms();
          }
        } else if (data.type === "join_room") {
          const reqName = data.username || data.name;
          if (reqName && typeof reqName === "string" && reqName.trim() !== "") {
            playerInfo.name = reqName.trim().substring(0, 24);
            playerInfo.username = playerInfo.name;
            ws.username = playerInfo.name;
          }
          if (data.gender) playerInfo.gender = data.gender;
          if (data.avatar) playerInfo.avatar = String(data.avatar);
          if (data.bumpkin) playerInfo.bumpkin = data.bumpkin;
          const oldRoom = playerInfo.roomId;
          const newRoom = String(data.roomId || defaultRoomId).trim();

          if (oldRoom && newRoom !== oldRoom) {
            broadcastToRoom(
              oldRoom,
              {
                type: "peer_left_room",
                playerId: playerInfo.id,
                userId: playerInfo.userId,
                name: playerInfo.name,
                username: playerInfo.username,
              },
              ws
            );
          }

          playerInfo.roomId = newRoom;
          playerInfo.currentRoom = newRoom;

          broadcastToRoom(
            newRoom,
            {
              type: "peer_joined_room",
              player: {
                id: playerInfo.id,
                userId: playerInfo.userId,
                name: playerInfo.name,
                username: playerInfo.username,
                avatar: playerInfo.avatar || "👨‍🌾",
                gender: playerInfo.gender || "male",
                farmId: playerInfo.farmId,
                roomId: playerInfo.roomId,
                level: playerInfo.level,
                ripeCrops: playerInfo.ripeCrops,
                isMicOn: !!playerInfo.isMicOn,
                bumpkin: playerInfo.bumpkin || null,
                x: playerInfo.x,
                y: playerInfo.y,
              },
            },
            ws
          );

          ws.send(
            JSON.stringify({
              type: "room_peers",
              roomId: newRoom,
              peers: getPeersInRoom(newRoom, ws, playerInfo.userId),
            })
          );

          broadcastOnlineFarms();
        } else if (data.type === "leave_room") {
          const oldRoom = playerInfo.roomId;
          if (oldRoom) {
            playerInfo.roomId = `farm_${playerInfo.farmId || playerInfo.id}`;
            playerInfo.currentRoom = playerInfo.roomId;
            broadcastToRoom(
              oldRoom,
              {
                type: "peer_left_room",
                playerId: playerInfo.id,
                userId: playerInfo.userId,
                name: playerInfo.name,
                username: playerInfo.username,
              },
              ws
            );

            broadcastOnlineFarms();
          }
        } else if (data.type === "chat") {
          const text = String(data.text || "").trim().substring(0, 200);
          if (!text) return;

          const msg = {
            id: "msg_" + Date.now() + "_" + Math.random().toString(36).substring(2, 5),
            playerId: playerInfo.id,
            userId: playerInfo.userId,
            name: playerInfo.name,
            avatar: playerInfo.avatar || "👨‍🌾",
            text,
            time: Date.now(),
          };

          recentMessages.push(msg);
          if (recentMessages.length > 50) recentMessages.shift();

          broadcast({ type: "chat", ...msg });
        } else if (data.type === "emote") {
          const emoji = String(data.emoji || "❤️").substring(0, 10);
          broadcast({
            type: "emote",
            playerId: playerInfo.id,
            userId: playerInfo.userId,
            name: playerInfo.name,
            avatar: playerInfo.avatar || "👨‍🌾",
            emoji,
            time: Date.now(),
          });
        } else if (data.type === "rename" || data.type === "set_name") {
          const newName = String(data.username || data.name || "").trim().substring(0, 24);
          if (newName && newName !== playerInfo.name) {
            const oldName = playerInfo.name;
            playerInfo.name = newName;
            playerInfo.username = newName;
            ws.username = newName;

            if (playerInfo.farmId) {
              const currentFarm = getFarmState(playerInfo.farmId);
              if (currentFarm) {
                currentFarm.name = newName;
                currentFarm.username = newName;
                saveFarmState(playerInfo.farmId, currentFarm);
              }
            }

            const renameMsg = {
              id: "sys_" + Date.now(),
              name: "🌾 Làng Miêu Thiện",
              avatar: "🌾",
              text: `${playerInfo.avatar || "👨‍🌾"} ${oldName} đã đổi tên thành ${newName}`,
              time: Date.now(),
              isSystem: true,
            };
            recentMessages.push(renameMsg);
            broadcast({ type: "chat", ...renameMsg });
            broadcastOnlineFarms();
          }
        } else if (data.type === "voice_signal") {
          const targetId = data.targetId;
          for (const targetPlayer of onlinePlayers.values()) {
            if ((targetPlayer.id === targetId || targetPlayer.userId === targetId) && targetPlayer.ws && targetPlayer.ws.readyState === 1) {
              targetPlayer.ws.send(
                JSON.stringify({
                  type: "voice_signal",
                  senderId: playerInfo.id,
                  userId: playerInfo.userId,
                  signal: data.signal,
                })
              );
              break;
            }
          }
        } else if (data.type === "voice_status") {
          playerInfo.isMicOn = !!data.isMicOn;
          // KÊNH THOẠI TOÀN LÀNG: Phát trạng thái mic cho toàn bộ người chơi trong làng
          broadcast({
            type: "voice_status",
            playerId: playerInfo.id,
            userId: playerInfo.userId,
            name: playerInfo.name,
            avatar: playerInfo.avatar || "👨‍🌾",
            isMicOn: playerInfo.isMicOn,
          });
          broadcastOnlineFarms();
        } else if (data.type === "voice_speaking") {
          playerInfo.isSpeaking = !!data.speaking;
          // KÊNH THOẠI TOÀN LÀNG: Phát tín hiệu đang nói cho toàn bộ người chơi trong làng
          broadcast({
            type: "voice_speaking",
            playerId: playerInfo.id,
            userId: playerInfo.userId,
            name: playerInfo.name,
            avatar: playerInfo.avatar || "👨‍🌾",
            speaking: !!data.speaking,
          });
        } else if (data.type === "sync_farm_state") {
          const syncFarmId = String(data.farmId || playerInfo.farmId);
          if (data.bumpkin) playerInfo.bumpkin = data.bumpkin;
          playerInfo.farmState = data.farmState;
          const realName = data.username || data.name || playerInfo.username || playerInfo.name;
          const farmData = {
            farmId: syncFarmId,
            farmState: data.farmState,
            bumpkin: data.bumpkin || playerInfo.bumpkin,
            name: realName,
            username: realName,
            avatar: data.avatar || playerInfo.avatar,
            x: playerInfo.x || 0,
            y: playerInfo.y !== undefined ? playerInfo.y : -1,
            updatedAt: Date.now(),
          };
          saveFarmState(syncFarmId, farmData);
          broadcast({
            type: "farm_state_updated",
            farmId: syncFarmId,
            farmState: data.farmState,
            bumpkin: farmData.bumpkin,
            name: farmData.name,
            username: farmData.username,
          });
        } else if (data.type === "request_farm_state") {
          const targetFarmId = String(data.farmId);
          const foundFarm = getFarmState(targetFarmId);
          ws.send(JSON.stringify({
            type: "farm_state_response",
            farmId: targetFarmId,
            data: foundFarm || null
          }));
        } else if (data.type === "update_bumpkin") {
          playerInfo.bumpkin = data.bumpkin;
          broadcast({
            type: "player_bumpkin_updated",
            playerId: playerInfo.id,
            userId: playerInfo.userId,
            bumpkin: data.bumpkin
          });
        } else if (data.type === "player_position") {
          playerInfo.x = Number(data.x) || 0;
          playerInfo.y = Number(data.y) || 0;
          if (data.facingLeft !== undefined) playerInfo.facingLeft = !!data.facingLeft;
          if (data.name) playerInfo.name = data.name;
          if (data.avatar) playerInfo.avatar = data.avatar;
          if (data.bumpkin) playerInfo.bumpkin = data.bumpkin;

          const posPayload = {
            type: "player_position",
            playerId: playerInfo.id,
            userId: playerInfo.userId,
            farmId: playerInfo.farmId,
            x: playerInfo.x,
            y: playerInfo.y,
            facingLeft: playerInfo.facingLeft,
            name: playerInfo.name,
            avatar: playerInfo.avatar,
            bumpkin: playerInfo.bumpkin,
          };

          broadcastToRoom(playerInfo.roomId, posPayload, ws);
          if (playerInfo.roomId !== `farm_${playerInfo.farmId}`) {
            broadcastToRoom(`farm_${playerInfo.farmId}`, posPayload, ws);
          }
        } else if (data.type === "update_profile") {
          if (data.avatar) playerInfo.avatar = String(data.avatar);
          if (data.level) playerInfo.level = Number(data.level) || 1;
          if (typeof data.ripeCrops === "number") playerInfo.ripeCrops = data.ripeCrops;
          broadcastOnlineFarms();
        } else if (data.type === "crop_steal") {
          const targetFarmId = data.targetFarmId;
          const cropName = data.cropName || "Nông sản";
          const thiefName = playerInfo.name;

          broadcast({
            type: "crop_steal_event",
            thiefId: playerInfo.id,
            userId: playerInfo.userId,
            thiefName,
            thiefAvatar: playerInfo.avatar || "🥷",
            targetFarmId,
            cropName,
            plotIndex: data.plotIndex,
            time: Date.now(),
          });

          const stealMsg = {
            id: "sys_" + Date.now(),
            name: "🌾 Làng Miêu Thiện",
            avatar: "🚨",
            text: `🚨 [HÁI TRỘM] ${playerInfo.avatar || "🥷"} ${thiefName} vừa lẻn vào vườn #${targetFarmId} hái trộm 1x ${cropName}!`,
            time: Date.now(),
            isSystem: true,
          };
          recentMessages.push(stealMsg);
          if (recentMessages.length > 50) recentMessages.shift();
          broadcast({ type: "chat", ...stealMsg });
        } else if (data.type === "crop_help") {
          const targetFarmId = data.targetFarmId;
          const cropName = data.cropName || "Nông sản";
          const helperName = playerInfo.name;

          broadcast({
            type: "crop_help_event",
            helperId: playerInfo.id,
            userId: playerInfo.userId,
            helperName,
            helperAvatar: playerInfo.avatar || "👨‍🌾",
            targetFarmId,
            cropName,
            plotIndex: data.plotIndex,
            time: Date.now(),
          });

          const helpMsg = {
            id: "sys_" + Date.now(),
            name: "🌾 Làng Miêu Thiện",
            avatar: "🤝",
            text: `🤝 [THU HOẠCH GIÚP] ${playerInfo.avatar || "👨‍🌾"} ${helperName} đã nhổ giúp 1x ${cropName} cho vườn #${targetFarmId}! Thưởng 10 Vàng.`,
            time: Date.now(),
            isSystem: true,
          };
          recentMessages.push(helpMsg);
          if (recentMessages.length > 50) recentMessages.shift();
          broadcast({ type: "chat", ...helpMsg });
        }
      } catch (err) {
        console.error("[Multiplayer Hub] Lỗi xử lý message:", err.message);
      }
    });

    // 4. DỌN DẸP NGAY LẬP TỨC KHI NGẮT KẾT NỐI (CLEANUP EXACT SOCKET)
    ws.on("close", () => {
      const uId = socketToUser.get(ws);
      if (uId) {
        const currentSession = onlinePlayers.get(uId);
        // Chỉ xóa khỏi danh sách online nếu socket vừa rớt đúng là socket đang giữ quyền active
        if (currentSession && currentSession.ws === ws) {
          onlinePlayers.delete(uId);
          console.log(`[Multiplayer Hub] Đã dọn dẹp người chơi ${uId} khỏi danh sách online`);

          if (currentSession.roomId) {
            broadcastToRoom(currentSession.roomId, {
              type: "peer_left_room",
              playerId: currentSession.id,
              userId: currentSession.userId,
              name: currentSession.name,
            });
          }

          const leaveMsg = {
            id: "sys_" + Date.now(),
            name: "🌾 Làng Miêu Thiện",
            avatar: "🌾",
            text: `${currentSession.avatar || "👨‍🌾"} ${currentSession.name} đã tạm rời Làng Miêu Thiện.`,
            time: Date.now(),
            isSystem: true,
          };
          recentMessages.push(leaveMsg);
          broadcast({ type: "chat", ...leaveMsg });

          broadcast({
            type: "player_left",
            playerId: currentSession.id,
            userId: currentSession.userId,
            name: currentSession.name,
            onlineCount: onlinePlayers.size,
          });

          broadcastOnlineFarms();
        }
        socketToUser.delete(ws);
      }
    });

    ws.on("error", (err) => {
      console.warn("[Multiplayer Hub] WebSocket error:", err.message);
    });
  });

  console.log(
    "🌾 [LÀNG MIEUTHIEN] Realtime Multiplayer, Voice, Avatars & Visiting Hub đã kích hoạt trên /ws/chat (Deduplicated Map Session)!"
  );
}

module.exports = { setupMultiplayerHub, getFarmState, saveFarmState };
