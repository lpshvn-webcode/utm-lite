// Api.gs — функции для google.script.run. Каждая: токен и роль → валидация входа → действие → наружу только {ok} или {ok:false, error: код}.
// Коды: forbidden, locked, bad_request, busy, too_soon, sync_failed, server_error. Подробности — в Log, без секретов и значений входа.

function failCode_(code) { var e = new Error(code); e.apiCode = code; return e; }
// Результат валидатора {ok, value} → value, иначе bad_request
function valid_(v) { if (!v.ok) throw failCode_('bad_request'); return v.value; }

function guarded_(name, token, need, fn) {
  try {
    var role = sessionRole_(token);
    if (!role || (need === 'admin' && role !== 'admin')) return { ok: false, error: 'forbidden' };
    return fn(role);
  } catch (e) {
    if (e && e.apiCode) return { ok: false, error: e.apiCode };
    log_('ERROR', name, e && e.message ? e.message : 'ошибка');
    return { ok: false, error: 'server_error' };
  }
}
// Сохранение: идёт синк (флаг SYNC_RUNNING) или замок занят → busy; сама запись — короткий замок
function locked_(source, fn) {
  if (syncRunning_()) throw failCode_('busy');
  lockedWrite_(function () {
    if (syncRunning_()) throw failCode_('busy'); // синк мог стартовать, пока ждали замок
    fn();
  }, source);
}

function loadRows_() {
  return { metaAds: readTable_('Meta_Ads'), leads: readTable_('CRM_Leads') };
}
function bumpVer_() { props_().setProperty('DATA_VER', String(Date.now())); }
function isoOfMs_(ms) { return +ms ? new Date(+ms).toISOString() : null; }
function readLogo_() { return logoFromRows_(readTable_('Assets')); }

// ───────── Кэш ответа (значение ≤100 КБ: режем на куски) ─────────
var CACHE_CHUNK = 30000, CACHE_MAX_CHUNKS = 40, CACHE_TTL_S = 6 * 3600;
function cacheGetJson_(key) {
  var c = cache_(), n = +c.get(key + ':n') || 0;
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + ':' + i);
  var got = c.getAll(keys), s = '';
  for (var j = 0; j < n; j++) { if (got[keys[j]] === null || got[keys[j]] === undefined) return null; s += got[keys[j]]; }
  try { return JSON.parse(s); } catch (e) { return null; }
}
function cachePutJson_(key, obj, ttl) {
  var s = JSON.stringify(obj), n = Math.ceil(s.length / CACHE_CHUNK), m = {};
  if (n > CACHE_MAX_CHUNKS) return; // слишком большой — просто не кэшируем
  for (var i = 0; i < n; i++) m[key + ':' + i] = s.slice(i * CACHE_CHUNK, (i + 1) * CACHE_CHUNK);
  m[key + ':n'] = String(n);
  try { cache_().putAll(m, ttl || CACHE_TTL_S); } catch (e) { /* кэш — ускорение, не обязанность */ }
}

// ───────── Без входа ─────────
// Ответ кэшируется на 10 минут; сбрасывается при смене названия, логотипа и паролей (bootDrop_)
var BOOT_TTL_S = 600;
function bootDrop_() { cache_().remove('boot:n'); }
function apiBoot() {
  try {
    var out = cacheGetJson_('boot');
    if (!out) {
      var logo = readLogo_();
      out = { ok: true, client: readConfig_().client_name, logo: validateLogo_(logo).ok ? logo : '', hasViewPass: !!props_().getProperty('VIEW_PASS'), needsSetup: !props_().getProperty('ADMIN_PASS') };
      cachePutJson_('boot', out, BOOT_TTL_S);
    }
    return out;
  } catch (e) {
    log_('ERROR', 'apiBoot', e.message);
    return { ok: false, error: 'server_error' };
  }
}

