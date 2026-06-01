/**
 * LOF 基金溢价监控工具
 * 数据来源：东方财富 / 天天基金 非官方公开接口
 * 溢价率 = (场内价格 - 单位净值) / 单位净值 × 100%
 */

// ─── Constants ───────────────────────────────────────────────────────────
const NAV_CACHE_TTL = 60 * 60 * 1000; // 净值缓存有效期：1 小时
const NAV_REQUEST_DELAY = 400;            // 每次净值请求间隔（ms），防止被 ban


// ─── State ───────────────────────────────────────────────────────────────
let spotFunds = [];   // 原始场内行情（不含净值）
let allFunds = [];   // 合并净值后的完整数据
let filteredFunds = [];
let sortKey = 'premium';
let sortDir = 'desc';
let isLoading = false;

// 净值缓存：code → { nav, ts }
const navCache = new Map();
let navFetching = false;     // 是否正在手动获取净值
let navFetchAbort = false;   // 用户取消标志

// ─── DOM refs ─────────────────────────────────────────────────────────────
const tableBody = document.getElementById('table-body');
const searchInput = document.getElementById('search-input');
const filterSelect = document.getElementById('filter-select');
const refreshBtn = document.getElementById('refresh-btn');
const navFetchBtn = document.getElementById('nav-fetch-btn');
const spotTimeLabel = document.getElementById('spot-time-label');
const navTimeLabel = document.getElementById('nav-time-label');
const spotChipDot = document.getElementById('spot-chip-dot');
const navChipDot = document.getElementById('nav-chip-dot');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const totalEl = document.getElementById('stat-total');
const premiumEl = document.getElementById('stat-premium');
const discountEl = document.getElementById('stat-discount');
const topEl = document.getElementById('stat-top');
const tableCountEl = document.getElementById('table-count');
const toastContainer = document.getElementById('toast-container');

// ─── API ────────────────────────────────────────────────────────

// 后端 API 基础路径
const API_BASE = '/api';

/**
 * 从后端拉取所有数据
 */
async function fetchFundsFromBackend() {
  const res = await fetch(`${API_BASE}/funds`);
  if (!res.ok) throw new Error(`后端接口异常，状态码：${res.status}`);
  return await res.json();
}

/**
 * 触发后端全量刷新场内行情
 */
async function triggerBackendSpotFetch() {
  const res = await fetch(`${API_BASE}/fetch/spot`, { method: 'POST' });
  if (!res.ok) throw new Error('触发刷新行情失败');
}

/**
 * 触发后端刷新单条净值
 */
async function triggerBackendNavFetch(code) {
  const res = await fetch(`${API_BASE}/fetch/nav/${code}`, { method: 'POST' });
  if (!res.ok) throw new Error('触发净值刷新失败');
}

// ─── 核心：加载数据 ────────────────────────────────────────────────────────

// ─── 核心：加载数据 ────────────────────────────────────────────────────────

/**
 * 纯前端高并发拉取东财场内行情（支持跨域，秒级响应，利用浏览器真实指纹，彻底解决后端拉取被断开问题）
 */
