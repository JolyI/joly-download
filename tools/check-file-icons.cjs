'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
var renderEnd = source.indexOf('/* ============================ 视图构建与增量对齐');
assert.ok(renderEnd > 0, '应能定位行渲染代码的结束位置');

function svgNode() {
  return {
    attributes: {},
    children: [],
    setAttribute: function (key, value) { this.attributes[key] = value; },
    appendChild: function (child) { this.children.push(child); }
  };
}

/* 直接执行生产映射及行渲染；截在视图构建前，避免启动下载查询和浏览器监听。 */
var context = vm.createContext({
  document: {
    getElementById: function () { return {}; },
    createElementNS: function () { return svgNode(); }
  },
  chrome: { runtime: { getManifest: function () { return { version: 'test' }; } } },
  URL: URL
});
vm.runInContext(source.slice(0, renderEnd), context, { filename: 'popup.js' });

var examples = [
  ['合同.pdf', 'pdf'],
  ['报告.doc', 'word'], ['报告.docx', 'word'], ['草稿.pages', 'word'], ['文档.rtf', 'word'],
  ['财务.xls', 'sheet'], ['财务.xlsx', 'sheet'], ['流水.csv', 'sheet'], ['预算.numbers', 'sheet'],
  ['演示.ppt', 'slide'], ['演示.pptx', 'slide'], ['发布会.key', 'slide'],
  ['说明.txt', 'text'], ['运行.log', 'text'],
  ['说明.md', 'markdown'], ['文档.markdown', 'markdown'], ['组件.mdx', 'markdown'],
  ['main.js', 'code'], ['component.tsx', 'code'], ['script.py', 'code'],
  ['package.json', 'code'], ['settings.yaml', 'code'], ['config.toml', 'code'], ['install.sh', 'code'],
  ['照片.jpg', 'image'], ['截屏.png', 'image'], ['照片.heic', 'image'], ['图标.ico', 'image'],
  ['标志.svg', 'vector'], ['标志.svgz', 'vector'], ['插画.eps', 'vector'],
  ['视频.mp4', 'video'], ['录屏.mov', 'video'], ['影片.mkv', 'video'], ['录像.ts', 'video'],
  ['音乐.mp3', 'audio'], ['音乐.flac', 'audio'], ['播客.m4a', 'audio'],
  ['备份.zip', 'archive'], ['备份.rar', 'archive'], ['备份.7z', 'archive'], ['source.tar.gz', 'archive'],
  ['系统.dmg', 'disk'], ['系统.iso', 'disk'], ['镜像.img', 'disk'],
  ['安装.exe', 'app'], ['安装.msi', 'app'], ['安装.pkg', 'app'], ['应用.apk', 'app'], ['服务.jar', 'app'],
  ['字体.ttf', 'font'], ['字体.otf', 'font'], ['字体.woff2', 'font'],
  ['作品.psd', 'design'], ['标志.ai', 'design'], ['稿件.sketch', 'design'],
  ['设计.fig', 'design'], ['界面.xd', 'design'],
  ['书籍.epub', 'ebook'], ['书籍.mobi', 'ebook'], ['书籍.azw', 'ebook'], ['书籍.azw3', 'ebook']
];
examples.forEach(function (example) {
  assert.equal(context.fileIconOf(example[0]), example[1], example[0]);
  assert.equal(context.fileIconOf(example[0].toUpperCase()), example[1], '大写：' + example[0]);
});
['', 'README', '.gitignore', '未命名', 'report.', 'data.unrecognized'].forEach(function (name) {
  assert.equal(context.fileIconOf(name), 'file', '通用回退：' + name);
});

