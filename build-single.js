// 构建单文件版 FundWatchWeb-single.html（把 styles.css + app.js 内联进 index 骨架）
// 以源文件为准，保证单文件与多文件版一致。
const fs = require('fs');
const dir = __dirname + '/';
const css = fs.readFileSync(dir + 'styles.css', 'utf8');
const js = fs.readFileSync(dir + 'app.js', 'utf8');
const html =
'<!DOCTYPE html>\n' +
'<html lang="zh-CN">\n' +
'<head>\n' +
'  <meta charset="UTF-8" />\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no" />\n' +
'  <meta name="theme-color" content="#EE2B3B" />\n' +
'  <title>估值宝 · 基金估值（单文件版）</title>\n' +
'  <style>\n' + css + '\n  </style>\n' +
'</head>\n' +
'<body>\n' +
'  <div id="app">\n' +
'    <header class="topbar" id="topbar">\n' +
'      <div class="brand">\n' +
'        <span class="brand-mark">估</span>\n' +
'        <span class="tb-title" id="tbTitle">自选基金</span>\n' +
'      </div>\n' +
'      <div class="tb-actions">\n' +
'        <button class="icon-btn add-top" id="btnAddTop" data-act="goAdd" title="添加基金">＋</button>\n' +
'        <button class="icon-btn" id="btnInfo" title="数据说明">i</button>\n' +
'        <button class="icon-btn" id="btnRefresh" title="刷新">&#8635;</button>\n' +
'        <button class="icon-btn" id="btnSettings" title="分组管理">&#9881;</button>\n' +
'      </div>\n' +
'    </header>\n' +
'    <main id="view" class="view"></main>\n' +
'    <nav class="bottombar" id="bottombar">\n' +
'      <button class="tab active" data-view="home"><span class="ti">&#9733;</span><span>自选</span></button>\n' +
'      <button class="tab" data-view="portfolio"><span class="ti">&#165;</span><span>收益</span></button>\n' +
'    </nav>\n' +
'    <button class="fab" id="btnAdd" data-act="goAdd" aria-label="添加基金">＋</button>\n' +
'  </div>\n' +
'  <div id="modalRoot"></div>\n' +
'  <script>\n' + js + '\n  </script>\n' +
'</body>\n' +
'</html>\n';
fs.writeFileSync(dir + 'FundWatchWeb-single.html', html, 'utf8');
console.log('OK single file bytes =', html.length);
