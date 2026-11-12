// Core.gs — чистая логика без Google API (тестируется в Node: node --test apps-script/tests).
// Все top-level объекты — через var/function, чтобы Node vm видел их как глобальные.

// ───────── Схема листов (контракт: docs/SPEC.md) ─────────
var SHEET_HEADERS = {
  Settings: ['key', 'value'],
  Meta_Ads: ['date', 'account_id', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name', 'spend', 'impressions', 'clicks', 'meta_leads', 'currency', 'fx_rate', 'spend_report'],
  CRM_Leads: ['crm_id', 'crm_type', 'created_at', 'closed_at', 'stage_id', 'stage_name', 'pipeline_id', 'status', 'amount', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'updated_at'],
  Stages: ['pipeline_id', 'pipeline_name', 'stage_id', 'name', 'sort', 'kind'],
  Assets: ['key', 'chunk', 'data'],
  Log: ['ts', 'level', 'source', 'message']
};
// Текстовые колонки: пишем как есть в ячейки с форматом '@' (формула там не исполняется, длинные id не превращаются в числа), без апострофа
var TEXT_COLUMNS = ['key', 'value', 'name', 'date', 'account_id', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name', 'crm_id', 'stage_id', 'stage_name',
  'pipeline_id', 'created_at', 'closed_at', 'updated_at', 'data', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

var UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// [ключ, значение по умолчанию]. Только эти ключи можно сохранить через apiSettingsSave
var SETTINGS_SCHEMA = [
  ['client_name', 'Клиент'], ['currency', 'KZT'], ['meta_currency', 'KZT'], ['fx_source', 'fixed'], ['fx_rate_to_report', 1],
  ['timezone', 'Asia/Almaty'], ['sync_days_back', 30], ['meta_ad_account_id', ''], ['meta_api_version', 'v26.0'],
  ['crm_type', 'none'], ['crm_domain', ''], ['crm_pipeline_ids', ''], ['qualification_stage_ids', ''], ['sale_stage_ids', ''],
  ['sale_amount_source', 'opportunity'], ['dashboard_default_days', 30]
];
var SETTINGS_NUMERIC = ['fx_rate_to_report', 'sync_days_back', 'dashboard_default_days'];

// kv: {key: value} из листа Settings → объект с дефолтами и числами
function parseConfig_(kv) {
  var out = {};
  kv = kv || {};
  SETTINGS_SCHEMA.forEach(function (c) {
    var v = kv[c[0]];
    if (v === undefined || v === null || String(v).trim() === '') v = c[1];
    if (SETTINGS_NUMERIC.indexOf(c[0]) >= 0) {
      var n = Number(String(v).replace(',', '.'));
      v = isFinite(n) ? n : c[1];
    } else {
      v = String(v).trim();
    }
    out[c[0]] = v;
  });
  return out;
}

// ───────── Утилиты ─────────
function splitList_(s) {
  if (s === null || s === undefined) return [];
  return String(s).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
}
function num_(v) {
  if (v === null || v === undefined || v === '') return 0;
  var n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}
// Защита от формульной инъекции: строка, начинающаяся на = + - @, записывается как текст (префикс ')
function sheetSafeValue_(v) {
  return typeof v === 'string' && /^[=+\-@ \t\r]/.test(v) ? "'" + v : v;
}
// Текст из публичных форм/CRM: без управляющих символов, не длиннее max. < > " ' не трогаем — экранирует интерфейс
function cleanText_(v, max) {
  return String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max || 200);
}
// В лог не должны попасть URL и токен вебхука Bitrix (/rest/<id>/<token>/)
function sanitizeLog_(msg) {
  return String(msg).replace(/\/rest\/\d+\/[^\/\s]+\/?/g, '/rest/[hidden]/').replace(/https?:\/\/\S+/g, '[url]');
}
function round2_(n) { return Math.round(n * 100) / 100; }
function ratio_(a, b) { return b > 0 ? round2_(a / b) : null; }
function dateKey_(s) {
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s || ''));
  return m ? m[1] : '';
}
function addDays_(key, n) {
  var p = key.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return d.toISOString().slice(0, 10);
}
function daysBetween_(a, b) { // включительно: a..b → число дней
  var pa = a.split('-'), pb = b.split('-');
  return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000) + 1;
}
function inRange_(key, from, to) { return key !== '' && key >= from && key <= to; }
function isPlainObject_(x) { return Object.prototype.toString.call(x) === '[object Object]'; }
function has_(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function isRealDate_(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays_(s, 0) === s; }
// Байты (знаковые, как отдаёт Utilities.computeDigest) → hex
function bytesToHex_(bytes) {
  return bytes.map(function (b) { var v = (b + 256) % 256; return (v < 16 ? '0' : '') + v.toString(16); }).join('');
}
// Сравнение строк за время, не зависящее от места первого расхождения
function constantTimeEqual_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length, n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// ───────── Имена / стадии / статусы (из донора) ─────────
var HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»' };
function decodeEntities_(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
    if (e.charAt(0) === '#') {
      var code = e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return isFinite(code) ? String.fromCharCode(code) : m;
    }
    var r = HTML_ENTITIES[e.toLowerCase()];
    return r === undefined ? m : r;
  });
}
// lowercase, HTML-entities, дефисы/тире/подчёркивания/пробелы → один пробел
function normalizeName_(s) {
  if (s === null || s === undefined) return '';
  var t = String(s);
  try { t = decodeURIComponent(t); } catch (e) { /* битая последовательность %… — оставляем строку как есть */ }
  return decodeEntities_(t.replace(/\+/g, ' ')).toLowerCase().replace(/[\s\-–—_]+/g, ' ').trim();
}