/* 改图标不能改变既有分类，尤其磁盘镜像和安装包仍遵循原分组。 */
var groups = [
  ['photo.png', 'image'], ['logo.svg', 'image'], ['movie.mp4', 'video'], ['main.ts', 'video'],
  ['song.mp3', 'audio'], ['book.epub', 'doc'], ['report.pdf', 'doc'], ['table.xlsx', 'doc'],
  ['slide.key', 'doc'], ['app.dmg', 'archive'], ['disk.iso', 'archive'], ['install.pkg', 'archive'],
  ['app.exe', 'app'], ['install.sh', 'app'], ['font.ttf', 'file'], ['design.psd', 'file'], ['README', 'file']
];
groups.forEach(function (example) {
  assert.equal(context.typeOf(example[0]), example[1], '分组：' + example[0]);
});
assert.deepEqual(Array.from(context.TYPE_ORDER), ['image', 'video', 'audio', 'doc', 'archive', 'app', 'file']);
assert.deepEqual(JSON.parse(JSON.stringify(context.TYPE_LABEL)), {
  image: '图片', video: '视频', audio: '音频', doc: '文档', archive: '压缩包', app: '安装包', file: '其他'
});

var refs = {};
['name', 'src', 'size', 'st', 'rate', 'eta', 'time', 'barRow', 'pct', 'acts'].forEach(function (key) {
  refs[key] = {};
});
refs.icBox = {
  replacements: 0,
  replaceChildren: function (child) { this.child = child; this.replacements++; }
};
var row = {
  el: { dataset: {}, style: { setProperty: function () {} } },
  refs: refs,
  cache: {},
  samples: { bytes: 0, ts: 0, speed: 0 },
  stuckAt: 0
};
var item = {
  id: 1, filename: '/Downloads/预算.xlsx', state: 'in_progress', danger: 'safe',
  receivedBytes: 10, totalBytes: 100, url: 'https://example.com/download'
};
context.updateRow(row, item);
assert.equal(row.el.dataset.type, 'doc');
assert.equal(row.el.dataset.fileIcon, 'sheet');
assert.equal(refs.icBox.child.attributes.class, 'ic file-icon');
assert.equal(refs.icBox.child.attributes.viewBox, '0 0 24 24');
assert.equal(refs.icBox.child.attributes['aria-hidden'], 'true');
assert.equal(refs.icBox.child.children[0].attributes.href, '#i-file-sheet');

var firstIcon = refs.icBox.child;
item.receivedBytes = 40;
context.updateRow(row, item);
assert.equal(refs.icBox.child, firstIcon, '进度更新应复用图标节点');
assert.equal(refs.icBox.replacements, 1);

item.filename = '/Downloads/预算.pdf';
context.updateRow(row, item);
assert.equal(row.el.dataset.type, 'doc', '同组改名不应影响分组');
assert.equal(row.el.dataset.fileIcon, 'pdf');
assert.equal(refs.icBox.child.children[0].attributes.href, '#i-file-pdf');
assert.equal(refs.icBox.replacements, 2, '同属文档的表格变 PDF 应更新图标');

item.filename = '/Downloads/预算（修改版）.PDF';
context.updateRow(row, item);
assert.equal(refs.icBox.replacements, 2, '同种图标的改名应复用节点');

item.filename = '/Downloads/install.sh';
context.updateRow(row, item);
assert.equal(row.el.dataset.type, 'app');
assert.equal(row.el.dataset.fileIcon, 'code');
var codeIcon = refs.icBox.child;
item.filename = '/Downloads/package.json';
context.updateRow(row, item);
assert.equal(row.el.dataset.type, 'file');
assert.equal(row.el.dataset.fileIcon, 'code');
assert.equal(refs.icBox.child, codeIcon, '分组变化而图标不变时应复用节点');

item.filename = '/Downloads/data.unrecognized';
context.updateRow(row, item);
assert.equal(row.el.dataset.fileIcon, 'file');
assert.equal(refs.icBox.child.children[0].attributes.href, '#i-file-file');

console.log('文件图标检查通过：18 类图标、大小写与通用回退、原分组兼容、同组改名和进度节点复用。');
