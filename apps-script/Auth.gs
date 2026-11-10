// Auth.gs — пароли (соль + SHA-256), сессии в CacheService, блокировка перебора.
// В Script Properties лежит 'соль:хеш', сам пароль нигде не хранится.

var SESSION_TTL_S = 6 * 3600;
var LOGIN_MAX_FAILS = 10;
var LOGIN_LOCK_S = 15 * 60;

function cache_() { return CacheService.getScriptCache(); }

function hashPass_(salt, pass) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pass, Utilities.Charset.UTF_8));
}

// kind: 'admin' | 'view' → свойства ADMIN_PASS / VIEW_PASS. Смена любого пароля отзывает все сессии (PASS_VER)
function savePassword_(kind, pass) {
  var salt = Utilities.getUuid();
  props_().setProperty(kind === 'admin' ? 'ADMIN_PASS' : 'VIEW_PASS', salt + ':' + hashPass_(salt, pass));
  props_().setProperty('PASS_VER', String((+props_().getProperty('PASS_VER') || 0) + 1));
  bootDrop_(); // hasViewPass / needsSetup в кэше экрана входа устарели
}

// Проверка всегда считает хеш (и при незаданном пароле), сравнение — по хешам одинаковой длины
function passwordMatches_(kind, pass) {
  var stored = props_().getProperty(kind === 'admin' ? 'ADMIN_PASS' : 'VIEW_PASS') || '';
  var i = stored.indexOf(':'), salt = i > 0 ? stored.slice(0, i) : 'none', hash = i > 0 ? stored.slice(i + 1) : '';
  var ok = constantTimeEqual_(hashPass_(salt, pass), hash);
  return i > 0 && ok;
}

// Попытку резервируем ДО сравнения пароля, под замком: проверка порога и +1 к счётчику. Пачка параллельных запросов
// проверит не больше LOGIN_MAX_FAILS паролей. Замок не взят за 2 с → 'busy' (без замка не считаем: иначе аноним, занимая замок, открыл бы гонку)
function loginReserve_() {
  if (cache_().get('login_lock') !== null) return 'locked'; // при блокировке поток запросов замок не занимает
  var lock = LockService.getScriptLock(), got = false;
  try { got = lock.tryLock(2000); } catch (e) { got = false; }
  if (!got) return 'busy';
  try {
    var c = cache_();
    if (c.get('login_lock') !== null) return 'locked';
    var n = (+c.get('login_fails') || 0) + 1;
    c.put('login_fails', String(n), LOGIN_LOCK_S);
    if (n >= LOGIN_MAX_FAILS) c.put('login_lock', '1', LOGIN_LOCK_S); // эта попытка последняя; следующая уже locked
    return 'ok';
  } finally { lock.releaseLock(); }
}
function loginLocked_() { return cache_().get('login_lock') !== null; }
// Успешный вход по паролю просмотра возвращает свою зарезервированную попытку (иначе 5 сотрудников за 15 минут заперли бы вход всем),
// но чужие неверные попытки не обнуляет. Блок снимается, только если его поставила сама эта попытка.
function loginRefund_() {
  var lock = LockService.getScriptLock(), got = false;
  try { got = lock.tryLock(2000); } catch (e) { got = false; }
  if (!got) return; // не вышло — попытка остаётся засчитанной (безопасная сторона)
  try {
    var c = cache_(), n = Math.max((+c.get('login_fails') || 0) - 1, 0);
    if (n === 0) c.remove('login_fails'); else c.put('login_fails', String(n), LOGIN_LOCK_S);
    if (n < LOGIN_MAX_FAILS) c.remove('login_lock');
  } finally { lock.releaseLock(); }
}
function clearLoginLock_() { cache_().remove('login_lock'); cache_().remove('login_fails'); }

// Новое значение пароля совпадает с паролем другого вида (view ≠ admin)?
function passwordClash_(kind, pass) {
  return passwordMatches_(kind === 'admin' ? 'view' : 'admin', pass);
}

// Сессия: токен → 'роль|версия паролей'
function newSession_(role) {
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  cache_().put('sess:' + token, role + '|' + (props_().getProperty('PASS_VER') || '0'), SESSION_TTL_S);
  return token;
}

// → {ok, token, role} | {ok:false, error: bad_request|locked|busy|forbidden|server_error}
function apiLogin(password) {
  try {
    if (typeof password !== 'string' || password === '' || password.length > 200) return { ok: false, error: 'bad_request' };
    var gate = loginReserve_();
    if (gate !== 'ok') return { ok: false, error: gate };
    var role = passwordMatches_('admin', password) ? 'admin' : (passwordMatches_('view', password) ? 'view' : null);
    if (!role) {
      Utilities.sleep(1000); // замедляет перебор; замок к этому моменту уже отпущен (loginReserve_)
      return { ok: false, error: loginLocked_() ? 'locked' : 'forbidden' };
    }
    // admin сбрасывает счётчик и блок. view возвращает только свою зарезервированную попытку: чужие неверные не сбрасываются
    // (подбор admin владельцем view-пароля остаётся под счётом), а несколько сотрудников не блокируют вход всем
    if (role === 'admin') clearLoginLock_(); else loginRefund_();
    return { ok: true, token: newSession_(role), role: role };
  } catch (e) {
    log_('ERROR', 'Login', e.message);
    return { ok: false, error: 'server_error' };
  }
}

// token → 'admin' | 'view' | null (сессия со старой версией паролей недействительна)
function sessionRole_(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  var v = cache_().get('sess:' + token), p = String(v || '').split('|');
  if ((p[0] !== 'admin' && p[0] !== 'view') || p[1] !== (props_().getProperty('PASS_VER') || '0')) return null;
  return p[0];
}
