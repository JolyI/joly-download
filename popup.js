'use strict';

/* Joly 下载 · 弹出窗面板
 *
 * 设计约束（对应需求文档 §4 性能红线）：
 *   - 零依赖：不引入任何框架或第三方库
 *   - 零常驻开销：空闲时没有任何定时器；仅当存在进行中下载时，
 *     才启动一个 1s 的兜底刷新定时器（速度/进度的保底更新），
 *     全部结束后立即清除。事件驱动仍是主路径。
 *   - 增量渲染：keyed 复用行 DOM，进度变化只改那一行，绝不整表重渲染
 *   - 面板关闭 → 页面销毁 → 内存全部释放
 */

var BS = String.fromCharCode(92);   // 反斜杠（Windows 路径分隔符）
var DEFAULT_LIMIT = 200;

var listEl = document.getElementById('list');
var emptyEl = document.getElementById('empty');
var emptyTextEl = document.getElementById('empty-text');
var searchEl = document.getElementById('search');
var tabsEl = document.getElementById('tabs');
var clearBtn = document.getElementById('btn-clear');
var groupBtn = document.getElementById('btn-group');
var settingsBtn = document.getElementById('btn-settings');
var delFileEl = document.getElementById('delFile');
var toastEl = document.getElementById('toast');
var verEl = document.getElementById('ver');

/* 版本号只从 manifest 读，避免和 manifest 里写的不一致 */
verEl.textContent = 'v' + chrome.runtime.getManifest().version;

/* nodeById: 节点 key -> { el, refs, cache, item?, kind, samples? }
 * 行节点 key 为 'd<downloadId>'，分组头节点 key 为 'g:<groupKey>'。
 * 行被移除时同步删除节点，保证 DOM 与数据可被 GC 回收。 */
var nodeById = new Map();
var items = [];          // 已加载的下载项（唯一数据副本）

var filter = 'all';
var query = '';
var groupMode = 'date';  // date | type | none
var delFileMode = false; // 顶部开关：删除时是否连磁盘文件一起删
var limit = DEFAULT_LIMIT;

var refreshTimer = 0;
var searchTimer = 0;
var toastTimer = 0;
var ticker = 0;          // 仅在有进行中下载时非 0

/* ============================ 常量表 ============================ */

var TYPE_MAP = {
  image:   ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'tiff', 'ico'],
  video:   ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts'],
  audio:   ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'],
  doc:     ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf',
            'pages', 'numbers', 'key', 'epub'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'dmg', 'iso', 'pkg'],
  app:     ['exe', 'msi', 'app', 'apk', 'deb', 'rpm', 'sh', 'jar']
};

var TYPE_ICON = {
  image: 'i-image',
  video: 'i-video',
  audio: 'i-audio',
  doc: 'i-doc',
  archive: 'i-archive',
  app: 'i-app'
};

var TYPE_ORDER = ['image', 'video', 'audio', 'doc', 'archive', 'app', 'file'];
var TYPE_LABEL = {
  image: '图片', video: '视频', audio: '音频', doc: '文档',
  archive: '压缩包', app: '安装包', file: '其他'
};

/* 数据已收齐却迟迟不翻 complete 超过这个时长，就判定为「收尾卡住」 */
var STUCK_MS = 6000;

/* 每种状态下可见的操作按钮（按钮按需创建，避免每行常驻 8 个 DOM 节点） */
var PHASE_ACTIONS = {
  running:     ['pause', 'cancel', 'copy'],
  paused:      ['resume', 'cancel', 'copy'],
  complete:    ['show', 'open', 'copy', 'erase'],
  interrupted: ['show', 'retry', 'copy', 'erase'],
  danger:      ['keep', 'cancel', 'copy'],
  scan:        ['cancel', 'copy'],
  stuck:       ['keep', 'revive', 'cancel', 'copy']
};

var ACT_SPEC = {
  show:   ['i-folder', '打开所在文件夹'],
  open:   ['i-external', '打开文件'],
  pause:  ['i-pause', '暂停下载'],
  resume: ['i-play', '继续下载'],
  cancel: ['i-x', '取消下载'],
  retry:  ['i-refresh', '重新下载'],
  copy:   ['i-link', '复制下载链接'],
  erase:  ['i-trash', '删除记录'],
  keep:   ['i-shield', '仍然保留（解除 Chrome 的不安全拦截）'],
  revive: ['i-refresh', '救活（断开重连，逼它走完收尾）']
};

/* ============================ 工具函数 ============================ */

function basename(p) {
  if (!p) return '';
  var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf(BS));
  return i >= 0 ? p.slice(i + 1) : p;
}

function nameOf(it) {
  return basename(it.filename || '') || basename(it.url || '') || '';
}

function extOf(name) {
  var i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

function hostOf(url) {
  if (!url) return '';
  try {
    var h = new URL(url).hostname;
    return h.indexOf('www.') === 0 ? h.slice(4) : h;
  } catch (e) {
    return '';
  }
}

function fmtBytes(n) {
  if (!n || n <= 0) return '';
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? String(Math.round(n)) : n.toFixed(n < 10 ? 1 : 0)) + ' ' + units[i];
}

