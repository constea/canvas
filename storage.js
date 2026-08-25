export const BOARD_W = 1024;                  // единая ширина холста (мировые px) для всех участников
export const NOTE_MAX_H = 4000;               // предел высоты плавающего окна (мировые px)
// Доска-блокнот схлопывается в одно полотно: лист встаёт под предыдущим, отступ
// между ними читается как «здесь кончился один лист и начался другой».
export const PAGE_FOLD_GAP = 400;             // зазор между склеенными листами (мировые px)
export const HL_ALPHA = 0.32;                 // прозрачность маркера
export const DEFAULT_PEN = ['#1d1d1d','#e03131','#2f9e44'];   // 3 быстрых цвета ручки
export const DEFAULT_HL  = ['#fde047','#7f46a4'];             // 2 цвета маркера
export const SIZE_PRESETS = {                 // пресеты толщины по инструментам
  pen:[2,3.5,6], highlighter:[14,22,30], eraser:[16,28,46]
};
export const SIZE_DEFAULT = { pen:1, highlighter:1, eraser:1 };  // индексы пресета толщины
export const MAX_EXPORT_H = 12000;            // ограничение высоты экспорта

// --- Плавающие окна ---
//
// Окно — маленький холст поверх листа, на котором пишут теми же инструментами.
// Штрихи и картинки листа живут в мировых координатах и уезжают вместе с
// камерой; окно — наоборот, приклеено к ЭКРАНУ, поэтому прокрутка его не
// двигает.
//
// Окно принадлежит доске целиком, а не куску полотна: полотно одно, и «уехать»
// от окна прокруткой нельзя — оно всегда на своём месте экрана.
//
// Единицы измерения выбраны так, чтобы «одна и та же часть экрана» значила одно
// и то же и на телефоне, и на мониторе:
//   x, w, h — мировые px (доска всегда 1024 в ширину, см. BOARD_W). Ширина окна
//             и толщина линий в нём масштабируются ровно как содержимое листа,
//             поэтому у всех участников окно занимает одинаковую долю экрана и
//             выглядит одинаково.
//   y       — доля видимой высоты (0…1): высота экрана у всех разная, и только
//             доля даёт одно и то же место по вертикали.
// Штрихи внутри окна — в его собственных координатах (0…w, 0…h), тот же масштаб.
export const NOTE_DEFAULT_W = 300;
export const NOTE_DEFAULT_H = 210;
export const NOTE_MIN_W = 130;
export const NOTE_MIN_H = 90;

