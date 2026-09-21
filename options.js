'use strict';

/* Joly 下载 · 设置页
 * 只读写少量设置项（几百字节），不镜像任何下载历史。 */

var DEFAULTS = {
  groupMode: 'date',
  listLimit: 200,
  notifyOnComplete: true,
  notifyOnFail: true
};

var elGroupMode = document.getElementById('groupMode');
var elListLimit = document.getElementById('listLimit');
var elNotifyComplete = document.getElementById('notifyOnComplete');
var elNotifyFail = document.getElementById('notifyOnFail');
var elHint = document.getElementById('hint');
var elVer = document.getElementById('ver');

/* 版本号只从 manifest 读，避免和 manifest 里写的不一致 */
elVer.textContent = 'v' + chrome.runtime.getManifest().version;

var hintTimer = 0;

function hint(msg) {
  elHint.textContent = msg;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(function () {
    hintTimer = 0;
    elHint.textContent = '';
  }, 1800);
}

function load() {
  chrome.storage.local.get(DEFAULTS).then(function (s) {
    elGroupMode.value = s.groupMode;
    elListLimit.value = String(s.listLimit);
    elNotifyComplete.checked = !!s.notifyOnComplete;
    elNotifyFail.checked = !!s.notifyOnFail;
  }).catch(function (err) {
    elHint.textContent = '读取设置失败：' + (err && err.message ? err.message : err);
  });
}

function save(patch) {
  chrome.storage.local.set(patch).then(function () {
    hint('已保存');
  }).catch(function (err) {
    hint('保存失败：' + (err && err.message ? err.message : err));
  });
}

elGroupMode.addEventListener('change', function () {
  save({ groupMode: elGroupMode.value });
});

elListLimit.addEventListener('change', function () {
  save({ listLimit: parseInt(elListLimit.value, 10) || 200 });
});

elNotifyComplete.addEventListener('change', function () {
  save({ notifyOnComplete: elNotifyComplete.checked });
});

elNotifyFail.addEventListener('change', function () {
  save({ notifyOnFail: elNotifyFail.checked });
});

load();