function fmtSpeed(bps) {
  if (!bps || bps < 1) return '';
  return fmtBytes(bps) + '/s';
}

function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0 || sec > 172800) return '';
  if (sec < 60) return '剩余 ' + Math.max(1, Math.round(sec)) + ' 秒';
  if (sec < 3600) {
    var m = Math.floor(sec / 60);
    var s = Math.round(sec - m * 60);
    return '剩余 ' + m + ' 分' + (s >= 10 ? ' ' + s + ' 秒' : '');
  }
  var h = Math.floor(sec / 3600);
  return '剩余 ' + h + ' 小时 ' + Math.floor((sec - h * 3600) / 60) + ' 分';
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

/* compact = true：日期已由分组头表达，只显示时刻，避免与分组头重复 */
function fmtTime(ts, compact) {
  if (!ts) return '';
  var now = Date.now();
  var diff = now - ts;
  if (diff < 0) return '';
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';

  var d = new Date(ts);
  var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (compact) return hm;
  if (d.toDateString() === new Date(now).toDateString()) return hm;
  if (d.toDateString() === new Date(now - 86400000).toDateString()) return '昨天 ' + hm;
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
}

function typeOf(name) {
  var e = extOf(name);
  for (var k in TYPE_MAP) {
    if (TYPE_MAP[k].indexOf(e) >= 0) return k;
  }
  return 'file';
}

/* 归一化状态：in_progress / paused / complete / interrupted */
function stateOf(it) {
  if (it.state === 'complete') return 'complete';
  if (it.state === 'interrupted') return 'interrupted';
  return it.paused ? 'paused' : 'in_progress';
}

/* Chrome 把「疑似不安全」的下载直接拦住，此时它是 state=in_progress + paused=true，
 * 只按状态判断会误显示成「已暂停」——真相是它在等用户点原生界面的「保留」。
 * danger: safe/accepted 为正常；scan 是深度安全扫描；其余均为「已拦截待确认」。 */
function dangerPhase(it) {
  var d = it.danger;
  if (!d || d === 'safe' || d === 'accepted') return '';
  return d === 'scan' ? 'scan' : 'danger';
}

function phaseOf(it) {
  var dp = dangerPhase(it);
  if (dp) return dp;
  var s = stateOf(it);
  if (s === 'complete') return 'complete';
  if (s === 'interrupted') return 'interrupted';
  return s === 'paused' ? 'paused' : 'running';
}

/* 数值安全：API 字段可能缺失或为 NaN，统一归零，杜绝界面出现 NaN */
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

/* 进度分母只认真实总大小；缺失时返回 0。
 * 绝不能拿「已下载字节 / 磁盘部分文件大小」当分母，否则会误显示 100%。 */
function totalOf(it) {
  return num(it.totalBytes) > 0 ? num(it.totalBytes) : 0;
}

/* 展示用大小：总大小 → 已下载 → 磁盘上的部分文件大小 */
function sizeOf(it) {
  return num(it.totalBytes) || num(it.receivedBytes) || num(it.fileSize);
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

/* ============================ 图标 ============================ */

var SVG_NS = 'http://www.w3.org/2000/svg';

function icon(symbolId, cls) {
  var svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls || 'ic');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  var use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#' + symbolId);
  svg.appendChild(use);
  return svg;
}

function mkActBtn(symbolId, title, act) {
  var b = document.createElement('button');
  b.type = 'button';
  b.dataset.act = act;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.appendChild(icon(symbolId));
  return b;
}

/* ============================ 行渲染 ============================ */

