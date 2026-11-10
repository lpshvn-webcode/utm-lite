// Amo.gs — чтение сделок и воронок amoCRM (API v4) → CRM_Leads, Stages. Токен: Script Property AMO_TOKEN.
// ТОЛЬКО ЧТЕНИЕ: единственный сетевой вызов — amoGet_ (GET). Имя сделки, контакты, телефоны, ответственных не забираем.

function amoHost_(cfg) {
  if (!cfg.crm_domain) throw pubError_('В настройках не задан crm_domain (поддомен amoCRM)');
  // проверка прямо перед запросом: даже испорченная настройка не уведёт токен на чужой хост
  if (!amoHostOk_(cfg.crm_domain)) throw pubError_('Недопустимый домен amoCRM (нужен поддомен или *.amocrm.ru / *.amocrm.com / *.kommo.com)');
  return cfg.crm_domain.indexOf('.') >= 0 ? cfg.crm_domain : cfg.crm_domain + '.amocrm.ru';
}

// null на 204 (пустая страница)
function amoGet_(cfg, path, query) {
  // скобки filter[...] кодируем: UrlFetchApp может не принять их в URL как есть
  var url = 'https://' + amoHost_(cfg) + path + (query ? '?' + query.replace(/\[/g, '%5B').replace(/\]/g, '%5D') : '');
  var resp;
  try {
    resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + secret_('AMO_TOKEN') }, muteHttpExceptions: true, followRedirects: false });
  } catch (e) {
    if (e.pub) throw e;
    throw pubError_('amoCRM: сеть недоступна'); // текст исключения может содержать адрес
  }
  var code = resp.getResponseCode();
  Utilities.sleep(200); // лимит ~7 запросов/сек
  if (code === 204) return null;
  if (code >= 300) throw pubError_('amoCRM ' + code + ' ' + path); // 30x не выполняем: токен не должен уйти на чужой хост
  try { return JSON.parse(resp.getContentText()); } catch (e) { throw pubError_('amoCRM ' + code + ': некорректный ответ'); }
}

function amoPaged_(cfg, path, query, embeddedKey, limit) {
  var out = [], page = 1;
  while (true) {
    var j = amoGet_(cfg, path, (query ? query + '&' : '') + 'limit=' + (limit || 250) + '&page=' + page);
    if (!j || !j._embedded || !j._embedded[embeddedKey] || !j._embedded[embeddedKey].length) break;
    out = out.concat(j._embedded[embeddedKey]);
    progressPage_();
    if (!j._links || !j._links.next) break;
    page++;
  }
  return out;
}

// custom_fields_values → {field_code | field_id | field_name: первое значение}
function amoFlatten_(cfv) {
  var flat = {};
  (cfv || []).forEach(function (f) {
    var v = f.values && f.values[0] ? String(f.values[0].value) : '';
    if (f.field_code) flat[f.field_code] = v;
    flat[String(f.field_id)] = v;
    if (f.field_name) flat[f.field_name] = v;
  });
  return flat;
}
function amoPick_(flat, name) { return flat[name.toUpperCase()] || flat[name.toLowerCase()] || ''; }

// Воронки → лист Stages; возвращает воронки (с вложенными статусами)
function amoStages_(cfg) {
  var pipelines = amoPaged_(cfg, '/api/v4/leads/pipelines', '', 'pipelines');
  lockedWrite_(function () { writeTable_('Stages', buildStageRows_(pipelines, cfg.crm_pipeline_ids)); });
  return pipelines;
}

// daysBack — необязательно: окно синка в днях; по умолчанию sync_days_back
function syncAmo_(daysBack) {
  var cfg = readConfig_(), tz = cfg.timezone;
  var from = Math.floor((Date.now() - (daysBack || cfg.sync_days_back) * 86400000) / 1000);
  var stageNames = {}, unsorted = []; // «Неразобранное» (type 1) обычный список сделок не отдаёт — запрашиваем отдельно (filter[statuses])
  var pipelines = amoStages_(cfg);
  pipelines.forEach(function (p) {
    ((p._embedded && p._embedded.statuses) || []).forEach(function (s) {
      stageNames[s.id] = s.name;
      if (s.type === 1) { var i = unsorted.length; unsorted.push('filter[statuses][' + i + '][pipeline_id]=' + p.id + '&filter[statuses][' + i + '][status_id]=' + s.id); }
    });
  });
  var pipes = splitList_(cfg.crm_pipeline_ids);
  var leads = amoPaged_(cfg, '/api/v4/leads', 'filter[updated_at][from]=' + from + '&order[updated_at]=asc', 'leads')
    .concat(unsorted.length ? amoPaged_(cfg, '/api/v4/leads', unsorted.join('&'), 'leads') : [])
    .filter(function (l) { return !pipes.length || pipes.indexOf(String(l.pipeline_id)) >= 0; });

  var rows = leads.map(function (l) {
    var flat = amoFlatten_(l.custom_fields_values);
    return makeLeadRow_({
      crm_id: l.id, crm_type: 'amocrm', created_at: fmtIso_(l.created_at * 1000, tz), closed_at: l.closed_at ? fmtIso_(l.closed_at * 1000, tz) : '',
      stage_id: l.status_id, stage_name: stageNames[l.status_id] || '', pipeline_id: l.pipeline_id,
      native_status: l.status_id === 142 ? 'won' : (l.status_id === 143 ? 'lost' : 'open'), opportunity: l.price,
      utm_source: amoPick_(flat, 'utm_source'), utm_medium: amoPick_(flat, 'utm_medium'), utm_campaign: amoPick_(flat, 'utm_campaign'),
      utm_content: amoPick_(flat, 'utm_content'), utm_term: amoPick_(flat, 'utm_term'), updated_at: fmtIso_(l.updated_at * 1000, tz)
    });
  });
  lockedWrite_(function () { mergeRows_('CRM_Leads', function (r) { return r.crm_type + '|' + r.crm_id; }, rows); });
  log_('INFO', 'Amo', 'синк сделок: ' + rows.length);
  return rows.length;
}
