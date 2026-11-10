// Core.gs — чистая логика без Google API (тестируется в Node: node --test apps-script/tests).
// Все top-level объекты — через var/function, чтобы Node vm видел их как глобальные.

// ───────── Схема листов (контракт: docs/SPEC.md) ─────────
var SHEET_HEADERS = {
  Settings: ['key', 'value'],
  Channels: ['id', 'name', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'spend_source', 'meta_filter', 'sort'],
  Spend_Manual: ['id', 'channel_id', 'date_from', 'date_to', 'amount', 'comment'],
  Meta_Spend: ['date', 'account_id', 'campaign_id', 'campaign_name', 'spend', 'impressions', 'clicks', 'currency', 'fx_rate', 'spend_report'],
  CRM_Leads: ['crm_id', 'crm_type', 'created_at', 'closed_at', 'stage_id', 'stage_name', 'pipeline_id', 'status', 'amount', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'updated_at'],
  Stages: ['pipeline_id', 'pipeline_name', 'stage_id', 'name', 'sort', 'kind'],
  Assets: ['key', 'chunk', 'data'],
  Log: ['ts', 'level', 'source', 'message']
};
// Колонки-текст: длинные id и даты-строки не должны превращаться в числа/Date
// Текстовые колонки: пишем как есть в ячейки с форматом '@' (формула там не исполняется), без апострофа
var TEXT_COLUMNS = ['key', 'value', 'id', 'name', 'channel_id', 'date', 'date_from', 'date_to', 'account_id', 'campaign_id', 'campaign_name', 'crm_id', 'stage_id', 'stage_name',
  'pipeline_id', 'created_at', 'closed_at', 'updated_at', 'data', 'comment', 'meta_filter', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

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
  return decodeEntities_(s).toLowerCase().replace(/[\s\-–—_]+/g, ' ').trim();
}
function isFilled_(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }

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
function metaCampaignRow_(r) {
  return {
    date: r.date_start, account_id: String(r.account_id || ''), campaign_id: String(r.campaign_id || ''), campaign_name: r.campaign_name || '',
    spend: num_(r.spend), impressions: num_(r.impressions), clicks: num_(r.clicks), currency: r.account_currency || '', fx_rate: '', spend_report: ''
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
// Расход строки Meta_Spend в валюте отчёта: курс дня (spend_report), иначе фиксированный курс
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

// ───────── Каналы ─────────
var SYSTEM_NONE = { id: '_none', name: 'Без меток' };
var SYSTEM_OTHER = { id: '_other', name: 'Прочие метки' };
var TREE_LEVELS = UTM_FIELDS;

function utmNorm_(v) { return v === null || v === undefined ? '' : String(v).trim().toLowerCase(); }
// Правила по sort по возрастанию, при равенстве — как в таблице
function sortChannels_(channels) {
  return (channels || []).map(function (c, i) { return { c: c, i: i }; })
    .sort(function (a, b) { return num_(a.c.sort) - num_(b.c.sort) || a.i - b.i; })
    .map(function (x) { return x.c; });
}
// Условия правил: null = любое, строка = точное (в нижнем регистре), массив = маска с * (части между звёздочками)
function compileChannels_(channels) {
  // канал без единого условия — только для расхода (радио, офлайн): заявки не забирает
  return sortChannels_(channels).filter(function (c) {
    return UTM_FIELDS.some(function (f) { return utmNorm_(c[f]) !== ''; });
  }).map(function (c) {
    return {
      id: String(c.id), name: c.name,
      tests: UTM_FIELDS.map(function (f) {
        var p = utmNorm_(c[f]);
        if (p === '') return null;
        if (p.indexOf('*') < 0) return p;
        return p.split('*');
      })
    };
  });
}
// Маска без regex (нет риска тяжёлых выражений): начало, части между * по порядку через indexOf, конец
function globMatch_(parts, v) {
  var last = parts.length - 1, pos = parts[0].length;
  if (v.indexOf(parts[0]) !== 0) return false;
  for (var i = 1; i < last; i++) {
    var at = v.indexOf(parts[i], pos);
    if (at < 0) return false;
    pos = at + parts[i].length;
  }
  return v.length - pos >= parts[last].length && v.slice(v.length - parts[last].length) === parts[last];
}
// utm — объект с полями utm_source…utm_term → {id, name}
function assignChannel_(utm, compiled) {
  var vals = UTM_FIELDS.map(function (f) { return utmNorm_(utm[f]); });
  for (var i = 0; i < compiled.length; i++) {
    var ok = true;
    for (var j = 0; j < 5 && ok; j++) {
      var t = compiled[i].tests[j];
      if (t === null) continue;
      ok = typeof t === 'string' ? vals[j] === t : globMatch_(t, vals[j]);
    }
    if (ok) return { id: compiled[i].id, name: compiled[i].name };
  }
  return vals.every(function (v) { return v === ''; }) ? SYSTEM_NONE : SYSTEM_OTHER;
}

// ───────── Расход каналов ─────────
// Meta: кампания (по campaign_id, имя — из самой свежей строки) уходит в первый по sort канал spend_source=meta,
// чьё meta_filter содержится в имени (пустой фильтр = любая). Ручной: сумма поровну по дням date_from..date_to, в период — доля дней.
// useReport — брать spend_report (fx_source=nbk), иначе spend × fx.
// → {byChannel: {id: сумма}, byDay: {YYYY-MM-DD: сумма}, unallocated: расход Meta за период, не попавший ни в один канал}
function channelSpend_(channels, metaRows, manualRows, from, to, fx, useReport) {
  var sorted = sortChannels_(channels), byChannel = {}, byDay = {};
  function add(id, day, amt) { byChannel[id] = (byChannel[id] || 0) + amt; byDay[day] = (byDay[day] || 0) + amt; }
  var camp = {}, owner = {}, metaTotal = 0, metaTaken = 0;
  (metaRows || []).forEach(function (r) {
    var id = String(r.campaign_id), d = dateKey_(r.date);
    if (!camp[id] || d >= camp[id].date) camp[id] = { name: String(r.campaign_name || '').toLowerCase(), date: d };
  });
  Object.keys(camp).forEach(function (id) {
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].spend_source !== 'meta') continue;
      var f = utmNorm_(sorted[i].meta_filter);
      if (f === '' || camp[id].name.indexOf(f) >= 0) { owner[id] = String(sorted[i].id); return; }
    }
  });
  (metaRows || []).forEach(function (r) {
    var day = dateKey_(r.date), o = owner[String(r.campaign_id)];
    if (!inRange_(day, from, to)) return;
    var amt = spendInReport_(r, fx, useReport);
    metaTotal += amt;
    if (o) { add(o, day, amt); metaTaken += amt; }
  });
  var manual = {};
  sorted.forEach(function (c) { if (c.spend_source === 'manual') manual[String(c.id)] = true; });
  (manualRows || []).forEach(function (m) {
    var a = dateKey_(m.date_from), b = dateKey_(m.date_to);
    if (!manual[String(m.channel_id)] || !a || !b || b < a) return;
    var per = num_(m.amount) / daysBetween_(a, b), s = a > from ? a : from, e = b < to ? b : to;
    for (var d = s; d <= e; d = addDays_(d, 1)) add(String(m.channel_id), d, per);
  });
  return { byChannel: byChannel, byDay: byDay, unallocated: metaTotal - metaTaken };
}

