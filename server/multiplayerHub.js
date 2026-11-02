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
const clients = new Map(); // ws -> player info

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
  for (const info of clients.values()) {
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

  // Sử dụng noServer: true để không xung đột với WebSocket HMR của Vite
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
    wss.clients.forEach((client) => {
      if (client !== excludeWs && client.readyState === 1 /* OPEN */) {
        client.send(payload);
      }
    });
  }

  function broadcastToRoom(roomId, data, excludeWs = null) {
    if (!roomId) return;
    const payload = JSON.stringify(data);
    const targetFarmId = roomId.startsWith("farm_") ? roomId.replace("farm_", "") : null;

    for (const [clientWs, info] of clients.entries()) {
      const isTarget =
        info.roomId === roomId ||
        (targetFarmId && String(info.farmId) === targetFarmId);

      if (
        isTarget &&
        clientWs !== excludeWs &&
        clientWs.readyState === 1 /* OPEN */
      ) {
        clientWs.send(payload);
      }
    }
  }

  function getPeersInRoom(roomId, excludeWs = null) {
    const list = [];
    const targetFarmId = roomId.startsWith("farm_") ? roomId.replace("farm_", "") : null;
    let foundOwner = false;

    for (const [clientWs, info] of clients.entries()) {
      const isOwner = targetFarmId ? String(info.farmId) === targetFarmId : false;
      const isTarget =
        info.roomId === roomId ||
        (targetFarmId && String(info.farmId) === targetFarmId);

      if (
        isTarget &&
        clientWs !== excludeWs &&
        clientWs.readyState === 1
      ) {
        if (isOwner) foundOwner = true;
        list.push({
          id: info.id,
          name: info.username || info.name,
          username: info.username || info.name,
          gender: info.gender || "male",
          avatar: info.avatar || "👨‍🌾",
          farmId: info.farmId,
          roomId: info.roomId,
          level: info.level || 1,
          ripeCrops: info.ripeCrops || 0,
          isMicOn: !!info.isMicOn,
          isSpeaking: !!info.isSpeaking,
          x: info.x || 0,
          y: info.y || 0,
          facingLeft: !!info.facingLeft,
          bumpkin: info.bumpkin || null,
          isOwner,
        });
      }
    }

    // Nếu người chơi đang ghé thăm một nông trại cụ thể (farm_xxx) mà chủ vườn chưa online hoặc ở phòng khác,
    // luôn đưa nhân vật Chủ Vườn vào danh sách người chơi trên đảo
    if (targetFarmId && !foundOwner) {
      const savedFarm = getFarmState(targetFarmId);
      let ownerName = savedFarm?.username || savedFarm?.name || "";
      if (!ownerName || /^Nông Dân\s+\d+$/.test(ownerName) || ownerName.startsWith("Chủ Vườn #")) {
        for (const info of clients.values()) {
          if (String(info.farmId) === String(targetFarmId) && (info.username || info.name) && !/^Nông Dân\s+\d+$/.test(info.username || info.name)) {
            ownerName = info.username || info.name;
            break;
          }
        }
      }
      if (!ownerName || /^Nông Dân\s+\d+$/.test(ownerName)) {
        ownerName = "Chủ Vườn";
      }

      list.push({
        id: `host_${targetFarmId}`,
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

  function getOnlinePlayersList() {
    return Array.from(clients.values()).map((p) => ({
      id: p.id,
      name: p.username || p.name,
      username: p.username || p.name,
      gender: p.gender || "male",
      avatar: p.avatar || "👨‍🌾",
      farmId: p.farmId,
      roomId: p.roomId,
      level: p.level || 1,
      ripeCrops: p.ripeCrops || 0,
      isMicOn: !!p.isMicOn,
      isSpeaking: !!p.isSpeaking,
      bumpkin: p.bumpkin || null,
      x: p.x || 0,
      y: p.y || 0,
    }));
  }

  wss.on("connection", (ws, req) => {
    const playerId = "p_" + Math.random().toString(36).substring(2, 9);
    let playerName = "";
    let defaultFarmId = Math.floor(Math.random() * 8000 + 1000);
    const defaultRoomId = "lang_mieuthien";
    let defaultAvatar =
      DEFAULT_AVATARS[Math.floor(Math.random() * DEFAULT_AVATARS.length)];
    let playerGender = "male";

    try {
      const parsedUrl = new URL(
        req.url,
        `http://${req.headers?.host || "localhost"}`
      );
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
      }
    } catch (e) {}

    // Chỉ gán tên dự phòng nếu client không truyền tên
    if (!playerName || playerName.trim() === "") {
      playerName = `Nông Dân ${playerId.slice(2, 6)}`;
    }

    const playerInfo = {
      id: playerId,
      name: playerName,
      username: playerName,
      gender: playerGender,
      avatar: defaultAvatar,
      farmId: defaultFarmId,
      roomId: defaultRoomId,
      level: 1,
      ripeCrops: Math.floor(Math.random() * 5 + 2),
      isMicOn: false,
      isSpeaking: false,
      x: 0,
      y: 0,
      joinedAt: Date.now(),
    };

    ws.username = playerName;
    ws.gender = playerGender;
    clients.set(ws, playerInfo);

    // Gửi dữ liệu khởi tạo cho client vừa kết nối
    ws.send(
      JSON.stringify({
        type: "init",
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

    // Gửi danh sách người chơi đang ở cùng phòng làng Miêu Thiện
    ws.send(
      JSON.stringify({
        type: "room_peers",
        roomId: defaultRoomId,
        peers: getPeersInRoom(defaultRoomId, ws),
      })
    );

    // Báo cho các người chơi khác trong phòng làng
    broadcastToRoom(
      defaultRoomId,
      {
        type: "peer_joined_room",
        player: {
          id: playerId,
          name: playerName,
          username: playerName,
          gender: playerGender,
          avatar: defaultAvatar,
          farmId: defaultFarmId,
          roomId: defaultRoomId,
          level: playerInfo.level,
          ripeCrops: playerInfo.ripeCrops,
          isMicOn: false,
          bumpkin: null,
          x: 0,
          y: 0,
        },
      },
      ws
    );

    // Thông báo cho mọi người có người chơi mới
    broadcast(
      {
        type: "player_joined",
        player: {
          id: playerId,
          name: playerName,
          username: playerName,
          gender: playerGender,
          avatar: defaultAvatar,
          farmId: defaultFarmId,
          roomId: defaultRoomId,
          level: playerInfo.level,
          ripeCrops: playerInfo.ripeCrops,
          isMicOn: false,
        },
        onlineCount: clients.size,
      },
      ws
    );

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

        if (data.type === "joinGame" || data.type === "join") {
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
            // Đồng bộ tên thật vào nông trại
            const curFarm = getFarmState(playerInfo.farmId);
            if (curFarm) {
              curFarm.name = playerInfo.name;
              curFarm.username = playerInfo.username;
              saveFarmState(playerInfo.farmId, curFarm);
            }
          }
          if (data.level) playerInfo.level = Number(data.level) || 1;
          if (typeof data.ripeCrops === "number") playerInfo.ripeCrops = data.ripeCrops;

          broadcast({
            type: "players_update",
            players: getOnlinePlayersList(),
            onlineCount: clients.size,
          });
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
                name: playerInfo.name,
                username: playerInfo.username,
              },
              ws
            );
          }

          playerInfo.roomId = newRoom;

          broadcastToRoom(
            newRoom,
            {
              type: "peer_joined_room",
              player: {
                id: playerInfo.id,
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
              peers: getPeersInRoom(newRoom, ws),
            })
          );

          broadcast({
            type: "players_update",
            players: getOnlinePlayersList(),
            onlineCount: clients.size,
          });
        } else if (data.type === "set_avatar") {
          if (data.avatar) {
            playerInfo.avatar = String(data.avatar);
            broadcast({
              type: "players_update",
              players: getOnlinePlayersList(),
              onlineCount: clients.size,
            });
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
                name: playerInfo.name,
                username: playerInfo.username,
              },
              ws
            );
          }

          playerInfo.roomId = newRoom;

          broadcastToRoom(
            newRoom,
            {
              type: "peer_joined_room",
              player: {
                id: playerInfo.id,
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
              peers: getPeersInRoom(newRoom, ws),
            })
          );

            broadcast({
              type: "players_update",
              players: getOnlinePlayersList(),
              onlineCount: clients.size,
            });
        } else if (data.type === "leave_room") {
          const oldRoom = playerInfo.roomId;
          if (oldRoom) {
            playerInfo.roomId = `farm_${playerInfo.farmId || playerInfo.id}`;
            broadcastToRoom(
              oldRoom,
              {
                type: "peer_left_room",
                playerId: playerInfo.id,
                name: playerInfo.name,
                username: playerInfo.username,
              },
              ws
            );

            broadcast({
              type: "players_update",
              players: getOnlinePlayersList(),
              onlineCount: clients.size,
            });
          }
        } else if (data.type === "chat") {
          const text = String(data.text || "").trim().substring(0, 200);
          if (!text) return;

          const msg = {
            id:
              "msg_" +
              Date.now() +
              "_" +
              Math.random().toString(36).substring(2, 5),
            playerId: playerInfo.id,
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

            // Đồng bộ tên mới vào bộ nhớ nông trại nếu có
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
            broadcast({
              type: "players_update",
              players: getOnlinePlayersList(),
              onlineCount: clients.size,
            });
          }
        } else if (data.type === "voice_signal") {
          const targetId = data.targetId;
          for (const [targetWs, info] of clients.entries()) {
            if (info.id === targetId && targetWs.readyState === 1 /* OPEN */) {
              targetWs.send(
                JSON.stringify({
                  type: "voice_signal",
                  senderId: playerInfo.id,
                  signal: data.signal,
                })
              );
              break;
            }
          }
        } else if (data.type === "voice_status") {
          playerInfo.isMicOn = !!data.isMicOn;
          broadcastToRoom(playerInfo.roomId, {
            type: "voice_status",
            playerId: playerInfo.id,
            name: playerInfo.name,
            avatar: playerInfo.avatar || "👨‍🌾",
            isMicOn: playerInfo.isMicOn,
          });
          if (playerInfo.farmId && playerInfo.roomId !== `farm_${playerInfo.farmId}`) {
            broadcastToRoom(`farm_${playerInfo.farmId}`, {
              type: "voice_status",
              playerId: playerInfo.id,
              name: playerInfo.name,
              avatar: playerInfo.avatar || "👨‍🌾",
              isMicOn: playerInfo.isMicOn,
            });
          }
          broadcast({
            type: "players_update",
            players: getOnlinePlayersList(),
            onlineCount: clients.size,
          });
        } else if (data.type === "voice_speaking") {
          playerInfo.isSpeaking = !!data.speaking;
          broadcastToRoom(playerInfo.roomId, {
            type: "voice_speaking",
            playerId: playerInfo.id,
            speaking: !!data.speaking,
          });
          if (playerInfo.farmId && playerInfo.roomId !== `farm_${playerInfo.farmId}`) {
            broadcastToRoom(`farm_${playerInfo.farmId}`, {
              type: "voice_speaking",
              playerId: playerInfo.id,
              speaking: !!data.speaking,
            });
          }
        
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
          broadcast({
            type: "players_update",
            players: getOnlinePlayersList(),
            onlineCount: clients.size,
          });
        } else if (data.type === "crop_steal") {
          const targetFarmId = data.targetFarmId;
          const cropName = data.cropName || "Nông sản";
          const thiefName = playerInfo.name;

          broadcast({
            type: "crop_steal_event",
            thiefId: playerInfo.id,
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

    ws.on("close", () => {
      const p = clients.get(ws);
      clients.delete(ws);

      if (p) {
        if (p.roomId) {
          broadcastToRoom(p.roomId, {
            type: "peer_left_room",
            playerId: p.id,
            name: p.name,
          });
        }

        const leaveMsg = {
          id: "sys_" + Date.now(),
          name: "🌾 Làng Miêu Thiện",
          avatar: "🌾",
          text: `${p.avatar || "👨‍🌾"} ${p.name} đã tạm rời Làng Miêu Thiện.`,
          time: Date.now(),
          isSystem: true,
        };
        recentMessages.push(leaveMsg);
        broadcast({ type: "chat", ...leaveMsg });

        broadcast({
          type: "player_left",
          playerId: p.id,
          name: p.name,
          onlineCount: clients.size,
          players: getOnlinePlayersList(),
        });
      }
    });

    ws.on("error", (err) => {
      console.warn("[Multiplayer Hub] WebSocket error:", err.message);
    });
  });

  console.log(
    "🌾 [LÀNG MIEUTHIEN] Realtime Multiplayer, Voice, Avatars & Visiting Hub đã kích hoạt trên /ws/chat!"
  );
}

module.exports = { setupMultiplayerHub, getFarmState, saveFarmState };
