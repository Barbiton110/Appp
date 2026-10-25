const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  me: null,
  accounts: [],
  selectedAccount: null,
  media: [],          // [{id, url}]
  when: 'datetime',
  postFilter: 'upcoming',
};

// ---------- utils ----------
async function api(path, opts = {}) {
  const init = { credentials: 'same-origin', ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || 'POST';
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'שגיאה'), { status: res.status });
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), 3000);
}

async function busy(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'רגע...';
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
}

function segment(container, attr, onChange) {
  $$(`[data-${attr}]`, container).forEach((b) =>
    b.addEventListener('click', () => {
      $$(`[data-${attr}]`, container).forEach((x) => x.classList.toggle('active', x === b));
      onChange(b.dataset[attr]);
    }));
}

const fmtDate = (ms) => new Date(ms).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
const toLocalInput = (ms) => {
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

// ---------- auth ----------
let authMode = 'login';
segment($('#auth-view'), 'auth', (mode) => {
  authMode = mode;
  $$('.reg-only').forEach((el) => el.classList.toggle('hidden', mode !== 'register'));
  $('#auth-submit').textContent = mode === 'login' ? 'התחברות' : 'יצירת חשבון';
  $('[name=password]', $('#auth-form')).autocomplete = mode === 'login' ? 'current-password' : 'new-password';
});

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#auth-error').textContent = '';
  const body = Object.fromEntries(new FormData(e.target));
  try {
    await busy($('#auth-submit'), () => api(`/api/auth/${authMode}`, { json: body }));
    await boot();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  location.href = '/';
});

// ---------- tabs ----------
segment($('.tabs'), 'tab', (tab) => {
  $$('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${tab}`));
  if (tab === 'schedule') loadPosts();
});
function goTab(tab) { $(`[data-tab=${tab}]`).click(); }

// ---------- accounts ----------
async function loadAccounts() {
  state.accounts = await api('/api/accounts');
  if (!state.accounts.some((a) => a.id === state.selectedAccount)) {
    state.selectedAccount = state.accounts[0]?.id ?? null;
  }
  renderAccountPicker();
  renderAccountsList();
}

function renderAccountPicker() {
  const el = $('#account-picker');
  if (!state.accounts.length) {
    el.innerHTML = `<p class="muted">עוד לא חיברתם חשבון אינסטגרם.</p>
      <button class="btn primary" id="go-connect">לחיבור חשבון</button>`;
    $('#go-connect').onclick = () => goTab('settings');
    return;
  }
  el.innerHTML = `<div class="accounts">${state.accounts.map((a) => `
    <button class="acct ${a.id === state.selectedAccount ? 'active' : ''}" data-id="${a.id}">@${esc(a.username)}</button>`).join('')}
  </div>`;
  $$('.acct', el).forEach((b) => b.addEventListener('click', () => {
    state.selectedAccount = Number(b.dataset.id);
    renderAccountPicker();
  }));
}

function renderAccountsList() {
  const el = $('#accounts-list');
  el.innerHTML = state.accounts.map((a) => {
    const days = Math.round((a.token_expires_at - Date.now()) / 86400000);
    const warn = days < 7 ? `<span class="badge failed">חברו מחדש</span>` : '';
    return `<div class="acct-row">
      <div><b>@${esc(a.username)}</b> ${warn}</div>
      <button class="btn ghost small danger" data-del="${a.id}">ניתוק</button>
    </div>`;
  }).join('') || '<p class="muted">אין חשבונות מחוברים.</p>';
  $$('[data-del]', el).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('לנתק את החשבון? פוסטים מתוזמנים שלו יימחקו.')) return;
    await api(`/api/accounts/${b.dataset.del}`, { method: 'DELETE' });
    loadAccounts();
  }));
}

$('#demo-account').addEventListener('click', async () => {
  await api('/api/accounts/demo', { method: 'POST' });
  toast('חשבון דמו נוסף');
  loadAccounts();
});

// ---------- media ----------
segment($('#tab-compose'), 'src', (src) => {
  $('#src-upload').classList.toggle('hidden', src !== 'upload');
  $('#src-ai').classList.toggle('hidden', src !== 'ai');
});

function renderMedia() {
  $('#selected-media').innerHTML = state.media.map((m, i) => `
    <div class="thumb"><img src="${esc(m.url)}" alt="" />
      <span class="n">${i + 1}</span>
      <button data-rm="${i}" aria-label="הסר">×</button></div>`).join('');
  $$('[data-rm]').forEach((b) => b.addEventListener('click', () => {
    state.media.splice(Number(b.dataset.rm), 1);
    renderMedia();
  }));
}