// ───────── Метрики ─────────
function computeMetrics_(a) {
  return {
    cpl: ratio_(a.spend, a.leads), costPerQualified: ratio_(a.spend, a.qualified), costPerSale: ratio_(a.spend, a.sales),
    qualRate: a.leads > 0 ? round2_(100 * a.qualified / a.leads) : null, // % от заявок
    closeRate: a.qualified > 0 ? round2_(100 * a.sales / a.qualified) : null, // % от квал-заявок
    romiPct: a.spend > 0 ? round2_(100 * (a.revenue - a.spend) / a.spend) : null,
    roas: ratio_(a.revenue, a.spend)
  };
}
var KPI_KEYS = ['spend', 'unallocatedSpend', 'leads', 'qualified', 'sales', 'revenue', 'cpl', 'costPerQualified', 'costPerSale', 'qualRate', 'closeRate', 'romiPct', 'roas'];
// Нет данных за период → все поля null, а не 0
function kpisOf_(t, empty) {
  var out = {};
  if (empty) { KPI_KEYS.forEach(function (k) { out[k] = null; }); return out; }
  var m = computeMetrics_(t);
  out.spend = round2_(t.spend); out.unallocatedSpend = round2_(Math.max(t.unallocated, 0)); out.leads = t.leads; out.qualified = t.qualified; out.sales = t.sales; out.revenue = round2_(t.revenue);
  ['cpl', 'costPerQualified', 'costPerSale', 'qualRate', 'closeRate', 'romiPct', 'roas'].forEach(function (k) { out[k] = m[k]; });
  return out;
}