function createRow(it) {
  var el = document.createElement('article');
  el.className = 'row';
  el.dataset.key = 'd' + it.id;
  el.dataset.id = String(it.id);
  /* 可聚焦：键盘 Tab 进入该行时会触发 focusin，从而懒创建操作按钮 */
  el.tabIndex = 0;

  var icBox = document.createElement('div');
  icBox.className = 'ic-box';

  var main = document.createElement('div');
  main.className = 'main';

  /* 第一行：文件名（可截断）+ 状态（右侧固定，永不截断） */
  var line1 = document.createElement('div');
  line1.className = 'l1';
  var name = document.createElement('span');
  name.className = 'name';
  var st = document.createElement('span');
  st.className = 'st';
  line1.appendChild(name);
  line1.appendChild(st);

  /* 第二行：来源站点（可截断）+ 大小 / 时间（右侧固定） */
  var line2 = document.createElement('div');
  line2.className = 'l2';
  var src = document.createElement('span');
  src.className = 'src';
  var right = document.createElement('span');
  right.className = 'r';
  var size = document.createElement('span');
  size.className = 'size';
  var time = document.createElement('span');
  time.className = 'time';
  right.appendChild(size);
  right.appendChild(time);
  line2.appendChild(src);
  line2.appendChild(right);

  /* 第三行：进度条 + 百分比 + 速度 + 剩余时间（仅下载中/已暂停时出现） */
  var barRow = document.createElement('div');
  barRow.className = 'bar-row';
  barRow.hidden = true;
  var pctEl = document.createElement('span');
  pctEl.className = 'pct';
  var rate = document.createElement('span');
  rate.className = 'rate';
  var eta = document.createElement('span');
  eta.className = 'eta';
  barRow.appendChild(pctEl);
  barRow.appendChild(rate);
  barRow.appendChild(eta);

  main.appendChild(line1);
  main.appendChild(line2);
  main.appendChild(barRow);

  var acts = document.createElement('div');
  acts.className = 'acts';

  el.appendChild(icBox);
  el.appendChild(main);
  el.appendChild(acts);

  var row = {
    el: el,
    kind: 'row',
    item: it,
    refs: {
      icBox: icBox,
      name: name,
      src: src,
      size: size,
      st: st,
      rate: rate,
      eta: eta,
      time: time,
      barRow: barRow,
      pct: pctEl,
      acts: acts
    },
    samples: { bytes: 0, ts: 0, speed: 0 },
    /* 数据收齐的时刻；超过 STUCK_MS 仍无进展即判定为「收尾卡住」 */
    stuckAt: 0,
    cache: {}
  };
  nodeById.set('d' + it.id, row);
  return row;
}

function createGroup(entry) {
  var el = document.createElement('div');
  el.className = 'group';
  el.dataset.key = entry.key;

  var label = document.createElement('span');
  label.className = 'g-label';
  var count = document.createElement('span');
  count.className = 'g-count';

  el.appendChild(label);
  el.appendChild(count);

  var node = {
    el: el,
    kind: 'group',
    refs: { label: label, count: count },
    cache: {}
  };
  nodeById.set(entry.key, node);
  return node;
}

function updateGroup(node, entry) {
  if (node.cache.label !== entry.label) {
    node.refs.label.textContent = entry.label;
    node.cache.label = entry.label;
  }
  var c = String(entry.count);
  if (node.cache.count !== c) {
    node.refs.count.textContent = c;
    node.cache.count = c;
  }
}

/* 操作按钮【懒创建】：只有鼠标悬浮到该行时才真正建 DOM。
 * 200 行 × 3~4 个按钮（含 svg/use）≈ 上千个节点，首屏不建可显著减少打开卡顿。 */
function buildActions(row) {
  var phase = row.cache.phase || 'complete';
  var acts = PHASE_ACTIONS[phase];
  var frag = document.createDocumentFragment();
  for (var i = 0; i < acts.length; i++) {
    var name = acts[i];
    var spec = ACT_SPEC[name];
    /* 「删除含文件」开着时，垃圾桶换成带 × 的图标并说明会连文件一起删 */
    if (name === 'erase' && delFileMode) {
      spec = ['i-trash-x', '删除（含磁盘文件，不进废纸篓）'];
    }
    frag.appendChild(mkActBtn(spec[0], spec[1], name));
  }
  row.refs.acts.replaceChildren(frag);
  row.cache.actsBuilt = true;
  row.cache.canOpen = null;
  applyOpenState(row);
}

/* 文件缺失时禁用「打开文件」 */
function applyOpenState(row) {
  if (!row.cache.actsBuilt || !row.item) return;
  var canOpen = phaseOf(row.item) === 'complete' && row.item.exists !== false;
  if (row.cache.canOpen === canOpen) return;
  row.cache.canOpen = canOpen;
  var openBtn = row.refs.acts.querySelector('button[data-act="open"]');
  if (openBtn) {
    openBtn.disabled = !canOpen;
    openBtn.title = canOpen ? '打开文件' : '文件不可用';
  }
}

/* 状态切换：已建过按钮的行立即重建；没建过的留到悬浮时再建 */
function renderActions(row, phase) {
  if (row.cache.phase === phase) return;
  row.cache.phase = phase;
  if (row.cache.actsBuilt) buildActions(row);
}

/* 模式切换后刷新所有已建过按钮的行，让垃圾桶图标立刻变样 */
function refreshActions() {
  nodeById.forEach(function (node) {
    if (node.kind === 'row' && node.cache.actsBuilt) buildActions(node);
  });
}

function setDelFileMode(on) {
  delFileMode = !!on;
  delFileEl.checked = delFileMode;
  listEl.classList.toggle('del-file', delFileMode);
  refreshActions();
}

/* 只更新发生变化的字段，避免无谓的 DOM 写入与样式重算 */
/* 刚下载完 → 盖一次章。
 * 只在状态【从非完成变为完成】时触发：首次渲染已完成的旧记录不会满屏盖章。 */
function stampDone(row) {
  if (row.el.classList.contains('just-done')) return;
  row.el.classList.add('just-done');
  if (row.stampTimer) clearTimeout(row.stampTimer);
  row.stampTimer = setTimeout(function () {
    row.stampTimer = 0;
    row.el.classList.remove('just-done');
  }, 560);
}

