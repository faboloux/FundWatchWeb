/* 估值宝 FundWatchWeb —— 纯前端基金净值/估值查看（自用）
 * 数据源（均跨域<script>/JSONP 注入，无 CORS / Referer 限制，纯前端无后端）：
 *  1) 东方财富 pingzhongdata.js       → 基金名 + 最新确认净值 + 历史净值（画走势）。所有基金可用。
 *  2) 腾讯 qt.gtimg.cn/q=<mkt><code>  → 场内基金(ETF/LOF)的实时行情（当前价/昨收），
 *     据此算出盘中实时涨跌幅。交易时段精确可用（这就是场内基金的实时价，非估算）。
 *  3) 新浪 FdFundService 估值曲线(JSONP) → 场外开放基金的【盘中实时估值】（实测 2026-07 仍可用，
 *     返回含今日时间戳的逐分钟估算净值序列）。这是“输任意基金代码看盘中估值”的来源。
 *  4) 东方财富 fundsuggest JSONP        → 搜索添加
 * 说明：天天基金 fundgz 盘中估值接口已于 2026 年被官方停用（301 死）；本版改用新浪估值曲线覆盖场外基金。
 *       估值/实时价 ≠ 官方净值，仅供参考，不构成投资建议。
 */
(function () {
  'use strict';

  var STORE_KEY = 'fundwatch_v1';
  var $ = function (s) { return document.querySelector(s); };
  var view = $('#view');
  var tbTitle = $('#tbTitle');

  // ---------------- 状态 ----------------
  var state = { funds: {}, groups: [], defaultGroup: '', version: 1 };
  var ui = {
    view: 'home', filter: '全部', selectedCode: null,
    searchKw: '', searchResults: [], searchTargets: {}, searching: false,
    wide: false, lastUpd: 0, refreshing: false
  };

  // ---------------- 存储 ----------------
  function load() {
    try {
      var r = localStorage.getItem(STORE_KEY);
      if (r) {
        var s = JSON.parse(r);
        if (s && s.funds) {
          state.funds = s.funds || {}; state.groups = s.groups || []; state.defaultGroup = s.defaultGroup || '';
          // 兼容旧数据：补齐新字段
          Object.keys(state.funds).forEach(function (k) {
            var f = state.funds[k];
            if (f.exchangeTraded == null) f.exchangeTraded = false;
            if (f.live == null) f.live = null;
            if (f.estimate == null) f.estimate = null;
          });
        }
      }
    } catch (e) {}
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ funds: state.funds, groups: state.groups, defaultGroup: state.defaultGroup, version: 1 }));
    } catch (e) { toast('当前环境无法本地保存（建议用本地服务器打开）'); }
  }

  // ---------------- 工具 ----------------
  function fmt(n, d) { d = d == null ? 4 : d; if (n == null || isNaN(n)) return '—'; return Number(n).toFixed(d); }
  function pad(x) { x = '' + x; return x.length < 2 ? '0' + x : x; }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function nowHM() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function marketOpen() {
    var d = new Date(), day = d.getDay();
    if (day === 0 || day === 6) return false;
    var t = d.getHours() * 60 + d.getMinutes();
    // 上午 9:30–11:30 (570–690) 与 下午 13:00–15:00 (780–900)，跳过午休
    return (t >= 570 && t <= 690) || (t >= 780 && t <= 900);
  }
  function colorClass(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : 'flat'); }
  function arrow(v) { return v > 0 ? '▲' : (v < 0 ? '▼' : '—'); }
  function sign(v) { return v > 0 ? '+' : ''; }
  function esc(s) {
    return ('' + (s == null ? '' : s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------------- JSONP / 脚本注入 ----------------
  function injectScript(src) {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      var done = false;
      var fin = function (v) { if (done) return; done = true; if (s.parentNode) s.parentNode.removeChild(s); resolve(v); };
      var to = setTimeout(function () { fin(null); }, 9000);
      s.onload = function () { clearTimeout(to); fin('ok'); };
      s.onerror = function () { clearTimeout(to); fin(null); };
      document.body.appendChild(s);
    });
  }

  function fetchPingzhong(code) {
    try { delete window.Data_netWorthTrend; delete window.fS_name; } catch (e) {}
    return injectScript('https://fund.eastmoney.com/pingzhongdata/' + code + '.js?_=' + Date.now())
      .then(function (ok) {
        if (ok !== 'ok') return null;
        var trend = window.Data_netWorthTrend;
        var name = window.fS_name;
        if (!trend || !trend.length) return null;
        // 元素结构：{x:时间戳(ms), y:净值, equityReturn:日涨跌%}
        var last = trend[trend.length - 1];
        var prev = trend[trend.length - 2] || last;
        var nav = Number(last.y), pnav = Number(prev.y);
        var er = Number(last.equityReturn);
        var chg = (!isNaN(er)) ? er : (pnav ? (nav - pnav) / pnav * 100 : 0);
        var dt = new Date(Number(last.x));
        var dstr = dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
        var history = trend.slice(-60).map(function (p) { return { t: Number(p.x), nav: Number(p.y) }; });
        return { name: name || '', nav: nav, chg: chg, date: dstr, history: history };
      });
  }

  // 场内/场外识别：用代码段判定（ETF/LOF/封基 占用专用号段 15/16/50/51/58，
  // 股票不会占用这些号段，因此不存在“基金代码撞股票代码”的误判；比名称匹配更稳）。
  function mktOf(code) { return /^[56]/.test(code) ? 'sh' : 'sz'; }
  function isETFPrefix(code) { return /^(15|16|50|51|58)/.test(code || ''); }
  function detectExchangeTraded(code) {
    return Promise.resolve(isETFPrefix(code));
  }
  // 场内基金实时行情（腾讯，跨域<script>可用，无需 Referer）
  function fetchLiveETF(code) {
    var mkt = mktOf(code);
    return injectScript('https://qt.gtimg.cn/q=' + mkt + code + '&_=' + Date.now())
      .then(function (ok) {
        if (ok !== 'ok') return null;
        var raw = window['v_' + mkt + code];
        if (!raw) return null;
        var f = raw.split('~');
        var price = parseFloat(f[3]), prev = parseFloat(f[4]);
        if (isNaN(price) || isNaN(prev) || prev <= 0) return null;
        var chg = (price - prev) / prev * 100;
        var ts = '';
        for (var i = f.length - 1; i >= 0; i--) {
          if (/^\d{14}$/.test(f[i] || '')) { var s = f[i] + ''; ts = s.slice(8, 10) + ':' + s.slice(10, 12); break; }
        }
        return { price: price, chg: chg, time: ts || nowHM(), name: f[1] };
      })
      .catch(function () { return null; });
  }

  // 新浪盘中估值曲线（JSONP 跨域，无需 Referer / CORS）。
  // 端点：stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol={code}
  // 返回 result.data：worth/ worth_date/ worth_rate = 最新确认净值；
  //        networth[] = 今日逐分钟估算序列（pre_date 为今日时即盘中实时估值）。
  function fetchSinaEstimate(code) {
    return new Promise(function (resolve) {
      var cb = 'fw_sina_' + code + '_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      var s = document.createElement('script');
      var done = false;
      function fin(v) { if (done) return; done = true; try { delete window[cb]; } catch (e) {} if (s.parentNode) s.parentNode.removeChild(s); resolve(v); }
      window[cb] = function (res) { fin(parseSinaEstimate(res)); };
      s.onerror = function () { fin(null); };
      s.src = 'https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getEstimateNetworthPic?symbol=' + code + '&callback=' + cb;
      s.async = true;
      document.body.appendChild(s);
      setTimeout(function () { fin(null); }, 10000);
    });
  }
  function parseSinaEstimate(res) {
    try {
      var data = res && res.result && res.result.data;
      if (!data) return null;
      var out = { nav: null, date: '', chg: 0, estimate: null };
      if (data.worth != null && data.worth !== '') {
        out.nav = parseFloat(data.worth);
        out.date = '' + (data.worth_date || '');                 // 如 20260720
        out.chg = (data.worth_rate != null && isFinite(Number(data.worth_rate))) ? Number(data.worth_rate) * 100 : 0;
      }
      var nw = data.networth;
      if (Array.isArray(nw) && nw.length) {
        var last = nw[nw.length - 1];
        var pd = ('' + (last.pre_date || '')).trim();
        var nav = parseFloat(last.pre_nav);      // 口径2 估算净值
        var pct = parseFloat(last.nav_pct);    // 口径2 估算涨跌幅%
        var nav2 = parseFloat(last.pre_nav2);   // 口径3 估算净值
        var pct2 = parseFloat(last.nav2_pct);   // 口径3 估算涨跌幅%
        var tm = ('' + (last.min_time || '')).slice(0, 5);
        if (Number.isFinite(nav) && pd === todayStr() && marketOpen()) {
          out.estimate = {
            nav: nav, chg: Number.isFinite(pct) ? pct : 0, time: tm || nowHM(),
            nav2: Number.isFinite(nav2) ? nav2 : null,
            chg2: Number.isFinite(pct2) ? pct2 : null
          };
        }
        // 今日的盘中估值曲线（所有点，用于详情页画图）
        out.curve = nw.filter(function (p) {
          return ('' + (p.pre_date || '')).trim() === todayStr();
        }).map(function (p) {
          return {
            time: ('' + (p.min_time || '')).slice(0, 5),
            nav: parseFloat(p.pre_nav),
            nav2: parseFloat(p.pre_nav2),
            chg: parseFloat(p.nav_pct),
            chg2: parseFloat(p.nav2_pct)
          };
        }).filter(function (p) { return Number.isFinite(p.nav); });
      }
      return out;
    } catch (e) { return null; }
  }

  function searchFunds(kw) {
    var cb = 'fw_s_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    var p = new Promise(function (resolve) {
      window[cb] = function (d) { try { delete window[cb]; } catch (e) {} resolve(d); };
    });
    var s = document.createElement('script');
    s.src = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=' +
      encodeURIComponent(kw) + '&callback=' + cb + '&_=' + Date.now();
    s.async = true;
    var to = setTimeout(function () { try { delete window[cb]; } catch (e) {} resolve(null); }, 9000);
    s.onload = function () { clearTimeout(to); };
    s.onerror = function () { clearTimeout(to); try { delete window[cb]; } catch (e) {} resolve(null); };
    document.body.appendChild(s);
    return p.then(function (d) {
      if (!d || !d.Datas) return [];
      return d.Datas.map(function (x) {
        return { code: x.CODE || (x.FundBaseInfo && x.FundBaseInfo.FCODE) || '', name: x.NAME || '', type: x.FundBaseInfo ? x.FundBaseInfo.FTYPE : '' };
      }).filter(function (x) { return x.code; });
    });
  }

  // ---------------- 派生值 ----------------
  function displayOf(f) {
    // 场内基金且处于交易时段：返回腾讯实时价（精确，非估算）
    if (f.exchangeTraded && f.live && marketOpen()) {
      return { nav: f.live.price, chg: f.live.chg, label: '盘中实时 ' + f.live.time, intraday: true, live: true };
    }
    // 场外开放基金且处于交易时段：返回新浪盘中实时估值
    if (f.estimate && marketOpen()) {
      return { nav: f.estimate.nav, chg: f.estimate.chg, label: '盘中估值 ' + f.estimate.time, intraday: true, live: true };
    }
    return { nav: f.lastNav, chg: f.lastChg, label: f.lastDate ? ('最新净值 ' + f.lastDate) : '暂无净值', intraday: false, live: false };
  }
  function holdingOf(f) {
    if (!(f.shares > 0)) return null;
    var d = displayOf(f);
    var nav = d.nav || 0, cost = f.costPrice || 0;
    var mv = nav * f.shares, profit = (nav - cost) * f.shares, pct = cost > 0 ? (nav - cost) / cost * 100 : 0;
    return { shares: f.shares, cost: cost, marketValue: mv, profit: profit, profitPct: pct };
  }

  // 当前估值口径（用于首页/收益汇总标签）：交易时段且有实时数据→“盘中估值”，否则“最新净值”
  function currentValLabel() {
    if (!marketOpen()) return '按最新净值';
    var has = Object.keys(state.funds).some(function (k) {
      var f = state.funds[k];
      return (f.exchangeTraded && f.live) || (f.estimate && marketOpen());
    });
    return has ? '按盘中估值' : '按最新净值';
  }
  // 汇总某范围内持仓基金的“按当前估值”收益（holdingOf 已用 displayOf 当前估值）
  function sumHold(codes) {
    var profit = 0, mv = 0, cost = 0, count = 0;
    codes.forEach(function (code) {
      var f = state.funds[code]; if (!f || !(f.shares > 0)) return;
      var h = holdingOf(f); if (!h) return;
      profit += h.profit; mv += h.marketValue; cost += h.cost; count++;
    });
    return { profit: profit, mv: mv, cost: cost, count: count };
  }
  // 单只基金的“今日预估收益”：份额 × 当前估值 × (今日涨跌幅%/100)
  // 依赖 displayOf 的 chg（盘中=新浪/腾讯今日涨跌，非盘=确认净值今日涨跌，均相对昨收）
  function todayProfitOf(f) {
    if (!(f.shares > 0)) return null;
    var h = holdingOf(f); if (!h) return null;
    var d = displayOf(f);
    return h.marketValue * ((d.chg || 0) / 100);
  }
  // 汇总某范围「截止当前估值的今日预估收益」
  function sumToday(codes) {
    var profit = 0, mv = 0, prevMv = 0, count = 0;
    codes.forEach(function (code) {
      var f = state.funds[code]; if (!f || !(f.shares > 0)) return;
      var h = holdingOf(f); if (!h) return;
      var d = displayOf(f), tp = h.marketValue * ((d.chg || 0) / 100);
      profit += tp; mv += h.marketValue;
      prevMv += h.marketValue / (1 + (d.chg || 0) / 100);
      count++;
    });
    return { profit: profit, mv: mv, prevMv: prevMv, count: count };
  }
  // 当前筛选范围下的基金代码（“全部”=所有；“分组”=该组）
  function scopeCodes() {
    var all = Object.keys(state.funds);
    if (ui.filter === '全部') return all;
    return all.filter(function (k) { return (state.funds[k].group || '') === ui.filter; });
  }

  // ---------------- 刷新 ----------------
  function refreshOne(code) {
    var f = state.funds[code]; if (!f) return Promise.resolve();
    // 场内：腾讯实时价；场外：新浪盘中估值（JSONP）。两者并行取。
    var pPing = fetchPingzhong(code);
    var pSina = f.exchangeTraded ? Promise.resolve(null) : fetchSinaEstimate(code);
    return Promise.all([pPing, pSina]).then(function (rs) {
      var f2 = state.funds[code]; if (!f2) return;
      var pd = rs[0], sn = rs[1];
      if (pd) {
        if (pd.name) f2.name = pd.name;
        f2.lastNav = pd.nav; f2.lastChg = pd.chg; f2.lastDate = pd.date; f2.history = pd.history;
      } else if (sn && sn.nav != null) {
        // pingzhongdata 失败时，用新浪确认净值兜底
        f2.lastNav = sn.nav; f2.lastChg = sn.chg; f2.lastDate = sn.date;
      }
      var liveP = f2.exchangeTraded ? fetchLiveETF(code) : Promise.resolve(null);
      return liveP.then(function (live) {
        var f3 = state.funds[code]; if (!f3) return;
        // 仅交易时段保留实时价/盘中估值；非交易时段回落到最新净值
        f3.live = (live && marketOpen()) ? live : null;
        f3.estimate = (sn && sn.estimate && marketOpen()) ? sn.estimate : null;
        f3.estimateCurve = (sn && sn.curve && sn.curve.length >= 2 && marketOpen()) ? sn.curve : null;
        f3.updatedAt = Date.now(); save();
        if (ui.view === 'home' || ui.view === 'detail' || ui.view === 'portfolio') render();
      });
    }).catch(function () {});
  }

  function refreshAll() {
    if (ui.refreshing) return;
    ui.refreshing = true; setSpin(true);
    var codes = Object.keys(state.funds);
    var seq = Promise.resolve();
    codes.forEach(function (code) {
      seq = seq.then(function () {
        return refreshOne(code);
      });
    });
    seq.then(function () {
      ui.refreshing = false; ui.lastUpd = Date.now(); setSpin(false); render();
    });
  }

  function setSpin(on) { var b = $('#btnRefresh'); if (b) b.classList.toggle('spin', on); }

  // ---------------- 渲染：通用 ----------------
  function render() {
    var titleMap = { home: '自选基金', portfolio: '持仓收益', groups: '分组管理', add: '添加基金', detail: (ui.selectedCode && state.funds[ui.selectedCode] ? state.funds[ui.selectedCode].name : '详情') };
    tbTitle.textContent = titleMap[ui.view] || '估值宝';
    var activeTab = ui.view === 'detail' ? 'home' : ui.view;
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === activeTab); });
    if (ui.view === 'home') renderHome();
    else if (ui.view === 'portfolio') renderPortfolio();
    else if (ui.view === 'groups') renderGroups();
    else if (ui.view === 'add') renderAdd();
    else if (ui.view === 'detail') renderDetail();
    var fab = document.getElementById('btnAdd');
    if (fab) fab.style.display = (ui.view === 'home' || ui.view === 'portfolio') ? 'flex' : 'none';
  }

  function visibleFunds() {
    var all = Object.keys(state.funds).map(function (k) { return state.funds[k]; });
    if (ui.filter === '全部') return all;
    return all.filter(function (f) { return (f.group || '') === ui.filter; });
  }

  function lastUpdText() { return ui.lastUpd ? ('更新 ' + nowHM()) : '未更新'; }

  // ---------------- 渲染：首页 ----------------
  function renderHome() {
    var open = marketOpen();
    var html = '';
    html += '<div class="market-row"><div class="market ' + (open ? 'open' : '') + '"><span class="dot"></span>' + (open ? '盘中交易中' : '非交易时段') + '</div><span class="upd">' + lastUpdText() + '</span></div>';
    // 分组标签栏（每个标签下显示本范围按估值的收益金额）
    html += '<div class="gtabs">';
    var allCodes = Object.keys(state.funds);
    var allToday = sumToday(allCodes);
    var gtabSub = function (profit, count) {
      if (!count) return '';
      return '<span class="gtab-sub ' + (profit >= 0 ? 'up' : 'down') + '">' + (profit >= 0 ? '+' : '') + '¥' + fmt(Math.abs(profit), 0) + '</span>';
    };
    html += '<button class="gtab ' + (ui.filter === '全部' ? 'on' : '') + '" data-act="filter" data-g="全部">全部' + gtabSub(allToday.profit, allToday.count) + '</button>';
    state.groups.forEach(function (g) {
      var gc = allCodes.filter(function (k) { return (state.funds[k].group || '') === g; });
      var gs = sumToday(gc);
      html += '<button class="gtab ' + (ui.filter === g ? 'on' : '') + '" data-act="filter" data-g="' + esc(g) + '">' + esc(g) + gtabSub(gs.profit, gs.count) + '</button>';
    });
    html += '<button class="gtab add" data-act="newGroup">＋分组</button>';
    html += '</div>';
    html += '<div class="info-note">首页主数字<b>优先显示实时估值</b>：场外基金盘中=新浪实时估值 · 场内基金(ETF/LOF)=腾讯实时价（点右上角“i”查看数据说明）</div>';

    // 当前范围「截止当前估值的今日预估收益」（全部=所有基金；分组=该组）
    var sc = scopeCodes();
    var sum = sumToday(sc);
    var scopeLabel = ui.filter === '全部' ? '全部今日预估收益' : ('「' + ui.filter + '」今日预估收益');
    var vlabel = currentValLabel();
    html += '<div class="section-h">' + esc(scopeLabel) + '（' + vlabel + '）</div>';
    if (sum.count > 0) {
      var pc = colorClass(sum.profit), ppct = sum.prevMv > 0 ? sum.profit / sum.prevMv * 100 : 0;
      html += '<div class="fcard pf"><div class="pf-row"><div class="pf-num ' + pc + '">' + (sum.profit >= 0 ? '+' : '') + '¥' + fmt(sum.profit, 2) + '</div><div class="chg-pill ' + pc + '">' + (sum.profit >= 0 ? '+' : '') + fmt(ppct, 2) + '%</div></div>';
      html += '<div class="pstats"><div class="ps"><div class="pl">昨日市值</div><div class="pv">¥' + fmt(sum.prevMv, 2) + '</div></div><div class="ps"><div class="pl">今日估算市值</div><div class="pv">¥' + fmt(sum.mv, 2) + '</div></div></div></div>';
    } else {
      html += '<div class="sum-empty">该范围暂无持仓 · 在基金详情里填份额和成本价后，这里显示按' + vlabel + '计算的今日预估收益</div>';
    }

    var list = visibleFunds();
    if (ui.wide) {
      html += '<div class="home-grid">';
      html += '<div class="pane-list">' + (list.length ? list.map(cardHTML).join('') : emptyMini()) + '</div>';
      html += '<div class="pane-detail">' + detailInner(ui.selectedCode && state.funds[ui.selectedCode] ? ui.selectedCode : null) + '</div>';
      html += '</div>';
    } else {
      html += list.length ? list.map(cardHTML).join('') : '<div class="empty"><div class="big">📭</div>还没有基金<br>点右下角 “＋” 添加，或去“收益”页</div>';
    }
    view.innerHTML = html;
  }

  function emptyMini() { return '<div class="empty" style="padding:30px 10px">该分组暂无基金</div>'; }

  function cardHTML(f) {
    var d = displayOf(f), c = colorClass(d.chg), h = holdingOf(f);
    var grp = f.group ? '<span class="grp-tag">' + esc(f.group) + '</span>' : '';
    var liveBadge = d.live ? '<span class="live-badge">' + (f.exchangeTraded ? '实时' : '盘中') + '</span>' : '';
    // 主页卡片主数字优先展示“今日预估收益金额”，无持仓时 fallback 为涨跌幅
    var mainVal, mainCls, mainLabel;
    if (h) {
      mainVal = (h.profit >= 0 ? '+' : '−') + '¥' + fmt(Math.abs(h.profit), 0);
      mainCls = h.profit >= 0 ? 'up' : 'down';
      mainLabel = '今日预估收益';
    } else {
      mainVal = sign(d.chg) + fmt(d.chg, 2) + '%';
      mainCls = c;
      mainLabel = d.label;
    }
    var hold = h ? '<span class="' + (h.profit >= 0 ? 'up' : 'down') + '">' + (h.profit >= 0 ? '+' : '') + '¥' + fmt(Math.abs(h.profit), 0) + '</span>' : '';
    return '<div class="fcard" data-act="open" data-code="' + f.code + '">' +
      '<button class="del" data-act="del" data-code="' + f.code + '" title="删除">✕</button>' +
      '<div class="top"><div><div class="nm">' + esc(f.name || f.code) + '</div><div class="cd">' + f.code + (f.type ? (' · ' + esc(f.type)) : '') + (f.exchangeTraded ? ' · 场内' : '') + '</div></div>' +
      '<div class="val"><div class="v ' + mainCls + '">' + mainVal + '</div><div class="chg-pill ' + c + '">' + arrow(d.chg) + ' ' + sign(d.chg) + fmt(d.chg, 2) + '%</div>' + liveBadge + '</div></div>' +
      '<div class="bot"><span>' + esc(h ? d.label : mainLabel) + '</span>' + (h ? '' : hold) + '</div>' + grp +
      '</div>';
  }

  // ---------------- 渲染：详情 ----------------
  // 交易时间轴映射：9:30–11:30 → 左半；13:00–15:00 → 右半（午休折叠）
  function timeToMin(t) {
    if (!t) return 0;
    var p = ('' + t).split(':');
    var hh = parseInt(p[0], 10) || 0, mm = parseInt(p[1], 10) || 0;
    return hh * 60 + mm;
  }
  function timeToX(m, w) {
    if (m <= 690) return ((m - 570) / 120) * (w * 0.5);          // 9:30–11:30
    if (m >= 780) return w * 0.5 + ((m - 780) / 120) * (w * 0.5); // 13:00–15:00
    return w * 0.5; // 午休段（数据一般不含）
  }
  function sparkSVG(history, w, h, color, opts) {
    opts = opts || {};
    if (!history || history.length < 2) return '<div class="spark" style="display:flex;align-items:center;justify-content:center;color:var(--sub);font-size:13px">暂无足够历史数据</div>';
    var vals = history.map(function (p) { return p.nav; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var rng = (max - min) || 1, n = vals.length;
    var first = null, last = null;
    var pts = history.map(function (p, i) {
      var x = (opts.timeField && p[opts.timeField]) ? timeToX(timeToMin(p[opts.timeField]), w) : (i / (n - 1)) * w;
      var y = h - ((p.nav - min) / rng) * (h - 12) - 6;
      var s = x.toFixed(1) + ',' + y.toFixed(1);
      if (i === 0) first = { x: x, y: y };
      last = { x: x, y: y };
      return s;
    }).join(' ');
    var area = first.x.toFixed(1) + ',' + h + ' ' + pts + ' ' + last.x.toFixed(1) + ',' + h;
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<polygon points="' + area + '" fill="' + color + '22" stroke="none"></polygon>' +
      '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round"></polyline></svg>';
  }

  function detailInner(code) {
    var f = code ? state.funds[code] : null;
    if (!f) return '<div class="empty"><div class="big">📈</div>选择一只基金查看详情</div>';
    var d = displayOf(f), c = colorClass(d.chg), h = holdingOf(f);
    var color = d.chg >= 0 ? '#EE2B3B' : '#0CA678';
    var nav = d.nav || 0;
    var groupsOpts = state.groups.map(function (g) { return '<option value="' + esc(g) + '" ' + ((f.group || '') === g ? 'selected' : '') + '>' + esc(g) + '</option>'; }).join('');
    var hasCurve = f.estimateCurve && f.estimateCurve.length >= 2;
    var spark = sparkSVG(hasCurve ? f.estimateCurve : f.history, 300, 140, color, hasCurve ? { timeField: 'time' } : null);
    var curveLabel = hasCurve ? '今日盘中估值曲线（新浪）' : '历史净值走势';

    var html = '<div class="detail-wrap">';
    html += '<div class="detail-head"><div><div style="font-weight:700;font-size:16px">' + esc(f.name || f.code) + '</div><div style="font-size:12px;color:var(--sub)">' + f.code + (f.type ? (' · ' + esc(f.type)) : '') + '</div></div>';
    html += '<button class="icon-btn" data-act="back" style="background:transparent">✕</button></div>';
    html += '<div class="detail-big ' + c + '">' + fmt(nav) + '</div><div class="detail-ch"><span class="chg-pill ' + c + '">' + arrow(d.chg) + ' ' + sign(d.chg) + fmt(d.chg, 2) + '%</span> <span style="font-size:12.5px;color:var(--sub);font-weight:600">' + esc(d.label) + '</span></div>';
    if (f.estimate && marketOpen()) {
      var e = f.estimate;
      html += '<div class="est-note">盘中估值（新浪）：' + fmt(e.nav) + ' · ' + arrow(e.chg) + ' ' + sign(e.chg) + fmt(e.chg, 2) + '% @ ' + esc(e.time) + '</div>';
      if (e.chg2 != null && Math.abs(e.chg2 - e.chg) > 0.3) {
        html += '<div class="est-alt">另一口径：' + fmt(e.nav2) + ' · ' + fmt(e.chg2, 2) + '%</div>';
      }
    }
    html += '<div class="curve-label">' + curveLabel + '</div>';
    html += spark;
    html += '<label class="et-toggle"><input type="checkbox" id="chkET" data-code="' + f.code + '" ' + (f.exchangeTraded ? 'checked' : '') + '/> 场内基金（ETF / LOF，显示盘中实时价）</label>';
    html += '<div>';
    html += kv('净值日期', f.lastDate || '—');
    html += kv('当前市值', h ? ('¥' + fmt(h.marketValue, 2)) : '未设置持仓');
    if (h) html += kv('持仓收益', '<span class="' + (h.profit >= 0 ? 'up' : 'down') + '">' + (h.profit >= 0 ? '+' : '') + '¥' + fmt(h.profit, 2) + ' (' + (h.profit >= 0 ? '+' : '') + fmt(h.profitPct, 2) + '%)</span>');
    html += '</div>';
    // 持仓编辑
    html += '<div class="hold-edit"><div style="font-weight:700;margin-bottom:4px">持仓设置</div>';
    html += '<label style="font-size:12px;color:var(--sub)">持有份额</label><input id="inpShares" type="number" inputmode="decimal" value="' + (f.shares || '') + '" placeholder="如 1000"/>';
    html += '<label style="font-size:12px;color:var(--sub);margin-top:8px;display:block">成本价</label><input id="inpCost" type="number" inputmode="decimal" value="' + (f.costPrice || '') + '" placeholder="如 1.2345"/>';
    html += '<div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-primary" data-act="saveHold" data-code="' + f.code + '">保存持仓</button></div></div>';
    // 移动分组
    html += '<div class="hold-edit"><div style="font-weight:700;margin-bottom:6px">所属分组</div><select id="selGroup" data-code="' + f.code + '" style="width:100%;border:1px solid var(--line);border-radius:10px;padding:10px;font-size:14px;background:var(--card);color:var(--txt)"><option value="">（未分组）</option>' + groupsOpts + '</select></div>';
    html += '<button class="btn btn-ghost" data-act="del" data-code="' + f.code + '" style="color:var(--brand)">删除该基金</button>';
    html += '</div>';
    return html;
  }

  function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><span>' + v + '</span></div>'; }

  function renderDetail() { view.innerHTML = detailInner(ui.selectedCode); }

  // ---------------- 渲染：收益 ----------------
  function renderPortfolio() {
    var held = Object.keys(state.funds).map(function (k) { return state.funds[k]; }).filter(function (f) { return f.shares > 0; });
    var totMV = 0, totCost = 0, totProfit = 0;
    held.forEach(function (f) { var h = holdingOf(f); if (h) { totMV += h.marketValue; totCost += h.cost; totProfit += h.profit; } });
    var pct = totCost > 0 ? totProfit / totCost * 100 : 0;
    var c = colorClass(totProfit);
    var html = '';
    html += '<div class="section-h">持仓总览（' + currentValLabel() + '）</div>';
    html += '<div class="fcard pf"><div class="pf-row"><div class="pf-num ' + c + '">' + (totProfit >= 0 ? '+' : '') + '¥' + fmt(totProfit, 2) + '</div><div class="chg-pill ' + c + '">' + (totProfit >= 0 ? '+' : '') + fmt(pct, 2) + '%</div></div>';
    html += '<div class="pstats"><div class="ps"><div class="pl">总市值</div><div class="pv">¥' + fmt(totMV, 2) + '</div></div><div class="ps"><div class="pl">总成本</div><div class="pv">¥' + fmt(totCost, 2) + '</div></div></div></div>';
    html += '<div class="section-h">逐只明细（' + held.length + '）</div>';
    if (!held.length) {
      html += '<div class="empty"><div class="big">💰</div>还没有设置持仓<br>在基金详情里填份额和成本价</div>';
    } else {
      held.forEach(function (f) {
        var h = holdingOf(f), hc = colorClass(h.profit);
        html += '<div class="fcard" data-act="open" data-code="' + f.code + '"><div class="top"><div><div class="nm">' + esc(f.name || f.code) + '</div><div class="cd">' + f.code + '</div></div>';
        html += '<div class="val"><div class="v ' + hc + '">' + (h.profit >= 0 ? '+' : '') + '¥' + fmt(h.profit, 0) + '</div><div class="chg-pill ' + hc + '">' + (h.profit >= 0 ? '+' : '') + fmt(h.profitPct, 2) + '%</div></div></div>';
        html += '<div class="bot"><span>市值 ¥' + fmt(h.marketValue, 0) + '</span><span>成本 ¥' + fmt(h.cost, 0) + '</span></div></div>';
      });
    }
    view.innerHTML = html;
  }

  // ---------------- 渲染：添加 ----------------
  function renderAdd() {
    var html = '';
    html += '<div class="searchbar"><input id="searchInput" type="search" placeholder="输入基金代码或名称" value="' + esc(ui.searchKw || '') + '"/><button class="go" data-act="doSearch">搜索</button></div>';
    if (ui.searching) {
      html += '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    } else if (ui.searchResults.length) {
      ui.searchResults.forEach(function (r) {
        var cur = ui.searchTargets[r.code] != null ? ui.searchTargets[r.code] : (state.defaultGroup || (state.groups[0] || ''));
        html += '<div class="res"><div class="row"><div style="flex:1;min-width:0"><div class="nm">' + esc(r.name) + '</div><div class="cd">' + esc(r.code) + (r.type ? (' · ' + esc(r.type)) : '') + '</div></div>';
        html += '<select class="grp-sel" data-code="' + r.code + '">';
        html += '<option value="">（未分组）</option>';
        state.groups.forEach(function (g) { html += '<option value="' + esc(g) + '" ' + (cur === g ? 'selected' : '') + '>' + esc(g) + '</option>'; });
        html += '</select>';
        var added = !!state.funds[r.code];
        html += '<button class="add ' + (added ? 'done' : '') + '" data-act="addFund" data-code="' + r.code + '" ' + (added ? 'disabled' : '')           + '>' + (added ? '已加' : '＋加') + '</button></div></div>';
      });
    } else {
      html += '<div class="add-hint"><div class="big">🔍</div>输入基金代码或名称开始搜索<br>例如：110011（易方达中小盘）</div>';
    }
    view.innerHTML = html;
  }

  // ---------------- 渲染：分组管理 ----------------
  function renderGroups() {
    var html = '<div class="section-h">分组（' + state.groups.length + '）</div>';
    if (!state.groups.length) {
      html += '<div class="empty"><div class="big">🗂️</div>还没有自定义分组<br>点下方“新建分组”</div>';
    }
    state.groups.forEach(function (g) {
      var count = Object.keys(state.funds).filter(function (k) { return (state.funds[k].group || '') === g; }).length;
      html += '<div class="gitem"><span class="gname">' + esc(g) + '</span><span class="gcount">' + count + ' 只</span>';
      html += '<button class="gact" data-act="renameGroup" data-g="' + esc(g) + '">✎</button><button class="gact del" data-act="delGroup" data-g="' + esc(g) + '">🗑</button></div>';
    });
    html += '<button class="btn btn-primary" data-act="newGroup" style="margin-top:14px">＋ 新建分组</button>';
    view.innerHTML = html;
  }

  // ---------------- 动作 ----------------
  function doSearch() {
    var kw = (ui.searchKw || '').trim(); if (!kw) return;
    ui.view = 'add'; ui.searching = true; ui.searchResults = []; render();
    searchFunds(kw).then(function (list) {
      ui.searching = false; ui.searchResults = list;
      list.forEach(function (r) { if (!(r.code in ui.searchTargets)) ui.searchTargets[r.code] = state.defaultGroup || (state.groups[0] || ''); });
      render();
    });
  }
  function addFund(code) {
    if (state.funds[code]) return;
    var r = ui.searchResults.filter(function (x) { return x.code === code; })[0] || { code: code, name: '', type: '' };
    var name = r.name || code;
    toast('正在添加…');
    detectExchangeTraded(code).then(function (isET) {
      if (state.funds[code]) return; // 重复点击防护
      state.funds[code] = {
        code: code, name: name, type: r.type || '',
        exchangeTraded: !!isET,
        group: ui.searchTargets[code] || '', shares: 0, costPrice: 0,
        history: [], lastNav: null, lastChg: 0, lastDate: '', live: null, estimate: null, updatedAt: 0
      };
      save(); render();
      toast((isET ? '已识别为场内(实时) · ' : '') + '已添加 ' + name);
      refreshOne(code);
    });
  }
  function deleteFund(code) {
    delete state.funds[code];
    if (ui.selectedCode === code) ui.selectedCode = null;
    save();
    if (ui.wide && ui.view === 'home') renderHome(); else render();
  }
  function moveGroup(code, group) {
    var f = state.funds[code]; if (!f) return;
    f.group = group || ''; save(); render();
  }
  function saveHold(code) {
    var f = state.funds[code]; if (!f) return;
    var s = parseFloat($('#inpShares').value), c = parseFloat($('#inpCost').value);
    f.shares = isNaN(s) ? 0 : s;
    f.costPrice = isNaN(c) ? 0 : c;
    save(); render(); toast('持仓已保存');
  }
  function newGroup() {
    openModal('新建分组', '', function (name) {
      if (!name) return;
      if (state.groups.indexOf(name) < 0) { state.groups.push(name); if (!state.defaultGroup) state.defaultGroup = name; save(); render(); toast('已建分组 ' + name); }
    });
  }
  function renameGroup(g) {
    openModal('重命名分组', g, function (newn) {
      if (!newn || newn === g) return;
      Object.keys(state.funds).forEach(function (k) { if ((state.funds[k].group || '') === g) state.funds[k].group = newn; });
      var i = state.groups.indexOf(g); if (i >= 0) state.groups[i] = newn;
      if (state.defaultGroup === g) state.defaultGroup = newn;
      save(); render();
    });
  }
  function delGroup(g) {
    confirmModal('删除分组“' + g + '”？组内基金会回到“未分组”，不会被删除。', function () {
      Object.keys(state.funds).forEach(function (k) { if ((state.funds[k].group || '') === g) state.funds[k].group = ''; });
      var i = state.groups.indexOf(g); if (i >= 0) state.groups.splice(i, 1);
      if (state.defaultGroup === g) state.defaultGroup = state.groups[0] || '';
      if (ui.filter === g) ui.filter = '全部';
      save(); render();
    });
  }

  // ---------------- 模态 ----------------
  function openModal(title, value, onOk) {
    var root = $('#modalRoot');
    root.innerHTML = '<div class="modal-mask"><div class="modal"><h3>' + esc(title) + '</h3>' +
      '<input id="modalInput" value="' + esc(value || '') + '" placeholder="分组名称"/><div class="mrow"><button class="cancel" data-m="cancel">取消</button><button class="ok" data-m="ok">确定</button></div></div></div>';
    var input = root.querySelector('#modalInput');
    setTimeout(function () { input.focus(); }, 50);
    root.querySelector('[data-m="ok"]').onclick = function () { var v = input.value.trim(); root.innerHTML = ''; if (v) onOk(v); };
    root.querySelector('[data-m="cancel"]').onclick = function () { root.innerHTML = ''; };
    root.querySelector('.modal-mask').onclick = function (ev) { if (ev.target.classList.contains('modal-mask')) root.innerHTML = ''; };
  }
  function confirmModal(msg, onYes) {
    var root = $('#modalRoot');
    root.innerHTML = '<div class="modal-mask"><div class="modal"><h3>' + esc(msg) + '</h3><div class="mrow"><button class="cancel" data-m="no">取消</button><button class="ok" data-m="yes" style="background:var(--brand)">确定</button></div></div></div>';
    root.querySelector('[data-m="yes"]').onclick = function () { root.innerHTML = ''; onYes(); };
    root.querySelector('[data-m="no"]').onclick = function () { root.innerHTML = ''; };
    root.querySelector('.modal-mask').onclick = function (ev) { if (ev.target.classList.contains('modal-mask')) root.innerHTML = ''; };
  }
  function infoModal(msg) {
    var root = $('#modalRoot');
    root.innerHTML = '<div class="modal-mask"><div class="modal"><h3>数据说明</h3>' + msg +
      '<div class="mrow"><button class="ok" data-m="ok">知道了</button></div></div></div>';
    root.querySelector('[data-m="ok"]').onclick = function () { root.innerHTML = ''; };
    root.querySelector('.modal-mask').onclick = function (ev) { if (ev.target.classList.contains('modal-mask')) root.innerHTML = ''; };
  }
  function openInfo() {
    infoModal('<p>数据来自东方财富、腾讯、新浪的公开接口（跨域脚本/JSONP 注入获取，纯前端、无后端、无账号）。</p>' +
      '<p><b>场外开放基金</b>：用<b>新浪盘中估值曲线</b>展示交易时段的<b>实时估值</b>（逐分钟更新，带今日时间戳）；非交易时段回落到最新确认净值 + 历史走势。天天基金 fundgz 接口已于 2026 年停用，已由新浪替代。</p>' +
      '<p><b>场内基金（ETF / LOF）</b>：用腾讯实时行情展示<b>盘中实时价</b>（即实时市价，比估算更准）。添加时按代码段自动识别；也可在详情页手动开关“场内基金”。</p>' +
      '<p>新浪估值有两个口径，差异较大时详情页会并列提示。实时价 / 估值 ≠ 官方净值，仅供参考，不构成投资建议。</p>');
  }
  var toastTimer = null;
  function toast(msg) {
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2000);
  }

  // ---------------- 事件 ----------------
  function onClick(e) {
    var el = e.target.closest('[data-act]');
    if (el) {
      var act = el.dataset.act, code = el.dataset.code, g = el.dataset.g;
      switch (act) {
        case 'open': ui.selectedCode = code; if (ui.wide) renderHome(); else { ui.view = 'detail'; render(); } break;
        case 'back': if (ui.wide) { ui.selectedCode = null; renderHome(); } else { ui.view = 'home'; render(); } break;
        case 'filter': ui.filter = g; renderHome(); break;
        case 'del': e.stopPropagation(); var nm = (state.funds[code] && state.funds[code].name) || code; confirmModal('确定删除“' + nm + '”？', function () { deleteFund(code); }); break;
        case 'doSearch': doSearch(); break;
        case 'addFund': addFund(code); break;
        case 'goAdd': ui.view = 'add'; ui.searchKw = ''; ui.searchResults = []; ui.searching = false; render(); break;
        case 'info': openInfo(); break;
        case 'saveHold': saveHold(code); break;
        case 'newGroup': newGroup(); break;
        case 'renameGroup': renameGroup(g); break;
        case 'delGroup': delGroup(g); break;
      }
      return;
    }
    var tab = e.target.closest('.tab');
    if (tab) { ui.view = tab.dataset.view; ui.selectedCode = null; render(); return; }
    if (e.target.id === 'btnRefresh') { refreshAll(); return; }
    if (e.target.id === 'btnSettings') { ui.view = 'groups'; render(); return; }
  }
  function onInput(e) {
    if (e.target.id === 'searchInput') { ui.searchKw = e.target.value; return; }
    if (e.target.classList.contains('grp-sel')) { ui.searchTargets[e.target.dataset.code] = e.target.value; return; }
  }
  function onChange(e) {
    if (e.target.id === 'selGroup') { moveGroup(e.target.dataset.code, e.target.value); return; }
    if (e.target.id === 'chkET') {
      var f = state.funds[e.target.dataset.code]; if (!f) return;
      f.exchangeTraded = e.target.checked; save(); render();
      if (e.target.checked) refreshOne(e.target.dataset.code);
    }
  }

  // ---------------- 宽屏检测 ----------------
  function checkWide() { ui.wide = window.matchMedia('(min-width:840px)').matches; }

  // ---------------- 初始化 ----------------
  function init() {
    load(); checkWide();
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { ui.view = t.dataset.view; ui.selectedCode = null; render(); });
    });
    $('#btnRefresh').addEventListener('click', function () { refreshAll(); });
    $('#btnSettings').addEventListener('click', function () { ui.view = 'groups'; render(); });
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    window.addEventListener('resize', function () {
      var w = window.matchMedia('(min-width:840px)').matches;
      if (w !== ui.wide) { ui.wide = w; if (ui.view === 'home' || ui.view === 'detail') render(); }
    });
    if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('sw.js?v=4').catch(function () {}); } catch (e) {} }
    render();
    refreshAll();
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