async function uploadFiles(files) {
  if (!files.length) return;
  const fd = new FormData();
  [...files].slice(0, 10).forEach((f) => fd.append('images', f));
  toast('מעלה תמונות...');
  try {
    const saved = await api('/api/media', { method: 'POST', body: fd });
    state.media.push(...saved);
    renderMedia();
    toast(`${saved.length} תמונות הועלו`);
  } catch (err) { toast(err.message); }
}

$('#file-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles(e.dataTransfer.files); });

$('#ai-image-btn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const prompt = $('#ai-image-prompt').value.trim();
  if (!prompt) return toast('כתבו תיאור לתמונה');
  try {
    const m = await api('/api/ai/image', { json: { prompt } });
    state.media.push(m);
    renderMedia();
  } catch (err) { toast(err.message); }
}));

// ---------- caption ----------
const caption = $('#caption');
caption.addEventListener('input', () => { $('#caption-count').textContent = caption.value.length; });

$('#ai-caption-btn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  try {
    const { caption: text } = await api('/api/ai/caption', { json: { topic: $('#ai-topic').value } });
    caption.value = text;
    caption.dispatchEvent(new Event('input'));
  } catch (err) { toast(err.message); }
}));

// ---------- schedule ----------
segment($('#tab-compose'), 'when', (w) => {
  state.when = w;
  $('#when-datetime').classList.toggle('hidden', w !== 'datetime');
  $('#when-queue').classList.toggle('hidden', w !== 'queue');
});

$('#schedule-btn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  $('#compose-error').textContent = '';
  const local = $('#scheduled-at').value;
  const body = {
    ig_account_id: state.selectedAccount,
    media_ids: state.media.map((m) => m.id),
    caption: caption.value,
    mode: state.when,
    scheduled_at: local ? new Date(local).toISOString() : null,
  };
  try {
    const created = await api('/api/posts', { json: body });
    const first = created[0].scheduled_at;
    toast(created.length === 1
      ? `תוזמן ל-${fmtDate(first)} ב-${fmtTime(first)}`
      : `${created.length} פוסטים תוזמנו, החל מ-${fmtDate(first)}`);
    state.media = [];
    renderMedia();
    caption.value = '';
    caption.dispatchEvent(new Event('input'));
    $('#ai-topic').value = '';
    goTab('schedule');
  } catch (err) {
    $('#compose-error').textContent = err.message;
  }
}));

// ---------- posts list ----------
segment($('#tab-schedule'), 'filter', (f) => { state.postFilter = f; loadPosts(); });

const STATUS = { scheduled: 'מתוזמן', publishing: 'בפרסום', published: 'פורסם', failed: 'נכשל' };

async function loadPosts() {
  const posts = await api('/api/posts');
  const f = state.postFilter;
  let list = posts.filter((p) =>
    f === 'upcoming' ? ['scheduled', 'publishing'].includes(p.status) : p.status === f);
  if (f === 'upcoming') list = list.sort((a, b) => a.scheduled_at - b.scheduled_at);

  const el = $('#posts-list');
  if (!list.length) {
    el.innerHTML = `<div class="empty">${f === 'upcoming'
      ? 'אין פוסטים מתוזמנים. <br><br><button class="btn primary" id="go-compose">צרו פוסט ראשון</button>'
      : 'אין כאן כלום עדיין.'}</div>`;
    $('#go-compose')?.addEventListener('click', () => goTab('compose'));
    return;
  }

  let lastDay = '';
  el.innerHTML = list.map((p) => {
    const t = p.status === 'published' ? p.published_at : p.scheduled_at;
    const day = fmtDate(t);
    const head = day !== lastDay ? `<div class="day-head">${day}</div>` : '';
    lastDay = day;
    const editable = ['scheduled', 'failed'].includes(p.status);
    return `${head}<div class="post" data-id="${p.id}">
      <img src="${esc(p.image_url)}" alt="" loading="lazy" />
      <div>
        <div class="meta"><b>${fmtTime(t)}</b> · @${esc(p.username)}
          <span class="badge ${p.status}">${STATUS[p.status]}</span></div>
        <div class="cap">${esc(p.caption) || '<i>ללא כיתוב</i>'}</div>
        ${p.error ? `<div class="err">${esc(p.error)}</div>` : ''}
        ${editable ? `<div class="actions">
          <button class="btn small" data-act="time">שינוי זמן</button>
          <button class="btn small" data-act="edit">עריכת כיתוב</button>
          <button class="btn small" data-act="now">פרסם עכשיו</button>
          <button class="btn small ghost danger" data-act="del">מחיקה</button>
        </div>` : ''}
      </div></div>`;
  }).join('');

  $$('.post [data-act]', el).forEach((b) => b.addEventListener('click', () => postAction(b, posts)));
}

