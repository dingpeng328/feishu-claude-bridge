const $ = selector => document.querySelector(selector);
const labels = { running: '执行中', completed: '已完成', failed: '失败', interrupted: '已中断', timeout: '超时', abandoned: '进程已结束' };
const platforms = { feishu: '飞书', wechat: '微信' };
let conversations = [], runs = [], selected, runId, offset = 0, filter = 'all', generation = 0;
let events = [], tools = new Map(), partial, textNodes = new Map(), fetching = false, lastList = 0;
let conversationLimit = 50, runLimit = 50, followLatest = true;
const date = time => new Date(time).toLocaleString('zh-CN', { hour12: false });
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function api(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`读取失败（${response.status}），请确认查看器仍在运行。`);
  return response.json();
}
function error(err) { $('#error').hidden = false; $('#error').textContent = err.message || String(err); $('#connection').textContent = '连接中断，自动重试中'; }
function healthy() { $('#error').hidden = true; $('#connection').textContent = '本地连接正常'; }
async function pages(endpoint, params, limit) {
  const items = []; let total = 0;
  for (let start = 0; start < limit; start += 50) {
    const data = await api(`${endpoint}?${new URLSearchParams({ ...params, offset: String(start) })}`);
    items.push(...data.items); total = data.total;
    if (items.length >= total) break;
  }
  return { items, total };
}
async function loadConversations() {
  const q = $('#search').value, platform = $('#platform').value;
  const data = await pages('/api/conversations', { q, platform }, conversationLimit);
  if (q !== $('#search').value || platform !== $('#platform').value) return;
  conversations = data.items;
  $('#count').textContent = String(data.total);
  $('#more-conversations').hidden = conversations.length >= data.total;
  const fragment = document.createDocumentFragment();
  for (const item of conversations) {
    const button = el('button', undefined, 'conversation');
    const active = selected?.conversationId === item.conversationId && selected?.platform === item.platform;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
    button.append(el('strong', item.title || '未命名会话'));
    const sub = el('div', undefined, 'sub');
    sub.append(el('span', `${platforms[item.platform]} · ${item.count} 次执行`), el('span', labels[item.status], `badge ${item.status}`));
    button.append(sub, el('div', date(item.startedAt), 'sub'));
    button.onclick = () => selectConversation(item).catch(error);
    fragment.append(button);
  }
  if (!conversations.length) fragment.append(el('p', $('#search').value ? '没有匹配的会话' : '还没有执行记录', 'empty-small'));
  $('#conversations').replaceChildren(fragment);
}
async function selectConversation(item) {
  selected = item; followLatest = true; runLimit = 50; runs = []; runId = undefined; generation++;
  $('#welcome').hidden = true; $('#detail').hidden = false;
  $('#title').textContent = item.title || '未命名会话';
  $('#source').textContent = `${platforms[item.platform]} / CONVERSATION`;
  $('#conversation-id').textContent = item.conversationId;
  clearTimeline();
  await Promise.all([loadRuns(), loadConversations()]);
}
async function loadRuns() {
  if (!selected) return;
  const current = selected;
  const data = await pages('/api/runs', { platform: current.platform, conversation: current.conversationId }, runLimit);
  if (current !== selected) return;
  runs = data.items;
  $('#more-runs').hidden = runs.length >= data.total;
  const options = runs.map((run, index) => {
    const option = el('option', `${date(run.startedAt)} · ${labels[run.status]} · ${run.title.slice(0, 36)}`);
    option.value = run.id;
    if (index === 0) option.textContent = `最新 · ${option.textContent}`;
    return option;
  });
  $('#runs').replaceChildren(...options);
  if (runs.length && (!runId || (followLatest && runId !== runs[0].id))) selectRun(runs[0].id);
  $('#runs').value = runId || '';
  renderMeta();
}
function renderMeta() {
  const run = runs.find(item => item.id === runId); if (!run) return;
  const duration = Math.max(0, Math.floor(((run.endedAt || Date.now()) - run.startedAt) / 1000));
  const status = el('span', labels[run.status] || run.status, `badge ${run.status}`);
  const agent = el('span', `${run.agent}${run.model ? ` / ${run.model}` : ''}`);
  const cwd = el('span', run.cwd || '', 'mono');
  const session = el('span', run.sessionId ? `Session: ${run.sessionId}` : 'Session: 等待创建', 'mono');
  $('#run-meta').replaceChildren(status, agent, el('span', run.status === 'abandoned' ? '结束时间未记录' : `${duration} 秒`), cwd, session);
}
function clearTimeline() {
  offset = 0; events = []; tools = new Map(); textNodes = new Map(); partial = undefined;
  $('#timeline').replaceChildren(); $('#event-empty').hidden = false;
  $('#event-empty').textContent = '等待执行事件…';
}
function selectRun(id) { runId = id; generation++; clearTimeline(); renderMeta(); }
function card(title, kind, time) {
  const root = el('article', undefined, `event ${kind}`); root.dataset.kind = kind;
  const head = el('div', undefined, 'event-head');
  head.append(el('strong', title), el('time', date(time))); root.append(head);
  $('#timeline').append(root); return root;
}
function detail(root, title, data, open = false) {
  if (data === undefined) return;
  const disclosure = el('details'); disclosure.open = open;
  disclosure.append(el('summary', title), el('pre', pretty(data))); root.append(disclosure);
  return disclosure;
}
function applyFilter() {
  let visible = 0;
  for (const node of $('#timeline').children) {
    node.hidden = filter === 'raw' ? node.dataset.kind !== 'raw'
      : node.dataset.kind === 'raw' || (filter !== 'all' && node.dataset.kind !== filter);
    if (!node.hidden) visible++;
  }
  $('#event-empty').hidden = visible > 0;
  $('#event-empty').textContent = events.length ? '该分类暂无事件' : '等待执行事件…';
}
function renderEvent(event) {
  if (filter === 'raw') {
    const rawCard = card(event.type, 'raw', event.time); detail(rawCard, '查看完整事件 JSON', event); return;
  }
  if (event.truncated) {
    const node = card('事件过大，已截断', 'system', event.time); detail(node, event.note, event.preview); return;
  }
  if (event.type === 'execution_started') {
    const node = card('用户输入与本轮上下文', 'input', event.time);
    detail(node, '展开完整 Prompt', event.prompt, true); return;
  }
  if (event.type === 'text_delta') {
    if (partial) { partial.root.remove(); partial = undefined; }
    const message = event.raw?.message;
    const blockIndex = message?.content?.findIndex(block => block.type === 'text' && block.text === event.text);
    const key = message?.id ? `${message.id}:${blockIndex}` : event.raw?.item?.id;
    let existing = key && textNodes.get(key);
    if (existing) existing.pre.textContent = event.text;
    else {
      const node = card('Agent 输出', 'text', event.time); const pre = el('pre', event.text); node.append(pre);
      if (key) textNodes.set(key, { root: node, pre });
    }
    return;
  }
  if (event.type === 'tool_started' || event.type === 'tool_finished') {
    const key = event.callId;
    let entry = key && tools.get(key);
    const block = event.raw?.message?.content?.find(block => block.id === key || block.tool_use_id === key);
    const item = event.raw?.item;
    const name = event.toolName || entry?.name || block?.name || item?.type || '工具';
    if (!entry) {
      const root = card(name, 'tool', event.time);
      entry = { root, name }; if (key) tools.set(key, entry);
      if (key) root.append(el('div', `调用 ID · ${key}`, 'muted mono'));
    }
    if (event.type === 'tool_started') {
      entry.root.querySelector('strong').textContent = `${name} · 调用中`;
      detail(entry.root, '调用参数', block?.input ?? item ?? event.raw, true);
    } else {
      entry.root.querySelector('strong').textContent = `${name} · ${event.isError ? '失败' : '完成'}`;
      if (event.isError) { entry.root.classList.add('error'); const node = card(`${name} 调用失败`, 'error', event.time); detail(node, '错误详情', block?.content ?? item ?? event.raw); }
      detail(entry.root, '工具输出', block?.content ?? item?.aggregated_output ?? item?.result ?? item ?? event.raw, true);
    }
    return;
  }
  if (event.type === 'execution_finished') {
    const node = card(`执行${labels[event.status] || event.status}`, ['failed', 'timeout'].includes(event.status) ? 'error' : 'system', event.time);
    detail(node, '执行结果', event, event.status === 'failed'); return;
  }
  if (event.type === 'stderr' || event.type === 'stream_error') {
    const node = card(event.type === 'stderr' ? '标准错误输出（含诊断日志）' : '流读取失败', 'error', event.time);
    detail(node, '查看内容', event.text || event.error, true); return;
  }
  if (event.type === 'system_init') {
    const node = card('Agent 会话已连接', 'system', event.time); node.append(el('pre', event.sessionId)); return;
  }
  const raw = event.raw;
  // Claude token deltas precede the complete assistant message. Replace the
  // live preview when that complete message arrives, avoiding duplicate output.
  if (raw?.type === 'stream_event' && raw.event?.delta?.type === 'text_delta') {
    if (!partial) { const root = card('Agent 正在输出…', 'text', event.time); const pre = el('pre', ''); root.append(pre); partial = { root, pre }; }
    partial.pre.textContent += raw.event.delta.text || ''; return;
  }
  if ((event.type === 'result' && event.isError) || raw?.type === 'error' || raw?.type === 'turn.failed') {
    const node = card('Agent 错误', 'error', event.time); detail(node, '错误详情', raw, true);
  }
}
async function loadEvents() {
  if (!runId) return;
  const id = runId, version = generation;
  const scroll = $('main');
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  let more = true, batches = 0;
  while (more && batches++ < 5) {
    const data = await api(`/api/runs/${id}/events?offset=${offset}`);
    if (id !== runId || version !== generation) return;
    offset = data.nextOffset; more = data.hasMore;
    events.push(...data.events);
    for (const event of data.events) renderEvent(event);
  }
  applyFilter();
  if ($('#follow').checked && nearBottom) scroll.scrollTop = scroll.scrollHeight;
}
async function poll() {
  if (fetching) return; fetching = true;
  try {
    if (Date.now() - lastList > 4500) {
      await Promise.all([loadConversations(), loadRuns()]); lastList = Date.now();
    }
    await loadEvents(); renderMeta(); healthy();
  } catch (err) { error(err); } finally { fetching = false; }
}
$('#runs').onchange = () => { followLatest = $('#runs').value === runs[0]?.id; selectRun($('#runs').value); void poll(); };
let searchTimer;
$('#search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { conversationLimit = 50; loadConversations().catch(error); }, 200); };
$('#platform').onchange = () => { conversationLimit = 50; loadConversations().catch(error); };
$('#more-conversations').onclick = () => { conversationLimit += 50; loadConversations().catch(error); };
$('#more-runs').onclick = () => { runLimit += 50; loadRuns().catch(error); };
for (const button of document.querySelectorAll('[data-filter]')) button.onclick = () => {
  filter = button.dataset.filter;
  for (const other of document.querySelectorAll('[data-filter]')) other.classList.toggle('active', other === button);
  $('#timeline').replaceChildren(); tools = new Map(); textNodes = new Map(); partial = undefined;
  for (const event of events) renderEvent(event);
  applyFilter();
};
void poll(); setInterval(() => void poll(), 1200);
