// Bitrix.gs — чтение сделок и стадий Bitrix24 через входящий вебхук (Script Property BITRIX_WEBHOOK) → CRM_Leads, Stages.
// Bitrix принимает методы чтения POST-ом. Вызываем только *.list и profile; методов add/update/delete здесь нет.
// Контакты, телефоны, названия сделок, ответственных не забираем.

function bitrixCall_(method, params) {
  var base = secret_('BITRIX_WEBHOOK');
  // Только облачный Bitrix24 (https://*.bitrix24.<зона>/rest/<id>/<ключ>/); коробочный не поддерживаем. Проверка прямо перед запросом
  if (!bitrixWebhookOk_(base)) throw pubError_('Недопустимый адрес вебхука Bitrix24 (нужен https://<портал>.bitrix24.<зона>/rest/<id>/<ключ>/)');
  if (base.slice(-1) !== '/') base += '/';
  var resp, json;
  try {
    resp = UrlFetchApp.fetch(base + method + '.json', {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(params || {}), muteHttpExceptions: true, followRedirects: false
    });
  } catch (e) { throw pubError_('Bitrix: сеть недоступна'); } // текст исключения содержит адрес с ключом вебхука
  if (resp.getResponseCode() >= 300 && resp.getResponseCode() < 400) throw pubError_('Bitrix ' + resp.getResponseCode() + ': ответ не принят'); // 30x не выполняем
  try { json = JSON.parse(resp.getContentText() || '{}'); } catch (e) { throw pubError_('Bitrix ' + resp.getResponseCode() + ': некорректный ответ'); }
  if (json.error) throw pubError_('Bitrix ' + resp.getResponseCode() + ': ' + errText_(json.error) + (json.error_description ? ' ' + errText_(json.error_description) : ''));
  return json;
}

// Пагинация start/next (50 записей за вызов)
function bitrixList_(method, params) {
  var out = [], start = 0;
  while (start !== undefined) {
    var p = {};
    Object.keys(params).forEach(function (k) { p[k] = params[k]; });
    p.start = start;
    var j = bitrixCall_(method, p);
    out = out.concat(j.result || []);
    start = j.next;
    progressPage_();
    Utilities.sleep(300); // лимит ~2 запроса/сек
  }
  return out;
}

// Воронки и стадии → лист Stages
function bitrixStages_(cfg) {
  var names = {};
  try { // названия воронок: нет метода/прав — остаются «Общая» и «Воронка N»
    bitrixList_('crm.dealcategory.list', {}).forEach(function (c) { names[String(c.ID)] = c.NAME; });
  } catch (e) { log_('WARN', 'Bitrix', 'названия воронок не получены'); }
  var rows = buildBitrixStageRows_(bitrixList_('crm.status.list', {}), names, cfg.crm_pipeline_ids);
  lockedWrite_(function () { writeTable_('Stages', rows); });
  return rows;
}

function syncBitrix_(daysBack) {
  var cfg = readConfig_(), tz = cfg.timezone;
  var since = fmtIso_(Date.now() - (daysBack || cfg.sync_days_back) * 86400000, cfg.timezone);
  var filter = { '>=DATE_MODIFY': since };
  var pipes = splitList_(cfg.crm_pipeline_ids);
  if (pipes.length) filter.CATEGORY_ID = pipes;
  var deals = bitrixList_('crm.deal.list', {
    filter: filter, order: { ID: 'ASC' },
    select: ['ID', 'DATE_CREATE', 'CLOSED', 'CLOSEDATE', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'CATEGORY_ID', 'OPPORTUNITY', 'DATE_MODIFY', 'UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_CONTENT', 'UTM_TERM']
  });
  var stageNames = {};
  bitrixStages_(cfg).forEach(function (s) { stageNames[s.stage_id] = s.name; });

  var rows = deals.map(function (d) {
    var sem = d.STAGE_SEMANTIC_ID;
    return makeLeadRow_({
      crm_id: d.ID, crm_type: 'bitrix24', created_at: isoInTz_(d.DATE_CREATE, tz), closed_at: d.CLOSED === 'Y' ? isoInTz_(d.CLOSEDATE, tz) : '',
      stage_id: d.STAGE_ID, stage_name: stageNames[d.STAGE_ID] || '', pipeline_id: d.CATEGORY_ID || '0',
      native_status: sem === 'S' ? 'won' : (sem === 'F' ? 'lost' : 'open'), opportunity: d.OPPORTUNITY,
      utm_source: d.UTM_SOURCE, utm_medium: d.UTM_MEDIUM, utm_campaign: d.UTM_CAMPAIGN, utm_content: d.UTM_CONTENT, utm_term: d.UTM_TERM,
      updated_at: isoInTz_(d.DATE_MODIFY, tz)
    });
  });
  lockedWrite_(function () { mergeRows_('CRM_Leads', function (r) { return r.crm_type + '|' + r.crm_id; }, rows); });
  log_('INFO', 'Bitrix', 'синк сделок: ' + rows.length);
  return rows.length;
}