function updateRow(row, it) {
  var r = row.refs;
  var c = row.cache;
  row.item = it;

  var name = nameOf(it) || '未命名';
  if (c.name !== name) {
    r.name.textContent = name;
    r.name.title = it.filename || it.url || '';
    c.name = name;
  }

  var type = typeOf(name);
  if (c.type !== type) {
    row.el.dataset.type = type;
    r.icBox.replaceChildren(icon(TYPE_ICON[type] || 'i-file'));
    c.type = type;
  }

  var phase = phaseOf(it);

  var host = hostOf(it.finalUrl || it.url || '');
  if (c.host !== host) {
    r.src.textContent = host;
    r.src.hidden = !host;
    c.host = host;
  }

  /* receivedBytes 缺失时退回磁盘上的部分文件大小，保证进度可读且永不出现 NaN */
  var received = num(it.receivedBytes) || num(it.fileSize);
  var total = totalOf(it);
  var active = phase === 'running' || phase === 'paused';

  /* 收尾卡住检测：数据已收齐（received >= total）但状态迟迟不翻 complete。
   * 典型成因是服务器没按规范结束响应流，Chrome 卡在收尾阶段等连接终止。 */
  var nowTs = Date.now();
  if (phase === 'running' && total > 0 && received >= total) {
    if (!row.stuckAt) row.stuckAt = nowTs;
  } else {
    row.stuckAt = 0;
  }
  var stuck = row.stuckAt > 0 && (nowTs - row.stuckAt) >= STUCK_MS;

  renderActions(row, stuck ? 'stuck' : phase);
  /* danger / scan / stuck 单独配色，不能混进普通的「下载中」「已暂停」 */
  var state = stuck ? 'stuck' : (dangerPhase(it) || stateOf(it));
  row.el.dataset.state = state;

  /* c.state 未定义 = 这行第一次渲染，此时不盖章，否则打开面板会满屏盖章 */
  if (state === 'complete' && c.state !== undefined && c.state !== 'complete') stampDone(row);
  c.state = state;

  /* ---- 状态文字：固定在第一行右侧，永不截断 ---- */
  var stText = phase === 'running' ? (stuck ? '收尾中…' : '下载中')
    : phase === 'paused' ? '已暂停'
      : phase === 'danger' ? '已拦截'
        : phase === 'scan' ? '安全检查中'
          : phase === 'complete' ? '已完成'
            : (it.error === 'USER_CANCELED' ? '已取消' : '失败');
  if (c.st !== stText) {
    r.st.textContent = stText;
    c.st = stText;
  }

  /* ---- 活跃下载：进度 + 速度 + 剩余时间 ---- */
  if (active) {
    /* 第二行右侧：大小 */
    var sizeText = total > 0
      ? fmtBytes(received) + ' / ' + fmtBytes(total)
      : fmtBytes(received);
    if (c.size !== sizeText) {
      r.size.textContent = sizeText;
      c.size = sizeText;
    }
    r.size.hidden = !sizeText;
    r.time.hidden = true;

    /* 第三行：进度条 / 百分比 / 速度 / 剩余时间 */
    if (c.active !== true) {
      r.barRow.hidden = false;
      c.active = true;
    }

    /* 速度采样（EMA 平滑；暂停则冻结） */
    if (phase === 'running') {
      var now = Date.now();
      if (row.samples.ts) {
        var dt = now - row.samples.ts;
        if (dt >= 400) {
          var inst = (received - row.samples.bytes) / (dt / 1000);
          if (isFinite(inst) && inst >= 0) {
            row.samples.speed = row.samples.speed > 0
              ? row.samples.speed * 0.65 + inst * 0.35
              : inst;
          }
          row.samples.bytes = received;
          row.samples.ts = now;
        }
      } else {
        row.samples.bytes = received;
        row.samples.ts = now;
      }
    }

    var pct = total > 0 ? Math.min(1, received / total) : 0;
    if (!isFinite(pct) || pct < 0) pct = 0;
    if (c.pct !== pct) {
      /* 不再画横条：让佛龛里的金箔从底部涌起，涌到的高度就是进度本身 */
      row.el.style.setProperty('--p', pct.toFixed(4));
      c.pct = pct;
    }

    var pctText = Math.round(pct * 100) + '%';
    if (c.pctText !== pctText) {
      r.pct.textContent = pctText;
      c.pctText = pctText;
    }

    var speedText = phase === 'running' ? fmtSpeed(row.samples.speed) : '';
    if (c.speed !== speedText) {
      r.rate.textContent = speedText;
      c.speed = speedText;
    }
    r.rate.hidden = !speedText;

    var etaText = '';
    if (phase === 'running' && total > 0 && row.samples.speed > 0) {
      etaText = fmtEta((total - received) / row.samples.speed);
    }
    if (c.eta !== etaText) {
      r.eta.textContent = etaText;
      c.eta = etaText;
    }
    r.eta.hidden = !etaText;
  } else {
    /* ---- 非活跃：收起进度行 ---- */
    if (c.active !== false) {
      r.barRow.hidden = true;
      c.active = false;
    }

    /* 已完成 → 金箔镀满整龛；失败/取消 → 空龛 */
    var gild = phase === 'complete' ? 1 : 0;
    if (c.gild !== gild) {
      row.el.style.setProperty('--p', gild);
      c.gild = gild;
    }

    var sizeDone = fmtBytes(sizeOf(it));
    if (c.size !== sizeDone) {
      r.size.textContent = sizeDone;
      c.size = sizeDone;
    }
    r.size.hidden = !sizeDone;

    /* 按日期分组时日期已由分组头表达，此处只留时刻，避免重复 */
    var timeText = fmtTime(it.endTime || it.startTime, groupMode === 'date');
    if (c.time !== timeText) {
      r.time.textContent = timeText;
      c.time = timeText;
    }
    r.time.hidden = !timeText;

    /* 文件缺失时禁用「打开文件」（按钮还没创建时由 applyOpenState 兜底） */
    applyOpenState(row);

    /* 离开活跃状态后清空速度采样，下次下载重新开始 */
    row.samples.bytes = 0;
    row.samples.ts = 0;
    row.samples.speed = 0;
  }
}