// ───────── Просмотр ─────────
function apiData(token, params) {
  return guarded_('apiData', token, 'view', function (role) {
    var p = valid_(validatePeriod_(params)), cfg = readConfig_();
    var to = p.to || todayKey_(cfg), from = p.from || addDays_(to, -cfg.dashboard_default_days + 1);
    // days: «последние N дней, включая сегодня» в поясе отчёта; если пришли from и to — игнорируется
    if (p.days && !(p.from && p.to)) { to = todayKey_(cfg); from = addDays_(to, -p.days + 1); }
    if (from > to) from = to;
    var key = 'data:' + (props_().getProperty('DATA_VER') || '0') + ':' + from + ':' + to;
    var data = cacheGetJson_(key);
    if (!data) {
      data = buildDashboardData_(loadRows_(), { from: from, to: to }, cfg, todayKey_(cfg), Date.now());
      cachePutJson_(key, data);
    }
    data.meta.syncedAt = isoOfMs_(props_().getProperty('SYNCED_AT'));
    data.meta.role = role;
    return { ok: true, data: data };
  });
}

function apiProgress(token) {
  return guarded_('apiProgress', token, 'view', function () {
    var pr = null;
    try { pr = JSON.parse(props_().getProperty('SYNC_PROGRESS') || 'null'); } catch (e) { pr = null; }
    // не закончился и не обновлялся 10 минут — синк умер (лимит времени, сбой)
    if (pr && !pr.finishedAt && Date.now() - Date.parse(pr.updatedAt || pr.startedAt) > 10 * 60 * 1000) { pr.stage = 'error'; pr.error = 'Синк прерван: нет новых данных больше 10 минут'; }
    var out = pr ? { stage: pr.stage, pct: pr.pct, error: pr.error, finishedAt: pr.finishedAt } : null;
    // поля продублированы на верхнем уровне: интерфейс может читать и r.progress, и r.stage
    return { ok: true, progress: out, stage: out && out.stage, pct: out ? out.pct : 0, error: out && out.error, finishedAt: out && out.finishedAt };
  });
}

// ───────── Настройки (admin) ─────────
function apiSettingsGet(token) {
  return guarded_('apiSettingsGet', token, 'admin', function () {
    var p = props_();
    function isSet(n) { return { set: !!p.getProperty(n) }; }
    return {
      ok: true, settings: readConfig_(),
      secrets: { META_TOKEN: isSet('META_TOKEN'), AMO_TOKEN: isSet('AMO_TOKEN'), BITRIX_WEBHOOK: isSet('BITRIX_WEBHOOK'), VIEW_PASS: isSet('VIEW_PASS') },
      stages: readTable_('Stages'),
      sync: { lastAt: isoOfMs_(p.getProperty('SYNCED_AT')), triggers: ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'triggerSyncAll'; }).length }
    };
  });
}

function apiSettingsSave(token, patch) {
  return guarded_('apiSettingsSave', token, 'admin', function () {
    var cur = readConfig_(), v = valid_(validateSettingsPatch_(patch, cur));
    var norm = function (x) { return String(x === undefined || x === null ? '' : x).trim().toLowerCase(); };
    var changed = function (k) { return v[k] !== undefined && norm(v[k]) !== norm(cur[k]); }; // регистр и пробелы — не смена
    var cleared = changed('crm_type') || changed('crm_domain') || changed('crm_pipeline_ids') || changed('timezone');
    // другая CRM или портал — id стадий прежнего аккаунта не подходят: сбрасываем, если в patch нет новых значений
    if (changed('crm_type') || changed('crm_domain')) {
      ['qualification_stage_ids', 'sale_stage_ids'].forEach(function (k) { if (v[k] === undefined) v[k] = ''; });
    }
    var rows = Object.keys(v).map(function (k) { return { key: k, value: v[k] }; });
    locked_('Settings', function () {
      mergeRows_('Settings', function (r) { return String(r.key); }, rows);
      // другая CRM, портал, воронки или пояс (даты заявок хранятся в поясе записи) — старые сделки и стадии не подходят: чистим
      if (cleared) {
        writeTable_('CRM_Leads', []); writeTable_('Stages', []);
        log_('INFO', 'Settings', 'изменены настройки CRM или пояс: листы CRM_Leads и Stages очищены, нужен синк');
      }
      if (changed('timezone')) { ss_().setSpreadsheetTimeZone(v.timezone); installTriggers_(); }
      bumpVer_();
      if (v.client_name !== undefined) bootDrop_();
      return true;
    });
    return { ok: true, settings: readConfig_(), cleared: cleared };
  });
}

