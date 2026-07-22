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
    wide: false, lastUpd: 0, refreshing: false,
    homeSort: 'today_desc', portSort: 'hold_desc', compact: false
  };
  // 各页允许的排序项：自选=今日预估/今日预估率；收益=历史收益/历史收益率（两页独立，不联动）
  var HOME_SORTS = ['today_desc', 'today_asc', 'todayrate_desc', 'todayrate_asc'];
  var PORT_SORTS = ['hold_desc', 'hold_asc', 'holdrate_desc', 'holdrate_asc'];
  function allowSorts() { return ui.view === 'portfolio' ? PORT_SORTS : HOME_SORTS; }
  // 取/设 当前页面使用的排序；对旧值/非法值回落到该页默认第一项
  function curSort() {
    var s = ui.view === 'portfolio' ? ui.portSort : ui.homeSort;
    var allow = allowSorts();
    return allow.indexOf(s) >= 0 ? s : allow[0];
  }
  function setCurSort(s) { if (ui.view === 'portfolio') ui.portSort = s; else ui.homeSort = s; }

  // ---------------- 存储 ----------------
  function load() {
    try {
      var r = localStorage.getItem(STORE_KEY);
      if (r) {
        var s = JSON.parse(r);
        if (s && s.funds) {
          state.funds = s.funds || {}; state.groups = s.groups || []; state.defaultGroup = s.defaultGroup || '';
          if (s.homeSort) ui.homeSort = s.homeSort;
          if (s.portSort) ui.portSort = s.portSort;
          if (s.compact != null) ui.compact = !!s.compact;
          // 兼容旧数据：补齐新字段
          Object.keys(state.funds).forEach(function (k) {
            var f = state.funds[k];
            // 本应用仅支持场外基金，强制按场外处理（重置历史遗留的场内标记）
            f.exchangeTraded = false;
            if (f.live == null) f.live = null;
            if (f.estimate == null) f.estimate = null;
            // 迁移单分组持仓 → holdings 数组（同一基金可挂多个分组，各自独立份额/成本）
            if (!Array.isArray(f.holdings)) {
              f.holdings = [{ group: f.group || '', shares: f.shares || 0, costPrice: f.costPrice || 0 }];
              delete f.group; delete f.shares; delete f.costPrice;
            }
          });
        }
      }
    } catch (e) {}
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ funds: state.funds, groups: state.groups, defaultGroup: state.defaultGroup, version: 1, homeSort: ui.homeSort, portSort: ui.portSort, compact: ui.compact }));
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

  // 本应用所有基金均为场外开放基金，统一走新浪盘中估值 + 东财确认净值两条数据源，
  // 不再保留场内(ETF/LOF)的腾讯实时行情逻辑。

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
        if (Number.isFinite(nav) && pd === todayStr()) {
          out.estimate = {
            nav: nav, chg: Number.isFinite(pct) ? pct : 0, time: tm || nowHM(),
            nav2: Number.isFinite(nav2) ? nav2 : null,
            chg2: Number.isFinite(pct2) ? pct2 : null,
            date: todayStr()
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
  // 数据源优先级状态机：
  //  ① 今日真实净值已更新(lastDate==今天) → 真实净值（今日涨跌为真实）
  //  ② 场外基金：新浪当日估值 —— 交易时段=盘中估值；收盘后=15:00 收盘预估
  //  ③ 最新确认净值(非今日，如 QDII 滞后/周末) → 用最新净值的涨跌幅作为“今日收益”口径
  //  ④ 兜底：无净值 → 无法计算
  function displayOf(f) {
    var navUpdated = (f.lastDate === todayStr());
    var trading = marketOpen();
    if (navUpdated) {
      return { nav: f.lastNav, chg: f.lastChg, chgToday: f.lastChg, label: '真实净值 ' + f.lastDate, real: true, estimate: false, live: false, navUpdated: true, latestNav: false };
    }
    if (f.estimate && f.estimate.date === todayStr()) {
      return {
        nav: f.estimate.nav, chg: f.estimate.chg, chgToday: f.estimate.chg,
        label: trading ? ('盘中估值 ' + f.estimate.time) : '收盘估值(预估) 15:00',
        real: false, estimate: true, live: trading, navUpdated: false, latestNav: false
      };
    }
    // QDII/非交易日：最新确认净值的涨跌也参与收益计算，避免只显示百分比
    var hasLatest = (f.lastNav != null && f.lastChg != null && f.lastDate);
    if (hasLatest) {
      return { nav: f.lastNav, chg: f.lastChg, chgToday: f.lastChg, label: '最新净值 ' + f.lastDate, real: false, estimate: false, live: false, navUpdated: false, latestNav: true };
    }
    return { nav: f.lastNav, chg: f.lastChg, chgToday: null, label: f.lastDate ? ('最新净值 ' + f.lastDate) : '暂无净值', real: false, estimate: false, live: false, navUpdated: false, latestNav: false };
  }
  // ---------------- 持仓（holdings）辅助 ----------------
  // 一个基金可挂多个分组，每个 holding 独立 份额/成本。
  function holdingsOf(f) { return Array.isArray(f.holdings) ? f.holdings : []; }
  function holdingIn(f, g) {
    g = g || '';
    var hs = holdingsOf(f);
    for (var i = 0; i < hs.length; i++) if ((hs[i].group || '') === g) return hs[i];
    return null;
  }
  function upsertHolding(f, group, shares, cost) {
    group = group || '';
    var hs = holdingsOf(f), ex = null;
    for (var i = 0; i < hs.length; i++) if ((hs[i].group || '') === group) { ex = hs[i]; break; }
    if (ex) {
      if (!isNaN(shares)) ex.shares = shares;
      if (!isNaN(cost)) ex.costPrice = cost;
    } else {
      hs.push({ group: group, shares: isNaN(shares) ? 0 : shares, costPrice: isNaN(cost) ? 0 : cost });
    }
  }
  function removeHolding(f, group) {
    group = group || '';
    f.holdings = holdingsOf(f).filter(function (h) { return (h.group || '') !== group; });
  }
  // 展开所有持仓为 position 列表：{code, f, h}
  function allPositions() {
    var out = [];
    Object.keys(state.funds).forEach(function (code) {
      var f = state.funds[code];
      holdingsOf(f).forEach(function (h) { out.push({ code: code, f: f, h: h }); });
    });
    return out;
  }
  // 单 holding 的派生值（基于该基金当前净值口径）
  function holdingDerived(f, h) {
    if (!h || !(h.shares > 0)) return null;
    var d = displayOf(f);
    var nav = d.nav || 0, cost = h.costPrice || 0;
    var mv = nav * h.shares, profit = (nav - cost) * h.shares, pct = cost > 0 ? (nav - cost) / cost * 100 : 0;
    return { shares: h.shares, cost: cost, marketValue: mv, profit: profit, profitPct: pct, group: h.group || '' };
  }
  // 多 holding 聚合成卡片数据：总份额/总市值/总成本/总收益/今日收益
  function aggregate(f, hs) {
    var d = displayOf(f);
    var totalShares = 0, totalMV = 0, totalCost = 0, totalProfit = 0;
    var today = 0, todayPrev = 0, hasToday = false;
    (hs || []).forEach(function (h) {
      if (!(h.shares > 0)) return;
      var nav = d.nav || 0, cost = h.costPrice || 0;
      totalShares += h.shares; totalMV += nav * h.shares; totalCost += cost * h.shares; totalProfit += (nav - cost) * h.shares;
      if (d.chgToday != null) {
        var mv = nav * h.shares;
        today += mv * (d.chgToday / 100);
        todayPrev += mv / (1 + d.chgToday / 100);
        hasToday = true;
      }
    });
    return {
      totalShares: totalShares, totalMV: totalMV, totalCost: totalCost, totalProfit: totalProfit,
      totalProfitPct: totalCost > 0 ? totalProfit / totalCost * 100 : 0,
      today: hasToday ? today : null, todayPct: (hasToday && todayPrev > 0) ? today / todayPrev * 100 : 0
    };
  }
  // 单 holding 今日收益（份额 × 当前市值 × 今日涨跌幅%）
  function todayProfitOf(f, h) {
    if (!h || !(h.shares > 0)) return null;
    var hv = holdingDerived(f, h); if (!hv) return null;
    var d = displayOf(f);
    if (d.chgToday == null) return null;
    return hv.marketValue * (d.chgToday / 100);
  }
  // 汇总卡片列表的“今日收益”（真实净值 or 收盘估值）
  function sumToday(cards) {
    var profit = 0, mv = 0, prevMv = 0, count = 0;
    (cards || []).forEach(function (card) {
      var agg = aggregate(card.f, card.hs);
      if (agg.today != null) {
        profit += agg.today; mv += agg.totalMV; prevMv += agg.totalMV / (1 + agg.todayPct / 100); count++;
      }
    });
    return { profit: profit, mv: mv, prevMv: prevMv, count: count };
  }

  // 当前估值口径（用于首页/收益汇总标签）
  function currentValLabel() {
    if (marketOpen()) return '盘中实时';
    var anyReal = Object.keys(state.funds).some(function (k) { return state.funds[k].lastDate === todayStr(); });
    return anyReal ? '今日真实净值' : '收盘估值(预估)';
  }
  // 汇总卡片列表的“历史总收益/总成本”
  function sumHistory(cards) {
    var profit = 0, cost = 0, mv = 0, count = 0;
    (cards || []).forEach(function (card) {
      var agg = aggregate(card.f, card.hs);
      profit += agg.totalProfit; mv += agg.totalMV; cost += agg.totalCost; count++;
    });
    return { profit: profit, mv: mv, cost: cost, count: count };
  }

  // 按当前筛选范围，聚合各基金今日 estimateCurve，生成逐分钟「预估收益/收益率」走势
  // 返回 [{time, profit, pct, mv, prevMv}]，按时间升序
  function calcTodayTrend(cards) {
    if (!cards || !cards.length) return [];
    var series = [];
    cards.forEach(function (card) {
      var f = card.f, hs = card.hs, curve = (f.estimateCurve || []).filter(function (p) { return p && p.time; });
      if (!curve.length) return;
      var shares = 0;
      (hs || []).forEach(function (h) { if (h && h.shares > 0) shares += h.shares; });
      if (shares <= 0) return;
      var pts = curve.map(function (p) {
        var nav = Number.isFinite(p.nav) ? p.nav : 0;
        var mv = nav * shares;
        var chg = Number.isFinite(p.chg) ? p.chg : 0;
        var prevMv = chg === -100 ? mv : mv / (1 + chg / 100);
        return { time: p.time, mv: mv, prevMv: prevMv, profit: mv - prevMv, pct: prevMv > 0 ? (mv - prevMv) / prevMv * 100 : 0 };
      });
      series.push(pts);
    });
    if (!series.length) return [];
    var timeSet = {};
    series.forEach(function (pts) { pts.forEach(function (p) { timeSet[p.time] = true; }); });
    var times = Object.keys(timeSet).sort(function (a, b) { return timeToMin(a) - timeToMin(b); });
    return times.map(function (t) {
      var tm = timeToMin(t), totalMV = 0, totalPrev = 0;
      series.forEach(function (pts) {
        var last = null;
        for (var i = 0; i < pts.length; i++) {
          if (timeToMin(pts[i].time) <= tm) last = pts[i]; else break;
        }
        if (last) { totalMV += last.mv; totalPrev += last.prevMv; }
      });
      var profit = totalMV - totalPrev;
      return { time: t, profit: profit, pct: totalPrev > 0 ? profit / totalPrev * 100 : 0, mv: totalMV, prevMv: totalPrev };
    });
  }

  // ---------------- 刷新 ----------------
  function refreshOne(code) {
    var f = state.funds[code]; if (!f) return Promise.resolve();
    // 场内：腾讯实时价；场外：新浪盘中估值（JSONP）。两者并行取。
    var pPing = fetchPingzhong(code);
    var pSina = fetchSinaEstimate(code);
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
      // 新浪盘中估值：交易时段=盘中估算；收盘后保留“15:00 收盘预估”（带日期），直到今日净值更新。
      // 仅当本次成功取到且为今日数据时才覆盖；取失败则保留上一次的值。
      if (sn && sn.estimate && sn.estimate.date === todayStr()) f2.estimate = sn.estimate;
      if (sn && sn.curve && sn.curve.length >= 2) f2.estimateCurve = sn.curve;
      f2.updatedAt = Date.now(); save();
      if (ui.view === 'home' || ui.view === 'detail' || ui.view === 'portfolio') render();
    }).catch(function () {});
  }

  function refreshAll() {
    if (ui.refreshing) return;
    ui.refreshing = true; setSpin(true);
    var codes = Object.keys(state.funds);
    Promise.all(codes.map(function (code) { return refreshOne(code); }))
      .then(finishRefresh).catch(finishRefresh);
  }
  function finishRefresh() {
    ui.refreshing = false; ui.lastUpd = Date.now(); setSpin(false); render();
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
    view.classList.toggle('compact', ui.compact && (ui.view === 'home' || ui.view === 'portfolio'));
  }

  // 渲染列表：返回“卡片对象”数组 [{f, hs}]
  // 全部：按基金聚合所有分组持仓（一张卡）；分组：只取该组持仓
  function visibleFunds() {
    if (ui.filter === '全部') {
      var map = {};
      allPositions().forEach(function (p) {
        (map[p.code] = map[p.code] || { f: p.f, hs: [] }).hs.push(p.h);
      });
      return Object.keys(map).map(function (c) { return map[c]; });
    }
    return allPositions()
      .filter(function (p) { return (p.h.group || '') === ui.filter; })
      .map(function (p) { return { f: p.f, hs: [p.h] }; });
  }
  // 全部基金按 code 聚合为卡片对象（忽略当前筛选），供首页“全部”标签汇总
  function allCards() {
    var map = {};
    allPositions().forEach(function (p) { (map[p.code] = map[p.code] || { f: p.f, hs: [] }).hs.push(p.h); });
    return Object.keys(map).map(function (c) { return map[c]; });
  }
  // 某分组的卡片对象（每 holding 一张卡），供首页分组标签汇总
  function cardsOfGroup(g) {
    return allPositions().filter(function (p) { return (p.h.group || '') === g; })
      .map(function (p) { return { f: p.f, hs: [p.h] }; });
  }

  // 排序指标：历史累计收益(hold)/收益率(holdrate) + 今日预估收益(today)/收益率(todayrate)；无持仓按 0 计
  function sortMetrics(card) {
    var agg = aggregate(card.f, card.hs);
    return {
      hold: agg.totalProfit, holdrate: agg.totalProfitPct || 0,
      today: agg.today || 0, todayrate: agg.todayPct || 0
    };
  }
  function sortFunds(list) {
    var s = curSort();
    var asc = s.indexOf('_asc') >= 0;
    var key = s.replace('_asc', '').replace('_desc', ''); // hold / holdrate / today / todayrate
    return list.slice().sort(function (a, b) {
      var ma = sortMetrics(a), mb = sortMetrics(b);
      return (asc ? 1 : -1) * ((ma[key] || 0) - (mb[key] || 0));
    });
  }
  function sortLabel() {
    return {
      'hold_desc': '历史收益 ↓', 'hold_asc': '历史收益 ↑',
      'holdrate_desc': '历史收益率 ↓', 'holdrate_asc': '历史收益率 ↑',
      'today_desc': '今日预估 ↓', 'today_asc': '今日预估 ↑',
      'todayrate_desc': '今日预估率 ↓', 'todayrate_asc': '今日预估率 ↑'
    }[curSort()] || (ui.view === 'portfolio' ? '历史收益 ↓' : '今日预估 ↓');
  }
  // 排序 + 简洁 工具栏
  function toolbarHTML() {
    return '<div class="toolbar">' +
      '<button class="tbtn" data-act="openSort"><span class="tlabel">排序</span><span class="tval">' + sortLabel() + '</span><span class="tcaret">▾</span></button>' +
      '<button class="tbtn" data-act="toggleCompact"><span class="tlabel">简洁</span><span class="tval ' + (ui.compact ? 'on' : '') + '">' + (ui.compact ? '开' : '关') + '</span></button>' +
      '</div>';
  }

  function lastUpdText() { return ui.lastUpd ? ('更新 ' + nowHM()) : '未更新'; }

  // ---------------- 渲染：首页 ----------------
  function renderHome() {
    var open = marketOpen();
    var axisToday = curSort().indexOf('today') >= 0;
    var html = '';
    html += '<div class="market-row"><div class="market ' + (open ? 'open' : '') + '"><span class="dot"></span>' + (open ? '盘中交易中' : '非交易时段') + '</div><span class="upd">' + lastUpdText() + '</span></div>';
    // 分组标签栏：按当前排序口径显示历史收益或今日收益
    html += '<div class="gtabs">';
    var gtabSub = function (profit, count) {
      if (!count) return '';
      return '<span class="gtab-sub ' + (profit >= 0 ? 'up' : 'down') + '">' + (profit >= 0 ? '+' : '') + '¥' + fmt(Math.abs(profit), 0) + '</span>';
    };
    var allSummary = axisToday ? sumToday(allCards()) : sumHistory(allCards());
    html += '<button class="gtab ' + (ui.filter === '全部' ? 'on' : '') + '" data-act="filter" data-g="全部">全部' + gtabSub(allSummary.profit, allSummary.count) + '</button>';
    state.groups.forEach(function (g) {
      var gs = axisToday ? sumToday(cardsOfGroup(g)) : sumHistory(cardsOfGroup(g));
      html += '<button class="gtab ' + (ui.filter === g ? 'on' : '') + '" data-act="filter" data-g="' + esc(g) + '">' + esc(g) + gtabSub(gs.profit, gs.count) + '</button>';
    });
    html += '<button class="gtab add" data-act="newGroup">＋分组</button>';
    html += '</div>';

    // 当前范围汇总：今日排序 → 今日收益；历史排序 → 历史累计收益
    var sc = visibleFunds();
    var sum, scopeLabel, scopeBadge = '', pctText = '', pc, ppct;
    if (axisToday) {
      sum = sumToday(sc);
      var vlabel = currentValLabel();
      var sbMap = { '盘中实时': { t: '实时', c: 'live' }, '今日真实净值': { t: '真实净值', c: 'real' }, '收盘估值(预估)': { t: '收盘预估', c: 'est' } };
      var sb2 = sbMap[vlabel];
      scopeLabel = (ui.filter === '全部' ? '全部今日收益' : ('「' + ui.filter + '」今日收益')) + '（' + vlabel + '）';
      scopeBadge = sb2 ? '<span class="state-badge ' + sb2.c + '">' + sb2.t + '</span>' : '';
      pc = colorClass(sum.profit); ppct = sum.prevMv > 0 ? sum.profit / sum.prevMv * 100 : 0;
      pctText = '<span class="chg-pill ' + pc + '">' + (sum.profit >= 0 ? '+' : '') + fmt(ppct, 2) + '%</span>';
    } else {
      sum = sumHistory(sc);
      scopeLabel = ui.filter === '全部' ? '全部历史收益' : ('「' + ui.filter + '」历史收益');
      pc = colorClass(sum.profit); ppct = sum.cost > 0 ? sum.profit / sum.cost * 100 : 0;
      pctText = '<span class="chg-pill ' + pc + '">' + (sum.profit >= 0 ? '+' : '') + fmt(ppct, 2) + '%</span>';
      scopeBadge = '<span class="state-badge">历史</span>';
    }
    html += '<div class="section-h">' + esc(scopeLabel) + '</div>';
    if (sum.count > 0) {
      html += '<div class="fcard pf pf-click" data-act="openTodayChart"><div class="pf-row"><div class="pf-num ' + pc + '">' + (sum.profit >= 0 ? '+' : '') + '¥' + fmt(sum.profit, 2) + '</div><div class="pf-right">' + pctText + scopeBadge + '</div></div><div class="pf-hint">点击查看今日走势 ▸</div></div>';
    } else {
      html += '<div class="sum-empty">该范围暂无持仓 · 在基金详情里填份额和成本价后，这里显示' + (axisToday ? '今日收益' : '历史收益') + '</div>';
    }

    html += toolbarHTML();
    var list = sortFunds(visibleFunds());
    var cardMode = axisToday ? 'today' : 'history';
    if (ui.wide) {
      html += '<div class="home-grid">';
      html += '<div class="pane-list">' + (list.length ? list.map(function (card) { return cardHTML(card.f, card.hs, cardMode); }).join('') : emptyMini()) + '</div>';
      html += '<div class="pane-detail">' + detailInner(ui.selectedCode && state.funds[ui.selectedCode] ? ui.selectedCode : null) + '</div>';
      html += '</div>';
    } else {
      html += list.length ? list.map(function (card) { return cardHTML(card.f, card.hs, cardMode); }).join('') : '<div class="empty"><div class="big">📭</div>还没有基金<br>点右下角 “＋” 添加，或去“收益”页</div>';
    }
    view.innerHTML = html;
  }

  function emptyMini() { return '<div class="empty" style="padding:30px 10px">该分组暂无基金</div>'; }

  // 状态徽标：真实净值 / 最新净值(QDII滞后) / 盘中(新浪估值·交易中) / 收盘预估(新浪估值·15:00)
  function stateBadge(d) {
    if (d.navUpdated) return { t: '真实净值', c: 'real' };
    if (d.latestNav) return { t: '最新净值', c: 'real' };
    if (d.estimate && d.live) return { t: '盘中', c: 'live' };
    if (d.estimate) return { t: '收盘预估', c: 'est' };
    return null;
  }

  function cardHTML(f, hs, mode) {
    var d = displayOf(f), c = colorClass(d.chg);
    var agg = aggregate(f, hs || []);
    // 分组标签：多分组显示“N个分组”，单分组显示组名
    var grp = '';
    if ((hs || []).length > 1) grp = '<span class="grp-tag">' + (hs.length) + '个分组</span>';
    else if ((hs || []).length === 1 && (hs[0].group || '')) grp = '<span class="grp-tag">' + esc(hs[0].group) + '</span>';
    var isHistory = mode === 'history';
    var mainVal, mainCls, pctText, badge = '', mainLabel;
    if (isHistory || (agg.today == null && (agg.totalProfit !== 0 || agg.totalShares > 0))) {
      // 历史口径：累计收益 + 累计收益率
      mainVal = (agg.totalProfit >= 0 ? '+' : '−') + '¥' + fmt(Math.abs(agg.totalProfit), 0);
      mainCls = agg.totalProfit >= 0 ? 'up' : 'down';
      pctText = (agg.totalProfit >= 0 ? '+' : '') + fmt(agg.totalProfitPct, 2) + '%';
      badge = '<span class="state-badge">历史</span>';
      mainLabel = '历史收益';
    } else if (agg.today != null) {
      // 今日口径：按 displayOf 区分真实/收盘预估/盘中/最新净值
      mainVal = (agg.today >= 0 ? '+' : '−') + '¥' + fmt(Math.abs(agg.today), 0);
      mainCls = agg.today >= 0 ? 'up' : 'down';
      pctText = (agg.today >= 0 ? '+' : '') + fmt(agg.todayPct, 2) + '%';
      var sb = stateBadge(d);
      badge = sb ? '<span class="state-badge ' + sb.c + '">' + sb.t + '</span>' : '';
      if (d.real) mainLabel = '今日收益（真实）';
      else if (d.latestNav) mainLabel = '今日收益（最新净值）';
      else if (d.live) mainLabel = '今日预估（盘中）';
      else if (d.estimate) mainLabel = '今日预估（收盘）';
      else mainLabel = '今日收益';
    } else {
      // 无持仓/无今日数据，退回到涨跌幅
      mainVal = sign(d.chg) + fmt(d.chg, 2) + '%';
      mainCls = c;
      pctText = '';
      mainLabel = d.label;
    }
    var pctHtml = pctText ? ('<div class="chg-pill ' + mainCls + '">' + pctText + '</div>') : '';
    return '<div class="fcard" data-act="open" data-code="' + f.code + '">' +
      '<button class="del" data-act="del" data-code="' + f.code + '" title="删除">✕</button>' +
      '<div class="top"><div><div class="nm">' + esc(f.name || f.code) + '</div><div class="cd">' + f.code + (f.type ? (' · ' + esc(f.type)) : '') + '</div></div>' +
      '<div class="val"><div class="v ' + mainCls + '">' + mainVal + '</div>' + pctHtml + badge + '</div></div>' +
      '<div class="bot"><span>' + esc(mainLabel) + '</span></div>' + grp +
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
    var d = displayOf(f), c = colorClass(d.chg);
    var agg = aggregate(f, holdingsOf(f));
    var sb = stateBadge(d);
    var dBadge = sb ? '<span class="state-badge ' + sb.c + '">' + sb.t + '</span>' : '';
    var color = d.chg >= 0 ? '#EE2B3B' : '#0CA678';
    var nav = d.nav || 0;
    var groupsOpts = state.groups.map(function (g) { return '<option value="' + esc(g) + '" ' + ((f.group || '') === g ? 'selected' : '') + '>' + esc(g) + '</option>'; }).join('');
    var hasCurve = f.estimateCurve && f.estimateCurve.length >= 2;
    var spark = sparkSVG(hasCurve ? f.estimateCurve : f.history, 300, 140, color, hasCurve ? { timeField: 'time' } : null);
    var curveLabel = hasCurve ? (marketOpen() ? '今日盘中估值曲线（新浪）' : '今日估值曲线（新浪·至15:00）') : '历史净值走势';

    var html = '<div class="detail-wrap">';
    html += '<div class="detail-head"><div><div style="font-weight:700;font-size:16px">' + esc(f.name || f.code) + '</div><div style="font-size:12px;color:var(--sub)">' + f.code + (f.type ? (' · ' + esc(f.type)) : '') + '</div></div>';
    html += '<button class="icon-btn" data-act="back" style="background:transparent">✕</button></div>';
    html += '<div class="detail-big ' + c + '">' + fmt(nav) + '</div><div class="detail-ch"><span class="chg-pill ' + c + '">' + arrow(d.chg) + ' ' + sign(d.chg) + fmt(d.chg, 2) + '%</span> ' + dBadge + ' <span style="font-size:12.5px;color:var(--sub);font-weight:600">' + esc(d.label) + '</span></div>';
    if (d.navUpdated) {
      html += '<div class="est-note real">今日真实净值已更新（东财 ' + esc(f.lastDate) + '）· 以上为真实收益</div>';
    } else if (d.estimate) {
      var e = f.estimate;
      var tag = marketOpen() ? '盘中估值（新浪预估）' : '收盘估值（新浪预估·15:00）';
      html += '<div class="est-note">' + tag + '：' + fmt(e.nav) + ' · ' + arrow(e.chg) + ' ' + sign(e.chg) + fmt(e.chg, 2) + '%' + (marketOpen() ? (' @ ' + esc(e.time)) : '') + '</div>';
      if (e.chg2 != null && Math.abs(e.chg2 - e.chg) > 0.3) {
        html += '<div class="est-alt">另一口径：' + fmt(e.nav2) + ' · ' + fmt(e.chg2, 2) + '%</div>';
      }
    }
    html += '<div class="curve-label">' + curveLabel + '</div>';
    html += spark;
    html += '<div>';
    html += kv('净值日期', (f.lastDate || '—') + (f.lastDate === todayStr() ? '（今日·真实）' : ''));
    html += '</div>';
    // 持仓汇总（多分组聚合）
    html += '<div class="hold-sum">';
    html += kv('总市值', agg.totalMV > 0 ? ('¥' + fmt(agg.totalMV, 2)) : '—');
    html += kv('总收益', '<span class="' + (agg.totalProfit >= 0 ? 'up' : 'down') + '">' + (agg.totalProfit >= 0 ? '+' : '') + '¥' + fmt(agg.totalProfit, 2) + ' (' + (agg.totalProfit >= 0 ? '+' : '') + fmt(agg.totalProfitPct, 2) + '%)</span>');
    if (agg.today != null) {
      var tcls = agg.today >= 0 ? 'up' : 'down';
      var tsb = stateBadge(displayOf(f));
      var tbadge = tsb ? ' <span class="state-badge ' + tsb.c + '">' + tsb.t + '</span>' : '';
      html += kv('今日收益', '<span class="' + tcls + '">' + (agg.today >= 0 ? '+' : '') + '¥' + fmt(agg.today, 2) + '</span>' + tbadge);
    }
    html += '</div>';
    // 逐分组持仓列表（各自独立份额/成本）
    html += '<div style="font-weight:700;margin:14px 0 6px">分组持仓（' + holdingsOf(f).length + '）</div>';
    holdingsOf(f).forEach(function (h) {
      var hv = holdingDerived(f, h);
      var tp = todayProfitOf(f, h);
      var gname = h.group || '未分组';
      html += '<div class="hold-row">';
      html += '<div class="hr-top"><span class="grp-tag">' + esc(gname) + '</span>';
      html += '<span class="hr-acts"><button class="hr-btn" data-act="editHold" data-code="' + f.code + '" data-group="' + esc(h.group || '') + '">编辑</button>';
      html += '<button class="hr-btn del" data-act="delHold" data-code="' + f.code + '" data-group="' + esc(h.group || '') + '">删除</button></span></div>';
      if (hv) {
        html += '<div class="hr-info">份额 ' + fmt(hv.shares, 0) + ' · 成本 ' + fmt(hv.cost, 4) + ' · 市值 ¥' + fmt(hv.marketValue, 0) + ' · 收益 <span class="' + (hv.profit >= 0 ? 'up' : 'down') + '">' + (hv.profit >= 0 ? '+' : '') + '¥' + fmt(hv.profit, 2) + '</span>';
        if (tp != null) html += ' · 今日 <span class="' + (tp >= 0 ? 'up' : 'down') + '">' + (tp >= 0 ? '+' : '') + '¥' + fmt(tp, 2) + '</span>';
        html += '</div>';
      } else {
        html += '<div class="hr-info">尚未设置份额 / 成本</div>';
      }
      html += '</div>';
    });
    html += '<button class="btn btn-primary" data-act="addHold" data-code="' + f.code + '" style="margin-top:10px;width:100%">＋ 添加分组持仓</button>';
    html += '<button class="btn btn-ghost" data-act="del" data-code="' + f.code + '" style="color:var(--brand);margin-top:8px;width:100%">删除该基金</button>';
    html += '</div>';
    return html;
  }

  function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><span>' + v + '</span></div>'; }

  function renderDetail() { view.innerHTML = detailInner(ui.selectedCode); }

  // ---------------- 渲染：收益 ----------------
  function renderPortfolio() {
    var pos = allPositions().filter(function (p) { return p.h.shares > 0; });
    var totMV = 0, totCost = 0, totProfit = 0;
    pos.forEach(function (p) {
      var hv = holdingDerived(p.f, p.h); if (hv) { totMV += hv.marketValue; totCost += hv.cost * hv.shares; totProfit += hv.profit; }
    });
    var pct = totCost > 0 ? totProfit / totCost * 100 : 0;
    var c = colorClass(totProfit);
    var html = '';
    html += '<div class="section-h">持仓总览（' + currentValLabel() + '）</div>';
    html += '<div class="fcard pf"><div class="pf-row"><div class="pf-num ' + c + '">' + (totProfit >= 0 ? '+' : '') + '¥' + fmt(totProfit, 2) + '</div><div class="chg-pill ' + c + '">' + (totProfit >= 0 ? '+' : '') + fmt(pct, 2) + '%</div></div>';
    html += '<div class="pstats"><div class="ps"><div class="pl">总市值</div><div class="pv">¥' + fmt(totMV, 2) + '</div></div><div class="ps"><div class="pl">总成本</div><div class="pv">¥' + fmt(totCost, 2) + '</div></div></div>';
    html += toolbarHTML();
    // 按基金聚合（多分组合并成一只）
    var map = {};
    pos.forEach(function (p) { (map[p.code] = map[p.code] || { f: p.f, hs: [] }).hs.push(p.h); });
    var cards = Object.keys(map).map(function (c) { return map[c]; });
    var axisToday = curSort().indexOf('today') >= 0;
    cards = sortFunds(cards);
    html += '<div class="section-h">逐只明细（' + cards.length + '）</div>';
    if (!cards.length) {
      html += '<div class="empty"><div class="big">💰</div>还没有设置持仓<br>在基金详情里填份额和成本价</div>';
    } else {
      cards.forEach(function (card) {
        var f = card.f, agg = aggregate(f, card.hs), d = displayOf(f);
        var valText, valCls, pctText, badge = '';
        if (axisToday && agg.today != null) {
          var sb = stateBadge(d);
          badge = sb ? '<span class="state-badge ' + sb.c + '">' + sb.t + '</span>' : '';
          valText = (agg.today >= 0 ? '+' : '−') + '¥' + fmt(Math.abs(agg.today), 0);
          valCls = agg.today >= 0 ? 'up' : 'down';
          pctText = (agg.today >= 0 ? '+' : '') + fmt(agg.todayPct, 2) + '%';
        } else {
          valText = (agg.totalProfit >= 0 ? '+' : '−') + '¥' + fmt(Math.abs(agg.totalProfit), 0);
          valCls = agg.totalProfit >= 0 ? 'up' : 'down';
          pctText = (agg.totalProfit >= 0 ? '+' : '') + fmt(agg.totalProfitPct, 2) + '%';
          if (axisToday) badge = '<span class="state-badge est">无今日数据</span>';
        }
        var grpTxt = card.hs.length > 1 ? (card.hs.length + '个分组') : ((card.hs[0] && (card.hs[0].group || '')) || '');
        html += '<div class="fcard" data-act="open" data-code="' + f.code + '"><div class="top"><div><div class="nm">' + esc(f.name || f.code) + '</div><div class="cd">' + f.code + '</div></div>';
        html += '<div class="val"><div class="v ' + valCls + '">' + valText + '</div><div class="chg-pill ' + valCls + '">' + pctText + '</div>' + badge + '</div></div>';
        var valLabelTxt;
        if (axisToday && agg.today != null) {
          if (d.navUpdated) valLabelTxt = '今日收益(真实)';
          else if (d.estimate) valLabelTxt = '今日预估';
          else if (d.latestNav) valLabelTxt = '今日收益(最新净值)';
          else valLabelTxt = '今日收益';
        } else {
          valLabelTxt = '历史收益';
        }
        html += '<div class="bot"><span>' + valLabelTxt + '</span><span>市值 ¥' + fmt(agg.totalMV, 0) + '</span><span>成本 ¥' + fmt(agg.totalCost, 0) + '</span>' + (grpTxt ? ('<span class="grp-tag">' + esc(grpTxt) + '</span>') : '') + '</div></div>';
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
        var af = state.funds[r.code];
        var added = af && holdingIn(af, ui.searchTargets[r.code] || '');
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
      var count = allPositions().filter(function (p) { return (p.h.group || '') === g; }).length;
      html += '<div class="gitem"><span class="gname">' + esc(g) + '</span><span class="gcount">' + count + ' 只</span>';
      html += '<button class="gact" data-act="renameGroup" data-g="' + esc(g) + '">✎</button><button class="gact del" data-act="delGroup" data-g="' + esc(g) + '">🗑</button></div>';
    });
    html += '<button class="btn btn-primary" data-act="newGroup" style="margin-top:14px">＋ 新建分组</button>';
    // 数据导入导出（Excel）
    html += '<div class="section-h">数据导入导出（Excel）</div>';
    html += '<div class="io-note">表格列：<b>分组 · 基金代码 · 基金名称(可留空) · 成本价 · 持有份额</b>。导入按“基金代码”合并更新，不会删除已有基金；名称留空会自动联网获取。</div>';
    html += '<div class="io-btns">' +
      '<button class="btn btn-primary" data-act="exportExcel">导出 Excel</button>' +
      '<button class="btn btn-ghost" data-act="exportTemplate">下载空白模板</button>' +
      '<button class="btn btn-ghost" data-act="pickExcel">导入 Excel</button>' +
      '</div>';
    view.innerHTML = html;
  }

  // ---------------- 动作 ----------------
  function doSearch() {
    var kw = (ui.searchKw || '').trim(); if (!kw) return;
    ui.view = 'add'; ui.searching = true; ui.searchResults = []; render();
    searchFunds(kw).then(function (list) {
      ui.searching = false; ui.searchResults = list;
      var defG = (state.groups.indexOf(ui.filter) >= 0) ? ui.filter : (state.defaultGroup || (state.groups[0] || ''));
      list.forEach(function (r) { if (!(r.code in ui.searchTargets)) ui.searchTargets[r.code] = defG; });
      render();
    });
  }
  // 添加基金到某分组（同一基金可加多个分组，各自独立持仓）
  function addFund(code) {
    var r = ui.searchResults.filter(function (x) { return x.code === code; })[0] || { code: code, name: '', type: '' };
    var name = r.name || code;
    var sel = document.querySelector('select.grp-sel[data-code="' + code + '"]');
    var group = (sel && sel.value) || ui.searchTargets[code] || '';
    var f = state.funds[code];
    toast('正在添加…');
    if (!f) {
      f = { code: code, name: name, type: r.type || '', exchangeTraded: false, holdings: [], history: [], lastNav: null, lastChg: 0, lastDate: '', live: null, estimate: null, estimateCurve: null, updatedAt: 0 };
      state.funds[code] = f;
    }
    if (holdingIn(f, group)) { toast(name + ' 已在「' + (group || '未分组') + '」'); return; }
    upsertHolding(f, group, 0, 0);
    save(); render();
    toast('已加入「' + (group || '未分组') + '」· ' + name);
    refreshOne(code);
  }
  function deleteFund(code) {
    delete state.funds[code];
    if (ui.selectedCode === code) ui.selectedCode = null;
    save();
    if (ui.wide && ui.view === 'home') renderHome(); else render();
  }
  // 把基金加入选中分组（保留其他分组 —— 支持同一基金多分组）
  function moveGroup(code, group) {
    var f = state.funds[code]; if (!f) return;
    if (holdingIn(f, group)) { toast('已在「' + (group || '未分组') + '」'); return; }
    upsertHolding(f, group, 0, 0);
    save(); render(); toast('已加入「' + (group || '未分组') + '」');
  }
  // 保存某分组的持仓（份额/成本），由详情页 modal 回调
  function saveHold(code, group, shares, cost) {
    var f = state.funds[code]; if (!f) return;
    upsertHolding(f, group, shares, cost);
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
      Object.keys(state.funds).forEach(function (k) {
        holdingsOf(state.funds[k]).forEach(function (h) { if ((h.group || '') === g) h.group = newn; });
      });
      var i = state.groups.indexOf(g); if (i >= 0) state.groups[i] = newn;
      if (state.defaultGroup === g) state.defaultGroup = newn;
      save(); render();
    });
  }
  function delGroup(g) {
    confirmModal('删除分组“' + g + '”？组内持仓会回到“未分组”，不会被删除。', function () {
      Object.keys(state.funds).forEach(function (k) {
        state.funds[k].holdings = holdingsOf(state.funds[k]).filter(function (h) { return (h.group || '') !== g; });
      });
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
  // 多分组持仓编辑：add=新增某组持仓；edit=编辑已有分组持仓
  function openHoldModal(code, mode, group) {
    var f = state.funds[code]; if (!f) return;
    var g = group || '';
    var ex = holdingIn(f, g);
    var shares = ex ? ex.shares : '', cost = ex ? ex.costPrice : '';
    var sel = '<select id="modalGroup" style="width:100%;border:1px solid var(--line);border-radius:10px;padding:10px;font-size:14px;background:var(--card);color:var(--txt)"><option value="">（未分组）</option>';
    state.groups.forEach(function (gg) { sel += '<option value="' + esc(gg) + '" ' + ((mode === 'edit' ? g : (ui.searchTargets[code] || '')) === gg ? 'selected' : '') + '>' + esc(gg) + '</option>'; });
    sel += '</select>';
    var grpField = mode === 'edit'
      ? '<div style="font-size:13px;color:var(--sub);margin-bottom:8px">分组：<b>' + esc(g || '未分组') + '</b></div>'
      : '<label style="font-size:12px;color:var(--sub)">所属分组</label>' + sel;
    var root = $('#modalRoot');
    root.innerHTML = '<div class="modal-mask"><div class="modal"><h3>' + (mode === 'edit' ? '编辑持仓' : '添加分组持仓') + '</h3>' +
      grpField +
      '<label style="font-size:12px;color:var(--sub);margin-top:8px;display:block">持有份额</label><input id="modalShares" type="number" inputmode="decimal" value="' + shares + '" placeholder="如 1000"/>' +
      '<label style="font-size:12px;color:var(--sub);margin-top:8px;display:block">成本价</label><input id="modalCost" type="number" inputmode="decimal" value="' + cost + '" placeholder="如 1.2345"/>' +
      '<div class="mrow"><button class="cancel" data-m="cancel">取消</button><button class="ok" data-m="ok">保存</button></div></div></div>';
    root.querySelector('[data-m="ok"]').onclick = function () {
      var ng = mode === 'edit' ? g : (root.querySelector('#modalGroup').value || '');
      var s = parseFloat(root.querySelector('#modalShares').value);
      var c = parseFloat(root.querySelector('#modalCost').value);
      root.innerHTML = '';
      if (mode === 'edit') upsertHolding(f, g, s, c);
      else upsertHolding(f, ng, s, c);
      save(); render(); toast('持仓已保存');
    };
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

  // 绘制今日收益/收益率走势图（支持收益/收益率切换，盈亏线上方红色/下方绿色分段）
  function renderTrendChart(data, mode, w, h) {
    mode = mode || 'profit';
    if (!data || data.length < 2) return { svg: '<div class="trend-empty">暂无足够今日估值曲线数据</div>', meta: null };
    var vals = data.map(function (p) { return mode === 'profit' ? p.profit : p.pct; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var rng = (max - min) || 1;
    var padT = 10, padB = 18, plotH = h - padT - padB;
    var zeroY = padT + plotH - ((0 - min) / rng) * plotH;
    var pts = data.map(function (p) {
      var v = mode === 'profit' ? p.profit : p.pct;
      var x = timeToX(timeToMin(p.time), w);
      var y = padT + plotH - ((v - min) / rng) * plotH;
      return { x: x, y: y, t: p.time };
    });
    // 零线上方（收益>0）用红色，下方（收益<0）用绿色；按零线拆分线段与填充区
    function signOf(y) { return y < zeroY ? 1 : (y > zeroY ? -1 : 0); }
    function colorOf(s) { return s > 0 ? 'var(--up)' : 'var(--down)'; }
    var segments = [];
    var cur = [pts[0]];
    var curSign = signOf(pts[0].y);
    for (var i = 1; i < pts.length; i++) {
      var p = pts[i], s = signOf(p.y);
      if (s === 0) s = curSign; // 恰在零线上，继承当前段
      if (s !== curSign && curSign !== 0) {
        var prev = pts[i - 1];
        var r = (zeroY - prev.y) / (p.y - prev.y);
        var ix = prev.x + (p.x - prev.x) * r;
        var inter = { x: ix, y: zeroY };
        cur.push(inter);
        segments.push({ sign: curSign, pts: cur });
        cur = [inter];
        curSign = s;
      }
      cur.push(p);
    }
    if (cur.length) segments.push({ sign: curSign, pts: cur });
    // 水平网格线
    var gridLines = '';
    for (var gi = 0; gi <= 2; gi++) {
      var gy = padT + (plotH * gi) / 2;
      gridLines += '<line x1="0" y1="' + gy.toFixed(1) + '" x2="' + w + '" y2="' + gy.toFixed(1) + '" stroke="var(--line)" stroke-width="1" stroke-dasharray="3,3" opacity="0.6"/>';
    }
    // 时间标签
    var times = [{ t: '9:30', a: 'start' }, { t: '11:30', a: 'middle' }, { t: '13:00', a: 'middle' }, { t: '15:00', a: 'end' }];
    var labels = times.map(function (o) {
      var x = timeToX(timeToMin(o.t), w);
      return '<text x="' + x + '" y="' + (h - 4) + '" text-anchor="' + o.a + '" font-size="10" fill="var(--sub)" font-weight="600">' + o.t + '</text>';
    }).join('');
    // 分段填充与折线
    var fills = '', lines = '';
    segments.forEach(function (seg) {
      var color = colorOf(seg.sign);
      var first = seg.pts[0], last = seg.pts[seg.pts.length - 1];
      var line = seg.pts.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
      var area = first.x.toFixed(1) + ',' + zeroY.toFixed(1) + ' ' + line + ' ' + last.x.toFixed(1) + ',' + zeroY.toFixed(1);
      fills += '<polygon points="' + area + '" fill="' + color + '" fill-opacity="0.10" stroke="none"></polygon>';
      lines += '<polyline points="' + line + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></polyline>';
    });
    return {
      svg: '<svg class="trend-chart" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
        gridLines +
        '<line x1="0" y1="' + zeroY.toFixed(1) + '" x2="' + w + '" y2="' + zeroY.toFixed(1) + '" stroke="var(--sub)" stroke-width="1" opacity="0.25"/>' +
        fills + lines + labels + '</svg>',
      meta: { min: min, rng: rng, padT: padT, plotH: plotH, w: w, h: h, zeroY: zeroY }
    };
  }

  function openTodayChart() {
    var scope = ui.filter || '全部';
    var cards = scope === '全部' ? allCards() : cardsOfGroup(scope);
    var data = calcTodayTrend(cards);
    var root = $('#modalRoot');
    var mode = ui.trendMode || 'profit'; // 'profit' | 'rate'
    var last = data && data.length ? data[data.length - 1] : null;
    var vlabel = currentValLabel();
    var sbMap = { '盘中实时': { t: '实时', c: 'live' }, '今日真实净值': { t: '真实净值', c: 'real' }, '收盘估值(预估)': { t: '收盘预估', c: 'est' } };
    var sb2 = sbMap[vlabel] || { t: '预估', c: 'est' };
    var title = (scope === '全部' ? '全部' : esc(scope)) + ' · 今日走势';
    var numVal = last ? (mode === 'profit' ? last.profit : last.pct) : 0;
    var numCls = numVal >= 0 ? 'up' : 'down';
    var numTxt = (mode === 'profit'
      ? (numVal >= 0 ? '+' : '−') + '¥' + fmt(Math.abs(numVal), 2)
      : (numVal >= 0 ? '+' : '') + fmt(numVal, 2) + '%');
    var subProfitTxt = last ? ((last.profit >= 0 ? '+' : '−') + '¥' + fmt(Math.abs(last.profit), 2)) : '—';
    var subRateTxt = last ? ((last.pct >= 0 ? '+' : '') + fmt(last.pct, 2) + '%') : '—';
    var chart = renderTrendChart(data, mode, 360, 190);
    var svg = chart.svg, meta = chart.meta;
    var dragHTML = meta ? '<div class="cc" id="cc"><div class="cc-line" id="ccLine"></div><div class="cc-tip" id="ccTip"></div></div>' : '';
    root.innerHTML = '<div class="modal-mask page-modal">' +
      '<div class="chart-page">' +
        '<div class="chart-head"><button class="icon-btn back" data-m="close">←</button><div class="chart-title">' + title + '</div><div style="width:44px"></div></div>' +
        '<div class="chart-body">' +
          '<div class="chart-big ' + numCls + '">' +
            '<div class="chart-big-label" id="cBigLabel">' + (mode === 'profit' ? '当前预估收益' : '当前预估收益率') + '</div>' +
            '<div class="chart-big-num" id="cBigNum">' + numTxt + '</div>' +
            '<div class="chart-big-row" id="cBigRow">' +
              '<span class="cb-item"><b>' + subProfitTxt + '</b>收益</span>' +
              '<span class="cb-item"><b>' + subRateTxt + '</b>收益率</span>' +
              '<span class="state-badge ' + sb2.c + '">' + sb2.t + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="chart-toggle">' +
            '<button class="tog ' + (mode === 'profit' ? 'on' : '') + '" data-m="modeProfit">收益</button>' +
            '<button class="tog ' + (mode === 'rate' ? 'on' : '') + '" data-m="modeRate">收益率</button>' +
          '</div>' +
          '<div class="chart-wrap" id="cWrap">' + svg + dragHTML + '</div>' +
          '<div class="chart-note">按当前筛选范围汇总 · 数据来源：新浪盘中估值曲线 · 横轴可拖动查看任意时刻</div>' +
        '</div>' +
      '</div>' +
    '</div>';
    root.querySelector('[data-m="close"]').onclick = function () { root.innerHTML = ''; };
    root.querySelector('[data-m="modeProfit"]').onclick = function () { ui.trendMode = 'profit'; openTodayChart(); };
    root.querySelector('[data-m="modeRate"]').onclick = function () { ui.trendMode = 'rate'; openTodayChart(); };
    root.querySelector('.modal-mask').onclick = function (ev) { if (ev.target.classList.contains('modal-mask')) root.innerHTML = ''; };
    if (meta && data && data.length) bindChartDrag(data, meta, mode, scope, sb2, { numCls: numCls, numTxt: numTxt, subProfitTxt: subProfitTxt, subRateTxt: subRateTxt, sb2: sb2 });
  }

  // 横轴拖动：显示任意时刻的盈亏值 / 收益率
  function bindChartDrag(data, meta, mode, scope, sb2, lastView) {
    var root = $('#modalRoot');
    var wrap = root.querySelector('#cWrap');
    var cc = root.querySelector('#cc');
    var ccLine = root.querySelector('#ccLine');
    var ccTip = root.querySelector('#ccTip');
    var bigEl = root.querySelector('.chart-big');
    var bigLabel = root.querySelector('#cBigLabel');
    var bigNum = root.querySelector('#cBigNum');
    var bigRow = root.querySelector('#cBigRow');
    if (!wrap) return;
    var ts = data.map(function (d) { return timeToMin(d.time); });
    function xToMinFromX(x, w) {
      var half = w * 0.5;
      if (x <= half) return 570 + (x / half) * 120; // 9:30–11:30
      return 780 + ((x - half) / half) * 120;        // 13:00–15:00
    }
    function minToTime(m) {
      m = Math.round(m); var hh = Math.floor(m / 60), mm = m % 60;
      return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
    }
    function interpolateAt(xvb) {
      var t = xToMinFromX(xvb, meta.w);
      var a = 0, b = ts.length - 1;
      if (t <= ts[0]) { a = b = 0; }
      else if (t >= ts[ts.length - 1]) { a = b = ts.length - 1; }
      else { for (var i = 0; i < ts.length - 1; i++) { if (t >= ts[i] && t <= ts[i + 1]) { a = i; b = i + 1; break; } } }
      var profit, pct;
      if (a === b) { profit = data[a].profit; pct = data[a].pct; }
      else {
        var r = (t - ts[a]) / (ts[b] - ts[a]);
        profit = data[a].profit + (data[b].profit - data[a].profit) * r;
        pct = data[a].pct + (data[b].pct - data[a].pct) * r;
      }
      var v = mode === 'profit' ? profit : pct;
      var y = meta.padT + meta.plotH - ((v - meta.min) / meta.rng) * meta.plotH;
      return { time: minToTime(t), profit: profit, pct: pct, v: v, y: y };
    }
    function showAt(xvb) {
      var r = interpolateAt(xvb);
      var pctLeft = (xvb / meta.w) * 100;
      var pctTop = (r.y / meta.h) * 100;
      cc.style.display = 'block';
      ccLine.style.left = pctLeft + '%';
      ccTip.style.left = pctLeft + '%';
      ccTip.style.top = pctTop + '%';
      var up = r.v >= 0;
      ccTip.className = 'cc-tip ' + (up ? 'up' : 'down');
      ccTip.innerHTML = '<div class="cc-time">' + r.time + '</div>' +
        '<div class="cc-row"><span>收益</span><b>' + (r.profit >= 0 ? '+' : '−') + '¥' + fmt(Math.abs(r.profit), 2) + '</b></div>' +
        '<div class="cc-row"><span>收益率</span><b>' + (r.pct >= 0 ? '+' : '') + fmt(r.pct, 2) + '%</b></div>';
      var nv = r.v;
      bigEl.className = 'chart-big ' + (up ? 'up' : 'down');
      bigLabel.textContent = mode === 'profit' ? '该时刻预估收益' : '该时刻预估收益率';
      bigNum.textContent = mode === 'profit'
        ? (nv >= 0 ? '+' : '−') + '¥' + fmt(Math.abs(nv), 2)
        : (nv >= 0 ? '+' : '') + fmt(nv, 2) + '%';
      bigRow.innerHTML = '<span class="cb-item"><b>' + (r.profit >= 0 ? '+' : '−') + '¥' + fmt(Math.abs(r.profit), 2) + '</b>收益</span>' +
        '<span class="cb-item"><b>' + (r.pct >= 0 ? '+' : '') + fmt(r.pct, 2) + '%</b>收益率</span>';
    }
    function resetToLast() {
      cc.style.display = 'none';
      bigEl.className = 'chart-big ' + lastView.numCls;
      bigLabel.textContent = mode === 'profit' ? '当前预估收益' : '当前预估收益率';
      bigNum.textContent = lastView.numTxt;
      bigRow.innerHTML = '<span class="cb-item"><b>' + lastView.subProfitTxt + '</b>收益</span>' +
        '<span class="cb-item"><b>' + lastView.subRateTxt + '</b>收益率</span>' +
        '<span class="state-badge ' + lastView.sb2.c + '">' + lastView.sb2.t + '</span>';
    }
    var dragging = false;
    function xvbFromEv(ev) {
      var rect = wrap.getBoundingClientRect();
      var x = (ev.clientX - rect.left) / rect.width * meta.w;
      return Math.max(0, Math.min(meta.w, x));
    }
    wrap.addEventListener('pointerdown', function (ev) {
      dragging = true;
      try { wrap.setPointerCapture(ev.pointerId); } catch (e) {}
      showAt(xvbFromEv(ev));
      ev.preventDefault();
    });
    wrap.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      showAt(xvbFromEv(ev));
      ev.preventDefault();
    });
    function endDrag(ev) { if (dragging) { dragging = false; resetToLast(); } }
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);
    wrap.addEventListener('pointerleave', function (ev) { if (dragging) { try { wrap.releasePointerCapture(ev.pointerId); } catch (e) {} } });
  }

  function openSortSheet() {
    var root = $('#modalRoot');
    var opts = ui.view === 'portfolio' ? [
      { s: 'hold_desc', t: '历史收益（高 → 低）' },
      { s: 'hold_asc', t: '历史收益（低 → 高）' },
      { s: 'holdrate_desc', t: '历史收益率（高 → 低）' },
      { s: 'holdrate_asc', t: '历史收益率（低 → 高）' }
    ] : [
      { s: 'today_desc', t: '今日预估（高 → 低）' },
      { s: 'today_asc', t: '今日预估（低 → 高）' },
      { s: 'todayrate_desc', t: '今日预估率（高 → 低）' },
      { s: 'todayrate_asc', t: '今日预估率（低 → 高）' }
    ];
    var html = '<div class="modal-mask"><div class="sheet">';
    html += '<div class="stitle">排序方式</div>';
    opts.forEach(function (o) {
      var sel = curSort() === o.s ? ' sel' : '';
      var ck = (curSort() === o.s) ? '<span class="check">✓</span>' : '<span class="check" style="opacity:0">✓</span>';
      html += '<div class="opt' + sel + '" data-act="setSort" data-s="' + o.s + '"><span>' + o.t + '</span>' + ck + '</div>';
    });
    html += '<div class="divider"></div>';
    html += '<div class="stitle">显示</div>';
    html += '<div class="opt" data-act="toggleCompactSheet"><span>简洁模式（卡片更紧凑，一屏看更多）</span>' +
      '<span class="switch ' + (ui.compact ? 'on' : '') + '"><span class="knob"></span></span></div>';
    html += '<div class="sheet-done"><button class="btn btn-primary" data-act="closeSheet">完成</button></div>';
    html += '</div></div>';
    root.innerHTML = html;
    root.querySelector('.modal-mask').onclick = function (ev) { if (ev.target.classList.contains('modal-mask')) root.innerHTML = ''; };
  }
  function openInfo() {
    infoModal('<p>数据来自东方财富、腾讯、新浪的公开接口（跨域脚本/JSONP 注入获取，纯前端、无后端、无账号）。</p>' +
      '<p><b>场外开放基金</b>：用<b>新浪盘中估值曲线</b>展示交易时段的<b>实时估值</b>（逐分钟更新，带今日时间戳）；非交易时段回落到最新确认净值 + 历史走势。天天基金 fundgz 接口已于 2026 年停用，已由新浪替代。</p>' +
      '<p><b>场内基金（ETF / LOF）</b>：用腾讯实时行情展示<b>盘中实时价</b>（即实时市价，比估算更准）。添加时按代码段自动识别；也可在详情页手动开关“场内基金”。</p>' +
      '<p>新浪估值有两个口径，差异较大时详情页会并列提示。实时价 / 估值 ≠ 官方净值，仅供参考，不构成投资建议。</p>' +
      '<p><b>状态区分（徽标）</b>：<span style="color:#0CA678;font-weight:700">实时/盘中</span>=交易时段估值；<span style="color:#B45309;font-weight:700">收盘预估</span>=15:00 收盘估值（净值更新前）；<span style="color:#4F46E5;font-weight:700">真实净值/真实</span>=今日官方净值已更新（东财）或场内收盘价。净值更新后主数字为真实收益。</p>');
  }

  // ---------------- Excel 导入导出（SheetJS，同源加载，离线可缓存） ----------------
  // 表格列：分组 / 基金代码 / 基金名称(可留空) / 成本价 / 持有份额
  var EXCEL_HEAD = ['分组', '基金代码', '基金名称', '成本价', '持有份额'];
  function aoaSheet(aoa, name) {
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 10 }, { wch: 12 }, { wch: 26 }, { wch: 12 }, { wch: 12 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, name || '持仓');
    return wb;
  }
  function exportExcel() {
    if (typeof XLSX === 'undefined') { toast('Excel 组件未加载，请刷新重试'); return; }
    var pos = allPositions().filter(function (p) { return (p.h.shares > 0) || (p.h.costPrice > 0); });
    pos.sort(function (a, b) {
      var ga = (a.h.group || ''), gb = (b.h.group || '');
      if (ga !== gb) return ga < gb ? -1 : 1;
      return a.code < b.code ? -1 : 1;
    });
    var aoa = [EXCEL_HEAD.slice()];
    pos.forEach(function (p) { aoa.push([p.h.group || '', p.code, p.f.name || '', p.h.costPrice || 0, p.h.shares || 0]); });
    XLSX.writeFile(aoaSheet(aoa, '持仓'), '估值宝_持仓_' + todayStr() + '.xlsx');
    toast('已导出 ' + pos.length + ' 条持仓');
  }
  function exportTemplate() {
    if (typeof XLSX === 'undefined') { toast('Excel 组件未加载，请刷新重试'); return; }
    // 示例演示“同一基金可挂在多个分组”（110011 在 示例组A / 示例组B 各一笔）
    var aoa = [
      EXCEL_HEAD.slice(),
      ['示例组A', '110011', '易方达中小盘（名称可留空）', 1.0000, 1000],
      ['示例组B', '110011', '', 1.0000, 500],
      ['', '005827', '', 2.5000, 500]
    ];
    XLSX.writeFile(aoaSheet(aoa, '模板'), '估值宝_持仓模板.xlsx');
    toast('已下载空白模板');
  }
  function importExcel(file) {
    if (typeof XLSX === 'undefined') { toast('Excel 组件未加载，请刷新重试'); return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(e.target.result, { type: 'binary' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
        processExcelRows(rows);
      } catch (err) {
        toast('导入失败：文件格式不支持');
      }
    };
    reader.readAsBinaryString(file);
  }
  function processExcelRows(rows) {
    var headerIdx = -1, header = null;
    var isHeaderCell = function (c) {
      var s = ('' + c).trim().toLowerCase();
      return ('' + c).indexOf('基金代码') >= 0 || s === 'code' || s === '代码';
    };
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r && r.some(isHeaderCell)) { headerIdx = i; header = r; break; }
    }
    if (headerIdx < 0) { toast('未找到表头（需含“基金代码”列）'); return; }
    var idx = function (names) {
      for (var j = 0; j < header.length; j++) {
        var h = ('' + header[j]).trim();
        for (var k = 0; k < names.length; k++) if (h === names[k]) return j;
      }
      return -1;
    };
    var ci = idx(['基金代码', '代码', 'code']);
    var gi = idx(['分组', '组', 'group']);
    var ni = idx(['基金名称', '名称', 'name']);
    var coi = idx(['成本价', '成本', 'cost']);
    var si = idx(['持有份额', '份额', 'shares']);
    if (ci < 0) { toast('表头缺少“基金代码”列'); return; }
    var added = 0, updated = 0;
    for (var i = headerIdx + 1; i < rows.length; i++) {
      var row = rows[i]; if (!row) continue;
      var code = ('' + (row[ci] || '')).replace(/\s/g, '');
      if (!code) continue;
      var group = gi >= 0 ? ('' + (row[gi] || '')).trim() : '';
      var name = ni >= 0 ? ('' + (row[ni] || '')).trim() : '';
      var cost = coi >= 0 ? parseFloat(row[coi]) : NaN;
      var shares = si >= 0 ? parseFloat(row[si]) : NaN;
      var f = state.funds[code];
      if (!f) {
        if (!state.defaultGroup && group) state.defaultGroup = group;
        if (group && state.groups.indexOf(group) < 0) state.groups.push(group);
        f = {
          code: code, name: name, type: '',
          exchangeTraded: false,
          holdings: [], history: [], lastNav: null, lastChg: 0, lastDate: '', live: null, estimate: null, estimateCurve: null, updatedAt: 0
        };
        state.funds[code] = f;
        added++;
      } else {
        if (name && !f.name) f.name = name;
      }
      // 按 代码+分组 追加/更新持仓（同一基金可多分组）
      upsertHolding(f, group, shares, cost);
      updated++;
    }
    save();
    toast('导入完成：新增 ' + added + ' 只，更新 ' + updated + ' 只');
    refreshAll();
    render();
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
        case 'addHold': openHoldModal(code, 'add'); break;
        case 'editHold': openHoldModal(code, 'edit', g); break;
        case 'delHold': (function () {
          var f = state.funds[code]; if (!f) return;
          var gg = g || ''; var grpName = gg || '未分组';
          confirmModal('删除「' + grpName + '」下的该基金持仓？', function () { removeHolding(f, gg); save(); render(); });
        })(); break;
        case 'newGroup': newGroup(); break;
        case 'renameGroup': renameGroup(g); break;
        case 'delGroup': delGroup(g); break;
        case 'openSort': openSortSheet(); break;
        case 'setSort': setCurSort(el.dataset.s); save(); render(); openSortSheet(); break;
        case 'toggleCompact': ui.compact = !ui.compact; save(); render(); break;
        case 'toggleCompactSheet': ui.compact = !ui.compact; save(); render(); openSortSheet(); break;
        case 'closeSheet': if ($('#modalRoot')) $('#modalRoot').innerHTML = ''; break;
        case 'openTodayChart': openTodayChart(); break;
        case 'exportExcel': exportExcel(); break;
        case 'exportTemplate': exportTemplate(); break;
        case 'pickExcel': var fi = document.getElementById('fileExcel'); if (fi) fi.click(); break;
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
    // Excel 导入：常驻隐藏文件选择框 + 监听
    var fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.id = 'fileExcel';
    fileInput.accept = '.xlsx,.xls,.csv'; fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (file) importExcel(file);
      e.target.value = ''; // 允许重复导入同一文件
    });
    window.addEventListener('resize', function () {
      var w = window.matchMedia('(min-width:840px)').matches;
      if (w !== ui.wide) { ui.wide = w; if (ui.view === 'home' || ui.view === 'detail') render(); }
    });
    if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('sw.js?v=18').catch(function () {}); } catch (e) {} }
    render();
    refreshAll();
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
