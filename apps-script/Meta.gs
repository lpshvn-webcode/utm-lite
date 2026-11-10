// Meta.gs — Marketing API Insights (level=campaign, по дням) → Meta_Spend. Токен: Script Property META_TOKEN.

// Тексты исключений UrlFetchApp и JSON.parse не пробрасываем (в них бывают URL и куски ответа): наружу только источник, HTTP-код и поле error
function graphGet_(url) {
  var resp, code, json;
  try {
    resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + secret_('META_TOKEN') }, muteHttpExceptions: true, followRedirects: false });
  } catch (e) {
    if (e.pub) throw e;
    throw pubError_('Meta: сеть недоступна');
  }
  code = resp.getResponseCode();
  try { json = JSON.parse(resp.getContentText() || '{}'); } catch (e) { json = {}; if (code < 300) throw pubError_('Meta ' + code + ': некорректный ответ'); }
  if (code >= 300 || json.error) throw pubError_('Meta ' + code + ': ' + errText_((json.error && json.error.message) || 'ошибка'));
  return json;
}
function graphBase_(cfg) { return 'https://graph.facebook.com/' + cfg.meta_api_version + '/'; }
function qs_(o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&'); }

// Все страницы (paging.next уже содержит параметры; токен идёт в заголовке). next — только на graph.facebook.com, не больше 200 страниц
var GRAPH_MAX_PAGES = 200;
function graphPaged_(url) {
  var out = [], pages = 0;
  while (url) {
    if (++pages > GRAPH_MAX_PAGES) throw pubError_('Meta: слишком много страниц ответа');
    var j = graphGet_(url);
    out = out.concat(j.data || []);
    url = j.paging && j.paging.next;
    if (url && !graphNextOk_(url)) throw pubError_('Meta: недопустимая ссылка следующей страницы');
    progressPage_();
  }
  return out;
}

function syncMeta_() {
  var cfg = readConfig_();
  if (!cfg.meta_ad_account_id) throw new Error('В настройках не задан кабинет Meta (meta_ad_account_id)');
  var to = todayKey_(cfg), from = daysAgoKey_(cfg, cfg.sync_days_back);
  var url = graphBase_(cfg) + 'act_' + cfg.meta_ad_account_id + '/insights?' + qs_({
    level: 'campaign', time_increment: 1, limit: 500, time_range: JSON.stringify({ since: from, until: to }),
    fields: 'date_start,account_id,account_currency,campaign_id,campaign_name,spend,impressions,clicks'
  });
  var rows = graphPaged_(url).map(metaCampaignRow_);
  if (cfg.fx_source === 'nbk' && cfg.meta_currency !== cfg.currency) applyNbkRates_(rows, cfg);
  lockedWrite_(function () { mergeRows_('Meta_Spend', function (r) { return dateKey_(r.date) + '|' + r.campaign_id; }, rows); });
  log_('INFO', 'Meta', 'синк ' + from + '..' + to + ': строк ' + rows.length);
  return rows.length;
}

// Курс НБ РК на дату каждой строки → fx_rate, spend_report. Нет курса → fx_rate_to_report + WARN в Log
function applyNbkRates_(rows, cfg) {
  if (cfg.currency !== 'KZT') throw new Error('fx_source=nbk работает только при currency=KZT');
  var dates = Object.keys(rows.reduce(function (m, r) { m[r.date] = 1; return m; }, {})), rate = {};
  try {
    var resps = UrlFetchApp.fetchAll(dates.map(function (d) {
      return { url: 'https://nationalbank.kz/rss/get_rates.cfm?fdate=' + d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4), muteHttpExceptions: true, followRedirects: false };
    }));
    dates.forEach(function (d, i) {
      if (resps[i].getResponseCode() === 200) rate[d] = parseNbkRate_(resps[i].getContentText(), cfg.meta_currency);
    });
  } catch (e) { log_('WARN', 'FX', 'НБ РК недоступен'); }
  var missed = dates.filter(function (d) { return !rate[d]; });
  if (missed.length) log_('WARN', 'FX', 'нет курса НБ РК на ' + missed.join(', ') + ' — взят fx_rate_to_report');
  rows.forEach(function (r) {
    r.fx_rate = rate[r.date] || cfg.fx_rate_to_report;
    r.spend_report = Math.round(r.spend * r.fx_rate * 100) / 100;
  });
}