function newAgg_() { return { leads: 0, qualified: 0, sales: 0, revenue: 0 }; }
function addAgg_(a, d) {
  a.leads++;
  if (d.f.qualified) a.qualified++;
  if (d.f.sold) { a.sales++; a.revenue += d.amount; }
}
function sumSpend_(byChannel) {
  return Object.keys(byChannel).reduce(function (s, k) { return s + byChannel[k]; }, 0);
}

// Дерево меток: source → medium → campaign → content → term (без учёта регистра и пробелов по краям)
function addToTree_(root, d) {
  var node = root;
  TREE_LEVELS.forEach(function (level) {
    var raw = String(d.row[level] === null || d.row[level] === undefined ? '' : d.row[level]).trim(), k = 'k:' + raw.toLowerCase();
    if (!has_(node.kids, k)) { node.kids[k] = { level: level, value: raw, agg: newAgg_(), kids: {}, order: [] }; node.order.push(k); }
    node = node.kids[k];
    addAgg_(node.agg, d);
  });
}
// Корень и узлы: kids (объект по ключу) и order (порядок появления)
function finishTree_(node) {
  return node.order.map(function (k) { return node.kids[k]; }).map(function (n) {
    var m = computeMetrics_({ spend: 0, leads: n.agg.leads, qualified: n.agg.qualified, sales: n.agg.sales, revenue: n.agg.revenue });
    return { level: n.level, value: n.value, leads: n.agg.leads, qualified: n.agg.qualified, sales: n.agg.sales, revenue: round2_(n.agg.revenue),
      qualRate: m.qualRate, closeRate: m.closeRate, children: finishTree_(n) };
  }).sort(function (a, b) { return b.leads - a.leads || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0); });
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

var MAX_LEADS_OUT = 2000;