// Квал: статус won или стадия из списка (id или название)
function evalQualified_(lead, stageList) {
  if (lead.status === 'won') return true;
  var wanted = splitList_(stageList).map(normalizeName_);
  if (!wanted.length) return false;
  return wanted.indexOf(normalizeName_(lead.stage_id)) >= 0 || wanted.indexOf(normalizeName_(lead.stage_name)) >= 0;
}
// native: 'won'|'lost'|'open' — системный статус CRM
function resolveStatus_(stageId, stageName, native, config) {
  var saleIds = splitList_(config.sale_stage_ids).map(normalizeName_);
  if (saleIds.length) {
    if (saleIds.indexOf(normalizeName_(stageId)) >= 0 || saleIds.indexOf(normalizeName_(stageName)) >= 0) return 'won';
    return native === 'lost' ? 'lost' : 'open';
  }
  return native || 'open';
}
function parseAmount_(opportunity) { return round2_(num_(opportunity)); }
// Флаги заявки по текущим настройкам (считаются при чтении: смена стадий в настройках действует сразу)
function leadFlags_(row, cfg) {
  var status = resolveStatus_(row.stage_id, row.stage_name, row.status, cfg);
  return { status: status, qualified: evalQualified_({ stage_id: row.stage_id, stage_name: row.stage_name, status: status }, cfg.qualification_stage_ids), sold: status === 'won' };
}
// Строка CRM_Leads. status здесь — системный (won/lost/open); ПДн (имя, телефон, ответственный) не берём
function makeLeadRow_(base) {
  return {
    crm_id: String(base.crm_id), crm_type: base.crm_type, created_at: base.created_at || '', closed_at: base.closed_at || '',
    stage_id: String(base.stage_id === undefined || base.stage_id === null ? '' : base.stage_id), stage_name: cleanText_(base.stage_name, 200),
    pipeline_id: String(base.pipeline_id === undefined || base.pipeline_id === null ? '' : base.pipeline_id),
    status: base.native_status || 'open', amount: parseAmount_(base.opportunity),
    utm_source: cleanText_(base.utm_source), utm_medium: cleanText_(base.utm_medium), utm_campaign: cleanText_(base.utm_campaign),
    utm_content: cleanText_(base.utm_content), utm_term: cleanText_(base.utm_term), updated_at: base.updated_at || ''
  };
}
function stageKind_(stageId) {
  var id = String(stageId);
  return id === '142' ? 'won' : (id === '143' ? 'lost' : 'open');
}
// pipelines — ответ /api/v4/leads/pipelines → строки листа Stages
function buildStageRows_(pipelines, pipelineIds) {
  var wanted = splitList_(pipelineIds), out = [];
  (pipelines || []).forEach(function (p) {
    if (wanted.length && wanted.indexOf(String(p.id)) < 0) return;
    ((p._embedded && p._embedded.statuses) || []).forEach(function (s) {
      out.push({ pipeline_id: String(p.id), pipeline_name: p.name || '', stage_id: String(s.id), name: s.name || '', sort: num_(s.sort), kind: stageKind_(s.id) });
    });
  });
  return out;
}
// Bitrix: crm.status.list (ENTITY_ID DEAL_STAGE / DEAL_STAGE_<воронка>) + названия воронок {id: name}
function buildBitrixStageRows_(statuses, pipelineNames, pipelineIds) {
  var wanted = splitList_(pipelineIds), out = [];
  (statuses || []).forEach(function (s) {
    var m = /^DEAL_STAGE(?:_(\d+))?$/.exec(String(s.ENTITY_ID));
    if (!m) return;
    var pid = m[1] || '0';
    if (wanted.length && wanted.indexOf(pid) < 0) return;
    var sem = String((s.EXTRA && s.EXTRA.SEMANTICS) || '').toLowerCase();
    var kind = sem === 's' || sem === 'success' ? 'won' : (sem === 'f' || sem === 'failure' ? 'lost' : 'open');
    out.push({ pipeline_id: pid, pipeline_name: (pipelineNames && pipelineNames[pid]) || (pid === '0' ? 'Общая' : 'Воронка ' + pid), stage_id: String(s.STATUS_ID), name: s.NAME || '', sort: num_(s.SORT), kind: kind });
  });
  return out;
}

// ───────── Meta ─────────
// actions: [{action_type, value}] → число лидов (результат «лид»; переписки не считаем)
function extractLeads_(actions) {
  var map = {};
  (actions || []).forEach(function (a) { map[a.action_type] = num_(a.value); });
  return map['lead'] !== undefined ? map['lead'] : (map['onsite_conversion.lead_grouped'] || 0);
}
// Строка insights (level=ad) → строка Meta_Ads. Превью, картинки, destination не забираем
function metaAdRow_(r) {
  return {
    date: r.date_start, account_id: String(r.account_id || ''), campaign_id: String(r.campaign_id || ''), campaign_name: cleanText_(r.campaign_name),
    adset_id: String(r.adset_id || ''), adset_name: cleanText_(r.adset_name), ad_id: String(r.ad_id || ''), ad_name: cleanText_(r.ad_name),
    spend: num_(r.spend), impressions: num_(r.impressions), clicks: num_(r.clicks), meta_leads: extractLeads_(r.actions),
    currency: r.account_currency || '', fx_rate: '', spend_report: ''
  };
}
function parseNbkRate_(xml, code) {
  var items = String(xml || '').split('<item>');
  function tag(ch, t) { var m = ch.match(new RegExp('<' + t + '>\\s*([^<]*?)\\s*</' + t + '>')); return m ? m[1] : ''; }
  for (var i = 1; i < items.length; i++) {
    if (tag(items[i], 'title') === String(code).toUpperCase()) {
      var rate = num_(tag(items[i], 'description')) / (num_(tag(items[i], 'quant')) || 1);
      return rate > 0 ? rate : 0;
    }
  }
  return 0;
}
// Расход строки Meta_Ads в валюте отчёта: курс дня (spend_report), иначе фиксированный курс
// useReport=false (fx_source=fixed) — сохранённый spend_report игнорируется
function spendInReport_(r, fx, useReport) {
  return useReport && r.spend_report !== undefined && r.spend_report !== '' ? num_(r.spend_report) : num_(r.spend) * fx;
}
// Валюты кабинета и отчёта совпадают → курс 1, иначе fx_rate_to_report
function metaFx_(cfg) { return cfg.meta_currency === cfg.currency ? 1 : (num_(cfg.fx_rate_to_report) || 1); }

