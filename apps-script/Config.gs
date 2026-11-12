// Config.gs — листы, настройки, секреты, лог, замок. Секреты — только Script Properties.

function props_() { return PropertiesService.getScriptProperties(); }

// Ошибка с безопасным текстом (без URL, токенов, кусков ответа): только такой текст показываем в «Проверке подключений»
function pubError_(msg) { var e = new Error(msg); e.pub = true; return e; }
// Короткое сообщение из поля error ответа API
function errText_(msg) { return sanitizeLog_(msg === undefined || msg === null ? '' : msg).slice(0, 120); }

function secret_(name) {
  var v = props_().getProperty(name);
  if (!v) throw pubError_('Не задан секрет ' + name + ' (раздел «Подключения» в настройках)');
  return v;
}

// SHEET_ID сохраняет setupTemplate: в веб-приложении getActive() может вернуть null. Один раз на выполнение
var ssCache_ = null;
function ss_() {
  if (!ssCache_) {
    var id = props_().getProperty('SHEET_ID');
    ssCache_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
  }
  return ssCache_;
}

function readConfig_() {
  var kv = {};
  readTable_('Settings').forEach(function (r) { if (r.key !== '') kv[String(r.key).trim()] = r.value; });
  return parseConfig_(kv);
}

function fmtIso_(ms, tz) { return Utilities.formatDate(new Date(ms), tz, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
// Любая ISO-дата со смещением → ISO в поясе отчёта (не разобралась — как есть)
function isoInTz_(s, tz) {
  var ms = Date.parse(s);
  return isFinite(ms) ? fmtIso_(ms, tz) : (s || '');
}

function cellValue_(v, header, tz) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, tz, 'HH:mm:ss') === '00:00:00' ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : fmtIso_(v.getTime(), tz);
  }
  if (TEXT_COLUMNS.indexOf(header) >= 0) return v === null || v === undefined ? '' : String(v);
  return v;
}

// Лист → массив объектов по заголовкам. Пояс — пояс таблицы (setupTemplate ставит его из Settings.timezone)
function readTable_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var tz = ss_().getSpreadsheetTimeZone();
  var values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var head = values[0], out = [];
  for (var i = 1; i < values.length; i++) {
    var empty = true, o = {};
    for (var j = 0; j < head.length; j++) {
      if (values[i][j] !== '') empty = false;
      o[head[j]] = cellValue_(values[i][j], head[j], tz);
    }
    if (!empty) out.push(o);
  }
  return out;
}

// Текстовые колонки пишем как есть (ячейка с форматом '@' формулу не исполняет, апострофы не копятся),
// остальные — через sheetSafeValue_ (= + - @ и ведущие пробел/таб экранируются)
function rowsToArrays_(head, rows) {
  return rows.map(function (r) {
    return head.map(function (h) {
      var v = r[h] === undefined || r[h] === null ? '' : r[h];
      return TEXT_COLUMNS.indexOf(h) >= 0 ? v : sheetSafeValue_(v);
    });
  });
}

// Формат '@' ставим на записываемый диапазон ДО значений
function putRows_(sh, startRow, head, rows) {
  var need = startRow + rows.length - 1 - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need); // иначе setValues за краем листа падает (Log растёт)
  head.forEach(function (h, i) {
    if (TEXT_COLUMNS.indexOf(h) >= 0) sh.getRange(startRow, i + 1, rows.length, 1).setNumberFormat('@');
  });
  sh.getRange(startRow, 1, rows.length, head.length).setValues(rowsToArrays_(head, rows));
}

// Полная перезапись данных (шапка остаётся): сначала новые строки, потом чистим только хвост — сбой посередине не оставит лист пустым
function writeTable_(name, rows) {
  var sh = ss_().getSheetByName(name), head = SHEET_HEADERS[name], old = sh.getLastRow();
  if (rows.length) {
    putRows_(sh, 2, head, rows);
  }
  if (old > rows.length + 1) sh.getRange(rows.length + 2, 1, old - rows.length - 1, head.length).clearContent();
}

// Upsert по ключу
function mergeRows_(name, keyFn, newRows) {
  var existing = readTable_(name), map = {}, order = [];
  existing.forEach(function (r) { var k = keyFn(r); if (!(k in map)) order.push(k); map[k] = r; });
  newRows.forEach(function (r) {
    var k = keyFn(r);
    if (!(k in map)) order.push(k);
    map[k] = r;
  });
  writeTable_(name, order.map(function (k) { return map[k]; }));
  return newRows.length;
}