async function postAction(btn, posts) {
  const id = Number(btn.closest('.post').dataset.id);
  const p = posts.find((x) => x.id === id);
  try {
    if (btn.dataset.act === 'del') {
      if (!confirm('למחוק את הפוסט מהתזמון?')) return;
      await api(`/api/posts/${id}`, { method: 'DELETE' });
    } else if (btn.dataset.act === 'now') {
      if (!confirm('לפרסם עכשיו לאינסטגרם?')) return;
      const r = await busy(btn, () => api(`/api/posts/${id}/publish-now`, { method: 'POST' }));
      toast(r.status === 'published' ? 'פורסם!' : `נכשל: ${r.error}`);
    } else if (btn.dataset.act === 'time') {
      const actions = btn.parentElement;
      actions.innerHTML = `<input type="datetime-local" value="${toLocalInput(p.scheduled_at)}" style="max-width:220px" />
        <button class="btn small primary">שמירה</button>`;
      actions.querySelector('button').onclick = async () => {
        const v = actions.querySelector('input').value;
        try {
          await api(`/api/posts/${id}`, { method: 'PUT', json: { scheduled_at: new Date(v).toISOString() } });
          loadPosts();
        } catch (err) { toast(err.message); }
      };
      return;
    } else if (btn.dataset.act === 'edit') {
      const text = prompt('כיתוב חדש:', p.caption);
      if (text === null) return;
      await api(`/api/posts/${id}`, { method: 'PUT', json: { caption: text } });
    }
    loadPosts();
  } catch (err) { toast(err.message); }
}

// ---------- settings ----------
$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/me', { method: 'PUT', json: Object.fromEntries(new FormData(e.target)) });
    $('#profile-saved').textContent = 'נשמר ✓';
    setTimeout(() => ($('#profile-saved').textContent = ''), 2000);
    await loadMe();
  } catch (err) { toast(err.message); }
});

async function loadMe() {
  const data = await api('/api/me');
  state.me = data;
  const u = data.user;
  const f = $('#profile-form');
  f.business_name.value = u.business_name || '';
  f.business_description.value = u.business_description || '';
  f.daily_time.value = u.daily_time;
  f.timezone.value = u.timezone;
  $('#queue-time').textContent = u.daily_time;

  $('#demo-account').classList.toggle('hidden', !data.dryRun);
  $('#connect-ig').classList.toggle('hidden', !data.igConfigured);
  $('#ai-caption-btn').disabled = !data.ai.caption;
  $('#ai-caption-btn').title = data.ai.caption ? '' : 'הגדירו ANTHROPIC_API_KEY בשרת';
  $('#ai-image-btn').disabled = !data.ai.image;
  $('#ai-image-note').textContent = data.ai.image ? '' : 'יצירת תמונות דורשת OPENAI_API_KEY בשרת.';

  const banner = $('#banner');
  banner.classList.toggle('hidden', !data.dryRun);
  banner.textContent = 'מצב בדיקה פעיל: פוסטים "יתפרסמו" בסימולציה בלבד (IG_DRY_RUN=1).';
}

// ---------- boot ----------
async function boot() {
  try {
    await loadMe();
  } catch (err) {
    if (err.status === 401) {
      $('#auth-view').classList.remove('hidden');
      $('#app-view').classList.add('hidden');
      return;
    }
    throw err;
  }
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');

  // ברירת מחדל: מחר בשעה היומית
  const [h, m] = state.me.user.daily_time.split(':').map(Number);
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  $('#scheduled-at').value = toLocalInput(d.getTime());

  await loadAccounts();

  const q = new URLSearchParams(location.search);
  if (q.get('connected')) toast('החשבון חובר בהצלחה!');
  if (q.get('ig_error')) toast(`החיבור נכשל: ${q.get('ig_error')}`);
  if (q.size) history.replaceState(null, '', '/');

  setInterval(() => { if (!$('#tab-schedule').classList.contains('hidden')) loadPosts(); }, 30000);
}

boot();