// ───────── Прогресс синка (Script Property SYNC_PROGRESS) ─────────
// [стадия, доля %, типичное число страниц API за шаг]
var SYNC_STEPS = { full: [['meta', 40, 5], ['crm', 60, 25]] };
function syncProgressPct_(kind, stage, pages) {
  if (stage === 'done' || stage === 'error') return 100;
  var steps = SYNC_STEPS[kind] || [], before = 0;
  for (var i = 0; i < steps.length; i++) {
    var s = steps[i];
    if (s[0] === stage) return Math.min(99, Math.floor(before + (s[2] && pages > 0 ? s[1] * (1 - Math.exp(-2 * pages / s[2])) : 0)));
    before += s[1];
  }
  return 0;
}
// Текст ошибки для прогресса: без адресов, почт и длинных чисел, не длиннее 150 символов
function syncErrorText_(source, message) {
  return (source + ': ' + sanitizeLog_(message)).replace(/[^\s@]+@[^\s@]+/g, '…').replace(/\+?\d[\d\s()-]{6,}\d/g, '…').slice(0, 150);
}

// ───────── Привязка заявки к рекламе Meta ─────────
// Пустышки вместо значений (незаполненный шаблон): не считаются метками
var UTM_PLACEHOLDERS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm source', 'utm medium', 'utm campaign', 'utm content', 'utm term'];
function isPlaceholderUtm_(v) {
  if (v === null || v === undefined) return true;
  var t = String(v).trim().toLowerCase();
  if (t === '' || UTM_PLACEHOLDERS.indexOf(t) >= 0) return true;
  return /^\{\{[^{}]*\}\}$/.test(t) || /^\{[^{}]*\}$/.test(t) || /^\[[^\[\]]*\]$/.test(t); // {{campaign.name}}, {campaign}, [campaign]
}
// Нормализованные непустые значения пяти меток заявки
function utmPoolOf_(lead) {
  var out = [];
  UTM_FIELDS.forEach(function (k) {
    if (!isPlaceholderUtm_(lead[k])) {
      var n = normalizeName_(lead[k]);
      if (n !== '' && out.indexOf(n) < 0) out.push(n);
    }
  });
  return out;
}

var MIN_SUBSTRING_LEN = 6; // «название внутри метки» — только для названий от 6 знаков; короче — лишь точное совпадение
var MIN_ID_LEN = 10;       // номер в метке — цифры длиной от 10 знаков
var NO_MATCH = { method: 'none', campaignId: null, campaignName: null, adsetId: null, adsetName: null, adId: null, adName: null };