// Meta_Ads: строки окна синка (date >= from) заменяются новыми, строки старше cutoff удаляются, остальные не трогаем
// (лист не переписывается целиком и не растёт бесконечно). Лист упорядочен по date; иначе (ручные правки, пустые строки) — полная атомарная перезапись.
// Порядок: сначала записываются новые строки (сбой записи оставляет лист как был), потом чистится хвост и удаляется старьё.
var META_KEEP_DAYS = 400;
function replaceMetaAds_(rows, from, cutoff) {
  var name = 'Meta_Ads', sh = ss_().getSheetByName(name), head = SHEET_HEADERS[name], existing = readTable_(name), byKey = {}, order = [];
  rows.forEach(function (r) { var k = dateKey_(r.date) + '|' + r.ad_id; if (!(k in byKey)) order.push(k); byKey[k] = r; });
  var fresh = order.map(function (k) { return byKey[k]; }).sort(function (p, q) { return dateKey_(p.date) < dateKey_(q.date) ? -1 : (dateKey_(p.date) > dateKey_(q.date) ? 1 : 0); });
  var tooOld = 0, keep = 0, sorted = existing.length === Math.max(sh.getLastRow() - 1, 0);
  existing.forEach(function (r, i) {
    var d = dateKey_(r.date);
    if (i > 0 && d < dateKey_(existing[i - 1].date)) sorted = false;
    if (d < cutoff) tooOld++; else if (d < from) keep++;
  });
  if (!sorted) {
    writeTable_(name, existing.filter(function (r) { var d = dateKey_(r.date); return d >= cutoff && d < from; }).concat(fresh));
    return;
  }
  var start = 2 + tooOld + keep, last = sh.getLastRow(), end = start + fresh.length - 1;
  if (fresh.length) putRows_(sh, start, head, fresh);
  if (last > Math.max(end, start - 1)) sh.getRange(Math.max(end, start - 1) + 1, 1, last - Math.max(end, start - 1), head.length).clearContent();
  if (tooOld > 0) sh.deleteRows(2, tooOld);
}

function appendRows_(name, rows) {
  if (!rows.length) return;
  var sh = ss_().getSheetByName(name);
  putRows_(sh, sh.getLastRow() + 1, SHEET_HEADERS[name], rows);
}

// Секреты в сообщение попадать не должны: вызывающий не передаёт значения, sanitizeLog_ убирает URL
function log_(level, source, message) {
  try {
    appendRows_('Log', [{ ts: fmtIso_(Date.now(), readConfig_().timezone), level: level, source: source, message: sanitizeLog_(message).slice(0, 500) }]);
  } catch (e) { console.error(source + ': ' + sanitizeLog_(message)); }
}
var LOG_KEEP = 2000;
function trimLog_() {
  var sh = ss_().getSheetByName('Log');
  if (sh && sh.getLastRow() > LOG_KEEP + 1) sh.deleteRows(2, sh.getLastRow() - 1 - LOG_KEEP);
}

// «Сегодня» в поясе отчёта — средствами Apps Script (чистые функции получают готовую строку)
function todayKey_(cfg) { return Utilities.formatDate(new Date(), cfg.timezone, 'yyyy-MM-dd'); }
function daysAgoKey_(cfg, n) { return addDays_(todayKey_(cfg), -n); }

// Идёт ли синк: флаг SYNC_RUNNING (время старта). Замок на время синка не держим — иначе вход и сохранения ждали бы минуты.
// Флаг старше 10 минут считается мёртвым (скрипт убит по лимиту времени)
var SYNC_FLAG_TTL_MS = 10 * 60 * 1000;
function syncRunning_() {
  var t = +props_().getProperty('SYNC_RUNNING') || 0;
  return t > 0 && Date.now() - t < SYNC_FLAG_TTL_MS;
}
// Короткая запись в лист под замком (секунды, без сетевых запросов); занято → ошибка с кодом busy
function lockedWrite_(fn, source) {
  var r = withLock_(source || 'Sync', function () { fn(); return true; });
  if (!r) { var e = pubError_('Лист занят другим процессом, повторите позже'); e.apiCode = 'busy'; throw e; }
}

// Замок на запись: не взяли за 30 с — пишем в Log и выходим (null). Перед отпусканием сбрасываем отложенные записи в лист
function withLock_(source, fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { log_('WARN', source, 'пропуск: другой процесс уже работает'); return null; }
  try { return fn(); } finally {
    try { SpreadsheetApp.flush(); } catch (e) { /* сброс — подстраховка */ }
    lock.releaseLock();
  }
}
