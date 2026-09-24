'use strict';

/* 仅供 preview-live.html 使用：所有下载与设置数据都保存在当前 iframe 的内存中。 */
(function () {
  if (!window.frameElement || window.frameElement.id !== 'popup-preview') {
    throw new Error('下载模拟器只能在本地交互预览中运行。');
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function event() {
    var listeners = [];
    return {
      addListener: function (listener) { listeners.push(listener); },
      removeListener: function (listener) {
        listeners = listeners.filter(function (item) { return item !== listener; });
      },
      emit: function () {
        var args = arguments;
        listeners.slice().forEach(function (listener) { listener.apply(null, args); });
      }
    };
  }

  var created = event();
  var changed = event();
  var erased = event();
  var storageChanged = event();
  var settings = {};
  var nextId = 7;

  function seed() {
    var now = Date.now();
    var mb = 1024 * 1024;
    var definitions = [
      ['蘑菇王国冒险-完整版.mp4', 'cdn.example.com', 1200 * mb, .45, 'in_progress', false, 'safe'],
      ['店铺运营数据-2026年9月.xlsx', 'files.example.com', 15284, 1, 'complete', false, 'safe'],
      ['蘑菇王国-场景素材.png', 'assets.example.com', 3.2 * mb, 1, 'complete', false, 'safe'],
      ['world-1-素材合集.zip', 'github.example.com', 240 * mb, .72, 'in_progress', true, 'safe'],
      ['unknown-setup.dmg', 'download.example.com', 88 * mb, 1, 'in_progress', true, 'uncommon'],
      ['关卡设计说明.pdf', 'docs.example.com', 4.8 * mb, .18, 'interrupted', false, 'safe']
    ];
    return definitions.map(function (entry, index) {
      var start = new Date(now - (index + 1) * 3600000).toISOString();
      var item = {
        id: index + 1,
        filename: '/preview/Downloads/' + entry[0],
        url: 'https://' + entry[1] + '/' + encodeURIComponent(entry[0]),
        totalBytes: Math.round(entry[2]),
        receivedBytes: Math.round(entry[2] * entry[3]),
        fileSize: Math.round(entry[2]),
        state: entry[4],
        paused: entry[5],
        danger: entry[6],
        exists: entry[4] === 'complete',
        startTime: start,
        canResume: true
      };
      if (item.state === 'complete') item.endTime = start;
      if (item.state === 'interrupted') item.error = 'NETWORK_FAILED';
      return item;
    });
  }

  var downloads = seed();

  function notify(message) {
    parent.postMessage({ type: 'joly-preview-status', message: message }, parent.location.origin);
  }

  function find(id) {
    var item = downloads.find(function (entry) { return entry.id === id; });
    if (!item) throw new Error('模拟下载记录不存在');
    return item;
  }

  function matches(item, query) {
    return (query.id === undefined || item.id === query.id) &&
      (query.state === undefined || item.state === query.state);
  }

  function update(id, values) {
    var item = find(id);
    var delta = { id: id };
    Object.keys(values).forEach(function (key) {
      if (item[key] === values[key]) return;
      delta[key] = { previous: item[key], current: values[key] };
      item[key] = values[key];
    });
    changed.emit(clone(delta));
    return Promise.resolve();
  }

  function erase(query) {
    var ids = downloads.filter(function (item) { return matches(item, query); })
      .map(function (item) { return item.id; });
    downloads = downloads.filter(function (item) { return ids.indexOf(item.id) === -1; });
    ids.forEach(function (id) { erased.emit(id); });
    return Promise.resolve(ids);
  }

  function active() {
    return downloads.find(function (item) {
      return item.state === 'in_progress' && !item.paused &&
        (item.danger === 'safe' || item.danger === 'accepted');
    });
  }

  function finish(item) {
    update(item.id, {
      receivedBytes: item.totalBytes,
      state: 'complete',
      paused: false,
      exists: true,
      endTime: new Date().toISOString()
    });
    notify('模拟下载已完成：' + item.filename.split('/').pop());
  }

  Object.defineProperty(window, 'chrome', { configurable: true, value: {
    runtime: {
      getManifest: function () { return { version: window.__previewVersion || '1.5.0' }; },
      openOptionsPage: function () {
        notify('预览：已拦截打开扩展设置操作，不会打开真实扩展。');
        return Promise.resolve();
      }
    },
    downloads: {
      onCreated: created,
      onChanged: changed,
      onErased: erased,
      search: function (query) {
        var results = downloads.filter(function (item) { return matches(item, query); });
        results.sort(function (a, b) { return b.startTime.localeCompare(a.startTime); });
        return Promise.resolve(clone(results.slice(0, query.limit || results.length)));
      },
      pause: function (id) { return update(id, { paused: true }); },
      resume: function (id) { return update(id, { paused: false }); },
      cancel: function (id) {
        return update(id, { state: 'interrupted', paused: false, error: 'USER_CANCELED', danger: 'safe' });
      },
      acceptDanger: function (id) { return update(id, { danger: 'accepted' }); },
      show: function () {
        notify('预览：打开文件夹操作已模拟，不会访问磁盘。');
        return Promise.resolve();
      },
      open: function () {
        notify('预览：打开文件操作已模拟，不会执行真实文件。');
        return Promise.resolve();
      },
      removeFile: function (id) {
        notify('预览：只更改模拟文件状态，不会删除真实文件。');
        return update(id, { exists: false });
      },
      erase: erase,
      download: function (options) {
        var source = downloads.find(function (item) { return item.url === options.url; });
        if (!source) return Promise.reject(new Error('预览只能重试现有模拟下载'));
        var item = Object.assign({}, source, {
          id: nextId++, receivedBytes: 0, state: 'in_progress', paused: false,
          danger: 'safe', exists: false, startTime: new Date().toISOString()
        });
        delete item.error;
        delete item.endTime;
        downloads.unshift(item);
        created.emit(clone(item));
        notify('预览：已创建模拟下载，没有发送网络请求。');
        return Promise.resolve(item.id);
      }
    },
    storage: {
      onChanged: storageChanged,
      local: {
        get: function (defaults) { return Promise.resolve(Object.assign({}, defaults, settings)); },
        set: function (values) {
          var changes = {};
          Object.keys(values).forEach(function (key) {
            changes[key] = { oldValue: settings[key], newValue: values[key] };
            settings[key] = values[key];
          });
          storageChanged.emit(changes, 'local');
          return Promise.resolve();
        }
      }
    }
  } });

  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: function () {
      notify('预览：已模拟复制链接，系统剪贴板保持不变。');
      return Promise.resolve();
    }
  } });

  window.previewDownloads = {
    advance: function () {
      var item = active();
      if (!item) { notify('没有正在进行的模拟下载，可继续暂停项或重置演示。'); return; }
      var received = Math.min(item.totalBytes, item.receivedBytes + Math.round(item.totalBytes * .1));
      if (received === item.totalBytes) { finish(item); return; }
      update(item.id, { receivedBytes: received });
      notify('模拟进度已推进至 ' + Math.round(received / item.totalBytes * 100) + '%。');
    },
    complete: function () {
      var item = active();
      if (item) finish(item);
      else notify('没有正在进行的模拟下载，可继续暂停项或重置演示。');
    },
    clear: function () {
      erase({});
      notify('已清空全部模拟记录，可验证空状态。');
    },
    reset: function () {
      erase({});
      downloads = seed();
      nextId = 7;
      downloads.forEach(function (item) { created.emit(clone(item)); });
      notify('已恢复 6 条模拟下载，进度只会随手动操作变化。');
    }
  };
})();