/* ============================ 视图构建与增量对齐 ============================ */

function matches(it) {
  var s = stateOf(it);
  if (filter === 'in_progress') {
    if (s !== 'in_progress' && s !== 'paused') return false;
  } else if (filter !== 'all' && s !== filter) {
    return false;
  }
  if (query) {
    var hay = (nameOf(it) + ' ' + hostOf(it.finalUrl || it.url || '')).toLowerCase();
    if (hay.indexOf(query) < 0) return false;
  }
  return true;
}

function dateGroupOf(it) {
  if (!it.startTime) return { key: 'unknown', label: '未知时间' };
  var d = new Date(it.startTime);
  var now = new Date();
  if (sameDay(d, now)) return { key: 'today', label: '今天' };
  if (sameDay(d, new Date(now.getTime() - 86400000))) return { key: 'yesterday', label: '昨天' };
  if (d.getFullYear() === now.getFullYear()) {
    return { key: 'd' + (d.getMonth() + 1) + '-' + d.getDate(),
             label: (d.getMonth() + 1) + '月' + d.getDate() + '日' };
  }
  return { key: 'y' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(),
           label: d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日' };
}

function rowEntry(it) {
  return { key: 'd' + it.id, kind: 'row', item: it };
}

function buildEntries() {
  var list = [];
  for (var i = 0; i < items.length; i++) {
    if (matches(items[i])) list.push(items[i]);
  }

  var entries = [];
  if (groupMode === 'none' || list.length === 0) {
    for (var j = 0; j < list.length; j++) entries.push(rowEntry(list[j]));
    return entries;
  }

  if (groupMode === 'date') {
    var curKey = null;
    var header = null;
    for (var k = 0; k < list.length; k++) {
      var it = list[k];
      var g = dateGroupOf(it);
      if (g.key !== curKey) {
        curKey = g.key;
        header = { key: 'g:' + g.key, kind: 'group', label: g.label, count: 0 };
        entries.push(header);
      }
      header.count++;
      entries.push(rowEntry(it));
    }
    return entries;
  }

  /* type 分组：按固定类型顺序分桶，桶内保持时间倒序 */
  var buckets = {};
  for (var m = 0; m < list.length; m++) {
    var t = typeOf(nameOf(list[m]));
    if (!buckets[t]) buckets[t] = [];
    buckets[t].push(list[m]);
  }
  for (var n = 0; n < TYPE_ORDER.length; n++) {
    var tt = TYPE_ORDER[n];
    var arr = buckets[tt];
    if (!arr || !arr.length) continue;
    entries.push({ key: 'g:t:' + tt, kind: 'group', label: TYPE_LABEL[tt], count: arr.length });
    for (var p = 0; p < arr.length; p++) entries.push(rowEntry(arr[p]));
  }
  return entries;
}

/* keyed 增量对齐：复用已有节点，只增删差异部分。
 * 前向对齐后，未被复用的节点必然聚在列表尾部，直接清尾并同步清理
 * nodeById，确保被移除节点的 DOM 与数据可被 GC 回收。 */
/* 主角卡选谁：列表里第一条"还在跑"的下载（进行中 / 已暂停 / 安全扫描）。
 * 被拦截的不算 —— 它在等用户在原生界面点「保留」，不是真的在下。 */
var heroKey = null;

function pickHero(entries) {
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].kind !== 'row') continue;
    var it = entries[i].item;
    var s = stateOf(it);
    if (s !== 'in_progress' && s !== 'paused') continue;
    if (dangerPhase(it) === 'danger') continue;
    return entries[i].key;
  }
  return null;
}

