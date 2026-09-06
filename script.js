/* max 订单 · 物流渠道匹配看板 */
/* 静态快照模式（GitHub Pages 版）：snapshot-core.js / snapshot-orders-*.js 提供 window.__SNAPSHOT__ */
const SNAPSHOT = (typeof window !== 'undefined' && window.__SNAPSHOT__) || null;

// 快照健康检查：缺核心数据或订单数据时给出明确提示，避免误走 /api 分支报 Failed to fetch
const SNAPSHOT_OK = SNAPSHOT && typeof SNAPSHOT.orders === 'object' && SNAPSHOT.orders !== null;
if (SNAPSHOT && !SNAPSHOT_OK) {
  document.addEventListener('DOMContentLoaded', () => {
    const st = document.getElementById('syncStatus');
    if (st) st.innerHTML = '<span style="color:var(--red)">快照数据不完整，请 Cmd/Ctrl + Shift + R 强刷</span>';
  });
}

const state = {
  config: null, meta: null, stats: null, base: null, categoryOptions: [],
  orders: [], expanded: new Set(), syncing: false, rawBase: null,
  catalog: {}, skuCat: '__all__',
};

// 分类选项排序（纯品类在前，混合/其他在后）
const CAT_ORDER = ['pure_dress', 'pure_homewear', 'pure_washedset', 'pure_waffle', 'mixed', 'other', 'unknown'];

const $ = (id) => document.getElementById(id);

function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 3600);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api/${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `请求失败 ${res.status}`);
  return data;
}

function ymd(d) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ------------------------------ 状态加载 ------------------------------ */

async function loadState() {
  let s;
  if (SNAPSHOT_OK) {
    s = {
      config: SNAPSHOT.config || {},
      hasCredentials: true,
      base: SNAPSHOT.base,
      meta: SNAPSHOT.meta,
      stats: SNAPSHOT.stats || { total: 0, byStatus: {}, byChannel: {}, byCountry: {}, byCategory: {} },
      storedCount: (SNAPSHOT.stats || {}).total || 0,
      categoryOptions: SNAPSHOT.categoryOptions || [],
    };
  } else if (SNAPSHOT) {
    throw new Error('快照数据不完整，请按 Cmd/Ctrl + Shift + R 强刷页面');
  } else {
    throw new Error('快照未加载，请检查网络后按 Cmd/Ctrl + Shift + R 强刷页面');
  }
  state.config = s.config || {};
  state.meta = s.meta;
  state.stats = s.stats || { total: 0, byStatus: {}, byChannel: {}, byCountry: {} };
  state.base = s.base;
  state.categoryOptions = s.categoryOptions || [];

  $('syncStatus').innerHTML = s.meta && s.meta.lastSyncBeijing
    ? `上次同步：<b>${esc(s.meta.lastSyncBeijing)}</b> · 店铺 <b>${esc((s.meta.window && s.meta.window.shopName) || state.config.shopName || '未设置')}</b> · 回看 ${esc((s.meta.window && s.meta.window.hours) || state.config.hours || 24)}h · 本次抓取 ${esc(s.meta.fetched || 0)} 单`
    : '<span style="color:var(--amber)">尚未同步</span>';

  $('baseStatus').textContent = state.base
    ? `已配置 · ${state.base.rowCount} 行 · ${state.base.updatedAt ? state.base.updatedAt.slice(0, 19).replace('T', ' ') : ''}`
    : '未配置底表';

  renderFilters();
  renderStats();
}

function renderFilters() {
  const keep = (sel, val) => {
    const el = $(sel);
    const cur = val || el.value;
    return cur;
  };
  const channels = Object.keys(state.stats.byChannel || {}).sort();
  const countries = Object.keys(state.stats.byCountry || {}).sort();
  fillSelect('fChannel', channels, keep('fChannel'));
  fillSelect('fCountry', countries, keep('fCountry'));
  const cats = (state.categoryOptions || []).slice()
    .sort((a, b) => CAT_ORDER.indexOf(a.key) - CAT_ORDER.indexOf(b.key));
  fillSelectCat('fCategory', cats, keep('fCategory'));
}