// Справочник рекламы из ВСЕХ строк Meta_Ads (не только периода). У каждого id копятся все названия, под которыми он встречался
// (после переименования старые заявки находятся по старому названию); в ответ идёт самое свежее непустое, пустое названием не затирается.
// Для поиска: exact — «название → записи по уровням», lens — «первые 6 знаков → длины названий» (поиск вхождения без перебора справочника)
function buildAdIndex_(metaRows) {
  var camps = {}, adsets = {}, ads = {}, memo = new Map();
  function nn(raw) { if (!memo.has(raw)) memo.set(raw, normalizeName_(raw)); return memo.get(raw); }
  function touch(map, id, name, d, par) {
    var e = map[id] || (map[id] = { id: id, name: '', nd: '', aliases: [], pd: '' });
    if (name) {
      var a = nn(name);
      if (a && e.aliases.indexOf(a) < 0) e.aliases.push(a);
      if (d >= e.nd) { e.name = name; e.nd = d; }
    }
    if (par && d >= e.pd) { Object.keys(par).forEach(function (k) { if (par[k]) e[k] = par[k]; }); e.pd = d; }
  }
  (metaRows || []).forEach(function (r) {
    var d = dateKey_(r.date), cid = String(r.campaign_id || ''), sid = String(r.adset_id || ''), aid = String(r.ad_id || '');
    if (cid) touch(camps, cid, r.campaign_name, d);
    if (sid) touch(adsets, sid, r.adset_name, d, { campaignId: cid });
    if (aid) touch(ads, aid, r.ad_name, d, { adsetId: sid, campaignId: cid });
  });
  var idx = { camps: camps, adsets: adsets, ads: ads, exact: new Map(), lens: new Map() };
  function register(level, ent, slots, cur) {
    if (slots.some(function (s) { return !s.length; })) return;
    var names = cur.map(nn);
    if (level !== 'campaign' && (names.some(function (n) { return !n; }) || names.filter(function (n, i) { return names.indexOf(n) === i; }).length < 2)) return; // «промо»: одинаковые названия — ложные совпадения
    var entry = { ent: ent, slots: slots }, last = slots[slots.length - 1];
    last.forEach(function (a) {
      var x = idx.exact.get(a);
      if (!x) idx.exact.set(a, x = { ad: [], adset: [], campaign: [] });
      x[level].push(entry);
      if (a.length >= MIN_SUBSTRING_LEN) {
        var key = a.slice(0, MIN_SUBSTRING_LEN), l = idx.lens.get(key);
        if (!l) idx.lens.set(key, l = []);
        if (l.indexOf(a.length) < 0) { l.push(a.length); l.sort(function (p, q) { return p - q; }); }
      }
    });
  }
  Object.keys(camps).forEach(function (id) { register('campaign', camps[id], [camps[id].aliases], [camps[id].name]); });
  Object.keys(adsets).forEach(function (id) {
    var s = adsets[id], c = camps[s.campaignId];
    if (c) register('adset', s, [c.aliases, s.aliases], [c.name, s.name]);
  });
  Object.keys(ads).forEach(function (id) {
    var a = ads[id], s = adsets[a.adsetId], c = camps[a.campaignId];
    if (s && c) register('ad', a, [c.aliases, s.aliases, a.aliases], [c.name, s.name, a.name]);
  });
  return idx;
}
// Результат привязки до уровня level ('ad'|'adset'|'campaign') с родителями из справочника (сверху вниз согласовано)
function matchAt_(idx, method, level, id) {
  var a = null, s = null, c = null;
  if (level === 'ad') { a = idx.ads[id]; s = idx.adsets[a.adsetId] || null; c = idx.camps[a.campaignId] || null; }
  else if (level === 'adset') { s = idx.adsets[id]; c = idx.camps[s.campaignId] || null; }
  else c = idx.camps[id];
  return {
    method: method, campaignId: c ? c.id : null, campaignName: c ? c.name : null,
    adsetId: s ? s.id : null, adsetName: s ? s.name : null, adId: a ? a.id : null, adName: a ? a.name : null
  };
}
// 1) по номеру: цифры от 10 знаков в любой из пяти меток (в т.ч. внутри строки вида «1202…_v2»); объявление → группа → кампания
function matchById_(lead, idx) {
  var seqs = [];
  UTM_FIELDS.forEach(function (f) {
    (String(lead[f] === null || lead[f] === undefined ? '' : lead[f]).match(/\d+/g) || []).forEach(function (s) { if (s.length >= MIN_ID_LEN) seqs.push(s); });
  });
  var levels = [['ad', 'ads'], ['adset', 'adsets'], ['campaign', 'camps']];
  for (var i = 0; i < levels.length; i++) {
    for (var j = 0; j < seqs.length; j++) {
      if (has_(idx[levels[i][1]], seqs[j])) return matchAt_(idx, 'id', levels[i][0], seqs[j]);
    }
  }
  return null;
}
// Кандидаты по последнему названию записи: точное совпадение с меткой или вхождение названия в метку.
// Метка, совпавшая точно, на вхождения не просматривается; остальные просматриваются по 6-знаковым ключам, без перебора справочника
function candidatesFor_(pool, idx) {
  var out = { ad: [], adset: [], campaign: [] }, seen = new Set();
  function addFrom(x) {
    ['ad', 'adset', 'campaign'].forEach(function (lv) { x[lv].forEach(function (en) { if (!seen.has(en)) { seen.add(en); out[lv].push(en); } }); });
  }
  pool.forEach(function (p) {
    var x = idx.exact.get(p);
    if (x) { addFrom(x); return; }
    for (var i = 0; i + MIN_SUBSTRING_LEN <= p.length; i++) {
      var lens = idx.lens.get(p.substr(i, MIN_SUBSTRING_LEN));
      if (!lens) continue;
      for (var k = 0; k < lens.length && i + lens[k] <= p.length; k++) {
        var y = idx.exact.get(p.substr(i, lens[k]));
        if (y) addFrom(y);
      }
    }
  });
  return out;
}
// Длина самого длинного названия слота, найденного в метках: точно или (loose) вхождением; 0 — не найдено
function slotLen_(slot, pool, poolSet, loose) {
  var best = 0;
  slot.forEach(function (a) {
    if (poolSet.has(a) || (loose && a.length >= MIN_SUBSTRING_LEN && pool.some(function (p) { return p.indexOf(a) >= 0; }))) best = Math.max(best, a.length);
  });
  return best;
}
// Записи, у которых найдены названия всех уровней (кампания, группа, объявление); len — длина найденного названия кампании
function hitsOf_(entries, pool, poolSet, loose) {
  var out = [];
  entries.forEach(function (en) {
    var first = 0, ok = true;
    for (var j = 0; j < en.slots.length && ok; j++) {
      var l = slotLen_(en.slots[j], pool, poolSet, loose);
      if (!l) ok = false; else if (j === 0) first = l;
    }
    if (ok) out.push({ ent: en.ent, len: first });
  });
  return out;
}
// Несколько кандидатов: объявление → общая группа, иначе общая кампания; группа → общая кампания;
// кампания → самое длинное найденное название (равные длины — не угадываем)
function resolveHits_(idx, level, hits) {
  var ents = hits.map(function (h) { return h.ent; });
  if (ents.length === 1) return matchAt_(idx, 'names', level, ents[0].id);
  if (level === 'campaign') {
    var s = hits.slice().sort(function (p, q) { return q.len - p.len; });
    return s[0].len > s[1].len ? matchAt_(idx, 'names', 'campaign', s[0].ent.id) : null;
  }
  var same = function (key) { return ents[0][key] && ents.every(function (e) { return e[key] === ents[0][key]; }); };
  if (level === 'ad' && same('adsetId')) return matchAt_(idx, 'names', 'adset', ents[0].adsetId);
  if (same('campaignId')) return matchAt_(idx, 'names', 'campaign', ents[0].campaignId);
  return null;
}
// 2) по названию: сначала точное совпадение всех названий, затем вхождение; уровни ad → adset → campaign, первый, где что-то нашлось
function matchByNames_(pool, idx) {
  if (!pool.length) return null;
  var poolSet = new Set(pool), c = candidatesFor_(pool, idx), levels = ['ad', 'adset', 'campaign'];
  for (var i = 0; i < levels.length; i++) {
    for (var p = 0; p < 2; p++) {
      var hits = hitsOf_(c[levels[i]], pool, poolSet, p === 1);
      if (hits.length) return resolveHits_(idx, levels[i], hits);
    }
  }
  return null;
}
// memo — Map в пределах одного расчёта: одинаковый набор из пяти меток привязывается один раз
function matchLead_(lead, idx, memo) {
  var key = memo ? UTM_FIELDS.map(function (f) { return lead[f] === null || lead[f] === undefined ? '' : String(lead[f]); }).join('\u0001') : null;
  if (memo && memo.has(key)) return memo.get(key);
  var m = matchById_(lead, idx) || matchByNames_(utmPoolOf_(lead), idx) || NO_MATCH;
  if (memo) memo.set(key, m);
  return m;
}

