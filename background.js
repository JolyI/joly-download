'use strict';

/* Joly 下载 · Service Worker
 *
 * 设计约束（需求文档 §4 性能红线）：
 *   - 无状态：不保存常驻变量（设置与通知映射一律走 storage，现读现写）
 *   - 无常驻定时器：所有 setTimeout 均为一次性、秒级内触发即释放
 *   - 事件驱动：SW 空闲自动休眠；仅当下载事件发生时被唤醒做即发即忘的工作
 *   - 性能：进度类事件不触发任何查询；角标只在结构变化时重算（防抖一次）
 */

/* 角标：红色数字，与蓝色图标形成强对比，最醒目 */
var BADGE_BG = '#ff3b30';
var BADGE_FG = '#ffffff';

var NOTIFY_DEFAULTS = { notifyOnComplete: true, notifyOnFail: true };
var notifyPrefs = NOTIFY_DEFAULTS;

/* ============================ 面板形态 ============================
 * 面板为浏览器动作弹出窗（popup），已在 manifest 的 action.default_popup 声明，
 * Service Worker 无需做任何注册；弹出窗关闭时页面即销毁，内存归零。
 */

/* ==================== 一次性迁移：复原被隐藏的原生下载 UI ====================
 * 历史版本提供过「接管原生下载界面」开关（setUiOptions({enabled:false})）。
 * 该功能已移除：关掉原生 UI 后，Chrome 就没有地方弹出安全下载的「保留」确认框，
 * 被 Safe Browsing 标记的文件会静默卡在 100% 且不打危险标记，客户端无法补救。
 *
 * 但 UI 的隐藏状态是写在 Chrome 里的，删代码并不会自动恢复，
 * 所以这里读一次旧开关：若曾经开启，就复原它并清掉这个残留键。
 * manifest 中的 "downloads.ui" 权限仅为这段迁移保留。
 */
chrome.storage.local
  .get({ takeoverNativeUI: false })
  .then(function (s) {
    if (!s.takeoverNativeUI) return;
    if (!chrome.downloads.setUiOptions) return;
    return chrome.downloads
      .setUiOptions({ enabled: true })
      .then(function () {
        console.info('[Joly 下载] 已复原 Chrome 原生下载界面（旧的「接管」设置已移除）');
        return chrome.storage.local.remove('takeoverNativeUI');
      });
  })
  .catch(function (err) {
    console.warn('[Joly 下载] 复原原生下载界面失败：', err);
  });

chrome.storage.local
  .get(NOTIFY_DEFAULTS)
  .then(function (s) { notifyPrefs = s; })
  .catch(function () {});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes.notifyOnComplete) notifyPrefs.notifyOnComplete = !!changes.notifyOnComplete.newValue;
  if (changes.notifyOnFail) notifyPrefs.notifyOnFail = !!changes.notifyOnFail.newValue;
});

/* ============================ 角标：进行中任务数 ============================ */

function applyBadgeStyle() {
  chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
  if (chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ color: BADGE_FG });
  }
}

function updateBadge() {
  chrome.downloads
    .search({ state: 'in_progress', paused: false, limit: 100, orderBy: ['-startTime'] })
    .then(function (list) {
      var n = list ? list.length : 0;
      applyBadgeStyle();
      chrome.action.setBadgeText({ text: n > 0 ? (n > 99 ? '99+' : String(n)) : '' });
    })
    .catch(function () {});
}

var badgeTimer = 0;
function debounceBadge() {
  if (badgeTimer) return;
  badgeTimer = setTimeout(function () {
    badgeTimer = 0;
    updateBadge();
  }, 400);
}

/* ============================ 完成/失败通知（批处理去重） ============================ */

var pending = { complete: [], interrupted: [] };
var notifyTimer = 0;

function queueNotify(kind, id) {
  var enabled = kind === 'complete' ? notifyPrefs.notifyOnComplete : notifyPrefs.notifyOnFail;
  if (!enabled) return;
  pending[kind].push(id);
  if (!notifyTimer) {
    notifyTimer = setTimeout(function () {
      notifyTimer = 0;
      flushNotify();
    }, 800);
  }
}

function flushNotify() {
  var ids = pending.complete.concat(pending.interrupted);
  pending = { complete: [], interrupted: [] };
  if (!ids.length) return;

  /* 一次查询拿回所有待通知项的 filename 与 error */
  chrome.downloads
    .search({ id: ids, limit: 50, orderBy: ['-startTime'] })
    .then(function (items) {
      var byId = {};
      for (var i = 0; i < items.length; i++) byId[items[i].id] = items[i];

      var done = [];
      var failed = [];
      for (var j = 0; j < ids.length; j++) {
        var it = byId[ids[j]];
        if (!it) continue;
        if (it.state === 'complete') done.push(it);
        /* 用户主动取消 / 浏览器退出导致的失败不打扰用户 */
        else if (it.error !== 'USER_CANCELED' && it.error !== 'USER_SHUTDOWN') failed.push(it);
      }
      if (done.length) sendNotify('complete', done);
      if (failed.length) sendNotify('interrupted', failed);
    })
    .catch(function () { /* 查询失败则静默丢弃本批通知 */ });
}

function nameOf(it) {
  var p = it.filename || it.url || '';
  var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function sendNotify(kind, items) {
  var title = kind === 'complete'
    ? (items.length > 1 ? items.length + ' 个文件下载完成' : '下载完成')
    : (items.length > 1 ? items.length + ' 个文件下载失败' : '下载失败');

  var message;
  if (items.length === 1) {
    message = nameOf(items[0]);
  } else {
    var names = [];
    for (var i = 0; i < Math.min(3, items.length); i++) names.push(nameOf(items[i]));
    message = names.join('、') + (items.length > 3 ? ' 等 ' + items.length + ' 个文件' : '');
  }

  chrome.notifications.create(
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: title,
      message: message
    },
    function (notifId) {
      /* 记住通知对应的下载 ID：点击通知 → 在文件夹中定位该文件 */
      if (notifId && kind === 'complete') {
        var key = 'notif:' + notifId;
        var patch = {};
        patch[key] = items[0].id;
        chrome.storage.session.set(patch).catch(function () {});
      }
    }
  );
}

chrome.notifications.onClicked.addListener(function (id) {
  chrome.notifications.clear(id);
  var key = 'notif:' + id;
  chrome.storage.session
    .get(key)
    .then(function (s) {
      if (s[key]) chrome.downloads.show(s[key]).catch(function () {});
    })
    .catch(function () {});
});

/* ============================ 下载事件（入口） ============================ */

/* 启动时先重算一次：浏览器重启后不会残留上次的旧角标 */
updateBadge();

chrome.downloads.onCreated.addListener(function () {
  debounceBadge();
});

chrome.downloads.onErased.addListener(function () {
  debounceBadge();
});

chrome.downloads.onChanged.addListener(function (delta) {
  /* 只在结构变化时重算角标，进度类事件直接忽略，不产生任何查询 */
  if (delta.state || delta.paused || delta.error) debounceBadge();

  if (delta.state && delta.state.current) {
    if (delta.state.current === 'complete') queueNotify('complete', delta.id);
    else if (delta.state.current === 'interrupted') queueNotify('interrupted', delta.id);
  }
});
