// Code.gs — точки входа: веб-приложение (doGet), меню таблицы, синк, прогресс, триггер.

// Публичны (доступны через google.script.run) только doGet, doPost, onOpen, api*, пункты меню и triggerSyncAll; остальное — с «_» на конце.
// Пункты меню первой строкой берут окно таблицы: из веб-приложения оно недоступно → {ok:false, error:'forbidden'}. Аргументы не читают.
function menuUi_() { try { return SpreadsheetApp.getUi(); } catch (e) { return null; } }
var FORBIDDEN_ = { ok: false, error: 'forbidden' };

function onOpen() {
  var ui = menuUi_();
  if (!ui) return FORBIDDEN_;
  ui.createMenu('UTM Аналитика')
    .addItem('Открыть дашборд', 'openDashboard')
    .addItem('Первичная настройка', 'setupTemplate')
    .addItem('Задать пароль администратора', 'setAdminPassword')
    .addItem('Синк сейчас', 'runSyncAll')
    .addItem('Сбросить блокировку входа', 'resetLoginLock')
    .addToUi();
}

// Страница живёт в iframe Google; X-Frame-Options оставляем по умолчанию (не ALLOWALL)
var DASH_URL_RE_ = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
function doGet() {
  // Адрес дашборда запоминаем здесь: только внутри опубликованного приложения Google отдаёт адрес именно этого развёртывания
  // (из меню таблицы getUrl() возвращает адрес другого, неопубликованного). Значение — от Google, не от посетителя.
  try {
    var u = String(ScriptApp.getService().getUrl() || '');
    if (DASH_URL_RE_.test(u) && props_().getProperty('DASH_URL') !== u) props_().setProperty('DASH_URL', u);
  } catch (e) { /* адрес — удобство для меню; его сбой не мешает открыть дашборд */ }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('UTM Аналитика')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

// Вызовы со страницы-оболочки (GitHub Pages): fetch с телом-JSON {"fn": "apiX", "args": [...]}, Content-Type text/plain (без preflight).
// Токен сессии — аргумент функций, cookie не используются, поэтому CSRF неприменим. Вызываются только 14 api* из явной таблицы
// (имя → вызов; не this[fn] и не eval), всё остальное — bad_request. Наружу только объект, который вернула api-функция, или код ошибки.
var DO_POST_MAX_BODY_ = 600000, DO_POST_MAX_ARGS_ = 3;
var API_TABLE_ = {
  apiBoot: function (a) { return apiBoot(a[0]); },
  apiLogin: function (a) { return apiLogin(a[0]); },
  apiData: function (a) { return apiData(a[0], a[1]); },
  apiProgress: function (a) { return apiProgress(a[0]); },
  apiSettingsGet: function (a) { return apiSettingsGet(a[0]); },
  apiSettingsSave: function (a) { return apiSettingsSave(a[0], a[1]); },
  apiSecretSave: function (a) { return apiSecretSave(a[0], a[1], a[2]); },
  apiPasswordSave: function (a) { return apiPasswordSave(a[0], a[1], a[2]); },
  apiChannelsSave: function (a) { return apiChannelsSave(a[0], a[1]); },
  apiSpendSave: function (a) { return apiSpendSave(a[0], a[1]); },
  apiLogoSave: function (a) { return apiLogoSave(a[0], a[1]); },
  apiCheck: function (a) { return apiCheck(a[0]); },
  apiStagesRefresh: function (a) { return apiStagesRefresh(a[0]); },
  apiSync: function (a) { return apiSync(a[0]); }
};
function postJson_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function doPost(e) {
  var res;
  try {
    var body = e && e.postData && e.postData.contents, req = null;
    if (typeof body === 'string' && body.length <= DO_POST_MAX_BODY_) { try { req = JSON.parse(body); } catch (err) { req = null; } }
    if (!isPlainObject_(req) || typeof req.fn !== 'string' || !has_(API_TABLE_, req.fn) || !Array.isArray(req.args) || req.args.length > DO_POST_MAX_ARGS_) {
      res = { ok: false, error: 'bad_request' };
    } else {
      res = API_TABLE_[req.fn](req.args);
      if (!isPlainObject_(res)) res = { ok: false, error: 'server_error' };
    }
  } catch (err) { res = { ok: false, error: 'server_error' }; } // текст исключения наружу не отдаём
  return postJson_(res);
}

// Меню не умеет открывать адрес напрямую — показываем окно со ссылкой. Адрес берём у самого развёртывания.
function openDashboard() {
  var ui = menuUi_();
  if (!ui) return FORBIDDEN_;
  var url = String(props_().getProperty('DASH_URL') || '');
  if (!DASH_URL_RE_.test(url)) {
    ui.alert('Адрес дашборда ещё не известен', 'Открой дашборд один раз по ссылке из окна развёртывания: Расширения → Apps Script → Начать развертывание → Управление развертываниями → URL. После этого пункт меню запомнит адрес.', ui.ButtonSet.OK);
    return;
  }
  var html = '<div style="font:14px/1.5 Arial,sans-serif">'
    + '<p><a href="' + url + '" target="_blank" rel="noopener" style="display:inline-block;padding:10px 18px;background:#F05A35;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">Открыть дашборд</a></p>'
    + '<p style="color:#555">Ссылка для сотрудников и клиентов:</p>'
    + '<input readonly onclick="this.select()" value="' + url + '" style="width:100%;box-sizing:border-box;padding:8px;font:12px monospace">'
    + '<p style="color:#888;font-size:12px">Не открывается и пишет «Не удалось открыть файл»? В браузере несколько аккаунтов Google — открой ссылку в окне инкогнито.</p></div>';
  // без try: если у скрипта ещё нет разрешения на окна, Google сам покажет запрос доступа (пойманная ошибка его бы скрыла)
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(460).setHeight(230), 'UTM Аналитика');
}

