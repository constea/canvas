import { decodePoints, normalizeNote, normalizeNoteStroke } from './storage.js';

const EPHEMERAL_TYPES = new Set(['cursorMove', 'cursorLeave']);

// Сообщения разговора приходят от сервера и доски не касаются: их разбирает
// voice.js, а не handleRemoteMessage. Поля «client» в них нет намеренно — иначе
// фильтр своих сообщений ниже съедал бы сигналинг между двумя вкладками с
// одинаковым clientId (sessionStorage копируется в дублированную вкладку).
const VOICE_TYPES = new Set(['voiceWelcome', 'voiceRoster', 'voiceSignal', 'voiceFull']);

export class NetworkManager {
  constructor(storage, onMessageReceived, onRemoteFocus) {
    this.storage = storage;
    this.onMessageReceived = onMessageReceived; // callback to trigger rerender
    this.onRemoteFocus = onRemoteFocus;
    this.onRemoteCursor = null;
    // Разговор подключается тем же хуком, что и курсоры соседей.
    this.onVoiceMessage = null;
    this.onSocketOpen = null;

    this.socket = null;
    this.reconnectTimer = null;

    // Buffering variables for outgoing strokes
    this.bufferInterval = null;
    this.bufferedPoints = [];
    this.currentStrokeId = null;

    // Toast element for network status
    this.toastEl = document.getElementById('toast');

    // Счётчик участников онлайн (обновляется сообщениями presence от сервера)
    this.presenceEl = document.getElementById('userCount');

    // Дебаунс резервной записи в localStorage (см. _scheduleLocalSave)
    this._saveTimer = null;

    this.activeClientId = null;
    this.activeStrokeId = null;
    this.focusPausedUntil = 0;
    this.remoteWritingClients = new Set();
    this.remoteStrokeLastPoint = new Map();
    this.remoteCursorTimers = new Map();
    this.remoteCursorResumeAt = new Map();
    this.lastCursorSentAt = 0;
    this.lastCursorPoint = null;
  }