function renderView(entries) {
  var prevEl = null;

  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var node = nodeById.get(e.key);
    if (!node) {
      node = e.kind === 'group' ? createGroup(e) : createRow(e.item);
    }
    if (e.kind === 'group') {
      updateGroup(node, e);
    } else {
      updateRow(node, e.item);
      /* 主角卡就是这一行，只多一个 class —— 不新增 DOM，不新增更新路径 */
      var isHero = e.key === heroKey;
      if (node.cache.hero !== isHero) {
        node.el.classList.toggle('is-hero', isHero);
        node.cache.hero = isHero;
      }
    }

    var el = node.el;
    var anchor = prevEl ? prevEl.nextSibling : listEl.firstChild;
    if (el !== anchor) listEl.insertBefore(el, anchor);
    prevEl = el;
  }

  var child;
  while ((child = listEl.lastChild) && child !== prevEl) {
    child.remove();
    nodeById.delete(child.dataset.key);
  }
}

/* 首屏只渲染前 FIRST_PAINT 条，剩余部分在浏览器空闲时增量补齐。
 * 目的：弹出窗一打开就先出内容，避免一次性创建数千节点造成 0.x 秒卡顿。 */
var FIRST_PAINT = 60;
var idleHandle = 0;

function cancelRest() {
  if (!idleHandle) return;
  if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idleHandle);
  else clearTimeout(idleHandle);
  idleHandle = 0;
}

function scheduleIdle(fn) {
  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(fn, { timeout: 200 });
  }
  return setTimeout(fn, 16);
}

function render() {
  var entries = buildEntries();
  heroKey = pickHero(entries);
  cancelRest();

  var matched = 0;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].kind === 'row') matched++;
  }

  /* 第一片：立刻渲染 */
  renderView(entries.slice(0, FIRST_PAINT));

  emptyEl.hidden = matched > 0;
  if (matched === 0) {
    emptyTextEl.textContent = items.length === 0 ? '还没有下载记录' : '没有匹配的下载';
  }

  /* 其余分片：空闲时补齐（keyed 复用，不会重建已有行） */
  if (entries.length > FIRST_PAINT) {
    var from = FIRST_PAINT;
    var step = function () {
      from = Math.min(from + 120, entries.length);
      renderView(entries.slice(0, from));
      idleHandle = from < entries.length ? scheduleIdle(step) : 0;
    };
    idleHandle = scheduleIdle(step);
  }

  syncTicker();
}

/* ============================ 数据加载 ============================ */

function refresh() {
  chrome.downloads
    .search({ limit: limit, orderBy: ['-startTime'] })
    .then(function (list) {
      items = list || [];
      render();
    })
    .catch(function (err) {
      toast('读取下载列表失败：' + (err && err.message ? err.message : err));
    });
}

/* 一次性防抖定时器（不是常驻定时器，触发后立即释放） */
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(function () {
    refreshTimer = 0;
    refresh();
  }, 250);
}

/* ============================ 活跃任务兜底定时器 ============================ */

function hasActive() {
  var now = Date.now();
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    /* 被 Chrome 拦截、等人确认的下载不会自己变化，不需要轮询（红线：空闲零定时器） */
    if (dangerPhase(it)) continue;
    if (stateOf(it) !== 'in_progress') continue;
    /* 已判定为「收尾卡住」的同样停表；真完成了会有 onChanged 事件把它翻新 */
    var row = nodeById.get('d' + it.id);
    if (row && row.stuckAt && now - row.stuckAt >= STUCK_MS) continue;
    return true;
  }
  return false;
}

/* 只在存在进行中下载时才运行 1s 定时器；全部结束后立即清除（红线：空闲零定时器） */
function syncTicker() {
  if (hasActive()) {
    if (!ticker) ticker = setInterval(tick, 1000);
  } else if (ticker) {
    clearInterval(ticker);
    ticker = 0;
  }
}

function tick() {
  chrome.downloads
    .search({ state: 'in_progress', limit: 50, orderBy: ['-startTime'] })
    .then(function (list) {
      if (!list || !list.length) {
        clearInterval(ticker);
        ticker = 0;
        scheduleRefresh();
        return;
      }
      for (var i = 0; i < list.length; i++) {
        var fresh = list[i];
        var row = nodeById.get('d' + fresh.id);
        if (!row) { scheduleRefresh(); continue; }
        /* 就地合并字段，避免常驻新对象（瞬态结果由 GC 回收） */
        mergeItem(row.item, fresh);
        updateRow(row, row.item);
      }
      /* 若所有活跃项都已转入「收尾卡住」，这里顺手把 1s 定时器停掉 */
      syncTicker();
    })
    .catch(function () {
      clearInterval(ticker);
      ticker = 0;
    });
}