// Первый пароль администратора — через окно таблицы (в веб-приложении его ещё нечем защитить)
function setAdminPassword() {
  var ui = menuUi_();
  if (!ui) return FORBIDDEN_;
  try {
    var r = ui.prompt('Пароль администратора', 'От 12 символов и минимум три вида знаков: строчные, заглавные, цифры, прочие. Либо фраза от 20 символов.', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    var v = validatePassword_('admin', r.getResponseText());
    if (!v.ok) { ui.alert('Пароль не сохранён', 'Нужно от 12 символов и минимум три вида знаков: строчные, заглавные, цифры, прочие. Либо фраза от 20 символов', ui.ButtonSet.OK); return; }
    if (passwordClash_('admin', v.value)) { ui.alert('Пароль не сохранён', 'Он совпадает с паролем просмотра. Нужен другой.', ui.ButtonSet.OK); return; }
    savePassword_('admin', v.value);
    bootDrop_();
    log_('INFO', 'Auth', 'пароль admin задан из меню таблицы');
    ui.alert('Готово', 'Пароль администратора сохранён. Прежние входы отозваны.', ui.ButtonSet.OK);
  } catch (e) { log_('ERROR', 'Menu', e.message); ui.alert('Не удалось', 'Подробности — на листе Log.', ui.ButtonSet.OK); }
}

function resetLoginLock() {
  var ui = menuUi_();
  if (!ui) return FORBIDDEN_;
  try {
    clearLoginLock_();
    log_('INFO', 'Auth', 'блокировка входа сброшена из меню таблицы');
    ui.alert('Готово', 'Блокировка входа снята.', ui.ButtonSet.OK);
  } catch (e) { log_('ERROR', 'Menu', e.message); ui.alert('Не удалось', 'Подробности — на листе Log.', ui.ButtonSet.OK); }
}

var SYNC_MIN_GAP_MS = 10 * 60 * 1000; // ручной синк — не чаще раза в 10 минут (SYNC_AT)
var TRIGGER_MIN_GAP_MS = 20 * 3600 * 1000; // запуск через triggerSyncAll — не чаще раза в 20 часов (TRIGGER_AT), ручной интервал на него не действует
function syncTooSoon_() {
  return Date.now() - (+props_().getProperty('SYNC_AT') || 0) < SYNC_MIN_GAP_MS;
}

function syncCrm_(daysBack) {
  var cfg = readConfig_();
  if (cfg.crm_type === 'none') return 0;
  return cfg.crm_type === 'amocrm' ? syncAmo_(daysBack) : syncBitrix_(daysBack);
}

// Каждый шаг в своём try: падение одного источника не мешает другому
function safe_(source, fn) {
  try { return fn(); } catch (e) { log_('ERROR', source, e.message); progressFail_(source, e.message); return null; }
}

// ───────── Прогресс синка → Script Property SYNC_PROGRESS {kind, stage, pct, startedAt, updatedAt, finishedAt, error} ─────────
var syncProgress_ = null, syncProgressPages_ = 0, syncProgressSavedAt_ = 0;
var SYNC_PROGRESS_EVERY_MS = 3000; // внутри шага — не чаще раза в 3 с: у Script Properties дневные квоты на запись
function progressSave_(force) {
  var now = Date.now();
  if (!force && now - syncProgressSavedAt_ < SYNC_PROGRESS_EVERY_MS) return;
  syncProgressSavedAt_ = now;
  syncProgress_.updatedAt = new Date(now).toISOString();
  try { props_().setProperty('SYNC_PROGRESS', JSON.stringify(syncProgress_)); } catch (e) { /* прогресс — подсказка: его сбой не ломает синк */ }
}
function progressStart_(kind) {
  syncProgress_ = { kind: kind, stage: null, pct: 0, startedAt: new Date().toISOString(), updatedAt: null, finishedAt: null, error: null };
}
function progressStage_(stage) {
  if (!syncProgress_) return;
  syncProgress_.stage = stage; syncProgressPages_ = 0;
  syncProgress_.pct = Math.max(syncProgress_.pct, syncProgressPct_(syncProgress_.kind, stage, 0));
  progressSave_(true);
}
// Очередная страница ответа Meta / CRM внутри шага
function progressPage_() {
  if (!syncProgress_) return;
  syncProgress_.pct = Math.max(syncProgress_.pct, syncProgressPct_(syncProgress_.kind, syncProgress_.stage, ++syncProgressPages_));
  progressSave_(false);
}
function progressFail_(source, message) {
  if (syncProgress_ && !syncProgress_.error) syncProgress_.error = syncErrorText_(source, message);
}
function progressFinish_() {
  if (!syncProgress_) return;
  syncProgress_.stage = syncProgress_.error ? 'error' : 'done'; syncProgress_.pct = 100; syncProgress_.finishedAt = new Date().toISOString();
  progressSave_(true);
  syncProgress_ = null;
}

// Meta → CRM; true, если оба шага прошли без ошибок. DATA_VER сбрасывает кэш ответа
function syncAll_() {
  var ok = false;
  progressStart_('full');
  try {
    progressStage_('meta'); safe_('Meta', function () { return readConfig_().meta_ad_account_id ? syncMeta_() : 0; });
    progressStage_('crm'); safe_('CRM', syncCrm_);
  } finally {
    ok = !(syncProgress_ && syncProgress_.error);
    if (ok) props_().setProperty('SYNCED_AT', String(Date.now()));
    bumpVer_();
    try { trimLog_(); } catch (e) { /* обрезка лога — не критично */ }
    progressFinish_();
  }
  return ok;
}

// Единая точка запуска синка для кнопки, меню и триггера → 'done'|'failed'|'too_soon'|'busy'. Замок общий.
// fromTrigger: свой интервал (TRIGGER_AT, 20 ч), пропуск пишет WARN в Log
function runSync_(fromTrigger) {
  function tooSoon() {
    if (!fromTrigger) return syncTooSoon_();
    var soon = Date.now() - (+props_().getProperty('TRIGGER_AT') || 0) < TRIGGER_MIN_GAP_MS;
    if (soon) log_('WARN', 'Trigger', 'пропуск: автозапуск был меньше 20 часов назад');
    return soon;
  }
  if (syncRunning_()) return 'busy';
  if (tooSoon()) return 'too_soon';
  // замок — на секунды, только чтобы проверить и поставить флаг; сам синк идёт без замка, запись в листы — короткими замками
  var start = withLock_('Sync', function () {
    if (syncRunning_()) return 'busy';
    if (tooSoon()) return 'too_soon';
    props_().setProperty('SYNC_AT', String(Date.now()));
    if (fromTrigger) props_().setProperty('TRIGGER_AT', String(Date.now()));
    props_().setProperty('SYNC_RUNNING', String(Date.now()));
    return 'go';
  });
  if (start !== 'go') return start || 'busy';
  try {
    return syncAll_() ? 'done' : 'failed';
  } finally { props_().deleteProperty('SYNC_RUNNING'); }
}

function runSyncAll() {
  var ui = menuUi_();
  if (!ui) return FORBIDDEN_;
  try {
    var r = runSync_();
    SpreadsheetApp.getActive().toast({ done: 'Готово.', failed: 'Готово с ошибками, см. лист Log.', too_soon: 'Синк был меньше 10 минут назад.', busy: 'Занято: уже идёт синк.' }[r], 'UTM Аналитика', 6);
  } catch (e) { log_('ERROR', 'Menu', e.message); ui.alert('Не удалось', 'Подробности — на листе Log.', ui.ButtonSet.OK); }
}

// Ночной синк (триггер 03:00). Публичная: аргументы игнорирует, свой интервал (20 ч), замок общий, наружу не бросает
function triggerSyncAll() {
  try {
    var r = runSync_(true);
    return r === 'done' || r === 'failed' ? { ok: true } : { ok: false, error: r };
  } catch (e) {
    try { log_('ERROR', 'Trigger', e.message); } catch (e2) { /* лог недоступен */ }
    return { ok: false, error: 'server_error' };
  }
}