// ───────── Метрики ─────────
function computeMetrics_(a) {
  return {
    // цена при нулевом расходе — не 0, а «нет данных» (как romi и roas)
    cpl: a.spend > 0 ? ratio_(a.spend, a.leads) : null, costPerQualified: a.spend > 0 ? ratio_(a.spend, a.qualified) : null, costPerSale: a.spend > 0 ? ratio_(a.spend, a.sales) : null,
    qualRate: a.leads > 0 ? round2_(100 * a.qualified / a.leads) : null, // % от заявок
    closeRate: a.qualified > 0 ? round2_(100 * a.sales / a.qualified) : null, // % от квал-заявок
    romiPct: a.spend > 0 ? round2_(100 * (a.revenue - a.spend) / a.spend) : null,
    roas: ratio_(a.revenue, a.spend)
  };
}
// Метрики строки. spend/impressions/clicks = null у строки «не определено» (расход к ней не относится) → все зависящие от них метрики null
function rowMetrics_(a) {
  var noSpend = a.spend === null, m = computeMetrics_({ spend: noSpend ? 0 : a.spend, leads: a.leads, qualified: a.qualified, sales: a.sales, revenue: a.revenue });
  if (noSpend) { m.cpl = null; m.costPerQualified = null; m.costPerSale = null; m.romiPct = null; m.roas = null; }
  return {
    spend: noSpend ? null : round2_(a.spend), impressions: a.impressions, clicks: a.clicks,
    ctr: a.impressions > 0 && a.clicks !== null ? round2_(100 * a.clicks / a.impressions) : null,
    cpc: a.clicks > 0 && !noSpend ? round2_(a.spend / a.clicks) : null,
    leads: a.leads, qualified: a.qualified, sales: a.sales, revenue: round2_(a.revenue),
    cpl: m.cpl, costPerQualified: m.costPerQualified, costPerSale: m.costPerSale, qualRate: m.qualRate, closeRate: m.closeRate, romiPct: m.romiPct, roas: m.roas
  };
}
var KPI_KEYS = ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'leads', 'qualified', 'sales', 'revenue', 'cpl', 'costPerQualified', 'costPerSale',
  'qualRate', 'closeRate', 'romiPct', 'roas', 'leadsAll', 'leadsUnattributed', 'matchRatePct'];
// t: суммы периода (spend, impressions, clicks весь кабинет; leads… только привязанные; all — все заявки). Нет данных → все поля null
function kpisOf_(t, empty) {
  var out = {};
  if (empty) { KPI_KEYS.forEach(function (k) { out[k] = null; }); return out; }
  var m = rowMetrics_(t);
  KPI_KEYS.forEach(function (k) { if (has_(m, k)) out[k] = m[k]; });
  out.leadsAll = t.all; out.leadsUnattributed = t.all - t.leads; out.matchRatePct = t.all > 0 ? round2_(100 * t.leads / t.all) : null;
  return out;
}

function newAgg_() { return { leads: 0, qualified: 0, sales: 0, revenue: 0 }; }
function addAgg_(a, d) {
  a.leads++;
  if (d.f.qualified) a.qualified++;
  if (d.f.sold) { a.sales++; a.revenue += d.amount; }
}

function leadUrlOf_(row, cfg) {
  if (!cfg.crm_domain) return null;
  if (row.crm_type === 'amocrm') {
    var host = cfg.crm_domain.indexOf('.') >= 0 ? cfg.crm_domain : cfg.crm_domain + '.amocrm.ru';
    return 'https://' + host + '/leads/detail/' + row.crm_id;
  }
  if (row.crm_type === 'bitrix24') return 'https://' + cfg.crm_domain + '/crm/deal/details/' + row.crm_id + '/';
  return null;
}

var MAX_LEADS_OUT = 2000, MAX_TABLE_ROWS = 1000, MAX_UTM_OUT = 120;