/* 把 fresh 的字段就地合并进 it，不产生新的常驻对象 */
function mergeItem(it, fresh) {
  if (fresh.filename !== undefined) it.filename = fresh.filename;
  if (fresh.url !== undefined) it.url = fresh.url;
  if (fresh.finalUrl !== undefined) it.finalUrl = fresh.finalUrl;
  if (fresh.totalBytes !== undefined) it.totalBytes = fresh.totalBytes;
  if (fresh.fileSize !== undefined) it.fileSize = fresh.fileSize;
  if (fresh.receivedBytes !== undefined) it.receivedBytes = fresh.receivedBytes;
  if (fresh.state !== undefined) it.state = fresh.state;
  if (fresh.paused !== undefined) it.paused = fresh.paused;
  if (fresh.error !== undefined) it.error = fresh.error;
  if (fresh.exists !== undefined) it.exists = fresh.exists;
  if (fresh.danger !== undefined) it.danger = fresh.danger;
  if (fresh.startTime !== undefined) it.startTime = fresh.startTime;
  if (fresh.endTime !== undefined) it.endTime = fresh.endTime;
}

/* ============================ 操作 ============================ */

function toast(msg, danger) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  toastEl.classList.toggle('is-danger', !!danger);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    toastTimer = 0;
    toastEl.hidden = true;
  }, danger ? 4200 : 2600);
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      toast('已复制下载链接');
    }).catch(function () {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast('已复制下载链接');
  } catch (e) {
    toast('复制失败');
  }
  ta.remove();
}

function runAction(act, id) {
  try {
    var row = nodeById.get('d' + id);
    var it = row ? row.item : null;
    var p;

    if (act === 'keep') {
      /* 等价于 Chrome 原生下载气泡里的「保留」：解除拦截，再把它推完。
       * 只有 Chrome 确实把下载标记为危险（danger 非 safe）时才可能成功；
       * 若只是收尾卡住，acceptDanger 会被拒绝，请改用「救活」。 */
      chrome.downloads.acceptDanger(id)
        .then(function () {
          return chrome.downloads.resume(id).catch(function () { /* 已不在暂停态就忽略 */ });
        })
        .catch(function (err) {
          toast('「保留」失败：Chrome 没把这条标记为危险下载（' +
            (err && err.message ? err.message : err) + '）');
        });
      return;
    }
    else if (act === 'revive') {
      /* 收尾卡住时客户端唯一能做的手段：断开重连（暂停 → 继续），逼它重新走完收尾。
       * 注意：若服务器不支持 Range，会从 0 重新下载。 */
      p = chrome.downloads.pause(id)
        .then(function () {
          return new Promise(function (res) { setTimeout(res, 300); });
        })
        .then(function () { return chrome.downloads.resume(id); });
    }
    else if (act === 'show') p = chrome.downloads.show(id);
    else if (act === 'open') p = chrome.downloads.open(id);
    else if (act === 'pause') p = chrome.downloads.pause(id);
    else if (act === 'resume') p = chrome.downloads.resume(id);
    else if (act === 'cancel') p = chrome.downloads.cancel(id);
    else if (act === 'erase') {
      /* 是否连磁盘文件一起删，完全由顶部「删除含文件」开关决定 */
      if (delFileMode) {
        var label = it ? (nameOf(it) || '文件') : '文件';
        var fileGone = false;
        p = chrome.downloads
          .removeFile(id)
          .then(function () { fileGone = true; },
                function () { /* 文件已不存在或不允许删：忽略，记录仍要删掉 */ })
          .then(function () { return chrome.downloads.erase({ id: id }); })
          .then(function () {
            toast(fileGone ? '已删除「' + label + '」及磁盘文件'
                           : '已删除记录（磁盘文件未删除或已不存在）', fileGone);
          });
      } else {
        p = chrome.downloads.erase({ id: id });
      }
    }
    else if (act === 'retry') {
      if (!it || !it.url) { toast('缺少下载链接，无法重新下载'); return; }
      p = chrome.downloads.download({ url: it.url, conflictAction: 'uniquify' });
    } else if (act === 'copy') {
      if (!it || !it.url) { toast('缺少下载链接'); return; }
      copyText(it.url);
      return;
    }

    if (p && typeof p.catch === 'function') {
      p.catch(function (err) {
        toast('操作失败：' + (err && err.message ? err.message : err));
      });
    }
  } catch (err) {
    toast('操作失败：' + (err && err.message ? err.message : err));
  }
}

/* 事件委托：整个列表只挂一个 click 监听 */
listEl.addEventListener('click', function (e) {
  var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
  if (!btn) return;
  var rowEl = btn.closest('.row');
  if (!rowEl) return;
  runAction(btn.dataset.act, Number(rowEl.dataset.id));
});

/* 悬浮/聚焦到某行时才创建该行的操作按钮（懒加载，见 buildActions） */
function ensureActionsFor(e) {
  var rowEl = e.target.closest ? e.target.closest('.row') : null;
  if (!rowEl) return;
  var row = nodeById.get(rowEl.dataset.key);
  if (row && row.kind === 'row' && !row.cache.actsBuilt) buildActions(row);
}
listEl.addEventListener('mouseover', ensureActionsFor);
listEl.addEventListener('focusin', ensureActionsFor);

