// ============================================================
// Front Security - ADM · Controle de Gastos
// Lançamento de gastos por posto (QTH) e categoria, dashboard do mês,
// relatório de fechamento para imprimir/PDF e backup JSON/CSV.
// Dados em /adm do mesmo Firebase dos apps Coberturas e Pagamentos.
// Funciona com internet ruim: cache local + fila de envio guardada no aparelho.
// ============================================================

// Bump together with version.json on every deploy: open apps reload themselves when it changes
const APP_VERSION = '2026-10-26.1';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyB2XpLy5atMeLtc-XuOaAtY9m72mK9dZSY',
  authDomain: 'front-security-coberturas.firebaseapp.com',
  databaseURL: 'https://front-security-coberturas-default-rtdb.firebaseio.com',
  projectId: 'front-security-coberturas',
  storageBucket: 'front-security-coberturas.firebasestorage.app',
  messagingSenderId: '820793276708',
  appId: '1:820793276708:web:869d32754c6375cd139bb1'
};

// The 8 standard categories have fixed ids: the form shows extra fields by id
// (dobra → funcionário + data da dobra, perdas → status/ressarcimento), so they can be renamed but not deleted.
const DEFAULT_CONFIG = {
  postos: ['Terreno Econ 03 Susana', 'Econ', 'Vitta Urbana', 'Kallas', 'Cursino', 'Clínica 3 Corações'],
  categorias: [
    { id: 'insumos', nome: 'Insumos', cor: '#F5A623', subtipos: [] },
    { id: 'dobra', nome: '3/6 – Dobra de funcionário', cor: '#9B59B6', subtipos: [] },
    { id: 'uber', nome: 'Uber', cor: '#3498DB', subtipos: [] },
    { id: 'gas_moto', nome: 'Gasolina moto', cor: '#E67E22', subtipos: [] },
    { id: 'gas_carro', nome: 'Gasolina carro', cor: '#C0392B', subtipos: [] },
    { id: 'manutencao', nome: 'Manutenção', cor: '#1ABC9C', subtipos: ['Chaves', 'Cadeados', 'Guarita', 'Outros'] },
    { id: 'preventivos', nome: 'Preventivos', cor: '#2ECC71', subtipos: ['Alarmes', 'Refletores', 'Outros'] },
    { id: 'perdas', nome: 'Perdas – furtos ressarcidos', cor: '#E74C3C', subtipos: [] }
  ],
  funcionarios: []
};
const FIXED_CATS = DEFAULT_CONFIG.categorias.map(c => c.id);
const SEM_QTH = ''; // gasto that is not tied to a post (shown as "Geral")
const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const MONTH_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// ===== helpers (same as the Pagamentos app) =====

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function today() { return toDateStr(new Date()); }
function currentMonth() { return today().slice(0, 7); }
function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]}/${y}`;
}
// "2026-10-05" → "05/10/2026"
function fmtDate(str) {
  if (!str) return '';
  const [y, m, d] = str.split('-');
  return `${d}/${m}/${y}`;
}
function normalizeText(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function makeId() {
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
// Brazilian money input → number: "1.500" = 1500, "1.800,50" = 1800.5, "150,5" = 150.5,
// "150.50" = 150.5, "1,500.00" = 1500. The LAST separator followed by 1–2 digits is the decimal one.
function parseMoney(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
  let s = String(v).replace(/[R$\s]/g, '');
  const neg = s.startsWith('-');
  s = s.replace(/[^0-9.,]/g, '');
  if (!s) return 0;
  const m = s.match(/^(.*)[.,](\d{1,2})$/);
  const intPart = (m ? m[1] : s).replace(/[.,]/g, '');
  const n = Number(`${intPart || '0'}.${m ? m[2] : '0'}`);
  if (!Number.isFinite(n)) return 0;
  return (neg ? -1 : 1) * Math.round(n * 100) / 100;
}
// Sums in integer cents (no floating point residue like 299,9999…)
function cents(v) { return Math.round(parseMoney(v) * 100); }
function brl(n) {
  return (n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function moneyInput(n) {
  return n ? n.toFixed(2).replace('.', ',') : '';
}
// Firebase drops empty arrays and may return arrays as {0:…,1:…}
function toArr(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : Object.values(v)).filter(x => x !== null && x !== undefined && x !== '');
}
function normalizeConfig(c) {
  c = c || {};
  const cats = toArr(c.categorias).map(k => ({ id: k.id, nome: k.nome || k.id, cor: k.cor || '#F5A623', subtipos: toArr(k.subtipos) }));
  // a standard category missing from the saved list comes back (its fields depend on it)
  DEFAULT_CONFIG.categorias.forEach(d => { if (!cats.some(k => k.id === d.id)) cats.push({ ...d }); });
  return {
    postos: c.postos ? toArr(c.postos) : [...DEFAULT_CONFIG.postos],
    categorias: cats,
    funcionarios: toArr(c.funcionarios)
  };
}
function sumCents(list) { return list.reduce((s, g) => s + cents(g.valor), 0); }
function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}

// ============================================================
// Store: server data + local cache + outbox of writes not yet confirmed by the server.
// Every write goes to the outbox first (saved on the phone), so a gasto typed with
// no signal survives closing the app and is sent when the connection comes back.
// ============================================================
class Store {
  constructor(onChange) {
    this.onChange = onChange;
    const cache = readJSON('adm_cache', {});
    this.serverGastos = cache.gastos || {};
    this.serverConfig = cache.config || null;
    this.outbox = readJSON('adm_outbox', []);
    this.loaded = !!cache.gastos;
    this.db = null;
    this.connected = false;
    this.flushing = false;
  }

  attach(db) {
    this.db = db;
    db.ref('.info/connected').on('value', s => {
      this.connected = s.val() === true;
      this.onChange('connection');
      if (this.connected) this.flush();
    });
    const fail = path => err => { console.error(path, err); this.onChange('denied', path); };
    db.ref('adm/gastos').on('value', s => {
      this.serverGastos = s.val() || {};
      this.loaded = true;
      this.saveCache();
      this.onChange('data');
    }, fail('adm/gastos'));
    db.ref('adm/config').on('value', s => {
      this.serverConfig = s.val();
      this.saveCache();
      this.onChange('data');
    }, fail('adm/config'));
  }

  saveCache() {
    writeJSON('adm_cache', { gastos: this.serverGastos, config: this.serverConfig });
  }

  // What the user sees: server data with the pending writes applied on top
  get gastos() {
    const g = { ...this.serverGastos };
    this.outbox.forEach(op => {
      const m = op.path.match(/^adm\/gastos\/(.+)$/);
      if (!m) return;
      if (op.value === null) delete g[m[1]]; else g[m[1]] = op.value;
    });
    return g;
  }
  get config() {
    let c = this.serverConfig;
    this.outbox.forEach(op => { if (op.path === 'adm/config') c = op.value; });
    return normalizeConfig(c);
  }
  isPending(id) { return this.outbox.some(op => op.path === `adm/gastos/${id}`); }
  pendingAnexo(id) {
    const op = [...this.outbox].reverse().find(o => o.path === `adm/anexos/${id}`);
    return op ? op.value : undefined;
  }

  write(path, value) {
    // a newer write to the same path replaces the older one still waiting
    this.outbox = this.outbox.filter(op => op.path !== path);
    this.outbox.push({ path, value, t: Date.now() });
    const saved = writeJSON('adm_outbox', this.outbox);
    this.onChange('data');
    this.flush();
    return saved;
  }

  // Sends the outbox in order; each op leaves the outbox only after the server confirms it
  async flush() {
    if (!this.db || !this.connected || this.flushing || !this.outbox.length) return;
    this.flushing = true;
    try {
      while (this.outbox.length && this.connected) {
        const op = this.outbox[0];
        await this.db.ref(op.path).set(op.value);
        // only drop it if nothing newer replaced it meanwhile
        if (this.outbox[0] === op) this.outbox.shift();
        writeJSON('adm_outbox', this.outbox);
        this.onChange('sync');
      }
    } catch (e) {
      console.error('flush', e);
      this.onChange('flush-error', e);
    } finally {
      this.flushing = false;
    }
  }
}

// ===== image compression: comprovante photo → small JPEG data URL =====
function compressImage(file, maxSide = 1280, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('image'));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        let url = canvas.toDataURL('image/jpeg', quality);
        // still big (very detailed photo)? one more, smaller pass
        if (url.length > 400000) {
          const c2 = document.createElement('canvas');
          c2.width = Math.round(canvas.width * 0.7);
          c2.height = Math.round(canvas.height * 0.7);
          c2.getContext('2d').drawImage(canvas, 0, 0, c2.width, c2.height);
          url = c2.toDataURL('image/jpeg', 0.5);
        }
        resolve(url);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ============================================================
class AdmApp {
  constructor() {
    this.month = currentMonth();
    this.charts = {};
    this.renderQueued = false;
    this.formCat = 'insumos';
    this.formAnexo = undefined; // undefined = unchanged, null = removed, string = new photo
  }

  init() {
    if (this.started) return; // never wire listeners twice
    this.started = true;
    this.store = new Store((type, info) => this.onStoreChange(type, info));
    this.cfg = this.store.config;
    this.gastosCache = [];
    this.setupEventListeners();
    this.renderMonthBar();
    this.queueRender(); // shows the cached data right away, even offline
    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      this.store.attach(firebase.database());
    } catch (e) {
      this.showToast('Erro ao iniciar o Firebase', 'error');
    }
    this.checkForUpdate();
    setInterval(() => this.checkForUpdate(), 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { this.checkForUpdate(); this.store.flush(); } });
  }

  onStoreChange(type, info) {
    if (type === 'connection') {
      const on = this.store.connected;
      document.getElementById('connection-status').className = on ? 'conn-dot connected' : 'conn-dot disconnected';
      document.getElementById('connection-text').textContent = on ? 'Online' : 'Offline';
    } else if (type === 'denied') {
      this.showToast(`⚠️ Sem permissão para ler ${info}. Publique as regras do Firebase (LEIAME).`, 'error');
    } else if (type === 'flush-error') {
      this.showToast('❌ O servidor recusou um lançamento. Verifique as permissões do Firebase.', 'error');
    } else if (type === 'sync' && !this.store.outbox.length) {
      this.showToast('☁️ Tudo sincronizado', 'success');
    }
    this.renderPending();
    if (type === 'data' || type === 'sync') this.queueRender();
  }

  queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.gastosCache = Object.values(this.store.gastos).filter(g => g && g.id);
      this.cfg = this.store.config;
      this.fillSelects();
      this.renderDashboard();
      this.renderList();
      this.renderReport();
      if (!this.configDirty) this.renderConfig();
      this.renderPending();
    });
  }

  // ===== data access =====

  cat(id) {
    return this.cfg.categorias.find(c => c.id === id) || { id, nome: id || '—', cor: '#888', subtipos: [] };
  }
  qthName(q) { return q ? q : 'Geral'; }
  ofMonth(ym) { return this.gastosCache.filter(g => (g.data || '').startsWith(ym)); }
  // lists the posts in config order, then any old name that only exists in launches
  qthsOf(list) {
    const names = [...this.cfg.postos];
    list.forEach(g => { if (!names.includes(g.qth || SEM_QTH)) names.push(g.qth || SEM_QTH); });
    return names;
  }
  groupCents(list, keyFn) {
    const m = new Map();
    list.forEach(g => { const k = keyFn(g); m.set(k, (m.get(k) || 0) + cents(g.valor)); });
    return m;
  }

  // ===== header =====

  renderMonthBar() {
    document.getElementById('month-label').textContent = monthLabel(this.month);
    document.getElementById('month-current').classList.toggle('active', this.month === currentMonth());
  }
  setMonth(ym) {
    this.month = ym;
    this.renderMonthBar();
    this.queueRender();
  }
  renderPending() {
    const n = this.store ? this.store.outbox.length : 0;
    const el = document.getElementById('pending-sync');
    el.style.display = n ? '' : 'none';
    el.textContent = `⏳ ${n}`;
  }

  fillSelects() {
    const opts = (list, sel) => list.map(([v, t]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(t)}</option>`).join('');
    const fq = document.getElementById('f-qth');
    const fc = document.getElementById('f-cat');
    const qths = this.qthsOf(this.gastosCache);
    fq.innerHTML = opts([['*', '🏢 Todos os QTHs'], ...qths.map(q => [q, this.qthName(q)])], fq.value || '*');
    fc.innerHTML = opts([['*', '🏷️ Todas as categorias'], ...this.cfg.categorias.map(c => [c.id, c.nome])], fc.value || '*');
    document.getElementById('func-names').innerHTML = this.cfg.funcionarios.map(f => `<option value="${esc(f)}">`).join('');
  }

  // ===== dashboard =====

  renderDashboard() {
    const list = this.ofMonth(this.month);
    const prev = this.ofMonth(shiftMonth(this.month, -1));
    const total = sumCents(list);
    const totalPrev = sumCents(prev);
    const diff = total - totalPrev;
    const pct = totalPrev ? Math.round((diff / totalPrev) * 100) : null;
    document.getElementById('month-total').textContent = brl(total / 100);
    document.getElementById('gasto-count').textContent = list.length || '';

    const perdasAll = this.gastosCache.filter(g => g.categoria === 'perdas');
    const pend = perdasAll.filter(g => g.perdaStatus !== 'ressarcido');
    const pendCents = pend.reduce((s, g) => s + cents(g.valor) - cents(g.valorRessarcido), 0);
    const ressMes = perdasAll.filter(g => (g.dataRessarcimento || '').startsWith(this.month)).reduce((s, g) => s + cents(g.valorRessarcido), 0);

    document.getElementById('dash-summary').innerHTML = `
      <div class="total"><span>Total de ${esc(monthLabel(this.month))}</span><b>${brl(total / 100)}</b><small>${list.length} lançamento(s)</small></div>
      <div><span>Mês anterior</span><b>${brl(totalPrev / 100)}</b>
        <small class="${diff > 0 ? 'up' : 'down'}">${totalPrev || total ? `${diff > 0 ? '▲' : diff < 0 ? '▼' : '='} ${brl(Math.abs(diff) / 100)}${pct !== null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''}` : '—'}</small></div>
      <div><span>Perdas pendentes</span><b class="${pend.length ? 'up' : ''}">${brl(pendCents / 100)}</b><small>${pend.length} ocorrência(s)</small></div>
      <div><span>Ressarcido no mês</span><b class="down">${brl(ressMes / 100)}</b></div>`;

    document.getElementById('dash-perdas').innerHTML = pend.length ? `
      <div class="perdas-alert">
        <h3>⚠️ Perdas pendentes de ressarcimento</h3>
        <div class="pay-lines">${pend.sort((a, b) => (a.data || '').localeCompare(b.data || '')).map(g => `
          <div class="pay-line"><span>${fmtDate(g.data)} · ${esc(this.qthName(g.qth))} · ${esc(g.descricao || 'sem descrição')}${cents(g.valorRessarcido) ? ` (já ressarcido ${brl(parseMoney(g.valorRessarcido))})` : ''}</span>
          <strong><a href="#" class="link-edit" data-id="${esc(g.id)}">${brl((cents(g.valor) - cents(g.valorRessarcido)) / 100)}</a></strong></div>`).join('')}
        </div>
      </div>` : '';

    // per category / per QTH lines + charts
    const byCat = this.groupCents(list, g => g.categoria);
    const cats = this.cfg.categorias.filter(c => byCat.get(c.id));
    [...byCat.keys()].filter(k => !cats.some(c => c.id === k)).forEach(k => cats.push(this.cat(k)));
    document.getElementById('dash-categorias').innerHTML = cats.length
      ? cats.map(c => `<div class="pay-line"><span><i class="dot" style="background:${esc(c.cor)}"></i>${esc(c.nome)}</span><strong>${brl(byCat.get(c.id) / 100)}</strong></div>`).join('')
      : '<div class="pay-line"><span>Nenhum gasto neste mês.</span></div>';

    const byQth = this.groupCents(list, g => g.qth || SEM_QTH);
    const qths = this.qthsOf(list).filter(q => byQth.get(q));
    document.getElementById('dash-qths').innerHTML = qths.length
      ? qths.map(q => `<div class="pay-line"><span>${esc(this.qthName(q))}</span><strong>${brl(byQth.get(q) / 100)}</strong></div>`).join('')
      : '<div class="pay-line"><span>Nenhum gasto neste mês.</span></div>';

    const months = Array.from({ length: 6 }, (_, i) => shiftMonth(this.month, i - 5));
    this.drawChart('chart-categorias', 'doughnut', cats.map(c => c.nome), cats.map(c => byCat.get(c.id) / 100), cats.map(c => c.cor));
    this.drawChart('chart-qths', 'bar', qths.map(q => this.qthName(q)), qths.map(q => byQth.get(q) / 100), '#F5A623', true);
    this.drawChart('chart-meses', 'bar', months.map(m => `${MONTH_SHORT[Number(m.slice(5)) - 1]}/${m.slice(2, 4)}`),
      months.map(m => sumCents(this.ofMonth(m)) / 100), months.map(m => m === this.month ? '#F5A623' : 'rgba(245,166,35,0.4)'));
  }

  drawChart(id, type, labels, data, colors, horizontal) {
    if (typeof Chart === 'undefined') return; // CDN not loaded (offline): the lines below the chart still show
    const ctx = document.getElementById(id);
    if (this.charts[id]) this.charts[id].destroy();
    const money = v => brl(Number(v));
    this.charts[id] = new Chart(ctx, {
      type,
      data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: type === 'doughnut' ? '#1B2A4A' : undefined, borderWidth: type === 'doughnut' ? 2 : 0, borderRadius: type === 'bar' ? 6 : 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false, indexAxis: horizontal ? 'y' : 'x',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => ` ${money(c.raw)}` } }
        },
        scales: type === 'bar' ? {
          // the value axis shows "R$ 1.500"; the other one keeps its default labels (QTH / month names)
          [horizontal ? 'x' : 'y']: { ticks: { color: 'rgba(255,255,255,0.7)', callback: v => money(v).replace(',00', '') }, grid: { color: 'rgba(255,255,255,0.06)' } },
          [horizontal ? 'y' : 'x']: { ticks: { color: 'rgba(255,255,255,0.7)' }, grid: { display: false } }
        } : undefined
      }
    });
  }

  // ===== lançamentos =====

  filtered() {
    const per = document.getElementById('f-periodo').value;
    const de = document.getElementById('f-de').value;
    const ate = document.getElementById('f-ate').value;
    const qth = document.getElementById('f-qth').value || '*';
    const cat = document.getElementById('f-cat').value || '*';
    const q = normalizeText(document.getElementById('f-busca').value);
    return this.gastosCache.filter(g => {
      const d = g.data || '';
      if (per === 'mes' && !d.startsWith(this.month)) return false;
      if (per === 'custom' && ((de && d < de) || (ate && d > ate))) return false;
      if (qth !== '*' && (g.qth || SEM_QTH) !== qth) return false;
      if (cat !== '*' && g.categoria !== cat) return false;
      if (q) {
        const hay = normalizeText([g.descricao, g.responsavel, g.obs, g.funcionario, g.subtipo, g.qth, this.cat(g.categoria).nome, moneyInput(parseMoney(g.valor))].join(' '));
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (b.data || '').localeCompare(a.data || '') || (b.criadoEm || 0) - (a.criadoEm || 0));
  }

  renderList() {
    const box = document.getElementById('gastos-list');
    if (!this.store.loaded && !this.gastosCache.length) return; // still the loading spinner
    const list = this.filtered();
    document.getElementById('list-summary').innerHTML = `${list.length} lançamento(s) · total <b>${brl(sumCents(list) / 100)}</b>`;
    if (!list.length) {
      box.innerHTML = '<div class="loading-state"><p>Nenhum gasto encontrado com esses filtros.</p></div>';
      return;
    }
    box.innerHTML = `<div class="gasto-list">${list.map(g => this.gastoRow(g)).join('')}</div>`;
  }

  gastoRow(g) {
    const c = this.cat(g.categoria);
    const extra = [];
    if (g.subtipo) extra.push(esc(g.subtipo));
    if (g.categoria === 'dobra' && g.funcionario) extra.push(`🔁 ${esc(g.funcionario)}${g.dataDobra ? ` (${fmtDate(g.dataDobra)})` : ''}`);
    if (g.categoria === 'perdas') {
      extra.push(g.perdaStatus === 'ressarcido'
        ? `<span class="status-badge ressarcido">✅ Ressarcido ${brl(parseMoney(g.valorRessarcido))}${g.dataRessarcimento ? ` em ${fmtDate(g.dataRessarcimento)}` : ''}</span>`
        : `<span class="status-badge pendente">⏳ Pendente${cents(g.valorRessarcido) ? ` · ressarcido ${brl(parseMoney(g.valorRessarcido))}` : ''}</span>`);
    }
    return `
      <div class="gasto-row${this.store.isPending(g.id) ? ' unsynced' : ''}" style="--cat-color:${esc(c.cor)}">
        <div class="gasto-main">
          <div class="gasto-title">${esc(g.descricao || c.nome)}</div>
          <div class="gasto-meta">
            <span>📅 ${fmtDate(g.data)}</span><span>🏢 ${esc(this.qthName(g.qth))}</span>
            <span class="cat-badge">${esc(c.nome)}</span>${extra.map(e => `<span>${e}</span>`).join('')}
            ${g.responsavel ? `<span>👤 ${esc(g.responsavel)}</span>` : ''}
            ${g.obs ? `<span>💬 ${esc(g.obs)}</span>` : ''}
            ${this.store.isPending(g.id) ? '<span>⏳ aguardando internet</span>' : ''}
          </div>
        </div>
        <div class="gasto-valor">${brl(parseMoney(g.valor))}</div>
        <div class="gasto-actions">
          ${g.temAnexo ? `<button class="btn-mini" data-act="anexo" data-id="${esc(g.id)}">📎 Comprovante</button>` : ''}
          <button class="btn-mini" data-act="edit" data-id="${esc(g.id)}">✏️ Editar</button>
          <button class="btn-mini" data-act="del" data-id="${esc(g.id)}">🗑️ Excluir</button>
        </div>
      </div>`;
  }

  // ===== formulário =====

  showGastoModal(id) {
    const g = id ? this.store.gastos[id] : null;
    if (id && !g) return;
    this.formAnexo = undefined;
    document.getElementById('gasto-modal-title').textContent = g ? '✏️ Editar gasto' : '➕ Novo gasto';
    document.getElementById('g-id').value = g ? g.id : '';
    document.getElementById('g-data').value = g ? g.data : today();
    document.getElementById('g-valor').value = g ? moneyInput(parseMoney(g.valor)) : '';
    document.getElementById('g-descricao').value = g ? g.descricao || '' : '';
    document.getElementById('g-responsavel').value = g ? g.responsavel || '' : (readJSON('adm_last', {}).responsavel || '');
    document.getElementById('g-obs').value = g ? g.obs || '' : '';
    document.getElementById('g-funcionario').value = g ? g.funcionario || '' : '';
    document.getElementById('g-data-dobra').value = g ? g.dataDobra || '' : today();
    document.getElementById('g-perda-status').value = g && g.perdaStatus === 'ressarcido' ? 'ressarcido' : 'pendente';
    document.getElementById('g-valor-ressarc').value = g ? moneyInput(parseMoney(g.valorRessarcido)) : '';
    document.getElementById('g-data-ressarc').value = g ? g.dataRessarcimento || '' : '';
    document.getElementById('g-anexo').value = '';
    document.getElementById('g-delete').style.display = g ? '' : 'none';

    // QTH select: config posts + "Geral" + the old name of this launch if it was renamed
    const last = readJSON('adm_last', {});
    const qth = g ? (g.qth || SEM_QTH) : (last.qth !== undefined ? last.qth : this.cfg.postos[0]);
    const names = [...this.cfg.postos];
    if (qth && !names.includes(qth)) names.push(qth);
    document.getElementById('g-qth').innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') + '<option value="">— Geral (sem posto) —</option>';
    document.getElementById('g-qth').value = names.includes(qth) || qth === SEM_QTH ? qth : names[0];

    this.formCat = g ? g.categoria : (last.categoria && this.cfg.categorias.some(c => c.id === last.categoria) ? last.categoria : 'insumos');
    this.renderCatChips();
    this.updateForm(g ? g.subtipo : undefined);
    this.renderAnexoPreview(g && g.temAnexo ? 'saved' : null);
    this.showModal('gasto-modal');
    if (!g) setTimeout(() => document.getElementById('g-valor').focus(), 150);
  }

  renderCatChips() {
    document.getElementById('g-cat-chips').innerHTML = this.cfg.categorias.map(c =>
      `<button type="button" class="chip${c.id === this.formCat ? ' active' : ''}" data-cat="${esc(c.id)}">${esc(c.nome)}</button>`).join('');
  }

  // Shows the extra fields of the chosen category
  updateForm(subtipo) {
    const c = this.cat(this.formCat);
    const subs = c.subtipos || [];
    const sel = document.getElementById('g-subtipo');
    document.getElementById('g-subtipo-group').style.display = subs.length ? '' : 'none';
    if (subtipo !== undefined || !subs.includes(sel.value)) {
      const list = subtipo && !subs.includes(subtipo) ? [...subs, subtipo] : subs;
      sel.innerHTML = list.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
      if (subtipo) sel.value = subtipo;
    }
    document.getElementById('g-dobra-box').classList.toggle('visible', this.formCat === 'dobra');
    document.getElementById('g-perda-box').classList.toggle('visible', this.formCat === 'perdas');
    document.getElementById('g-ressarc-row').style.display = document.getElementById('g-perda-status').value === 'ressarcido' ? '' : 'none';
  }

  renderAnexoPreview(src) {
    const box = document.getElementById('g-anexo-preview');
    if (!src) { box.innerHTML = '<span class="form-help">Nenhum</span>'; return; }
    box.innerHTML = `${src === 'saved' ? '<span>📎 Comprovante salvo</span>' : `<img src="${src}" alt="Comprovante">`}
      <button type="button" class="btn-mini" id="g-anexo-remove">✕ Remover</button>`;
    document.getElementById('g-anexo-remove').onclick = () => { this.formAnexo = null; this.renderAnexoPreview(null); };
  }

  async onAnexoPicked(file) {
    if (!file) return;
    try {
      this.showToast('🗜️ Comprimindo foto...', 'info');
      this.formAnexo = await compressImage(file);
      this.renderAnexoPreview(this.formAnexo);
    } catch (e) {
      this.showToast('❌ Não foi possível ler essa imagem', 'error');
    }
  }

  saveGasto() {
    const v = id => document.getElementById(id).value.trim();
    const id = v('g-id') || makeId();
    const old = this.store.gastos[id];
    const valor = parseMoney(v('g-valor'));
    const data = v('g-data');
    if (!data) return this.showToast('Informe a data', 'error');
    if (!(valor > 0)) return this.showToast('Informe o valor', 'error');
    const cat = this.formCat;
    if (cat === 'dobra' && !v('g-funcionario')) return this.showToast('Informe o funcionário que dobrou', 'error');
    const c = this.cat(cat);
    const g = {
      id, data, valor,
      qth: v('g-qth'),
      categoria: cat,
      subtipo: (c.subtipos || []).length || (old && old.subtipo) ? v('g-subtipo') || null : null,
      descricao: v('g-descricao'),
      responsavel: v('g-responsavel'),
      obs: v('g-obs'),
      funcionario: cat === 'dobra' ? v('g-funcionario') : null,
      dataDobra: cat === 'dobra' ? v('g-data-dobra') || data : null,
      perdaStatus: cat === 'perdas' ? v('g-perda-status') : null,
      valorRessarcido: cat === 'perdas' && v('g-perda-status') === 'ressarcido' ? parseMoney(v('g-valor-ressarc')) || valor : (cat === 'perdas' ? parseMoney(v('g-valor-ressarc')) : null),
      dataRessarcimento: cat === 'perdas' && v('g-perda-status') === 'ressarcido' ? v('g-data-ressarc') || today() : null,
      temAnexo: this.formAnexo === undefined ? !!(old && old.temAnexo) : !!this.formAnexo,
      criadoEm: old ? old.criadoEm || Date.now() : Date.now(),
      atualizadoEm: Date.now()
    };
    // the photo lives in its own node so the list stays light
    if (this.formAnexo !== undefined) this.store.write(`adm/anexos/${id}`, this.formAnexo);
    const savedLocally = this.store.write(`adm/gastos/${id}`, g);
    writeJSON('adm_last', { qth: g.qth, categoria: g.categoria, responsavel: g.responsavel });
    // remember new names for the suggestions
    const novos = [g.responsavel, g.funcionario].filter(n => n && !this.cfg.funcionarios.some(f => normalizeText(f) === normalizeText(n)));
    if (novos.length) this.store.write('adm/config', { ...this.cfg, funcionarios: [...this.cfg.funcionarios, ...new Set(novos)] });
    this.hideModal('gasto-modal');
    if (!savedLocally) this.showToast('⚠️ Memória do aparelho cheia: o comprovante pode não ser guardado sem internet.', 'error');
    this.showToast(this.store.connected ? `✅ Gasto salvo: ${brl(valor)}` : `⏳ Salvo no aparelho: ${brl(valor)} — envia quando a internet voltar`, this.store.connected ? 'success' : 'info');
  }

  deleteGasto(id) {
    const g = this.store.gastos[id];
    if (!g) return;
    this.confirm(`Excluir o gasto de ${brl(parseMoney(g.valor))} (${fmtDate(g.data)} · ${this.cat(g.categoria).nome})?`, () => {
      if (g.temAnexo) this.store.write(`adm/anexos/${id}`, null);
      this.store.write(`adm/gastos/${id}`, null);
      this.hideModal('gasto-modal');
      this.showToast('🗑️ Gasto excluído', 'success');
    });
  }

  async showAnexo(id) {
    const view = document.getElementById('anexo-view');
    view.innerHTML = '<div class="loading-spinner"></div>';
    this.showModal('anexo-modal');
    let src = this.store.pendingAnexo(id);
    if (src === undefined) {
      try { src = (await firebase.database().ref(`adm/anexos/${id}`).once('value')).val(); } catch (e) { src = null; }
    }
    view.innerHTML = src ? `<img src="${src}" alt="Comprovante"><p><a class="btn-mini" href="${src}" download="comprovante-${esc(id)}.jpg">⬇️ Baixar</a></p>`
      : '<p>Comprovante indisponível (sem internet?).</p>';
  }

  // ===== relatório =====

  renderReport() {
    const list = this.ofMonth(this.month).sort((a, b) => (a.data || '').localeCompare(b.data || ''));
    const total = sumCents(list);
    const qths = this.qthsOf(list).filter(q => list.some(g => (g.qth || SEM_QTH) === q));
    const cats = this.cfg.categorias.filter(c => list.some(g => g.categoria === c.id));
    list.forEach(g => { if (!cats.some(c => c.id === g.categoria)) cats.push(this.cat(g.categoria)); });
    const byQth = this.groupCents(list, g => g.qth || SEM_QTH);
    const byCat = this.groupCents(list, g => g.categoria);
    const cell = (q, c) => sumCents(list.filter(g => (g.qth || SEM_QTH) === q && g.categoria === c));
    const pct = v => total ? `${Math.round((v / total) * 1000) / 10}%`.replace('.', ',') : '—';
    const detalhe = document.getElementById('rel-detalhe').checked;
    const perdas = list.filter(g => g.categoria === 'perdas');

    let html = `
      <h2>FRONT SECURITY · Fechamento de gastos</h2>
      <div class="rel-sub">CFS Front Security · ${esc(monthLabel(this.month))} · emitido em ${fmtDate(today())} · ${list.length} lançamento(s)</div>`;
    if (!list.length) {
      document.getElementById('relatorio').innerHTML = html + '<p>Nenhum gasto lançado neste mês.</p>';
      return;
    }
    html += `
      <h3>Resumo por QTH</h3>
      <table><tr><th>QTH</th><th class="num">Qtd.</th><th class="num">Total</th><th class="num">%</th></tr>
        ${qths.map(q => `<tr><td>${esc(this.qthName(q))}</td><td class="num">${list.filter(g => (g.qth || SEM_QTH) === q).length}</td><td class="num">${brl(byQth.get(q) / 100)}</td><td class="num">${pct(byQth.get(q))}</td></tr>`).join('')}
        <tr class="tot"><td>Total</td><td class="num">${list.length}</td><td class="num">${brl(total / 100)}</td><td class="num">100%</td></tr></table>

      <h3>Resumo por categoria</h3>
      <table><tr><th>Categoria</th><th class="num">Qtd.</th><th class="num">Total</th><th class="num">%</th></tr>
        ${cats.map(c => `<tr><td>${esc(c.nome)}</td><td class="num">${list.filter(g => g.categoria === c.id).length}</td><td class="num">${brl(byCat.get(c.id) / 100)}</td><td class="num">${pct(byCat.get(c.id))}</td></tr>`).join('')}
        <tr class="tot"><td>Total</td><td class="num">${list.length}</td><td class="num">${brl(total / 100)}</td><td class="num">100%</td></tr></table>

      <h3>QTH × categoria</h3>
      <div class="rel-wrap"><table><tr><th>QTH</th>${cats.map(c => `<th class="num">${esc(c.nome)}</th>`).join('')}<th class="num">Total</th></tr>
        ${qths.map(q => `<tr><td>${esc(this.qthName(q))}</td>${cats.map(c => { const v = cell(q, c.id); return `<td class="num">${v ? brl(v / 100) : '–'}</td>`; }).join('')}<td class="num"><b>${brl(byQth.get(q) / 100)}</b></td></tr>`).join('')}
        <tr class="tot"><td>Total</td>${cats.map(c => `<td class="num">${brl(byCat.get(c.id) / 100)}</td>`).join('')}<td class="num">${brl(total / 100)}</td></tr></table></div>`;

    if (perdas.length) {
      const ress = perdas.reduce((s, g) => s + cents(g.valorRessarcido), 0);
      html += `
      <h3>Perdas – furtos</h3>
      <table><tr><th>Data</th><th>QTH</th><th>Descrição</th><th>Status</th><th class="num">Valor</th><th class="num">Ressarcido</th></tr>
        ${perdas.map(g => `<tr><td>${fmtDate(g.data)}</td><td>${esc(this.qthName(g.qth))}</td><td>${esc(g.descricao)}</td><td>${g.perdaStatus === 'ressarcido' ? `Ressarcido${g.dataRessarcimento ? ' ' + fmtDate(g.dataRessarcimento) : ''}` : 'Pendente'}</td><td class="num">${brl(parseMoney(g.valor))}</td><td class="num">${brl(parseMoney(g.valorRessarcido))}</td></tr>`).join('')}
        <tr class="tot"><td colspan="4">Total · saldo a ressarcir ${brl((sumCents(perdas) - ress) / 100)}</td><td class="num">${brl(sumCents(perdas) / 100)}</td><td class="num">${brl(ress / 100)}</td></tr></table>`;
    }

    if (detalhe) {
      html += qths.map(q => {
        const rows = list.filter(g => (g.qth || SEM_QTH) === q);
        return `
      <h3>${esc(this.qthName(q))} — ${brl(byQth.get(q) / 100)}</h3>
      <div class="rel-wrap"><table><tr><th>Data</th><th>Categoria</th><th>Descrição</th><th>Responsável</th><th class="num">Valor</th></tr>
        ${rows.map(g => `<tr><td>${fmtDate(g.data)}</td><td>${esc(this.cat(g.categoria).nome)}${g.subtipo ? ` · ${esc(g.subtipo)}` : ''}</td>
          <td>${esc(g.descricao)}${g.funcionario ? ` (${esc(g.funcionario)}${g.dataDobra ? ', dobra ' + fmtDate(g.dataDobra) : ''})` : ''}${g.obs ? ` — ${esc(g.obs)}` : ''}${g.temAnexo ? ' 📎' : ''}</td>
          <td>${esc(g.responsavel)}</td><td class="num">${brl(parseMoney(g.valor))}</td></tr>`).join('')}</table></div>`;
      }).join('');
    }
    html += '<div class="rel-sign"><div>Responsável ADM</div><div>Diretoria</div></div>';
    document.getElementById('relatorio').innerHTML = html;
  }

  // ===== configurações =====

  renderConfig() {
    document.getElementById('cfg-postos').value = this.cfg.postos.join('\n');
    document.getElementById('cfg-funcionarios').value = this.cfg.funcionarios.join('\n');
    this.renderCatEditor(this.cfg.categorias);
  }

  renderCatEditor(cats) {
    document.getElementById('cfg-categorias').innerHTML = cats.map(c => `
      <div class="cat-edit" data-id="${esc(c.id)}">
        <input type="color" class="cat-cor" value="${esc(c.cor)}" aria-label="Cor">
        <input type="text" class="form-input cat-nome" value="${esc(c.nome)}" placeholder="Nome">
        <input type="text" class="form-input cat-subs" value="${esc((c.subtipos || []).join(', '))}" placeholder="Subtipos (opcional)">
        <button type="button" class="cat-del" title="Excluir" ${FIXED_CATS.includes(c.id) ? 'disabled' : ''}>✕</button>
      </div>`).join('');
  }

  readCatEditor() {
    return [...document.querySelectorAll('#cfg-categorias .cat-edit')].map(r => ({
      id: r.dataset.id,
      nome: r.querySelector('.cat-nome').value.trim() || r.dataset.id,
      cor: r.querySelector('.cat-cor').value,
      subtipos: r.querySelector('.cat-subs').value.split(',').map(s => s.trim()).filter(Boolean)
    }));
  }

  saveConfig() {
    const lines = id => [...new Set(document.getElementById(id).value.split('\n').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean))];
    const postos = lines('cfg-postos');
    if (!postos.length) return this.showToast('Cadastre pelo menos um posto', 'error');
    this.store.write('adm/config', { postos, categorias: this.readCatEditor(), funcionarios: lines('cfg-funcionarios') });
    this.configDirty = false;
    this.showToast('✅ Configurações salvas', 'success');
  }

  // ===== exportar / importar =====

  download(name, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // CSV with ";" and comma decimals: opens straight in the Brazilian Excel
  exportCSV() {
    const list = this.filtered();
    if (!list.length) return this.showToast('Nada para exportar com esses filtros', 'error');
    const q = s => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
    const num = n => (parseMoney(n) || 0).toFixed(2).replace('.', ',');
    const head = ['Data', 'QTH', 'Categoria', 'Subtipo', 'Descrição', 'Valor (R$)', 'Responsável', 'Funcionário (3/6)', 'Data da dobra', 'Status perda', 'Valor ressarcido', 'Data ressarcimento', 'Observação', 'Comprovante'];
    const rows = list.map(g => [fmtDate(g.data), this.qthName(g.qth), this.cat(g.categoria).nome, g.subtipo, g.descricao, num(g.valor), g.responsavel, g.funcionario, fmtDate(g.dataDobra),
      g.categoria === 'perdas' ? (g.perdaStatus === 'ressarcido' ? 'Ressarcido' : 'Pendente') : '', g.categoria === 'perdas' ? num(g.valorRessarcido) : '', fmtDate(g.dataRessarcimento), g.obs, g.temAnexo ? 'Sim' : 'Não']);
    rows.push(['', '', '', '', 'TOTAL', num(sumCents(list) / 100)]);
    const csv = '﻿' + [head, ...rows].map(r => r.map(q).join(';')).join('\r\n');
    this.download(`gastos-adm-${today()}.csv`, csv, 'text/csv;charset=utf-8');
  }

  async exportJSON() {
    let anexos = {};
    if (this.store.connected) {
      try { anexos = (await firebase.database().ref('adm/anexos').once('value')).val() || {}; } catch (e) { /* sem anexos */ }
    } else {
      this.showToast('Sem internet: o backup sai sem as fotos dos comprovantes', 'info');
    }
    const data = { app: 'adm-controle-gastos', versao: APP_VERSION, exportadoEm: new Date().toISOString(), config: this.cfg, gastos: this.store.gastos, anexos };
    this.download(`backup-adm-${today()}.json`, JSON.stringify(data, null, 1), 'application/json');
  }

  importJSON(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); } catch (e) { return this.showToast('❌ Arquivo inválido', 'error'); }
      const gastos = data && data.gastos && typeof data.gastos === 'object' ? Object.values(data.gastos).filter(g => g && g.id && g.data) : null;
      if (!gastos) return this.showToast('❌ Este arquivo não é um backup do ADM', 'error');
      if (!this.store.connected) return this.showToast('Conecte-se à internet para importar', 'error');
      const novos = gastos.filter(g => !this.store.gastos[g.id]).length;
      this.confirm(`Importar ${gastos.length} gasto(s) (${novos} novo(s), ${gastos.length - novos} substituído(s))${data.config ? ' e as configurações' : ''}? Gastos que não estão no arquivo continuam como estão.`, async () => {
        const upd = {};
        gastos.forEach(g => { upd[`gastos/${g.id}`] = g; });
        Object.entries(data.anexos || {}).forEach(([k, v]) => { if (typeof v === 'string' && v.startsWith('data:image/')) upd[`anexos/${k}`] = v; });
        if (data.config) upd.config = normalizeConfig(data.config);
        try {
          await firebase.database().ref('adm').update(upd);
          this.showToast(`✅ ${gastos.length} gasto(s) importado(s)`, 'success');
        } catch (e) {
          console.error(e);
          this.showToast('❌ Falha ao importar. Verifique as permissões.', 'error');
        }
      });
    };
    reader.readAsText(file);
  }

  // ===== auto update =====

  async checkForUpdate() {
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { v } = await res.json();
      if (!v || v === APP_VERSION || this.updating || document.querySelector('.modal-overlay.active')) return;
      this.updating = true;
      this.showToast('⬆️ Nova versão do app — atualizando…', 'info');
      await Promise.all(['index.html', 'app.js', 'style.css', 'adm.css'].map(f => fetch(f, { cache: 'reload' }).catch(() => null)));
      setTimeout(() => location.reload(), 800);
    } catch (e) { /* offline */ }
  }

  // ===== UI utilities =====

  showModal(id) { document.getElementById(id).classList.add('active'); }
  hideModal(id) { document.getElementById(id).classList.remove('active'); }

  confirm(message, onYes) {
    document.getElementById('confirm-message').textContent = message;
    this.showModal('confirm-overlay');
    document.getElementById('confirm-yes').onclick = () => { this.hideModal('confirm-overlay'); onYes(); };
    document.getElementById('confirm-no').onclick = () => this.hideModal('confirm-overlay');
  }

  showToast(message, type = 'info') {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = message;
    c.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4000);
  }

  setupEventListeners() {
    const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);
    document.querySelectorAll('.view-tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach(x => x.classList.toggle('active', x === t));
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${t.dataset.view}`));
    }));
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => this.hideModal(b.dataset.close)));
    document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) this.hideModal(o.id); }));
    on('month-prev', 'click', () => this.setMonth(shiftMonth(this.month, -1)));
    on('month-next', 'click', () => this.setMonth(shiftMonth(this.month, 1)));
    on('month-current', 'click', () => this.setMonth(currentMonth()));

    // lista
    ['f-busca', 'f-de', 'f-ate'].forEach(id => on(id, 'input', () => this.renderList()));
    ['f-qth', 'f-cat'].forEach(id => on(id, 'change', () => this.renderList()));
    on('f-periodo', 'change', () => {
      const custom = document.getElementById('f-periodo').value === 'custom';
      ['f-de', 'f-ate'].forEach(id => { document.getElementById(id).style.display = custom ? '' : 'none'; });
      this.renderList();
    });
    on('gastos-list', 'click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'edit') this.showGastoModal(b.dataset.id);
      else if (b.dataset.act === 'del') this.deleteGasto(b.dataset.id);
      else if (b.dataset.act === 'anexo') this.showAnexo(b.dataset.id);
    });
    on('dash-perdas', 'click', e => {
      const a = e.target.closest('.link-edit');
      if (a) { e.preventDefault(); this.showGastoModal(a.dataset.id); }
    });
    on('export-csv', 'click', () => this.exportCSV());

    // formulário
    on('add-gasto-btn', 'click', () => this.showGastoModal(null));
    on('g-cat-chips', 'click', e => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      this.formCat = b.dataset.cat;
      this.renderCatChips();
      this.updateForm();
    });
    on('g-perda-status', 'change', () => {
      if (document.getElementById('g-perda-status').value === 'ressarcido') {
        if (!document.getElementById('g-valor-ressarc').value) document.getElementById('g-valor-ressarc').value = document.getElementById('g-valor').value;
        if (!document.getElementById('g-data-ressarc').value) document.getElementById('g-data-ressarc').value = today();
      }
      this.updateForm();
    });
    on('g-anexo', 'change', e => this.onAnexoPicked(e.target.files[0]));
    on('g-save', 'click', () => this.saveGasto());
    on('g-delete', 'click', () => this.deleteGasto(document.getElementById('g-id').value));

    // relatório
    on('print-btn', 'click', () => window.print());
    on('rel-detalhe', 'change', () => this.renderReport());

    // configurações
    on('view-config', 'input', () => { this.configDirty = true; });
    on('cfg-save', 'click', () => this.saveConfig());
    on('cfg-add-cat', 'click', () => {
      this.configDirty = true;
      this.renderCatEditor([...this.readCatEditor(), { id: 'c' + Date.now().toString(36), nome: '', cor: '#95A5A6', subtipos: [] }]);
      const inputs = document.querySelectorAll('#cfg-categorias .cat-nome');
      inputs[inputs.length - 1].focus();
    });
    on('cfg-categorias', 'click', e => {
      const b = e.target.closest('.cat-del');
      if (!b || b.disabled) return;
      const row = b.closest('.cat-edit');
      const n = this.gastosCache.filter(g => g.categoria === row.dataset.id).length;
      if (n) return this.showToast(`Esta categoria tem ${n} lançamento(s): mude-os de categoria antes de excluir`, 'error');
      this.configDirty = true;
      row.remove();
    });
    on('export-json', 'click', () => this.exportJSON());
    on('import-json', 'click', () => document.getElementById('import-file').click());
    on('import-file', 'change', e => { this.importJSON(e.target.files[0]); e.target.value = ''; });
    on('logout-btn', 'click', () => {
      const n = this.store.outbox.length;
      this.confirm(`Sair deste aparelho? A senha da equipe será pedida de novo.${n ? ` ATENÇÃO: ${n} lançamento(s) ainda não foram enviados.` : ''}`, () => {
        // financial data does not stay on a device that logged out (unsent writes are kept)
        localStorage.removeItem('adm_cache');
        AuthGate.signOut();
      });
    });
  }
}

if (typeof module !== 'undefined') {
  module.exports = { parseMoney, brl, fmtDate, shiftMonth, normalizeConfig, toArr };
} else {
  const app = new AdmApp();
  window.app = app;
  // The app starts only after the team password is accepted (auth-gate.js)
  document.addEventListener('DOMContentLoaded', () => {
    AuthGate.start(FIREBASE_CONFIG).then(() => app.init());
  });
}