// rows: {metaAds, leads} — строки листов; params: {from, to}; today — 'YYYY-MM-DD' в поясе отчёта (считает Config.gs);
// учитываются только заявки текущей CRM (crm_type); → data по контракту SPEC
function buildDashboardData_(rows, params, cfg, today, nowMs) {
  params = params || {};
  var now = nowMs || Date.now();
  var to = dateKey_(params.to) || today;
  var from = dateKey_(params.from) || addDays_(to, -(num_(cfg.dashboard_default_days) || 30) + 1);
  if (from > to) from = to;
  var len = daysBetween_(from, to), prevTo = addDays_(from, -1), prevFrom = addDays_(prevTo, -(len - 1));
  var fx = metaFx_(cfg), useReport = cfg.fx_source === 'nbk' && cfg.meta_currency !== cfg.currency;
  var meta = rows.metaAds || [], idx = buildAdIndex_(meta), matchMemo = new Map();

  var cur = [], prev = [];
  (rows.leads || []).forEach(function (row) {
    if (row.crm_type !== cfg.crm_type) return; // остатки прежней CRM не считаем
    var key = dateKey_(row.created_at), inCur = inRange_(key, from, to), inPrev = inRange_(key, prevFrom, prevTo);
    if (!inCur && !inPrev) return;
    (inCur ? cur : prev).push({ row: row, key: key, m: matchLead_(row, idx, matchMemo), f: leadFlags_(row, cfg), amount: num_(row.amount) });
  });
  var metaCur = meta.filter(function (r) { return inRange_(dateKey_(r.date), from, to); });
  var metaPrev = meta.filter(function (r) { return inRange_(dateKey_(r.date), prevFrom, prevTo); });

  function totals(metaList, list) {
    var t = { spend: 0, impressions: 0, clicks: 0, leads: 0, qualified: 0, sales: 0, revenue: 0, all: list.length };
    metaList.forEach(function (r) { t.spend += spendInReport_(r, fx, useReport); t.impressions += num_(r.impressions); t.clicks += num_(r.clicks); });
    list.forEach(function (d) { if (d.m.method !== 'none') addAgg_(t, d); });
    return t;
  }
  function isEmpty(t) { return t.all === 0 && t.spend === 0 && t.impressions === 0 && t.clicks === 0; }
  var tCur = totals(metaCur, cur), tPrev = totals(metaPrev, prev);
  var kpis = kpisOf_(tCur, isEmpty(tCur));
  kpis.prev = kpisOf_(tPrev, isEmpty(tPrev));

  var perDay = {};
  function dayOf(k) { return perDay[k] || (perDay[k] = { spend: 0, a: newAgg_() }); }
  metaCur.forEach(function (r) { dayOf(dateKey_(r.date)).spend += spendInReport_(r, fx, useReport); });
  cur.forEach(function (d) { if (d.m.method !== 'none') addAgg_(dayOf(d.key).a, d); });
  var daily = [];
  for (var day = from; day <= to; day = addDays_(day, 1)) {
    var x = dayOf(day);
    daily.push({ date: day, spend: round2_(x.spend), leads: x.a.leads, qualified: x.a.qualified, sales: x.a.sales, revenue: round2_(x.a.revenue) });
  }

  // кампании / группы / объявления: расход Meta за период + привязанные заявки. Заявка, привязанная не до самого низа,
  // идёт в строку «не определено» (id: null, расход null) под своим родителем
  var maps = { camps: {}, sets: {}, ads: {} };
  function row(map, key, init) {
    if (!has_(map, key)) { var o = newAgg_(); Object.keys(init).forEach(function (k) { o[k] = init[k]; }); map[key] = o; }
    return map[key];
  }
  function nm(entity, id) { return entity[id] ? entity[id].name : null; }
  function campParent(cid) { return { campaignId: cid || null, campaignName: cid ? nm(idx.camps, cid) : null }; }
  function setParent(sid) { var s = idx.adsets[sid]; return Object.assign({ adsetId: sid || null, adsetName: sid ? nm(idx.adsets, sid) : null }, campParent(s ? s.campaignId : null)); }
  function real(spendless) { return spendless ? { spend: null, impressions: null, clicks: null } : { spend: 0, impressions: 0, clicks: 0 }; }
  function addMeta(o, r) { o.spend += spendInReport_(r, fx, useReport); o.impressions += num_(r.impressions); o.clicks += num_(r.clicks); }
  metaCur.forEach(function (r) {
    var cid = String(r.campaign_id || ''), sid = String(r.adset_id || ''), aid = String(r.ad_id || '');
    if (cid) addMeta(row(maps.camps, cid, Object.assign({ id: cid, name: nm(idx.camps, cid) }, real(false))), r);
    if (sid) addMeta(row(maps.sets, sid, Object.assign({ id: sid, name: nm(idx.adsets, sid) }, campParent(idx.adsets[sid].campaignId), real(false))), r);
    if (aid) addMeta(row(maps.ads, aid, Object.assign({ id: aid, name: nm(idx.ads, aid) }, setParent(idx.ads[aid].adsetId), real(false))), r);
  });
  cur.forEach(function (d) {
    var m = d.m;
    if (m.method === 'none') return;
    var cid = m.campaignId, sid = m.adsetId, aid = m.adId;
    if (cid) addAgg_(row(maps.camps, cid, Object.assign({ id: cid, name: m.campaignName }, real(false))), d);
    if (sid) addAgg_(row(maps.sets, sid, Object.assign({ id: sid, name: m.adsetName }, campParent(cid), real(false))), d);
    else addAgg_(row(maps.sets, 'n|' + cid, Object.assign({ id: null, name: null }, campParent(cid), real(true))), d);
    if (aid) addAgg_(row(maps.ads, aid, Object.assign({ id: aid, name: m.adName }, setParent(sid), real(false))), d);
    else if (sid) addAgg_(row(maps.ads, 'n|' + sid, Object.assign({ id: null, name: null }, setParent(sid), real(true))), d);
    else addAgg_(row(maps.ads, 'n|c|' + cid, Object.assign({ id: null, name: null, adsetId: null, adsetName: null }, campParent(cid), real(true))), d);
  });
  var truncated = {};
  function finish(name, map, parentKeys) {
    var all = Object.keys(map).map(function (k) { return map[k]; }).filter(function (o) {
      return o.leads > 0 || o.spend > 0 || o.impressions > 0 || o.clicks > 0;
    }).map(function (o) {
      var out = { id: o.id, name: o.name };
      parentKeys.forEach(function (p) { out[p] = o[p]; });
      return Object.assign(out, rowMetrics_(o));
    }).sort(function (a, b) {
      return (b.spend === null ? -1 : b.spend) - (a.spend === null ? -1 : a.spend) || b.leads - a.leads || (String(a.name) < String(b.name) ? -1 : 1);
    });
    truncated[name] = all.length > MAX_TABLE_ROWS; // ответ ограничен: в списке первые MAX_TABLE_ROWS по расходу, затем по заявкам
    return all.slice(0, MAX_TABLE_ROWS);
  }

  function utmOut(v) { return String(v === null || v === undefined ? '' : v).slice(0, MAX_UTM_OUT); } // в листе до 200 знаков, в ответе до 120
  var leads = cur.slice().sort(function (p, q) {
    return p.row.created_at < q.row.created_at ? 1 : (p.row.created_at > q.row.created_at ? -1 : 0);
  }).slice(0, MAX_LEADS_OUT).map(function (d) {
    var r = d.row;
    return {
      crmId: String(r.crm_id), url: leadUrlOf_(r, cfg), createdAt: r.created_at,
      utm: { source: utmOut(r.utm_source), medium: utmOut(r.utm_medium), campaign: utmOut(r.utm_campaign), content: utmOut(r.utm_content), term: utmOut(r.utm_term) },
      match: d.m, stageName: r.stage_name || '', status: d.f.status, qualified: d.f.qualified, sold: d.f.sold, amount: round2_(d.amount)
    };
  });

  var campaigns = finish('campaigns', maps.camps, []), adsets = finish('adsets', maps.sets, ['campaignId', 'campaignName']);
  var adsOut = finish('ads', maps.ads, ['adsetId', 'adsetName', 'campaignId', 'campaignName']);
  return {
    meta: { client: cfg.client_name, currency: cfg.currency, from: from, to: to, prevFrom: prevFrom, prevTo: prevTo, generatedAt: new Date(now).toISOString(), syncedAt: null, role: null, truncated: truncated },
    kpis: kpis, daily: daily, campaigns: campaigns, adsets: adsets, ads: adsOut, leads: leads, leadsTotal: cur.length
  };
}

