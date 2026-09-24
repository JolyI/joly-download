# Joly 下载 v1.5.0 · 超级玛丽主题

本版将下载面板重新设计成像素关卡：从天空与管道场景、角色进度，到文件道具格和操作按钮，
面板与设置页使用同一套超级玛丽主题。下载管理功能、权限和设置规则沿用现有实现，无新增运行时依赖。

## 更新内容

- 顶部加入天空、云朵、山丘、管道和砖块；面板跟随系统切换浅色与夜间配色。
- 四个状态筛选显示已加载记录中的数量，搜索时保留整体计数；「删除含文件」和「清空记录」集中在底部。
- 第一条进行中、已暂停或安全扫描的任务作为「当前关卡」展示，操作按钮直接可见；
  像素角色随真实进度向终点旗帜移动，其余条目保留进度条和按需显示的操作。
- 下载刚完成时弹出一次金币，历史记录不会重复播放；空状态改为问号砖块和角色，区分无记录与无匹配结果。
- 18 类文件图标统一为金色道具格：XLSX 等表格使用绿色「X＋表格」，SVG 等矢量文件使用像素节点。
- 文件夹、打开、暂停、继续、取消、重试、复制链接、删除等操作重画为实心像素图标。
- 扩展图标改为红帽与金色 J 字母，设置页同步为像素场景与分区控制面板，保留即时保存和窄窗口适配。
- 保留键盘焦点与减少动态效果支持；新增加载正式面板的交互预览和模拟下载控制。

<p align="center">
  <img src="https://raw.githubusercontent.com/JolyI/joly-download/v1.5.0/docs/mario-panel.png" alt="浅色下载面板" width="380">
  <img src="https://raw.githubusercontent.com/JolyI/joly-download/v1.5.0/docs/mario-panel-dark.png" alt="深色下载面板" width="380">
</p>

![18 类像素文件图标](https://raw.githubusercontent.com/JolyI/joly-download/v1.5.0/docs/file-icons.png)

## 安装与升级

需要 **Chrome 116 或更高版本**。

1. 下载本 Release 的 [`joly-download-v1.5.0.zip`](https://github.com/JolyI/joly-download/releases/download/v1.5.0/joly-download-v1.5.0.zip)，解压到准备长期保留的目录。
2. 打开 `chrome://extensions`，开启「开发者模式」。
3. 点「加载已解压的扩展程序」，选择包含 `manifest.json` 的目录。

从旧版升级时，将新版本文件覆盖到原加载目录，再点击扩展卡片上的「重新加载」。
保持加载路径不变可沿用原扩展 ID 与设置；面板与设置页显示 `v1.5.0`。

底部「删除含文件」开关默认关闭，也会保留你之前的选择：关闭时只移除记录，开启时连磁盘文件一起删除，
不进废纸篓；「清空记录」始终只移除已完成记录。

## 开发检查与性能约定

无需安装运行时依赖。在仓库根目录执行：

```bash
node --check popup.js
node --check background.js
node --check options.js
node --check tools/preview-mock.js
node tools/check-file-icons.cjs
```

启动交互预览：

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

打开 `http://127.0.0.1:8765/tools/preview-live.html`，可检查正式面板的筛选、搜索、分组与行内操作，
并通过预览按钮推进进度、完成下载、清空或恢复模拟记录。模拟器不执行真实下载、磁盘或剪贴板操作。
静态预览继续覆盖列表、空状态和 18 类图标。

本版已检查亮暗主题、设置页窄窗口和模拟交互；图标检查覆盖扩展名识别、大小写与通用回退、
分组兼容、同组改名和进度更新时的节点复用。

继续遵循低内存约定：无 content script、无空闲轮询，进行中下载按需刷新，列表增量渲染，
面板关闭即销毁页面。打开空闲时低于 15 MB、有下载时低于 30 MB 仍是性能验收目标。
本版未重新实测进程内存，也未重新验证真实 Chrome 下载、系统通知与磁盘操作；
模拟预览与脚本检查不作为完整扩展集成验收结果。