function fillSelect(id, options, keepValue) {
  const el = $(id);
  const prev = keepValue || el.value;
  el.innerHTML = `<option value="">全部</option>` + options
    .map((o) => `<option value="${esc(o)}"${o === prev ? ' selected' : ''}>${esc(o)}</option>`).join('');
  if (prev && options.includes(prev)) el.value = prev;
}

function fillSelectCat(id, options, keepValue) {
  const el = $(id);
  const prev = keepValue || el.value;
  el.innerHTML = `<option value="">全部</option>` + options
    .map((o) => `<option value="${esc(o.key)}"${o.key === prev ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  if (prev && options.some((o) => o.key === prev)) el.value = prev;
}

/** 快照模式：本地实现与后端 /api/orders 相同的过滤逻辑 */
function filterOrdersLocal() {
  const from = $('fFrom').value, to = $('fTo').value;
  let list = Object.values(SNAPSHOT.orders);
  if (from) list = list.filter((o) => String(o.updateTime || '') >= from);
  if (to) list = list.filter((o) => String(o.updateTime || '') <= `${to} 23:59:59`);
  if ($('fStatus').value) list = list.filter((o) => o.status === $('fStatus').value);
  if ($('fChannel').value) list = list.filter((o) => (o.channels || []).includes($('fChannel').value));
  if ($('fCountry').value) list = list.filter((o) => (o.countryNameCN || o.countryCode) === $('fCountry').value);
  if ($('fCategory').value) list = list.filter((o) => (o.category && o.category.key) === $('fCategory').value);
  const kw = $('fQ').value.trim().toLowerCase();
  if (kw) {
    list = list.filter((o) =>
      [o.platformOrderId, o.salesRecordNumber, o.erpOrderId, o.postCode, o.countryNameCN, o.countryCode, o.route]
        .concat((o.items || []).map((i) => i.stockSku))
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(kw)));
  }
  list.sort((a, b) => String(b.updateTime || '').localeCompare(String(a.updateTime || '')));
  return list;
}

async function loadOrders() {
  if (SNAPSHOT_OK) {
    state.orders = filterOrdersLocal();
    $('tableMeta').textContent = `共 ${state.orders.length} 单（${SNAPSHOT.generatedAt || ''} 快照）`;
    renderTable();
    return;
  }
  if (SNAPSHOT) throw new Error('快照数据不完整，无法加载订单');
  const q = new URLSearchParams();
  const from = $('fFrom').value;
  const to = $('fTo').value;
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if ($('fStatus').value) q.set('status', $('fStatus').value);
  if ($('fChannel').value) q.set('channel', $('fChannel').value);
  if ($('fCountry').value) q.set('country', $('fCountry').value);
  if ($('fCategory').value) q.set('category', $('fCategory').value);
  if ($('fQ').value.trim()) q.set('q', $('fQ').value.trim());
  q.set('limit', '3000');

  const r = await api(`orders?${q.toString()}`);
  state.orders = r.orders || [];
  $('tableMeta').textContent = `共 ${r.total} 单，已加载 ${r.returned} 单`;
  renderTable();
}

/* ------------------------------ 渲染 ------------------------------ */

/* ------------------- 美国订单线路分布 · 按分类 总结看板 ------------------- */

async function renderUsSummary() {
  const el = $('usSummary');
  if (!el) return;
  let orders;
  if (SNAPSHOT_OK) {
    orders = Object.values(SNAPSHOT.orders || {});
  } else if (SNAPSHOT) {
    if (el) el.innerHTML = '<div class="empty" style="padding:20px">快照数据不完整，请强刷页面后查看</div>';
    return;
  } else {
    try {
      const r = await api('orders?country=美国&limit=20000');
      orders = r.orders || [];
    } catch (e) { orders = []; }
  }

  const catMap = Object.fromEntries((state.categoryOptions || []).map((c) => [c.key, c.label]));
  const rows = {};        // catKey -> { label, ch:{}, total }
  const chTotal = {};     // channel -> 总单量
  let usTotal = 0;

  for (const o of orders) {
    const isUS = o.countryCode === 'US' || o.countryNameCN === '美国';
    if (!isUS) continue;
    const catKey = (o.category && o.category.key) || 'unknown';
    if (!rows[catKey]) rows[catKey] = { label: catMap[catKey] || catKey, ch: {}, total: 0 };
    for (const ch of (o.channels || [])) {
      rows[catKey].ch[ch] = (rows[catKey].ch[ch] || 0) + 1;
      chTotal[ch] = (chTotal[ch] || 0) + 1;
      rows[catKey].total++;
    }
    usTotal++;
  }

  const cats = Object.keys(rows).sort((a, b) => CAT_ORDER.indexOf(a) - CAT_ORDER.indexOf(b));
  const chs = Object.keys(chTotal).sort((a, b) => chTotal[b] - chTotal[a]);

  $('usSummaryMeta').textContent = `美国订单共 ${usTotal} 单 · 涉及 ${cats.length} 个分类 / ${chs.length} 条线路`;

  if (!cats.length) {
    el.innerHTML = '<div class="empty" style="padding:20px">暂无美国订单</div>';
    return;
  }

  const head = `<th>订单分类</th>${chs.map((c) => `<th class="num" title="${esc(c)}">${esc(c)}</th>`).join('')}<th class="num">合计</th>`;
  const body = cats.map((k) => {
    const r = rows[k];
    const cells = chs.map((c) => {
      const n = r.ch[c] || 0;
      return `<td class="num">${n ? n : '<span class="zero">·</span>'}</td>`;
    }).join('');
    return `<tr><td class="cat">${esc(r.label)}</td>${cells}<td class="num total">${r.total}</td></tr>`;
  }).join('');
  const foot = `<tr class="foot"><td class="cat">合计</td>${chs.map((c) => `<td class="num">${chTotal[c]}</td>`).join('')}<td class="num total">${usTotal}</td></tr>`;

  el.innerHTML = `<div class="table-scroll"><table class="matrix">
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
    <tfoot>${foot}</tfoot>
  </table>
  <div class="hintrow" style="margin-top:8px">单元格 = 该分类下使用某条线路的美国订单数（多线路订单按所走线路分别计数）；合计列 = 该分类美国订单线路使用总次数。</div></div>`;
}

function renderStats() {
  const st = state.stats.byStatus || {};
  const total = state.stats.total || 0;
  const matched = st['已匹配'] || 0;
  const multi = st['多线路'] || 0;
  const partial = st['部分未匹配'] || 0;
  const unmatched = st['未匹配'] || 0;
  const cards = [
    { k: '订单总量（近' + (state.config.retentionDays || 7) + '天留存）', v: total, cls: '' },
    { k: '已匹配', v: matched, cls: 'ok' },
    { k: '多线路', v: multi, cls: 'warn' },
    { k: '部分未匹配', v: partial, cls: 'warn' },
    { k: '未匹配', v: unmatched, cls: 'bad' },
    { k: '底表规则数', v: (state.meta && state.meta.rulesCount) || 0, cls: '' },
  ];
  $('stats').innerHTML = cards.map((c) => `
    <div class="stat ${c.cls}"><div class="k">${esc(c.k)}</div><div class="v">${c.v}</div></div>
  `).join('');

  const ch = Object.entries(state.stats.byChannel || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...ch.map(([, n]) => n));
  $('channels').innerHTML = ch.length
    ? ch.map(([name, n]) => `
        <div class="bar">
          <div title="${esc(name)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
          <div class="track"><div class="fill" style="width:${(n / max) * 100}%"></div></div>
          <div class="n">${n}</div>
        </div>`).join('')
    : '<div class="empty" style="padding:20px">暂无匹配结果</div>';

  // 订单分类占比
  const catMap = Object.fromEntries((state.categoryOptions || []).map((c) => [c.key, c.label]));
  const catEntries = Object.entries(state.stats.byCategory || {}).sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(1, ...catEntries.map(([, n]) => n));
  $('catBars').innerHTML = catEntries.length
    ? catEntries.map(([key, n]) => `
        <div class="bar">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(catMap[key] || key)}</div>
          <div class="track"><div class="fill cat-${key}" style="width:${(n / catMax) * 100}%"></div></div>
          <div class="n">${n}</div>
        </div>`).join('')
    : '<div class="empty" style="padding:20px">暂无数据</div>';
}

/* --------------------------- 分类 SKU 清单 --------------------------- */

const SKU_ALL = '__all__';

/** 取某分类的 SKU 列表；SKU_ALL 返回全部分类合并 */
function skuListFor(cat) {
  if (cat === SKU_ALL) return Object.values(state.catalog).flat();
  return state.catalog[cat] || [];
}

function skuLabel(cat) {
  return cat === SKU_ALL ? '全部' : cat;
}

async function loadCatalog() {
  try {
    if (SNAPSHOT_OK) {
      state.catalog = SNAPSHOT.catalogGroups || {};
    } else {
      const r = await api('catalog');
      state.catalog = r.groups || {};
    }
    if (state.skuCat !== SKU_ALL && !state.catalog[state.skuCat]) state.skuCat = SKU_ALL;
    renderSkuTabs();
    renderSkuCloud();
  } catch (e) { /* 清单模块失败不影响主看板 */ }
}

function renderSkuTabs() {
  const entries = Object.entries(state.catalog);
  const total = entries.reduce((n, [, l]) => n + l.length, 0);
  const tabs = [[SKU_ALL, '全部', total], ...entries.map(([n, l]) => [n, n, l.length])];
  $('skuTabs').innerHTML = tabs.map(([key, name, count]) =>
    `<button class="sku-tab${key === state.skuCat ? ' active' : ''}" data-cat="${esc(key)}">${esc(name)}<span>${count}</span></button>`).join('');
  $('skuTabs').querySelectorAll('.sku-tab').forEach((b) => b.addEventListener('click', () => {
    state.skuCat = b.dataset.cat;
    $('skuSearch').value = '';
    renderSkuTabs();
    renderSkuCloud();
  }));
}

function renderSkuCloud() {
  const kw = ($('skuSearch').value || '').trim().toLowerCase();
  const all = skuListFor(state.skuCat);
  $('skuMeta').textContent = `${skuLabel(state.skuCat)} · ${all.length} 个`;
  const list = kw ? all.filter((s) => s.toLowerCase().includes(kw)) : all;
  $('skuCloud').innerHTML = list.length
    ? list.map((s) => `<span class="chip sku-chip" title="点击复制">${esc(s)}</span>`).join('')
    : '<div class="empty" style="padding:14px">无匹配 SKU</div>';
  $('skuCloud').querySelectorAll('.sku-chip').forEach((c) => c.addEventListener('click', () => {
    navigator.clipboard.writeText(c.textContent)
      .then(() => toast(`已复制 ${c.textContent}`))
      .catch(() => toast('复制失败', true));
  }));
}

function copySkuCategory() {
  const list = skuListFor(state.skuCat);
  if (!list.length) { toast('当前分类没有 SKU', true); return; }
  navigator.clipboard.writeText(list.join('\n'))
    .then(() => toast(`已复制「${skuLabel(state.skuCat)}」${list.length} 个 SKU`))
    .catch(() => toast('复制失败', true));
}

function exportSkuCatalog() {
  const rows = [['分类', '库存SKU']];
  for (const [name, list] of Object.entries(state.catalog)) {
    for (const s of list) rows.push([name, s]);
  }
  if (rows.length === 1) { toast('SKU 清单为空', true); return; }
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  download(`SKU分类清单_${ymd(new Date())}.csv`, csv);
  toast(`已导出 ${rows.length - 1} 行`);
}

function skuCell(items) {
  if (!items || !items.length) return '<span style="color:var(--muted)">—</span>';
  return items.map((i) => `<span class="chip">${esc(i.stockSku || '(无SKU)')}<span class="q"> ×${esc(i.quantity || 1)}</span></span>`).join('');
}

function statusBadge(s) {
  const map = { 已匹配: 'ok', 多线路: 'warn', 部分未匹配: 'warn', 未匹配: 'bad' };
  return `<span class="badge ${map[s] || 'mute'}">${esc(s)}</span>`;
}

const CAT_CLASS = {
  pure_dress: 'cat-dress', pure_homewear: 'cat-homewear', pure_washedset: 'cat-wash',
  pure_waffle: 'cat-waffle', mixed: 'cat-mixed', other: 'cat-other',
};
function categoryBadge(c) {
  if (!c || !c.key) return '<span class="badge cat-unknown">未分类</span>';
  return `<span class="badge ${CAT_CLASS[c.key] || 'cat-unknown'}">${esc(c.label || c.key)}</span>`;
}

function renderTable() {
  const rows = state.orders;
  if (!rows.length) {
    $('ordersBody').innerHTML = `<tr><td colspan="9"><div class="empty"><div class="big">没有符合条件的订单</div>
      调整筛选条件，或点击右上角「手动拉取」同步最新订单</div></td></tr>`;
    return;
  }
  const html = rows.map((o) => {
    const key = o.platformOrderId;
    const open = state.expanded.has(key);
    let detail = '';
    if (open) {
      detail = `<tr class="row-detail"><td colspan="9">
        <table style="width:auto;min-width:60%">
          <tr><th>库存SKU</th><th>数量</th><th>商品名</th><th>该SKU匹配渠道</th><th>命中维度</th><th>底表行号</th></tr>
          ${(o.lines || []).map((l) => `<tr>
            <td class="mono">${esc(l.stockSku || '—')}</td>
            <td>${esc(l.quantity || '—')}</td>
            <td>${esc((l.title || '').slice(0, 40))}</td>
            <td class="${l.channel ? 'route' : 'route none'}">${esc(l.channel || '未匹配')}</td>
            <td>${esc((l.matchedBy || []).join('+') || '—')}</td>
            <td>${esc(l.ruleRow || '—')}</td>
          </tr>`).join('')}
        </table></td></tr>`;
    }
    return `
      <tr class="clickable" data-key="${esc(key)}">
        <td class="mono">${open ? '▾' : '▸'} ${esc(o.platformOrderId)}</td>
        <td class="mono">${esc(o.salesRecordNumber || '—')}</td>
        <td>${esc(o.countryNameCN || o.countryCode || '—')} <span style="color:var(--muted);font-size:11.5px">${esc(o.countryCode || '')}</span></td>
        <td class="mono">${esc(o.postCode || '—')}</td>
        <td class="sku">${skuCell(o.items)}</td>
        <td class="${o.route ? 'route' : 'route none'}">${esc(o.route || '未匹配')}</td>
        <td>${categoryBadge(o.category)}</td>
        <td>${statusBadge(o.status)}</td>
        <td class="mono" style="color:var(--text-2)">${esc(o.updateTime || '—')}</td>
      </tr>${detail}`;
  }).join('');
  $('ordersBody').innerHTML = html;
  $('ordersBody').querySelectorAll('tr.clickable').forEach((tr) => {
    tr.addEventListener('click', () => {
      const k = tr.dataset.key;
      if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k);
      renderTable();
    });
  });
}

/* ------------------------------ 同步 ------------------------------ */

async function syncNow(hours) {
  if (SNAPSHOT || state.syncing) return;
  state.syncing = true;
  const btn = $('btnSync');
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading"></span> 抓取中…';
  try {
    const r = await api('sync', { method: 'POST', body: JSON.stringify(hours ? { hours } : {}) });
    const m = r.meta;
    toast(`同步完成：抓取 ${m.fetched} 单，累计 ${m.total} 单，未匹配 ${(m.byStatus && m.byStatus['未匹配']) || 0} 单`);
    await loadState();
    await loadOrders();
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.syncing = false;
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

/* ------------------------------ 底表 ------------------------------ */

function openBase() {
  $('modalBase').classList.add('show');
  $('mappingWrap').style.display = 'none';
  $('previewWrap').style.display = 'none';
  if (!state.base) $('baseText').value = '';
}

async function parseBase() {
  const text = $('baseText').value.trim();
  if (!text) { toast('请先粘贴底表内容', true); return; }
  const btn = $('btnParseBase');
  btn.disabled = true; btn.innerHTML = '<span class="loading"></span> 解析中…';
  try {
    await api('basetable', { method: 'POST', body: JSON.stringify({ text }) });
    const full = await api('basetable');
    state.rawBase = full;
    renderMapping(full);
    toast(`底表已保存：${full.rows.length} 行，并重算了全部订单`);
    await loadState();
    await loadOrders();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false; btn.innerHTML = '解析并保存';
  }
}

const MAP_FIELDS = [
  ['channel', '物流渠道（必填）'],
  ['country', '国家'],
  ['post', '邮编范围'],
  ['sku', '库存SKU'],
  ['reach', '可达/状态'],
];

function renderMapping(full) {
  const det = full.detected || {};
  $('mappingWrap').style.display = 'block';
  $('mapping').innerHTML = MAP_FIELDS.map(([key, label]) => `
    <div class="field">
      <label>${label}</label>
      <select data-map="${key}">
        <option value="">— 不使用 —</option>
        ${full.headers.map((h, i) => `<option value="${i}"${det[key] == i ? ' selected' : ''}>${esc(h || '列' + (i + 1))}</option>`).join('')}
      </select>
    </div>`).join('');

  const rows = full.rows.slice(0, 12);
  $('previewWrap').style.display = 'block';
  $('preview').innerHTML = `<table>
    <tr>${full.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>
    ${rows.map((r) => `<tr>${full.headers.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}
  </table>`;
}

async function saveMapping() {
  if (!state.rawBase) return;
  const detected = {};
  $('mapping').querySelectorAll('select[data-map]').forEach((sel) => {
    if (sel.value !== '') detected[sel.dataset.map] = Number(sel.value);
  });
  try {
    await api('basetable', {
      method: 'POST',
      body: JSON.stringify({ headers: state.rawBase.headers, rows: state.rawBase.rows, detected }),
    });
    toast('列映射已更新并重算');
    $('modalBase').classList.remove('show');
    await loadState();
    await loadOrders();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ------------------------------ 设置 ------------------------------ */

function openSettings() {
  const c = state.config || {};
  $('cfgShop').value = c.shopName || '';
  $('cfgHours').value = c.hours || 24;
  $('cfgRetention').value = c.retentionDays || 7;
  $('cfgAppkey').value = c.appkey || '';
  $('cfgAppsecret').value = c.appsecret || ''; // 服务端返回的是脱敏值
  $('modalSettings').classList.add('show');
}

async function loadShops() {
  const btn = $('btnLoadShops');
  btn.disabled = true; btn.innerHTML = '<span class="loading"></span> 读取中…';
  try {
    const r = await api('shops?hours=24');
    $('shopList').innerHTML = (r.shops || []).map((s) => `<option value="${esc(s.name)}">`).join('');
    toast(`读取到 ${r.shops.length} 个店铺，请点击输入框选择`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false; btn.innerHTML = '从马帮读取店铺列表';
  }
}

async function saveConfig() {
  try {
    const body = {
      shopName: $('cfgShop').value.trim(),
      hours: Number($('cfgHours').value) || 24,
      retentionDays: Number($('cfgRetention').value) || 7,
    };
    const ak = $('cfgAppkey').value.trim();
    const as = $('cfgAppsecret').value.trim();
    if (ak) body.appkey = ak;
    if (as && as !== '••••••') body.appsecret = as; // 脱敏占位符不回写
    await api('config', { method: 'POST', body: JSON.stringify(body) });
    toast('设置已保存');
    $('modalSettings').classList.remove('show');
    await loadState();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ------------------------------ 导出 ------------------------------ */

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(filename, text) {
  const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportCSV(mode) {
  if (!state.orders.length) { toast('当前没有可导出的订单', true); return; }
  const stamp = ymd(new Date());
  let head, body;
  if (mode === 'lines') {
    head = ['订单号', '内部单号', '交易号', '国家', '国家代码', '州省', '城市', '邮编', '库存SKU', '数量', '商品名', '该SKU匹配渠道', '命中维度', '底表行号', '订单分类', '订单更新时间'];
    body = [];
    for (const o of state.orders) {
      const cat = (o.category && o.category.label) || '';
      for (const l of (o.lines || [])) {
        body.push([o.platformOrderId, o.erpOrderId, o.salesRecordNumber, o.countryNameCN, o.countryCode,
          o.province, o.city, o.postCode, l.stockSku, l.quantity, l.title, l.channel,
          (l.matchedBy || []).join('+'), l.ruleRow, cat, o.updateTime]);
      }
    }
  } else {
    head = ['订单号', '内部单号', '交易号', '国家', '国家代码', '州省', '城市', '邮编', '库存SKU', '匹配物流线路', '订单分类', '状态', '订单更新时间'];
    body = state.orders.map((o) => [o.platformOrderId, o.erpOrderId, o.salesRecordNumber, o.countryNameCN,
      o.countryCode, o.province, o.city, o.postCode,
      (o.items || []).map((i) => `${i.stockSku}×${i.quantity}`).join(' ; '),
      o.route, (o.category && o.category.label) || '', o.status, o.updateTime]);
  }
  const csv = [head, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n');
  download(`max物流渠道匹配_${mode === 'lines' ? 'SKU明细' : '按订单'}_${stamp}.csv`, csv);
  toast(`已导出 ${body.length} 行`);
}

/* ------------------------------ 启动 ------------------------------ */

function bind() {
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  if (!SNAPSHOT) {
    const today = new Date();
    const from = new Date(today.getTime() - 2 * 86400000);
    if ($('fFrom')) $('fFrom').value = ymd(from);
    if ($('fTo')) $('fTo').value = ymd(today);
  }

  on('btnSync', 'click', () => syncNow());
  on('btnSync3', 'click', () => syncNow(3));
  on('btnBase', 'click', openBase);
  on('btnBase2', 'click', openBase);
  on('btnSettings', 'click', openSettings);
  on('btnExport', 'click', () => exportCSV('orders'));
  on('btnExportDetail', 'click', () => exportCSV('lines'));

  on('btnSkuCopy', 'click', copySkuCategory);
  on('btnSkuExport', 'click', exportSkuCatalog);
  let skuT;
  on('skuSearch', 'input', () => {
    clearTimeout(skuT);
    skuT = setTimeout(renderSkuCloud, 200);
  });

  on('btnParseBase', 'click', parseBase);
  on('btnSaveMapping', 'click', saveMapping);
  on('btnSaveConfig', 'click', saveConfig);
  on('btnLoadShops', 'click', loadShops);

  ['fFrom', 'fTo', 'fStatus', 'fChannel', 'fCountry', 'fCategory'].forEach((id) => {
    on(id, 'change', () => loadOrders().catch((e) => toast(e.message, true)));
  });
  let t;
  on('fQ', 'input', () => {
    clearTimeout(t);
    t = setTimeout(() => loadOrders().catch((e) => toast(e.message, true)), 320);
  });

  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => {
      el.closest('.modal-mask').classList.remove('show');
    });
  });
  document.querySelectorAll('.modal-mask').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('show'); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-mask').forEach((m) => m.classList.remove('show'));
  });
}

async function main() {
  bind();
  try {
    await loadState();
    await loadOrders();
    await renderUsSummary();
    loadCatalog();
  } catch (e) {
    console.error(e);
    toast(e.message, true);
  }
}

main();