  showToast(msg) {
    if (!this.toastEl) return;
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 2000);
  }

  updatePresence(count) {
    const n = Math.max(0, count | 0);
    if (this.presenceEl) this.presenceEl.textContent = String(n);
  }

  pauseAutoFocus(ms = 3500) {
    this.focusPausedUntil = Math.max(this.focusPausedUntil, Date.now() + ms);
  }

  resumeAutoFocus() {
    this.focusPausedUntil = 0;
  }

  focusRemotePoint(point, clientId, strokeId) {
    if (!this.onRemoteFocus || !point) return;
    if (Date.now() < this.focusPausedUntil) return;

    this.activeClientId = clientId || null;
    this.activeStrokeId = strokeId || null;
    this.onRemoteFocus(point);
  }

  async init() {
    // 1. First load the initial board state via REST
    await this.loadInitialState();

    // 2. Open the WebSocket connection
    this.connectWebSocket();
  }

  async loadInitialState() {
    let ok = false;
    try {
      const r = await fetch(`api/board/${encodeURIComponent(this.storage.boardId)}`);
      if (r.ok) {
        const text = await r.text();
        if (text && text.trim() && text.trim() !== '{}') {
          ok = this.storage.deserialize(text);
        }
      }
    } catch (e) {
      console.warn("Failed to load state from server, falling back to local storage:", e);
    }

    if (!ok) {
      const ls = localStorage.getItem(this.storage.LS_KEY);
      if (ls) {
        this.storage.deserialize(ls);
      }
    }

    this.onMessageReceived();
  }

  connectWebSocket() {
    if (this.socket) {
      try { this.socket.close(); } catch(_) {}
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws/${encodeURIComponent(this.storage.boardId)}`;

    console.log("Connecting to WS:", wsUrl);
    this.socket = new WebSocket(wsUrl);

    this.socket.onopen = () => {
      console.log("WebSocket connected.");
      this.showToast("Соединение установлено");
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      // On reconnect, catch up state to ensure we are 100% in sync
      this.loadInitialState();
      // Разговор переживает обрыв сокета: медиа идёт мимо сигналинга. Но заново
      // представиться серверу и вернуться в состав нужно — этим займётся voice.js.
      if (this.onSocketOpen) this.onSocketOpen();
    };

    this.socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.client === this.storage.clientId) {
          // Ignore own messages as they are applied locally immediately
          return;
        }
        this.handleRemoteMessage(msg);
      } catch (err) {
        console.error("Error processing incoming WS message:", err);
      }
    };

    this.socket.onclose = (event) => {
      console.warn("WebSocket closed. Reconnecting in 3s...", event.reason);
      this.showToast("Соединение разорвано. Переподключение...");
      this.scheduleReconnect();
    };

    this.socket.onerror = (err) => {
      console.error("WebSocket error:", err);
      this.socket.close();
    };
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 3000);
  }

  send(msg) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const envelope = {
        board: this.storage.boardId,
        client: this.storage.clientId,
        timestamp: Date.now(),
        ...msg
      };
      this.socket.send(JSON.stringify(envelope));
    } else {
      // Local backup if server offline (сериализация отложена и коалесится)
      this.storage.dirty = true;
      this._scheduleLocalSave();
    }
  }

  sendEphemeral(msg) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      board: this.storage.boardId,
      client: this.storage.clientId,
      timestamp: Date.now(),
      ...msg
    }));
  }

  // Сигналинг разговора. От sendEphemeral отличается тем, что сообщает, ушло ли
  // сообщение: потерянный offer надо переиграть, а не молча забыть. Очередь тут
  // вредна — SDP протухает за секунды, а накопленные ICE-кандидаты после
  // переподключения относились бы уже к мёртвой сессии.
  sendVoice(msg) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({
      board: this.storage.boardId,
      client: this.storage.clientId,
      timestamp: Date.now(),
      ...msg
    }));
    return true;
  }

  sendCursor(point) {
    if (this.currentStrokeId || !point) return;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;

    const now = Date.now();
    const last = this.lastCursorPoint;
    // Ограничитель частоты был инвертирован: он отбрасывал пакет только когда
    // курсор почти стоит на месте, а ДВИЖУЩИЙСЯ курсор проходил без задержки —
    // то есть отправлял кадр на каждый pointermove (60–120 в секунду вместо 16).
    // Теперь окно в 60 мс действует всегда, а порог в 4 px дополнительно гасит
    // дрожание неподвижного курсора. Видимое поведение то же: соседи и раньше
    // видели курсор сглаженным (в canvas.js он интерполируется к цели).
    if (now - this.lastCursorSentAt < 60) return;
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 4) return;

    this.lastCursorSentAt = now;
    this.lastCursorPoint = { x: point.x, y: point.y };
    this.sendEphemeral({
      type: 'cursorMove',
      payload: { x: point.x, y: point.y }
    });
  }

  sendCursorLeave() {
    this.lastCursorPoint = null;
    this.sendEphemeral({ type: 'cursorLeave', payload: {} });
  }

  setRemoteCursor(clientId, point) {
    if (this.onRemoteCursor) this.onRemoteCursor(clientId, point);
  }

  // Плавающие окна живут в DOM, а не на холсте: перерисовка канвы их не
  // касается, поэтому об изменениях сообщаем отдельным событием.
  notesChanged() {
    window.dispatchEvent(new CustomEvent('notesChanged'));
  }

  clearRemoteCursorDelay(clientId) {
    const timer = this.remoteCursorTimers.get(clientId);
    if (timer) clearTimeout(timer);
    this.remoteCursorTimers.delete(clientId);
    this.remoteCursorResumeAt.delete(clientId);
  }

  scheduleRemoteCursor(clientId, point, delay = 450) {
    if (!clientId || !point) return;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;

    const showAt = Date.now() + delay;
    this.remoteCursorResumeAt.set(clientId, showAt);
    this.remoteStrokeLastPoint.set(clientId, point);

    const oldTimer = this.remoteCursorTimers.get(clientId);
    if (oldTimer) clearTimeout(oldTimer);

    const timer = setTimeout(() => {
      this.remoteCursorTimers.delete(clientId);
      this.remoteCursorResumeAt.delete(clientId);
      if (!this.remoteWritingClients.has(clientId)) {
        this.setRemoteCursor(clientId, this.remoteStrokeLastPoint.get(clientId) || point);
      }
    }, delay);
    this.remoteCursorTimers.set(clientId, timer);
  }

  // Резервное сохранение в localStorage с дебаунсом: убирает синхронную
  // сериализацию всей доски на каждый исходящий пакет (например, точки штриха).
  _scheduleLocalSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        localStorage.setItem(this.storage.LS_KEY, this.storage.serialize());
      } catch (_) {}
    }, 400);
  }

  // --- Buffering outgoing points (30-60 FPS) ---

  startStroke(strokeId, tool, color, size, startPoint) {
    this.currentStrokeId = strokeId;
    this.bufferedPoints = [this.encodePoint(startPoint)];
    this.lastCursorPoint = null;

    // Broadcast immediately the beginStroke event
    this.send({
      type: 'beginStroke',
      payload: {
        strokeId: strokeId,
        tool: tool,
        color: color,
        size: size,
        points: [this.encodePoint(startPoint)]
      }
    });

    // Start interval to send points (every 24ms, ~40fps)
    this.bufferInterval = setInterval(() => {
      this.flushBufferedPoints();
    }, 24);
  }

  bufferPoint(point) {
    this.bufferedPoints.push(this.encodePoint(point));
  }

  // Координата уходила в сеть с полной точностью float64: «240.23419203747073»
  // — 18 значащих цифр, около 20 байт на число. Мир доски шириной 1024 px, и
  // сотая доля мирового пикселя лежит далеко за пределом различимого даже при
  // DPR 3, поэтому округление до сотых не меняет ни одной видимой точки, но
  // сокращает точку в пакете примерно втрое. Округляем на клиенте, а не на
  // сервере: тогда экономятся и байты каждого пакета, и процессорное время
  // сервера при сохранении снимка.
  encodePoint(point) {
    const x = Math.round(point.x * 100) / 100;
    const y = Math.round(point.y * 100) / 100;
    const pressure = point.pressure ?? point.p;
    if (Number.isFinite(pressure)) return [x, y, Math.round(pressure * 1000) / 1000];
    return [x, y];
  }

  decodePoint(point) {
    if (Array.isArray(point)) {
      const decoded = { x: point[0], y: point[1] };
      if (Number.isFinite(point[2])) decoded.pressure = point[2];
      return decoded;
    }
    return point;
  }

  flushBufferedPoints() {
    if (this.bufferedPoints.length > 0 && this.currentStrokeId) {
      this.send({
        type: 'appendPoints',
        payload: {
          strokeId: this.currentStrokeId,
          points: this.bufferedPoints
        }
      });
      this.bufferedPoints = [];
    }
  }

  endStroke() {
    if (this.bufferInterval) {
      clearInterval(this.bufferInterval);
      this.bufferInterval = null;
    }
    this.flushBufferedPoints();
    if (this.currentStrokeId) {
      this.send({
        type: 'endStroke',
        payload: {
          strokeId: this.currentStrokeId
        }
      });
    }
    this.currentStrokeId = null;

    // Резервная копия доски в localStorage (отложенно, вне горячего пути)
    this._scheduleLocalSave();
  }

  // --- Handling Remote Operations ---

  handleRemoteMessage(msg) {
    if (VOICE_TYPES.has(msg.type)) {
      // return, а не break: у switch ниже нет ветки default, поэтому любой
      // неопознанный тип доходит до onMessageReceived() в конце метода — это
      // была бы полная перерисовка холста на каждый ICE-кандидат.
      if (this.onVoiceMessage) this.onVoiceMessage(msg);
      return;
    }
    if (EPHEMERAL_TYPES.has(msg.type)) {
      if (msg.type === 'cursorMove' && !this.remoteWritingClients.has(msg.client)) {
        const payload = msg.payload || {};
        const point = {
          x: Number(payload.x),
          y: Number(payload.y)
        };
        const resumeAt = this.remoteCursorResumeAt.get(msg.client) || 0;
        if (Date.now() < resumeAt) {
          this.scheduleRemoteCursor(msg.client, point, resumeAt - Date.now());
        } else {
          this.setRemoteCursor(msg.client, point);
        }
      } else if (msg.type === 'cursorLeave') {
        this.clearRemoteCursorDelay(msg.client);
        this.setRemoteCursor(msg.client, null);
      }
      return;
    }

    switch (msg.type) {
      case 'beginStroke': {
        const payload = msg.payload;
        const pts = (payload.points || []).map(p => this.decodePoint(p));
        this.clearRemoteCursorDelay(msg.client);
        this.remoteWritingClients.add(msg.client);
        this.setRemoteCursor(msg.client, null);
        const stroke = {
          id: payload.strokeId,
          tool: payload.tool,
          color: payload.color,
          size: payload.size,
          points: pts
        };
        this.storage.computeBBox(stroke);
        this.storage.strokes.push(stroke);
        this.storage.extendBottom(stroke);
        const lastPt = pts[pts.length - 1];
        if (lastPt) this.remoteStrokeLastPoint.set(msg.client, lastPt);
        // Полотно одно: чужой штрих всегда «наш», к нему просто подводим камеру.
        this.focusRemotePoint(lastPt, msg.client, payload.strokeId);
        break;
      }
      case 'appendPoints': {
        const payload = msg.payload;
        const stroke = this.storage.strokeById(payload.strokeId);
        if (stroke) {
          const newPts = payload.points.map(p => this.decodePoint(p));
          this.clearRemoteCursorDelay(msg.client);
          this.remoteWritingClients.add(msg.client);
          this.setRemoteCursor(msg.client, null);
          stroke.points.push(...newPts);
          // Обновляем bbox и границу только по новым точкам, а не по всему штриху.
          this.storage.extendBBox(stroke, newPts);
          this.storage.extendBottomPoints(newPts);
          const lastPt = newPts[newPts.length - 1];
          if (lastPt) this.remoteStrokeLastPoint.set(msg.client, lastPt);
          this.focusRemotePoint(lastPt, msg.client, payload.strokeId);
        }
        break;
      }
      case 'endStroke': {
        // Stroke complete. Bounding boxes already handled.
        const payload = msg.payload;
        if (payload && payload.strokeId === this.activeStrokeId) {
          this.activeClientId = null;
          this.activeStrokeId = null;
        }
        this.remoteWritingClients.delete(msg.client);
        this.scheduleRemoteCursor(msg.client, this.remoteStrokeLastPoint.get(msg.client) || null);
        break;
      }
      case 'deleteObject': {
        const id = msg.payload.objectId;
        const sIdx = this.storage.strokes.findIndex(s => s.id === id);
        if (sIdx >= 0) {
          this.storage.strokes.splice(sIdx, 1);
        } else {
          const iIdx = this.storage.images.findIndex(im => im.id === id);
          if (iIdx >= 0) {
            this.storage.images.splice(iIdx, 1);
          } else if (this.storage.removeNote(id)) {
            this.notesChanged();
          }
        }
        this.storage.selection = null;
        this.storage.recomputeContentBottom();
        break;
      }
      case 'restoreObject': {
        const id = msg.payload.objectId;
        const data = msg.payload.data;
        if (data.type === 'stroke') {
          // Ensure we don't have duplicates
          const idx = this.storage.strokes.findIndex(s => s.id === id);
          const strokeObj = {
            id: id,
            tool: data.tool,
            color: data.color,
            size: data.size,
            points: decodePoints(data.points)
          };
          this.storage.computeBBox(strokeObj);
          if (idx >= 0) {
            this.storage.strokes[idx] = strokeObj;
            this.storage.invalidateIndex();   // длина не изменилась, объект — да
          } else {
            this.storage.strokes.push(strokeObj);
          }
        } else if (data.type === 'note') {
          const note = normalizeNote({ ...data, id });
          const idx = this.storage.notes.findIndex(n => n.id === id);
          if (idx >= 0) this.storage.notes[idx] = note;
          else this.storage.notes.push(note);
          this.notesChanged();
        } else if (data.type === 'image') {
          const idx = this.storage.images.findIndex(im => im.id === id);
          // Растр заведёт окно загрузки, когда картинка окажется рядом с камерой.
          const img = {
            id: id,
            src: data.src,
            x: data.x,
            y: data.y,
            w: data.w,
            h: data.h,
            img: null
          };
          if (idx >= 0) {
            this.storage.images[idx] = img;
            this.storage.invalidateIndex();   // длина не изменилась, объект — да
          } else {
            this.storage.images.push(img);
          }
        }
        this.storage.selection = null;
        this.storage.recomputeContentBottom();
        break;
      }
      case 'moveObject': {
        const payload = msg.payload;
        const img = this.storage.imageById(payload.objectId);
        if (img) {
          img.x = payload.x;
          img.y = payload.y;
          if (payload.w) img.w = payload.w;
          if (payload.h) img.h = payload.h;
          this.storage.recomputeContentBottom();
        }
        break;
      }
      case 'addImage': {
        const payload = msg.payload;
        const img = {
          id: payload.imageId,
          src: payload.src,
          x: payload.x,
          y: payload.y,
          w: payload.w,
          h: payload.h,
          img: null
        };
        this.storage.images.push(img);
        this.storage.extendBottom(img);
        break;
      }
      case 'addNote': {
        const payload = msg.payload || {};
        const note = normalizeNote({ ...payload, id: payload.noteId });
        if (!this.storage.noteById(note.id)) this.storage.notes.push(note);
        this.notesChanged();
        break;
      }
      case 'updateNote': {
        // Геометрия окна идёт потоком при перетаскивании — обновляем по месту,
        // чтобы не пересоздавать элемент и не сбивать чужой набор текста.
        const payload = msg.payload || {};
        const note = this.storage.noteById(payload.noteId);
        if (note) {
          // Нормализуем только геометрию: пересобирать штрихи окна на каждый
          // пакет перетаскивания незачем.
          const next = normalizeNote({
            id: note.id,
            x: payload.x ?? note.x,
            y: payload.y ?? note.y,
            w: payload.w ?? note.w,
            h: payload.h ?? note.h
          });
          note.x = next.x;
          note.y = next.y;
          note.w = next.w;
          note.h = next.h;
          this.notesChanged();
        }
        break;
      }
      case 'noteStroke': {
        // Штрих в чужом окне: тот же формат, что и на полотне, но координаты —
        // внутренние координаты окна.
        const payload = msg.payload || {};
        const note = this.storage.noteById(payload.noteId);
        if (note && !note.strokes.some(s => s.id === payload.strokeId)) {
          note.strokes.push(normalizeNoteStroke({ ...payload, id: payload.strokeId }));
          this.notesChanged();
        }
        break;
      }
      case 'noteStrokePoints': {
        const payload = msg.payload || {};
        const note = this.storage.noteById(payload.noteId);
        const stroke = note && note.strokes.find(s => s.id === payload.strokeId);
        if (stroke) {
          stroke.points.push(...decodePoints(payload.points));
          this.notesChanged();
        }
        break;
      }
      case 'noteStrokeDelete': {
        const payload = msg.payload || {};
        const note = this.storage.noteById(payload.noteId);
        if (note) {
          const at = note.strokes.findIndex(s => s.id === payload.strokeId);
          if (at >= 0) {
            note.strokes.splice(at, 1);
            this.notesChanged();
          }
        }
        break;
      }
      case 'clearBoard': {
        this.storage.strokes = [];
        this.storage.images = [];
        this.storage.notes = [];
        this.storage.selected = null;
        this.storage.selection = null;
        this.storage.contentBottom = 0;
        this.storage.cameraY = 0;
        this.notesChanged();
        break;
      }
      case 'undo': {
        if (msg.payload && msg.payload.inverseOp) {
          this.handleRemoteMessage(msg.payload.inverseOp);
        }
        break;
      }
      case 'redo': {
        if (msg.payload && msg.payload.op) {
          this.handleRemoteMessage(msg.payload.op);
        }
        break;
      }
      case 'presence': {
        // Только обновляем счётчик участников — перерисовка холста не нужна.
        this.updatePresence(msg.count);
        return;
      }
    }

    // Trigger canvas repaint
    this.onMessageReceived();
  }
}