// rows: {channels, spendManual, metaSpend, leads} — строки листов; params: {from, to}; today — 'YYYY-MM-DD' в поясе отчёта
// (считает Config.gs через Utilities.formatDate); учитываются только заявки текущей CRM (crm_type); → data по контракту SPEC
function buildDashboardData_(rows, params, cfg, today, nowMs) {
  params = params || {};
  var now = nowMs || Date.now();
  var to = dateKey_(params.to) || today;
  var from = dateKey_(params.from) || addDays_(to, -(num_(cfg.dashboard_default_days) || 30) + 1);
  if (from > to) from = to;
  var len = daysBetween_(from, to), prevTo = addDays_(from, -1), prevFrom = addDays_(prevTo, -(len - 1));
  var fx = metaFx_(cfg), channels = rows.channels || [];
  var compiled = compileChannels_(channels);

  var useReport = cfg.fx_source === 'nbk' && cfg.meta_currency !== cfg.currency;
  var spendCur = channelSpend_(channels, rows.metaSpend, rows.spendManual, from, to, fx, useReport);
  var spendPrev = channelSpend_(channels, rows.metaSpend, rows.spendManual, prevFrom, prevTo, fx, useReport);

  // заявки обоих периодов, один раз с каналом и флагами
  var cur = [], prev = [];
  (rows.leads || []).forEach(function (row) {
    if (row.crm_type !== cfg.crm_type) return; // остатки прежней CRM не считаем
    var key = dateKey_(row.created_at), inCur = inRange_(key, from, to), inPrev = inRange_(key, prevFrom, prevTo);
    if (!inCur && !inPrev) return;
    var d = { row: row, key: key, ch: assignChannel_(row, compiled), f: leadFlags_(row, cfg), amount: num_(row.amount) };
    (inCur ? cur : prev).push(d);
  });

  function totals(list, sp) {
    var t = newAgg_();
    list.forEach(function (d) { addAgg_(t, d); });
    t.spend = sumSpend_(sp.byChannel); t.unallocated = sp.unallocated;
    return t;
  }
  function isEmpty(t) { return t.leads === 0 && t.spend === 0 && t.unallocated < 0.005; }
  var tCur = totals(cur, spendCur), tPrev = totals(prev, spendPrev);
  var kpis = kpisOf_(tCur, isEmpty(tCur));
  kpis.prev = kpisOf_(tPrev, isEmpty(tPrev));

  var perDay = {};
  cur.forEach(function (d) { addAgg_(perDay[d.key] = perDay[d.key] || newAgg_(), d); });
  var daily = [];
  for (var day = from; day <= to; day = addDays_(day, 1)) {
    var a = perDay[day] || newAgg_();
    daily.push({ date: day, spend: round2_(spendCur.byDay[day] || 0), leads: a.leads, qualified: a.qualified, sales: a.sales, revenue: round2_(a.revenue) });
  }

  // каналы: все из справочника + системные, если в них есть заявки
  var chMap = {}, chOrder = [];
  function chEntry(id, name, source) {
    if (!has_(chMap, id)) { chMap[id] = { id: id, name: name, spendSource: source, agg: newAgg_(), tree: { kids: {}, order: [] } }; chOrder.push(id); }
    return chMap[id];
  }
  sortChannels_(channels).forEach(function (c) { chEntry(String(c.id), c.name, c.spend_source || 'none'); });
  cur.forEach(function (d) {
    var e = chEntry(d.ch.id, d.ch.name, 'none');
    addAgg_(e.agg, d);
    addToTree_(e.tree, d);
  });
  var chOut = chOrder.map(function (id) {
    var e = chMap[id], spend = round2_(spendCur.byChannel[id] || 0);
    var m = computeMetrics_({ spend: spend, leads: e.agg.leads, qualified: e.agg.qualified, sales: e.agg.sales, revenue: e.agg.revenue });
    return { id: e.id, name: e.name, spendSource: e.spendSource, spend: spend, leads: e.agg.leads, qualified: e.agg.qualified, sales: e.agg.sales,
      revenue: round2_(e.agg.revenue), cpl: m.cpl, costPerQualified: m.costPerQualified, costPerSale: m.costPerSale, qualRate: m.qualRate,
      closeRate: m.closeRate, romiPct: m.romiPct, roas: m.roas, children: finishTree_(e.tree) };
  }).sort(function (x, y) { return y.spend - x.spend || y.leads - x.leads; });

  var leads = cur.slice().sort(function (x, y) {
    return x.row.created_at < y.row.created_at ? 1 : (x.row.created_at > y.row.created_at ? -1 : 0);
  }).slice(0, MAX_LEADS_OUT).map(function (d) {
    var r = d.row;
    return {
      crmId: String(r.crm_id), url: leadUrlOf_(r, cfg), createdAt: r.created_at, channelId: d.ch.id, channelName: d.ch.name,
      utm: { source: r.utm_source || '', medium: r.utm_medium || '', campaign: r.utm_campaign || '', content: r.utm_content || '', term: r.utm_term || '' },
      stageName: r.stage_name || '', status: d.f.status, qualified: d.f.qualified, sold: d.f.sold, amount: round2_(d.amount)
    };
  });

  return {
    meta: { client: cfg.client_name, currency: cfg.currency, from: from, to: to, prevFrom: prevFrom, prevTo: prevTo, generatedAt: new Date(now).toISOString(), syncedAt: null, role: null },
    kpis: kpis, daily: daily, channels: chOut, leads: leads, leadsTotal: cur.length
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

var MAX_CHANNELS = 200, MAX_SPEND_ROWS = 2000, MAX_LOGO_BYTES = 300 * 1024;
var SPEND_SOURCES = ['meta', 'manual', 'none'];
function idOf_(v, genId, seen) {
  var id;
  if (v === undefined || v === null || v === '') {
    do { id = genId(); } while (seen[id]);
  } else {
    if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(v)) return null; // «_…» зарезервировано под системные каналы
    id = v;
  }
  if (seen[id]) return null;
  seen[id] = true;
  return id;
}
// Полная замена справочника. genId() — генератор id для новых строк
function validateChannels_(list, genId) {
  if (!Array.isArray(list) || list.length > MAX_CHANNELS) return bad_();
  var seen = {}, out = [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (!isPlainObject_(c)) return bad_();
    var row = { name: textOf_(c.name, 80, true) };
    if (row.name === null) return bad_();
    for (var j = 0; j < UTM_FIELDS.length; j++) {
      var p = c[UTM_FIELDS[j]] === undefined || c[UTM_FIELDS[j]] === null ? '' : textOf_(c[UTM_FIELDS[j]], 100, false);
      if (p === null || p.split('*').length > 6) return bad_();
      row[UTM_FIELDS[j]] = p;
    }
    row.spend_source = c.spend_source === undefined || c.spend_source === null || c.spend_source === '' ? 'none' : c.spend_source;
    if (SPEND_SOURCES.indexOf(row.spend_source) < 0) return bad_();
    row.meta_filter = c.meta_filter === undefined || c.meta_filter === null ? '' : textOf_(c.meta_filter, 100, false);
    if (row.meta_filter === null) return bad_();
    if (c.sort === undefined || c.sort === null || c.sort === '') row.sort = (i + 1) * 10;
    else {
      var s = typeof c.sort === 'number' ? c.sort : (typeof c.sort === 'string' && /^-?\d{1,7}$/.test(c.sort.trim()) ? +c.sort : NaN);
      if (!isFinite(s) || Math.abs(s) > 1000000) return bad_();
      row.sort = Math.round(s);
    }
    row.id = idOf_(c.id, genId, seen);
    if (row.id === null) return bad_();
    out.push(row);
  }
  return good_(out);
}
// Полная замена ручного расхода. channelIds — {id: true} существующих каналов
function validateSpend_(list, channelIds, genId) {
  if (!Array.isArray(list) || list.length > MAX_SPEND_ROWS) return bad_();
  var seen = {}, out = [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (!isPlainObject_(r)) return bad_();
    if (typeof r.channel_id !== 'string' || !has_(channelIds, r.channel_id)) return bad_();
    if (!isRealDate_(r.date_from) || !isRealDate_(r.date_to) || r.date_to < r.date_from || daysBetween_(r.date_from, r.date_to) > 3660) return bad_();
    var amount = typeof r.amount === 'number' ? r.amount : (typeof r.amount === 'string' && r.amount.trim() !== '' ? Number(r.amount.replace(/\s/g, '').replace(',', '.')) : NaN);
    if (!isFinite(amount) || amount < 0 || amount > 1e12) return bad_();
    var comment = r.comment === undefined || r.comment === null ? '' : textOf_(r.comment, 200, false);
    if (comment === null) return bad_();
    var id = idOf_(r.id, genId, seen);
    if (id === null) return bad_();
    out.push({ id: id, channel_id: r.channel_id, date_from: r.date_from, date_to: r.date_to, amount: round2_(amount), comment: comment });
  }
  return good_(out);
}
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