// ───────── Валидация входа (всё снаружи враждебно) ─────────
function bad_() { return { ok: false }; }
function good_(v) { return { ok: true, value: v }; }

// Текст: строка, без управляющих символов, не начинается с = + - @ (формулы). '' допустим только если !required
function textOf_(v, max, required) {
  if (typeof v !== 'string') return null;
  var s = v.trim();
  if (s.length > max || (required && s === '') || /[\u0000-\u001f\u007f]/.test(s) || /^[=+\-@]/.test(s)) return null;
  return s;
}
function intInRange_(s, min, max) {
  if (!/^\d{1,6}$/.test(s)) return null;
  var n = +s;
  return n >= min && n <= max ? String(n) : null;
}
function stageListOf_(s) {
  var items = splitList_(s);
  if (items.length > 100 || s.length > 2000) return null;
  for (var i = 0; i < items.length; i++) if (!/^[A-Za-z0-9_:.\-]{1,40}$/.test(items[i])) return null;
  return items.join(',');
}
// → нормализованная строка или null
function settingValueOf_(key, v) {
  if (typeof v === 'number' && isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  var s = v.trim(), n;
  switch (key) {
    case 'client_name': return textOf_(s, 80, true);
    case 'currency': case 'meta_currency': return s === 'KZT' || s === 'USD' ? s : null;
    case 'fx_source': return s === 'fixed' || s === 'nbk' ? s : null;
    case 'crm_type': return s === 'amocrm' || s === 'bitrix24' || s === 'none' ? s : null;
    case 'sale_amount_source': return s === 'opportunity' ? s : null;
    case 'fx_rate_to_report':
      n = Number(s.replace(',', '.'));
      return s !== '' && isFinite(n) && n > 0 && n <= 1000000 ? String(n) : null;
    case 'sync_days_back': return intInRange_(s, 1, 90);
    case 'dashboard_default_days': return intInRange_(s, 1, 366);
    case 'timezone':
      if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(s) || s.length > 64) return null;
      try { new Intl.DateTimeFormat('en-CA', { timeZone: s }); return s; } catch (e) { return null; }
    case 'meta_ad_account_id': s = s.replace(/^act_/, ''); return /^\d{0,20}$/.test(s) ? s : null;
    case 'meta_api_version': return /^v\d{1,2}\.\d{1,2}$/.test(s) ? s : null;
    case 'crm_domain': s = s.toLowerCase(); return s === '' || /^[a-z0-9][a-z0-9.\-]{0,98}$/.test(s) ? s : null; // допустимость хоста — в validateSettingsPatch_
    case 'crm_pipeline_ids': case 'qualification_stage_ids': case 'sale_stage_ids': return stageListOf_(s);
  }
  return null;
}
// current — действующие настройки: тип CRM и домен проверяются вместе (SSRF: запросы уходят только на домены CRM)
function validateSettingsPatch_(patch, current) {
  if (!isPlainObject_(patch)) return bad_();
  var keys = Object.keys(patch), out = {};
  if (keys.length > SETTINGS_SCHEMA.length) return bad_();
  var known = SETTINGS_SCHEMA.map(function (c) { return c[0]; });
  for (var i = 0; i < keys.length; i++) {
    if (known.indexOf(keys[i]) < 0) return bad_();
    var v = settingValueOf_(keys[i], patch[keys[i]]);
    if (v === null) return bad_();
    out[keys[i]] = v;
  }
  var cur = current || {};
  // курс НБ РК работает только при валюте отчёта KZT — по итоговому состоянию настроек
  var fxSrc = has_(out, 'fx_source') ? out.fx_source : cur.fx_source, rep = has_(out, 'currency') ? out.currency : cur.currency;
  if (fxSrc === 'nbk' && rep !== 'KZT') return bad_();
  if (!crmHostOk_(has_(out, 'crm_type') ? out.crm_type : cur.crm_type, has_(out, 'crm_domain') ? out.crm_domain : cur.crm_domain)) return bad_();
  return good_(out);
}