// Доля видимой области: всё, что не число или вне 0…1, приводится к границе.
export function clampUnit(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function noteSide(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Штрих внутри окна: тот же формат, что и на полотне, минус bbox — окно
// маленькое, отсечения по видимости в нём не нужно.
export function normalizeNoteStroke(raw) {
  const src = raw || {};
  return {
    id: src.id || generateUUID(),
    tool: src.tool === 'highlighter' || src.tool === 'eraser' ? src.tool : 'pen',
    color: typeof src.color === 'string' ? src.color.slice(0, 32) : '#1d1d1d',
    size: Number.isFinite(Number(src.size)) ? Math.max(0.5, Math.min(120, Number(src.size))) : 3.5,
    points: decodePoints(src.points)
  };
}

// Единая нормализация окна: и для снимка доски, и для сообщений по сети. Чужой
// клиент (или старый снимок) не должен уметь прислать окно с NaN-координатой.
export function normalizeNote(raw) {
  const src = raw || {};
  const w = noteSide(src.w, NOTE_DEFAULT_W, NOTE_MIN_W, BOARD_W);
  return {
    id: src.id || generateUUID(),
    x: Math.max(0, Math.min(BOARD_W - w, Number(src.x) || 0)),
    y: clampUnit(src.y, 0.1),
    w,
    h: noteSide(src.h, NOTE_DEFAULT_H, NOTE_MIN_H, NOTE_MAX_H),
    strokes: (src.strokes || []).map(normalizeNoteStroke)
  };
}

// Точки приходят с сервера и по сети в компактном виде [x, y] / [x, y, pressure]
// (втрое меньше байт, чем {"x":…,"y":…}). Внутри клиента точка — объект: так её
// читают рендер, лассо и история. Разворачиваем один раз при загрузке снимка.
export function decodePoints(points) {
  if (!points || !points.length) return [];
  if (!Array.isArray(points[0])) return points;
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    out[i] = Number.isFinite(p[2])
      ? { x: p[0], y: p[1], pressure: p[2] }
      : { x: p[0], y: p[1] };
  }
  return out;
}

export function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// --- Склейка блокнота в полотно ---
//
// Доски, записанные версией со страницами, приходят списком листов: у объекта
// есть page, а его y отсчитан от верха СВОЕГО листа. Полотно одно, поэтому
// лист встаёт под предыдущим — сдвиг равен сумме фактических высот всех листов
// до него плюс зазор на каждый стык. Пустой лист занимает один зазор: копить
// пустоту в тысячи px там, где никто ничего не нарисовал, незачем.
//
// Работаем с сырым снимком (points ещё в компактном виде [x, y]) и правим его
// на месте: ровно те же вычисления делает сервер, когда поднимает с диска
// старый файл доски.
const LEGACY_PAGE_ID = 'page-1';

function rawPointY(p) {
  const y = Array.isArray(p) ? p[1] : (p && p.y);
  return Number.isFinite(Number(y)) ? Number(y) : 0;
}

function shiftRawPoint(p, dy) {
  if (Array.isArray(p)) p[1] = rawPointY(p) + dy;
  else if (p) p.y = rawPointY(p) + dy;
}

export function foldPages(snapshot) {
  const o = snapshot || {};
  const strokes = Array.isArray(o.strokes) ? o.strokes : [];
  const images = Array.isArray(o.images) ? o.images : [];

  // Порядок листов: сначала объявленный в снимке, затем страницы, встретившиеся
  // только у объектов, — так же их добирала прежняя ensurePage.
  const order = [];
  const known = new Set();
  const track = (id) => {
    const key = typeof id === 'string' && id ? id : LEGACY_PAGE_ID;
    if (!known.has(key)) { known.add(key); order.push(key); }
    return key;
  };
  for (const id of (Array.isArray(o.pages) ? o.pages : [])) track(id);
  for (const s of strokes) track(s && s.page);
  for (const im of images) track(im && im.page);
  delete o.pages;
  if (order.length < 2) return o;               // один лист — координаты уже полотняные

  // Высота листа — самая нижняя точка его содержимого.
  const bottom = new Map(order.map(id => [id, 0]));
  const grow = (page, y) => { if (y > bottom.get(page)) bottom.set(page, y); };
  for (const s of strokes) {
    const page = track(s && s.page);
    const size = Number(s && s.size) || 0;
    for (const p of (s && s.points) || []) grow(page, rawPointY(p) + size);
  }
  for (const im of images) {
    grow(track(im && im.page), (Number(im && im.y) || 0) + (Number(im && im.h) || 0));
  }

  const offset = new Map();
  let top = 0;
  for (const id of order) {
    offset.set(id, top);
    top += bottom.get(id) + PAGE_FOLD_GAP;
  }

  for (const s of strokes) {
    const dy = offset.get(track(s && s.page)) || 0;
    delete s.page;
    if (!dy) continue;
    for (const p of (s && s.points) || []) shiftRawPoint(p, dy);
  }
  for (const im of images) {
    const dy = offset.get(track(im && im.page)) || 0;
    delete im.page;
    if (dy) im.y = (Number(im.y) || 0) + dy;
  }
  for (const n of (Array.isArray(o.notes) ? o.notes : [])) delete n.page;
  return o;
}

export class BoardStorage {
  constructor() {
    this.boardId = (decodeURIComponent((location.hash||'').replace(/^#/,''))
                     .replace(/[^A-Za-z0-9_\-]/g,'').slice(0,64)) || 'default';
    this.LS_KEY = 'wb:' + this.boardId;
    this.clientId = this.getOrCreateClientId();

    this.penColors = DEFAULT_PEN.slice();
    this.hlColors  = DEFAULT_HL.slice();
    this.tool = 'pen';                      // pen | highlighter | eraser | lasso | select
    this.penIdx = 0;
    this.hlIdx = 0;            // выбранный быстрый цвет
    this.sizeIdx = Object.assign({}, SIZE_DEFAULT);

    // Доска — одно непрерывное полотно: у объектов есть только мировая
    // координата, и всё, что на нём нарисовано, лежит в одной системе координат.
    this.strokes = [];                      // [{id, tool, color, size, points:[{x,y}], minY, maxY}]
    // img у картинки — растр по окну загрузки (см. syncImages): вне окна
    // остаётся только строка src.
    this.images  = [];                      // [{id, src, img, x, y, w, h}]
    // Плавающие окна: координаты — доли экрана, а не мира (см. normalizeNote).
    // Живут в DOM поверх холста, поэтому в рендер канвы не попадают.
    this.notes   = [];                      // [{id, x, y, w, h, strokes}]
    this.contentBottom = 0;                 // нижняя граница содержимого (мир)
    this.cameraY = 0;                       // смещение «камеры» вниз (мир)
    this.selected = null;                   // выбранное изображение
    this.selection = null;                  // групповое выделение лассо: {strokes, images}
    this.dirty = false;
  }

  getOrCreateClientId() {
    let id = sessionStorage.getItem('wb_client_id');
    if (!id) {
      id = generateUUID();
      sessionStorage.setItem('wb_client_id', id);
    }
    return id;
  }

  // v: 2 — полотно вместо блокнота. Полей pages и page в снимке больше нет;
  // снимок первой версии разбирается через foldPages (см. deserialize).
  serialize() {
    return JSON.stringify({
      v: 2,
      contentBottom: this.contentBottom,
      penColors: this.penColors,
      hlColors: this.hlColors,
      strokes: this.strokes.map(s => ({
        id: s.id || generateUUID(),
        tool: s.tool,
        color: s.color,
        size: s.size,
        points: s.points
      })),
      images: this.images.map(im => ({
        id: im.id || generateUUID(),
        x: im.x,
        y: im.y,
        w: im.w,
        h: im.h,
        src: im.src
      })),
      notes: this.notes.map(n => normalizeNote(n))
    });
  }

  deserialize(text) {
    let o;
    try {
      o = typeof text === 'string' ? JSON.parse(text) : text;
    } catch(_) {
      return false;
    }
    if (!o || typeof o !== 'object') return false;

    if (Array.isArray(o.penColors) && o.penColors.length) this.penColors = o.penColors.slice(0,3);
    if (Array.isArray(o.hlColors) && o.hlColors.length) this.hlColors = o.hlColors.slice(0,2);

    // Снимок доски-блокнота приводится к полотну до разбора — дальше про
    // страницы не знает уже никто.
    foldPages(o);

    this.strokes = (o.strokes || []).map(s => {
      const st = {
        id: s.id || generateUUID(),
        tool: s.tool,
        color: s.color,
        size: s.size,
        points: decodePoints(s.points)
      };
      this.computeBBox(st);
      return st;
    });

    // Растр картинки заводится не здесь, а окном загрузки (см. syncImages):
    // декодировать разом всё полотно — это десятки мегабайт за содержимое,
    // до которого ещё не доскроллили.
    this.images = (o.images || []).map(d => ({
      id: d.id || generateUUID(),
      src: d.src,
      x: d.x,
      y: d.y,
      w: d.w,
      h: d.h,
      img: null
    }));

    this.notes = (o.notes || []).map(d => normalizeNote(d));

    this.selected = null;
    this.selection = null;
    this.recomputeContentBottom();
    if (window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('notesChanged'));
    }
    return true;
  }

  noteById(id) {
    return this.notes.find(n => n.id === id);
  }

  removeNote(id) {
    const at = this.notes.findIndex(n => n.id === id);
    return at < 0 ? null : this.notes.splice(at, 1)[0];
  }

  // --- Окно загрузки картинок ---
  //
  // Полотно одно и длинное: держать декодированными все картинки доски — это
  // десятки мегабайт видеопамяти за содержимое, которого не видно. Растр живёт
  // только у картинок в окне вокруг камеры, у остальных остаётся строка src, и
  // возвращение в окно стоит одной загрузки.
  //
  // Порог выгрузки вдвое дальше порога загрузки: без этого запаса картинка,
  // стоящая ровно на кромке окна, грузилась бы и выгружалась на каждом
  // дрожании прокрутки.
  syncImages(top, bottom, pad) {
    const loadTop = top - pad, loadBottom = bottom + pad;
    const dropTop = top - pad * 2, dropBottom = bottom + pad * 2;
    for (const im of this.images) {
      const y0 = im.y, y1 = im.y + im.h;
      if (y1 >= loadTop && y0 <= loadBottom) this.loadImage(im);
      else if (y1 < dropTop || y0 > dropBottom) this.unloadImage(im);
    }
  }

  loadImage(im) {
    if (!im || !im.src) return null;
    if (im.img) return im.img;
    const img = new Image();
    img.onload = () => {
      if (window.dispatchEvent) window.dispatchEvent(new CustomEvent('imageLoaded'));
    };
    img.src = im.src;
    im.img = img;
    return img;
  }

  // Ссылку на элемент отпускаем — растр освобождает сборщик мусора. Присваивать
  // src пустую строку при этом нельзя: часть браузеров понимает её как запрос к
  // самой странице.
  unloadImage(im) {
    if (!im || !im.img) return;
    if (im === this.selected) return;          // выбранную картинку сейчас держат за ручки
    im.img.onload = null;
    im.img = null;
  }

  // Все картинки разом — для экспорта: в PDF уходит всё полотно, а не окно.
  loadAllImages() {
    const pending = [];
    for (const im of this.images) {
      const img = this.loadImage(im);
      if (!img || (img.complete && img.naturalWidth)) continue;
      pending.push(new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }));
    }
    return Promise.all(pending);
  }

  extendBottom(s) {
    if (s.points) {
      for (const p of s.points) {
        if (p.y > this.contentBottom) this.contentBottom = p.y;
      }
    } else if (s.y !== undefined && s.h !== undefined) {
      if (s.y + s.h > this.contentBottom) this.contentBottom = s.y + s.h;
    }
  }

  // Инкрементальное расширение bbox штриха только по новым точкам —
  // без повторного обхода всех точек (важно для «живого» удалённого штриха).
  extendBBox(s, pts) {
    if (s.minY === undefined || s.maxY === undefined) { this.computeBBox(s); return; }
    for (const p of pts) {
      const lo = p.y - s.size, hi = p.y + s.size;
      if (lo < s.minY) s.minY = lo;
      if (hi > s.maxY) s.maxY = hi;
    }
  }

  // Рост нижней границы содержимого только по переданным точкам.
  extendBottomPoints(pts) {
    for (const p of pts) {
      if (p.y > this.contentBottom) this.contentBottom = p.y;
    }
  }

  recomputeContentBottom() {
    let m = 0;
    for (const s of this.strokes) {
      if (s.maxY > m) m = s.maxY;
    }
    for (const im of this.images) {
      if (im.y + im.h > m) m = im.y + im.h;
    }
    this.contentBottom = m;
  }

  // --- Индекс по id ---
  //
  // Поиск объекта по id стоял на самом горячем сетевом пути: appendPoints от
  // каждого пишущего соседа (≈40 пакетов/с) делал линейный скан всего массива
  // штрихов. Замер: 0.0395 мс на скан по 10 000 штрихов против 0.0001 мс через
  // Map — в 395 раз дороже, и стоимость растёт с числом и штрихов, и соседей.
  //
  // Индекс — кэш, а не второй источник истины: он перестраивается, как только
  // длина массива изменилась (push/splice/filter) или его пометили вручную
  // (замена элемента по месту при restoreObject). Пропустить инвалидацию
  // невозможно: любое добавление или удаление меняет длину.
  invalidateIndex() {
    this._idxDirty = true;
  }

  _index() {
    if (this._idx === undefined) { this._idx = new Map(); this._idxLen = -1; this._idxDirty = true; }
    if (this._idxDirty || this._idxLen !== this.strokes.length + this.images.length) {
      this._idx.clear();
      for (const s of this.strokes) this._idx.set(s.id, s);
      for (const im of this.images) this._idx.set(im.id, im);
      this._idxLen = this.strokes.length + this.images.length;
      this._idxDirty = false;
    }
    return this._idx;
  }

  strokeById(id) {
    const o = this._index().get(id);
    return o && o.points !== undefined ? o : undefined;
  }

  imageById(id) {
    const o = this._index().get(id);
    return o && o.points === undefined ? o : undefined;
  }

  objectById(id) {
    return this._index().get(id);
  }

  computeBBox(s) {
    let mnY = Infinity, mxY = -Infinity;
    for (const p of s.points) {
      if (p.y < mnY) mnY = p.y;
      if (p.y > mxY) mxY = p.y;
    }
    s.minY = mnY === Infinity ? 0 : mnY - s.size;
    s.maxY = mxY === -Infinity ? 0 : mxY + s.size;
  }
}
