// Setup.gs — создаёт листы, настройки по умолчанию, триггер. Данные существующих листов не удаляет.

function setupTemplate() {
  var ui = menuUi_(); // из веб-приложения недоступно; аргументы не читаем
  if (!ui) return FORBIDDEN_;
  try {
    setupTemplate_();
  } catch (e) { log_('ERROR', 'Setup', e.message); ui.alert('Не удалось', 'Подробности — на листе Log.', ui.ButtonSet.OK); }
}

function setupTemplate_() {
  var ss = SpreadsheetApp.getActive();
  props_().setProperty('SHEET_ID', ss.getId()); // не секрет; нужен веб-приложению (там getActive() может быть null)
  Object.keys(SHEET_HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var head = SHEET_HEADERS[name];
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#d9ead3');
    sh.setFrozenRows(1);
    head.forEach(function (h, i) {
      if (TEXT_COLUMNS.indexOf(h) >= 0) sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
    });
  });
  seedSettings_(ss);
  SpreadsheetApp.flush();
  ss.setSpreadsheetTimeZone(readConfig_().timezone); // даты в листах = пояс отчёта, иначе день «уезжает»
  ['Sheet1', 'Лист1'].forEach(function (n) {
    var s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
  installTriggers_();
  ss.toast('Готово. Дальше: «Задать пароль администратора» (от 12 символов), затем откройте веб-приложение.', 'UTM Аналитика', 8);
}

// Добавляет только отсутствующие ключи — значения клиента не затираются
function seedSettings_(ss) {
  var sh = ss.getSheetByName('Settings'), have = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { have[String(r[0]).trim()] = true; });
  var add = SETTINGS_SCHEMA.filter(function (c) { return !have[c[0]]; }).map(function (c) { return [c[0], String(c[1])]; });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 2).setValues(add);
}

// Один триггер: полный синк в 03:00 (пояс из настроек). Прежний триггер этого набора удаляется — дублей при повторном запуске нет
function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'triggerSyncAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('triggerSyncAll').timeBased().atHour(3).everyDays(1).inTimezone(readConfig_().timezone).create();
}