// ───────── Куда можно ходить по сети (SSRF) ─────────
// amoCRM: поддомен без точки (→ .amocrm.ru) или хост на .amocrm.ru / .amocrm.com / .kommo.com
function amoHostOk_(d) {
  d = String(d || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9.\-]{0,98}$/.test(d)) return false;
  return d.indexOf('.') < 0 || /^[a-z0-9\-]+(\.[a-z0-9\-]+)*\.(amocrm\.ru|amocrm\.com|kommo\.com)$/.test(d);
}
// Bitrix24: только облако *.bitrix24.<зона>. Коробочный Bitrix (свой домен) не поддерживаем — иначе вебхук мог бы указать куда угодно
var BITRIX_ZONES = ['ru', 'by', 'kz', 'ua', 'com', 'eu', 'de', 'es', 'fr', 'it', 'pl', 'in', 'cn', 'vn', 'id', 'jp', 'uk', 'mx', 'co', 'com.br', 'com.tr'];
function bitrixHostOk_(d) {
  var m = /^[a-z0-9\-]+\.bitrix24\.([a-z.]+)$/.exec(String(d || '').toLowerCase());
  return !!m && BITRIX_ZONES.indexOf(m[1]) >= 0;
}
function crmHostOk_(type, domain) {
  if (!domain) return true;
  return type === 'amocrm' ? amoHostOk_(domain) : (type === 'bitrix24' ? bitrixHostOk_(domain) : true);
}
function bitrixWebhookOk_(url) {
  var m = /^https:\/\/([A-Za-z0-9.\-]+)\/rest\/\d+\/[A-Za-z0-9]+\/?$/.exec(String(url || ''));
  return !!m && bitrixHostOk_(m[1]);
}
// Ссылка пагинации Meta принимается только на graph.facebook.com
function graphNextOk_(url) { return typeof url === 'string' && url.indexOf('https://graph.facebook.com/') === 0; }

var MAX_LOGO_BYTES = 300 * 1024;
// '' = удалить логотип
function validateLogo_(dataUrl) {
  if (typeof dataUrl !== 'string') return bad_();
  if (dataUrl === '') return good_('');
  var m = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+\/]+={0,2})$/.exec(dataUrl.length > 450000 ? '' : dataUrl);
  if (!m) return bad_();
  var b64 = m[1], pad = b64.length - b64.replace(/=+$/, '').length;
  if (b64.length % 4 !== 0 || b64.length * 3 / 4 - pad > MAX_LOGO_BYTES) return bad_();
  return good_(dataUrl);
}
var LOGO_CHUNK = 40000;
// dataUrl → строки Assets. Перед данными 'b': base64 может начинаться с '+', а sheetSafeValue_ поставил бы туда апостроф
function logoToRows_(dataUrl) {
  var rows = [];
  for (var i = 0; i * LOGO_CHUNK < dataUrl.length; i++) rows.push({ key: 'logo', chunk: i, data: 'b' + dataUrl.slice(i * LOGO_CHUNK, (i + 1) * LOGO_CHUNK) });
  return rows;
}
function logoFromRows_(rows) {
  return (rows || []).filter(function (r) { return r.key === 'logo'; })
    .sort(function (a, b) { return num_(a.chunk) - num_(b.chunk); })
    .map(function (r) { return String(r.data).slice(1); }).join('');
}
function validatePassword_(kind, value) {
  if (kind !== 'view' && kind !== 'admin') return bad_();
  if (typeof value !== 'string' || value.length < 12 || value.length > 200) return bad_();
  // минимум 3 из 4 классов (строчные, заглавные, цифры, прочие; буквы любого алфавита) либо фраза от 20 символов
  var classes = [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[^\p{L}\p{N}]/u].filter(function (re) { return re.test(value); }).length;
  if (classes < 3 && value.length < 20) return bad_();
  return good_(value);
}
var SECRET_NAMES = ['META_TOKEN', 'AMO_TOKEN', 'BITRIX_WEBHOOK'];
// Пустое значение = удалить секрет
function validateSecret_(name, value) {
  if (SECRET_NAMES.indexOf(name) < 0 || typeof value !== 'string') return bad_();
  var s = value.trim();
  if (s.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(s)) return bad_();
  if (name === 'BITRIX_WEBHOOK' && s !== '' && !bitrixWebhookOk_(s)) return bad_();
  return good_(s);
}
var MAX_PERIOD_DAYS = 731;
function validatePeriod_(p) {
  if (!isPlainObject_(p)) return bad_();
  var out = { from: '', to: '', days: 0 };
  if (p.days !== undefined && p.days !== null && p.days !== '') { // «последние N дней»: целое 1..366
    var dn = typeof p.days === 'number' ? p.days : (typeof p.days === 'string' && /^\d{1,3}$/.test(p.days) ? +p.days : NaN);
    if (!isFinite(dn) || dn !== Math.floor(dn) || dn < 1 || dn > 366) return bad_();
    out.days = dn;
  }
  ['from', 'to'].forEach(function (k) {
    if (p[k] !== undefined && p[k] !== null && p[k] !== '') { if (isRealDate_(p[k])) out[k] = p[k]; else out[k] = null; }
  });
  if (out.from === null || out.to === null) return bad_();
  if (out.from && out.to && (out.from > out.to || daysBetween_(out.from, out.to) > MAX_PERIOD_DAYS)) return bad_();
  return good_(out);
}