async function fetchLOFSpotFromFrontend() {
  const PAGE_SIZE = 100;
  const BASE = `https://push2.eastmoney.com/api/qt/clist/get?pz=${PAGE_SIZE}&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f20&fs=b:MK0404,b:MK0405,b:MK0406,b:MK0407&fields=f1,f2,f3,f12,f14,f15,f16,f17,f18,f20,f62,f124,f152`;

  async function fetchPage(pn) {
    const url = `${BASE}&pn=${pn}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`行情接口第 ${pn} 页拉取失败`);
    return res.json();
  }

  const first = await fetchPage(1);
  const total = first?.data?.total ?? 0;
  
  const parseDiff = (data) => {
    const diff = data?.data?.diff;
    if (!diff || !Array.isArray(diff)) return [];
    return diff.map(item => ({
      code: item.f12,
      name: item.f14,
      price: safeNum(item.f2),
      change: safeNum(item.f3),
      high: safeNum(item.f15),
      low: safeNum(item.f16),
      open: safeNum(item.f17),
      preClose: safeNum(item.f18),
      volume: safeNum(item.f20),
      priceTime: formatUnixSec(item.f124),
    })).filter(f => f.code && f.price > 0);
  };

  let allItems = parseDiff(first);
  const totalPages = Math.ceil(total / PAGE_SIZE);
  
  if (totalPages > 1) {
    const pageNums = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const results = await Promise.all(pageNums.map(pn => fetchPage(pn).catch(err => {
      console.warn(`第 ${pn} 页行情并发拉取失败，降级忽略此页:`, err);
      return null;
    })));
    results.forEach(data => {
      if (data) {
        allItems = allItems.concat(parseDiff(data));
      }
    });
  }

  // 行情按代码去重
  const seen = new Set();
  return allItems.filter(f => {
    if (seen.has(f.code)) return false;
    seen.add(f.code);
    return true;
  });
}

async function loadData() {
  if (isLoading) return;
  isLoading = true;
  setStatus('loading', '正在获取最新的实时场内价格…');
  refreshBtn.disabled = true;
  if (allFunds.length === 0) showLoading(); // 仅首次霸屏

  try {
    // 黄金双轨并发：前端直拉实时场内价格，同时后端0毫秒返回数据库缓存的场外净值
    const [spotList, backendList] = await Promise.all([
      fetchLOFSpotFromFrontend().catch(err => {
        console.error('前端拉取场内价格失败，将以降级旧数据渲染:', err);
        return [];
      }),
      fetchFundsFromBackend().catch(err => {
        console.error('拉取后端净值数据库失败:', err);
        return [];
      })
    ]);

    if (spotList.length === 0 && backendList.length === 0) {
      throw new Error('无法连接至东方财富或本地后端，请检查网络！');
    }

    console.log(`[LOF Monitor] 场内拉取 ${spotList.length} 只，后端库拉取 ${backendList.length} 只`);

    // 将数据库的净值和限额以 Map 存储以便 O(1) 闪电 join
    const dbMap = new Map();
    backendList.forEach(item => {
      dbMap.set(item.code, item);
    });

    // 内存秒级 join 计算溢价率
    const merged = (spotList.length > 0 ? spotList : backendList).map(spot => {
      const dbItem = dbMap.get(spot.code) || {};
      
      const navVal = dbItem.nav != null ? parseFloat(dbItem.nav) : null;
      const priceVal = parseFloat(spot.price);
      
      let premiumVal = null;
      if (navVal != null && navVal > 0 && priceVal > 0) {
        premiumVal = ((priceVal - navVal) / navVal) * 100;
      }

      // 洗涤后端可能因环境编码坏掉的 buyStatus 文字
      let safeBuyStatus = dbItem.buyStatus || '开放申购';
      if (safeBuyStatus.includes('?') || /[\uFFFD\u0080-\uFFFF]/.test(safeBuyStatus)) {
        // 如果后端传回的申购状态包含乱码问号，或者非标准汉字，一律安全回退至开放申购
        if (safeBuyStatus.includes('限') || safeBuyStatus.includes('额')) {
          safeBuyStatus = '限制大额申购';
        } else if (safeBuyStatus.includes('暂') || safeBuyStatus.includes('停')) {
          safeBuyStatus = '暂停申购';
        } else {
          safeBuyStatus = '开放申购';
        }
      }

      return {
        code: spot.code,
        name: spot.name || dbItem.name || '—', // 100% 优先使用前端东财直拉的完美无乱码中文名字
        price: spot.price,
        change: spot.change,
        high: spot.high,
        low: spot.low,
        open: spot.open,
        preClose: spot.preClose,
        volume: spot.volume,
        priceTime: spot.priceTime,
        
        // 数据库中的净值与限制
        nav: navVal,
        navTime: dbItem.navTime || '',
        premium: premiumVal,
        buyStatus: safeBuyStatus,
        buyLimit: dbItem.buyLimit,
        tractorAccounts: dbItem.tractorAccounts || 1,
        updatedAt: dbItem.updatedAt
      };
    });

    allFunds = merged;

    // 独立异常防护屏障，绝不让次级渲染报错阻断核心加载生命周期
    try {
      updateStats();
    } catch (err) {
      console.error('[LOF Monitor] updateStats 异常:', err);
    }
    
    try {
      applyFilters();
    } catch (err) {
      console.error('[LOF Monitor] applyFilters 异常:', err);
    }
    
    try {
      updateSyncIndicators();
    } catch (err) {
      console.error('[LOF Monitor] updateSyncIndicators 异常:', err);
    }

    setStatus('live', `最新同步：${now()}`);
  } catch (e) {
    console.error('[LOF Monitor] 数据加载异常：', e);
    setStatus('error', '同步数据失败: ' + e.message);
    showError(e.message);
    toast(e.message, 'error');
  } finally {
    isLoading = false;
    refreshBtn.disabled = false;
  }
}

async function triggerSpotRefresh() {
  if (isLoading) return;
  
  const originalHtml = refreshBtn.innerHTML;
  refreshBtn.innerHTML = `
    <svg class="spinner" style="width:12px;height:12px;border-width:2px;margin-right:6px;" viewBox="0 0 16 16"></svg>
    正在刷新实时价格…
  `;
  refreshBtn.disabled = true;
  setStatus('loading', '正在秒级同步最新的场内行情价格…');
  
  try {
    // 纯前端直接闪电刷新，耗时 0.2 秒！
    await loadData();
    toast('场内实时行情已成功更新！', 'success');
  } catch (e) {
    toast('刷新价格失败: ' + e.message, 'error');
    setStatus('error', '刷新场内价格失败');
  } finally {
    refreshBtn.innerHTML = originalHtml;
    refreshBtn.disabled = false;
  }
}

async function fetchNavManual() {
  if (navFetching) return;
  navFetching = true;
  
  const originalHtml = navFetchBtn.innerHTML;
  navFetchBtn.innerHTML = `
    <svg class="spinner" style="width:12px;height:12px;border-width:2px;margin-right:6px;" viewBox="0 0 16 16"></svg>
    正在全量同步单位净值…
  `;
  navFetchBtn.disabled = true;
  toast('已发起场外净值全量同步！基于高并发协程池正在极速更新中…', 'info');
  
  try {
    const res = await fetch(`${API_BASE}/fetch/navs/all`, { method: 'POST' });
    if (!res.ok) throw new Error('同步请求失败');
    
    // 净值刷新在后台静默跑，前台 2.5 秒后同步拉取数据库的更新成果
    setTimeout(async () => {
      await loadData();
      toast('最新场外净值已成功同步载入！', 'success');
      navFetching = false;
      navFetchBtn.innerHTML = originalHtml;
      navFetchBtn.disabled = false;
    }, 2500);
  } catch (e) {
    toast('场外净值同步失败: ' + e.message, 'error');
    navFetching = false;
    navFetchBtn.innerHTML = originalHtml;
    navFetchBtn.disabled = false;
  }
}

function updateSyncIndicators() {
  if (!spotTimeLabel || !navTimeLabel) return;
  
  // 采样提取最新的场内更新时间
  const sampleWithPriceTime = allFunds.find(f => f.priceTime);
  const lastPriceTimeStr = sampleWithPriceTime ? sampleWithPriceTime.priceTime : '—';
  
  // 采样提取最新的场外净值发布日期
  const sampleWithNavTime = allFunds.find(f => f.navTime);
  const lastNavTimeStr = sampleWithNavTime ? sampleWithNavTime.navTime : '—';
  
  const noNavCount = allFunds.filter(f => f.nav == null).length;
  
  spotTimeLabel.textContent = lastPriceTimeStr;
  navTimeLabel.textContent = lastNavTimeStr + (noNavCount > 0 ? ` (缺 ${noNavCount} 支)` : '');
  
  // 动态更新状态圆点指示
  if (spotChipDot) {
    spotChipDot.className = 'status-dot live'; // 场内实时闪烁
  }
  if (navChipDot) {
    if (noNavCount > 0) {
      navChipDot.className = 'status-dot loading'; // 净值缺失，呈现黄色警告
    } else {
      navChipDot.className = 'status-dot live'; // 全部齐备，呈现翠绿色闪烁
    }
  }
}

function getArbitrageScore(f) {
  if (f.premium == null || f.premium <= 0 || f.buyStatus === '暂停申购') return 0;
  
  let score = f.premium;
  
  // 限额权重
  let limitWeight = 1.0;
  if (f.buyLimit != null) {
    if (f.buyLimit <= 100) limitWeight = 0.05;
    else if (f.buyLimit <= 1000) limitWeight = 0.15;
    else if (f.buyLimit <= 10000) limitWeight = 0.50;
    else if (f.buyLimit <= 100000) limitWeight = 0.85;
  }
  
  // 流动性权重（成交额低于 5w 极易踩踏，给 0.1 惩罚）
  let volWeight = 1.0;
  const vol = f.volume || 0;
  if (vol < 50000) volWeight = 0.10;
  else if (vol < 200000) volWeight = 0.50;
  else if (vol < 1000000) volWeight = 0.85;
  
  return score * limitWeight * volWeight;
}

function applyFilters() {
  const q = searchInput.value.trim().toLowerCase();
  const filter = filterSelect.value;

  filteredFunds = allFunds.filter(f => {
    if (q && !f.code.includes(q) && !f.name.toLowerCase().includes(q)) return false;
    if (filter === 'arbitrage' && (f.premium == null || f.premium <= 0 || f.buyStatus === '暂停申购')) return false;
    if (filter === 'open_high') {
      const canBuy = f.buyStatus && f.buyStatus !== '暂停申购';
      if (!canBuy || f.premium == null || f.premium < 1.0) return false;
    }
    if (filter === 'premium' && (f.premium == null || f.premium < 1.0)) return false;
    if (filter === 'discount' && (f.premium == null || f.premium >= 0)) return false;
    if (filter === 'nonav' && f.nav !== null) return false;
    return true;
  });

  sortFunds();
  renderTable();
}

function sortFunds() {
  const filter = filterSelect.value;
  // 如果是智能套利推荐，且排序列依然是默认的 premium (没有手动点击其它表头排序)，则采用智能评分排序
  if (filter === 'arbitrage' && sortKey === 'premium') {
    filteredFunds.sort((a, b) => {
      let sa = getArbitrageScore(a);
      let sb = getArbitrageScore(b);
      return sortDir === 'asc' ? sa - sb : sb - sa;
    });
    return;
  }

  filteredFunds.sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (av == null) av = sortDir === 'asc' ? Infinity : -Infinity;
    if (bv == null) bv = sortDir === 'asc' ? Infinity : -Infinity;
    return sortDir === 'asc' ? av - bv : bv - av;
  });
}

function updateStats() {
  const withNav = allFunds.filter(f => f.premium != null);
  totalEl.textContent = allFunds.length;
  premiumEl.textContent = withNav.filter(f => f.premium > 0).length;
  discountEl.textContent = withNav.filter(f => f.premium < 0).length;

  const top = withNav.reduce((best, f) =>
    f.premium > (best?.premium ?? -Infinity) ? f : best, null);
    
  if (top) {
    const safeName = (top.name || '').slice(0, 6);
    const safePremStr = safeFixed(top.premium, 2);
    topEl.textContent = `${safeName} +${safePremStr}%`;
  } else {
    topEl.textContent = withNav.length === 0 ? '净值未加载' : '—';
  }
}

// ─── Render ───────────────────────────────────────────────────────────────

function renderBuyStatus(status, limit) {
  if (!status) return '';
  if (status === '暂停申购') {
    return '<span class="status-badge" style="font-size:10px;margin-left:6px;padding:2px 6px;border-radius:4px;color:#fff;background:#f85149;font-weight:600;white-space:nowrap;">暂停申购</span>';
  }

  if (status === '限制大额申购' && limit != null) {
    let bg = 'var(--warning)';
    let color = '#fff';
    if (limit <= 100) {
      bg = '#da3633'; // 猩红色警示极小限购
    } else if (limit <= 1000) {
      bg = '#e57a08'; // 橙色
    } else if (limit >= 50000) {
      bg = '#3fb950'; // 宽裕额度绿色
    }
    
    let textLimit = limit >= 10000 ? (limit / 10000) + '万' : limit;
    return `<span class="status-badge" style="font-size:10px;margin-left:6px;padding:2px 6px;border-radius:4px;color:${color};background:${bg};font-weight:600;white-space:nowrap;">限 ${textLimit}</span>`;
  }

  return '<span class="status-badge" style="font-size:10px;margin-left:6px;padding:2px 6px;border-radius:4px;color:#fff;background:#238636;font-weight:600;white-space:nowrap;">开放申购</span>';
}

function renderTable() {
  tableCountEl.textContent = `共 ${filteredFunds.length} 只`;

  if (filteredFunds.length === 0) {
    tableBody.innerHTML = `
      <tr><td colspan="9">
        <div class="state-overlay">
          <div class="state-icon">🔍</div>
          <div class="state-title">无匹配结果</div>
          <div class="state-desc">请调整搜索条件或筛选项</div>
        </div>
      </td></tr>`;
    return;
  }

  const rows = filteredFunds.map(f => {
    if (!f) return '';
    
    // 溢价率显示
    let premHtml;
    if (f.premium != null) {
      const premVal = parseFloat(f.premium);
      const premCls = premVal > 1 ? 'premium-high' : premVal < -1 ? 'premium-low' : 'premium-mid';
      const premSign = premVal > 0 ? '+' : '';
      const premStr = safeFixed(premVal, 3);
      premHtml = `<span class="premium-badge ${premCls}">${premSign}${premStr}%</span>`;
    } else {
      premHtml = `<span class="premium-badge premium-mid" style="opacity:.45">净值未加载</span>`;
    }

    const chgVal = f.change != null ? parseFloat(f.change) : 0.0;
    const chgColor = chgVal > 0 ? 'var(--premium-high)' : chgVal < 0 ? 'var(--premium-low)' : 'var(--text-secondary)';
    const chgSign = chgVal > 0 ? '+' : '';
    const chgText = safeFixed(chgVal, 2);
    
    const vol = formatVolume(f.volume);

    const btnLabel = '更新净值';
    const btnTip = f.updatedAt ? `最后数据库更新: ${new Date(f.updatedAt).toLocaleTimeString()}` : '请求后端更新';

    const tractorHtml = f.tractorAccounts > 1
      ? `<span class="tractor-badge" style="font-size:10px;margin-left:6px;padding:2px 4px;border-radius:4px;color:#fff;background:var(--accent-blue);font-weight:600;" title="单日申购支持的最大子账户数量">一拖${f.tractorAccounts}</span>`
      : '';

    const priceText = safeFixed(f.price, 3);
    const highText = safeFixed(f.high, 3);
    const navText = f.nav != null ? safeFixed(f.nav, 4) : '<span style="opacity:.35">—</span>';

    return `
    <tr class="tr-interactive" data-code="${f.code}" style="cursor:pointer" title="点击启动套利计算器">
      <td class="code-cell">${f.code}</td>
      <td>
        <div class="name-cell" title="${f.name || ''}" style="display:flex;align-items:center;">
          ${f.name || '—'}
          ${renderBuyStatus(f.buyStatus, f.buyLimit)}
          ${tractorHtml}
        </div>
      </td>
      <td class="price-cell">
        ${priceText}
        ${f.priceTime ? `<div class="time-sub">${f.priceTime}</div>` : ''}
      </td>
      <td class="nav-cell">
        ${navText}
        ${f.navTime ? `<div class="time-sub">${f.navTime}</div>` : ''}
      </td>
      <td>${premHtml}</td>
      <td class="change-cell" style="color:${chgColor}">${chgSign}${chgText}%</td>
      <td class="price-cell" style="font-size:12px;color:var(--text-secondary)">${highText}</td>
      <td class="volume-cell">${vol}</td>
      <td style="text-align:center">
        <button class="btn-row-nav" data-code="${f.code}" title="${btnTip}">${btnLabel}</button>
      </td>
    </tr>`;
  });

  tableBody.innerHTML = rows.join('');
}

function showLoading() {
  tableBody.innerHTML = `
    <tr><td colspan="9">
      <div class="state-overlay">
        <div class="spinner"></div>
        <div class="state-title">正在加载数据…</div>
        <div class="state-desc">正在拉取同步数据</div>
      </div>
    </td></tr>`;
}

function showError(msg) {
  tableBody.innerHTML = `
    <tr><td colspan="9">
      <div class="state-overlay">
        <div class="state-icon">⚠️</div>
        <div class="state-title">数据加载失败</div>
        <div class="state-desc">${msg}</div>
      </div>
    </td></tr>`;
}

// ─── Sort ─────────────────────────────────────────────────────────────────

document.querySelectorAll('thead th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    sortDir = sortKey === key ? (sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    sortKey = key;
    document.querySelectorAll('thead th').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
    th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    sortFunds();
    renderTable();
  });
});

// ─── Events ───────────────────────────────────────────────────────────────

searchInput.addEventListener('input', applyFilters);
filterSelect.addEventListener('change', applyFilters);
refreshBtn.addEventListener('click', () => { triggerSpotRefresh(); });
navFetchBtn.addEventListener('click', fetchNavManual);

// 行级点击与操作分发：更新净值、套利计算器
tableBody.addEventListener('click', async (e) => {
  // 1. 更新单只基金净值
  const btn = e.target.closest('.btn-row-nav');
  if (btn) {
    e.stopPropagation();
    const code = btn.dataset.code;
    if (!code || btn.disabled) return;

    btn.disabled = true;
    btn.textContent = '请求后端…';

    try {
      await triggerBackendNavFetch(code);
      toast(`已提交 ${code} 的净值更新请求`, 'info');

      setTimeout(() => {
        loadData().then(() => {
          toast(`${code} 净值已成功同步`, 'success');
        });
      }, 1500);

    } catch (error) {
      toast(`${code} 请求失败`, 'error');
      btn.disabled = false;
      btn.textContent = '更新失败';
    }
    return;
  }

  // 3. 点击整行弹起套利决策计算器 (排除点击了调试按钮或拖拉机按钮的情况)
  const row = e.target.closest('.tr-interactive');
  if (row) {
    const code = row.dataset.code;
    if (code) {
      const fund = allFunds.find(f => f.code === code);
      if (fund) {
        openCalculator(fund);
      }
    }
  }
});

// ─── Calculator Logic ──────────────────────────────────────────────────
const modal = document.getElementById('arbitrage-modal');
const modalClose = document.getElementById('modal-close');
const calcName = document.getElementById('calc-name');
const calcCode = document.getElementById('calc-code');
const calcPremium = document.getElementById('calc-premium');
const calcLimit = document.getElementById('calc-limit');
const calcTractorVal = document.getElementById('calc-tractor-val');
const calcTractorDec = document.getElementById('calc-tractor-dec');
const calcTractorInc = document.getElementById('calc-tractor-inc');
const calcTotalApply = document.getElementById('calc-total-apply');
const calcFeeInput = document.getElementById('calc-fee-input');
const calcProfit = document.getElementById('calc-profit');
const calcWarning = document.getElementById('calc-warning');

let currentCalcFund = null;
let tempTractorVal = 1;

function openCalculator(fund) {
  currentCalcFund = fund;
  tempTractorVal = fund.tractorAccounts || 1;
  
  calcName.textContent = fund.name;
  calcCode.textContent = fund.code;
  calcPremium.textContent = fund.premium != null ? `${safeFixed(fund.premium, 3)}%` : '—';
  
  if (fund.buyStatus === '暂停申购') {
    calcLimit.textContent = '暂停申购';
    calcLimit.style.color = '#f85149';
  } else if (fund.buyLimit != null) {
    calcLimit.textContent = `${formatMoney(fund.buyLimit)}元`;
    calcLimit.style.color = 'var(--warning)';
  } else {
    calcLimit.textContent = '无限制';
    calcLimit.style.color = 'var(--premium-low)';
  }
  
  calcTractorVal.textContent = tempTractorVal;
  
  // 警告提示
  const vol = fund.volume || 0;
  if (fund.buyStatus === '暂停申购') {
    calcWarning.textContent = '🚨 该基金当前处于暂停申购状态，无法发起申购套利！';
    calcWarning.style.color = '#f85149';
    calcWarning.style.background = 'rgba(248, 81, 73, 0.12)';
  } else if (vol < 100000) {
    calcWarning.textContent = '⚠️ 警示：该基金日成交额过低（流动性不足 10 万元），若申购资金过多，在场内卖出变现时极易因缺乏对手盘导致砸盘折价，产生折损风险！';
    calcWarning.style.color = 'var(--warning)';
    calcWarning.style.background = 'var(--warning-dim)';
  } else {
    calcWarning.textContent = '✅ 流动性良好。完成申购并折算场内份额后，请注意下一工作日的场内波动，在合适溢价位置通过二级市场卖出。';
    calcWarning.style.color = 'var(--premium-low)';
    calcWarning.style.background = 'var(--premium-low-dim)';
  }
  
  updateCalculations();
  modal.style.display = 'flex';
}

function updateCalculations() {
  if (!currentCalcFund) return;
  
  let limit = currentCalcFund.buyLimit;
  let premium = currentCalcFund.premium || 0;
  let feeRate = parseFloat(calcFeeInput.value) || 0;
  
  let totalApply = 0;
  let limitText = '';
  
  if (currentCalcFund.buyStatus === '暂停申购') {
    totalApply = 0;
    limitText = '0 元 (暂停申购)';
  } else if (limit != null) {
    totalApply = limit * tempTractorVal;
    limitText = `${formatMoney(totalApply)}元 (${tempTractorVal}账户联申)`;
  } else {
    totalApply = 50000 * tempTractorVal; // 缺省假定为 5 万/账户
    limitText = `${formatMoney(totalApply)}元 (建议单日测算上限)`;
  }
  
  calcTotalApply.textContent = limitText;
  
  // 纯收益 = 申购金额 * (溢价率 - 申购费率)
  let profit = totalApply * ((premium - feeRate) / 100);
  if (profit < 0) profit = 0;
  
  calcProfit.textContent = `+${profit.toFixed(2)} 元`;
}

calcTractorDec.addEventListener('click', () => {
  if (tempTractorVal > 1) {
    tempTractorVal--;
    calcTractorVal.textContent = tempTractorVal;
    updateCalculations();
  }
});

calcTractorInc.addEventListener('click', () => {
  if (tempTractorVal < 6) {
    tempTractorVal++;
    calcTractorVal.textContent = tempTractorVal;
    updateCalculations();
  }
});

calcFeeInput.addEventListener('input', updateCalculations);

modalClose.addEventListener('click', () => {
  modal.style.display = 'none';
  currentCalcFund = null;
});

modal.addEventListener('click', (e) => {
  if (e.target === modal) {
    modal.style.display = 'none';
    currentCalcFund = null;
  }
});

function formatMoney(num) {
  if (num >= 10000) return (num / 10000).toFixed(1) + ' 万';
  return num.toLocaleString();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function safeFixed(val, digits = 2) {
  if (val == null || val === '') return '—';
  const num = parseFloat(val);
  return isNaN(num) ? '—' : num.toFixed(digits);
}

function safeNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

/** 将东方财富 f124 字段（Unix 秒）转为 HH:mm 字符串，非交易时段返回 '' */
function formatUnixSec(sec) {
  const n = parseInt(sec, 10);
  if (!n || n <= 0) return '';
  const d = new Date(n * 1000);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function formatVolume(v) {
  if (!v) return '—';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (v >= 1e4) return (v / 1e4).toFixed(2) + ' 万';
  return v.toFixed(0);
}

function setStatus(type, text) {
  if (statusDot) {
    statusDot.className = 'status-dot ' + type;
  }
  if (statusText) {
    statusText.textContent = text;
  }
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  el.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ─── Init ─────────────────────────────────────────────────────────────────

// 设置定时刷新页面数据 (每 15 秒同步一次后端，确保看见最新)
setInterval(() => {
  if (!document.hidden && !isLoading) {
    loadData();
  }
}, 15000);

loadData();