tabsEl.addEventListener('click', function (e) {
  var btn = e.target.closest ? e.target.closest('button[data-filter]') : null;
  if (!btn) return;
  filter = btn.dataset.filter;
  var all = tabsEl.querySelectorAll('.tab');
  for (var i = 0; i < all.length; i++) {
    all[i].classList.toggle('is-active', all[i] === btn);
  }
  render();
});

searchEl.addEventListener('input', function () {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(function () {
    searchTimer = 0;
    query = searchEl.value.trim().toLowerCase();
    render();
  }, 120);
});

delFileEl.addEventListener('change', function () {
  setDelFileMode(delFileEl.checked);
  chrome.storage.local.set({ delFile: delFileMode }).catch(function () {});
});

clearBtn.addEventListener('click', function () {
  chrome.downloads
    .erase({ state: 'complete' })
    .then(function (ids) {
      if (ids && ids.length) toast('已清空 ' + ids.length + ' 条记录');
      refresh();
    })
    .catch(function (err) {
      toast('清空失败：' + (err && err.message ? err.message : err));
    });
});

groupBtn.addEventListener('click', function () {
  groupMode = groupMode === 'date' ? 'type' : groupMode === 'type' ? 'none' : 'date';
  updateGroupBtn();
  render();
  chrome.storage.local.set({ groupMode: groupMode }).catch(function () {});
});

settingsBtn.addEventListener('click', function () {
  chrome.runtime.openOptionsPage();
});

function updateGroupBtn() {
  groupBtn.textContent = groupMode === 'date' ? '按日期'
    : groupMode === 'type' ? '按类型' : '不分组';
}

/* ============================ 事件驱动的实时更新 ============================ */

chrome.downloads.onCreated.addListener(function () {
  scheduleRefresh();
});

chrome.downloads.onErased.addListener(function (id) {
  var row = nodeById.get('d' + id);
  if (row) {
    row.el.remove();
    nodeById.delete('d' + id);
  }
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === id) { items.splice(i, 1); break; }
  }
  if (items.length === 0) {
    emptyEl.hidden = false;
    emptyTextEl.textContent = '还没有下载记录';
  }
  /* 分组头计数需要重新收敛，用防抖刷新避免批量删除时反复重排 */
  scheduleRefresh();
});

/* 进度更新只改一行 DOM；结构变化（新建/结束/失败）才触发一次防抖刷新 */
chrome.downloads.onChanged.addListener(function (delta) {
  var row = nodeById.get('d' + delta.id);
  if (!row) { scheduleRefresh(); return; }

  var it = row.item;
  if (delta.filename) it.filename = delta.filename.current;
  if (delta.url) it.url = delta.url.current;
  if (delta.finalUrl) it.finalUrl = delta.finalUrl.current;
  if (delta.totalBytes) it.totalBytes = delta.totalBytes.current;
  if (delta.fileSize) it.fileSize = delta.fileSize.current;
  if (delta.receivedBytes) it.receivedBytes = delta.receivedBytes.current;
  if (delta.state) it.state = delta.state.current;
  if (delta.paused) it.paused = delta.paused.current;
  if (delta.error) it.error = delta.error.current;
  if (delta.exists) it.exists = delta.exists.current;

  updateRow(row, it);
  syncTicker();

  if (delta.state || delta.error || delta.filename) scheduleRefresh();
});

/* 面板重新可见时校正一次数据（一次性，不常驻） */
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) refresh();
});

/* 设置变更（来自设置页或其他面板实例）即时生效 */
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  var needRender = false;
  if (changes.groupMode) {
    groupMode = changes.groupMode.newValue;
    updateGroupBtn();
    needRender = true;
  }
  if (changes.listLimit) {
    limit = changes.listLimit.newValue || DEFAULT_LIMIT;
    needRender = true;
  }
  if (needRender) render();
  if (changes.listLimit) refresh();
});

/* 面板关闭/页面销毁前清掉所有定时器 */
window.addEventListener('pagehide', function () {
  cancelRest();
  if (ticker) { clearInterval(ticker); ticker = 0; }
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = 0; }
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = 0; }
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = 0; }
});

/* ============================ 启动 ============================ */

/* 启动：数据查询是关键路径，立刻发起，不等设置读取（两者并行）。
 * 设置通常就是默认值，所以常见情况下一次 IPC 往返即可出内容。 */
updateGroupBtn();
refresh();

chrome.storage.local
  .get({ groupMode: 'date', listLimit: DEFAULT_LIMIT, delFile: false })
  .then(function (s) {
    var gm = s.groupMode || 'date';
    var lim = s.listLimit || DEFAULT_LIMIT;
    setDelFileMode(!!s.delFile);
    if (gm !== groupMode) {
      groupMode = gm;
      updateGroupBtn();
      render();
    }
    if (lim !== limit) {
      limit = lim;
      refresh();
    }
  })
  .catch(function () { /* 读取失败则沿用默认值 */ });