function apiSecretSave(token, name, value) {
  return guarded_('apiSecretSave', token, 'admin', function () {
    var v = valid_(validateSecret_(name, value));
    if (v === '') props_().deleteProperty(name); else props_().setProperty(name, v);
    log_('INFO', 'Secrets', name + (v === '' ? ' удалён' : ' обновлён'));
    return { ok: true, set: v !== '' };
  });
}

function apiPasswordSave(token, kind, value) {
  return guarded_('apiPasswordSave', token, 'admin', function () {
    var v = valid_(validatePassword_(kind, value));
    if (passwordClash_(kind, v)) throw failCode_('bad_request'); // пароли просмотра и администратора должны различаться
    savePassword_(kind, v);
    bootDrop_();
    log_('INFO', 'Auth', 'пароль ' + kind + ' обновлён');
    return { ok: true, token: newSession_('admin') }; // все сессии отозваны (PASS_VER): выдаём вызывающему новую
  });
}

function apiLogoSave(token, dataUrl) {
  return guarded_('apiLogoSave', token, 'admin', function () {
    var v = valid_(validateLogo_(dataUrl));
    locked_('Assets', function () { writeTable_('Assets', logoToRows_(v)); bootDrop_(); return true; });
    return { ok: true };
  });
}

// В ответ идёт только заранее безопасный текст (pubError_); остальное — общая фраза, подробности в Log
function checkText_(e) {
  if (e && e.pub) return e.message;
  log_('ERROR', 'apiCheck', e && e.message ? e.message : 'ошибка');
  return 'Не удалось проверить (подробности в Log)';
}

function apiCheck(token) {
  return guarded_('apiCheck', token, 'admin', function () {
    var cfg = readConfig_(), out = { ok: true, meta: null, crm: null };
    try {
      if (!cfg.meta_ad_account_id) throw new Error('Не задан кабинет Meta');
      var j = graphGet_(graphBase_(cfg) + 'act_' + cfg.meta_ad_account_id + '?' + qs_({ fields: 'name,currency' }));
      out.meta = { ok: true, text: 'Кабинет: ' + (j.name || cfg.meta_ad_account_id) + (j.currency ? ' (' + j.currency + ')' : '') };
    } catch (e) { out.meta = { ok: false, text: checkText_(e) }; }
    if (cfg.crm_type === 'none') out.crm = { ok: true, text: 'CRM не подключена' };
    else {
      try {
        if (cfg.crm_type === 'amocrm') amoGet_(cfg, '/api/v4/account', ''); else bitrixCall_('profile', {});
        out.crm = { ok: true, text: 'Подключение к CRM работает' };
      } catch (e) { out.crm = { ok: false, text: checkText_(e) }; }
    }
    return out;
  });
}

function apiStagesRefresh(token) {
  return guarded_('apiStagesRefresh', token, 'admin', function () {
    if (syncRunning_()) throw failCode_('busy');
    var cfg = readConfig_();
    if (cfg.crm_type === 'none') return { ok: true, stages: [] };
    if (cfg.crm_type === 'amocrm') amoStages_(cfg); else bitrixStages_(cfg); // запись внутри — под коротким замком
    return { ok: true, stages: readTable_('Stages') };
  });
}

function apiSync(token) {
  return guarded_('apiSync', token, 'admin', function () {
    var r = runSync_();
    if (r === 'failed') throw failCode_('sync_failed'); // подробности — в Log
    if (r !== 'done') throw failCode_(r);
    return { ok: true, syncedAt: isoOfMs_(props_().getProperty('SYNCED_AT')) };
  });
}
