// 合成fixtureとローカルdistだけを使う。HTTP listenerや実APIへは接続しない。
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const runtime = process.env.CODEX_BROWSER_RUNTIME ?? resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = createRequire(`${runtime}/playwright/package.json`)('playwright');
const root = process.cwd();
const out = resolve(root, '.evidence');
await mkdir(out, { recursive: true });
const results = [];
const unexpected = [];
const errors = [];
const statuses = ['waiting_human', 'waiting_human', 'answered', 'claimed', 'resolved', 'cancelled'];
function fixtures() {
  return statuses.map((status, i) => ({
    id: `hd_${String(i + 1).padStart(16, '0')}`, taskId: 't_0000000000000001',
    ownerOrchestratorId: 'o_0000000000000001', kind: 'approval',
    title: ['合成デモ：公開前の確認', '合成デモ：検証結果の確認', '合成デモ：回答済み', '合成デモ：処理中', '合成デモ：解決済み', '合成デモ：取消'][i],
    question: 'これは検証専用の合成データです。画面の表示と操作を確認してよいですか。',
    action: '合成プレビューの表示を確認する', targetRevision: { kind: 'git_commit', value: 'a'.repeat(40) },
    choices: [], links: [], defaultOutcome: 'deny', relatedRequestId: null, deadlineAt: null,
    status, answerRevision: status === 'waiting_human' ? 0 : 1,
    answer: status === 'waiting_human' ? null : { kind: 'approval', outcome: 'approve' }, answerComment: null,
    requestProvenance: { kind: 'orchestrator', actorId: 'o_0000000000000001', actorSessionId: 'synthetic', actorGeneration: 1 },
    answerProvenance: null, cancelProvenance: null, resolveProvenance: null, answeredAt: null,
    claimantOrchestratorId: null, claimantSessionId: null, claimantGeneration: null, claimLeaseUntil: null,
    resolution: status === 'resolved' ? '検証完了' : null, resolvedAt: null,
    cancelReason: status === 'cancelled' ? '合成依頼の取消' : null, cancelledAt: null,
    createdAt: 1789000000000, updatedAt: 1789000000000,
  }));
}
const emptyStatuses = ['triage', 'todo', 'ready', 'blocked', 'review', 'needs-integration', 'done', 'archived'];
const board = { tenants: ['synthetic-alpha', 'synthetic-beta'], currentTenant: null,
  counts: Object.fromEntries(emptyStatuses.map(s => [s, 0])), doneOrigins: { total: 0, counts: { gatePassed: 0, orchestratorHostFinalize: 0, humanDecision: 0, unknown: 0 }, automaticCompletionRate: 0, manualRecoveryRate: 0, unknownRate: 0 },
  retryPending: 0, steerDeliveriesByTask: {}, lanes: { humanQueue: [], humanDecisionQueue: [], orchestratorRecoveryQueue: [], inProgress: [], byStatus: Object.fromEntries(emptyStatuses.map(s => [s, []])) } };
const task = { id: 't_0000000000000001', title: '合成デモ：画面の表示を確認する', body: '検証用の合成タスクです。長い情報もカード内に収めます。' + 'synthetic_revision_'.repeat(20), status: 'ready', priority: 1, tenant: 'synthetic-alpha', assignee: '', provider: 'codex', profile: 'implement', modelOverride: '', effortOverride: '', speedOverride: '', reviewProfileOverride: '', reviewProviderOverride: '', reviewModelOverride: '', reviewEffortOverride: '', reviewSpeedOverride: '', blockReason: '', claimLock: '', watched: false, consecutiveFailures: 0, lastFailureError: '', lastHeartbeatAt: null, maxRetries: 2, createdAt: 1789000000000, updatedAt: 1789000000000, startedAt: null, completedAt: null };
board.lanes.byStatus.ready.push(task); board.counts.ready = 1;
const browser = await chromium.launch({ headless: true });
async function setup(width = 1280, theme = 'light', options = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const state = { requests: fixtures(), mode: 'success', posts: [], hold: null, listError: false, holdList: null, listHeld: false, lateAlpha: false };
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error' && !e.text().includes('Failed to load resource')) errors.push(e.text()); });
  await context.route('**/*', async route => {
    const req = route.request(); const url = new URL(req.url());
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.origin !== 'https://hachi.test') { unexpected.push(req.url()); return route.abort(); }
    if (url.pathname === '/api/board') return json(board);
    if (url.pathname === '/api/supervisor') return json({ launchd: null, stages: [], lastTick: null, killSwitchDir: '/synthetic' });
    if (url.pathname === '/api/runtime-resources') return json({ generatedAt: 1789000000000, summary: { total: 0, active: 0, stale: 0, expired: 0, cleanupPending: 0, quarantined: 0, legacyNever: 0 }, leases: [] });
    if (url.pathname === '/api/sessions') return json({ sessions: [] });
    if (url.pathname === '/api/knowledge') return json({ knowledge: [] });
    if (url.pathname === '/api/human-decisions') {
      if (state.listHeld || (state.lateAlpha && url.searchParams.get('tenant') === 'synthetic-alpha')) await new Promise(r => { state.holdList = r; });
      const requests = url.searchParams.get('tenant') === 'synthetic-beta' ? [{ ...fixtures()[0], title: '合成ベータ専用確認' }] : state.requests;
      return state.listError ? json({ error: '合成取得エラー' }, 503) : json({ requests });
    }
    if (/^\/api\/human-decisions\/[^/]+\/answer$/.test(url.pathname)) {
      state.posts.push(req.postDataJSON());
      if (state.mode === 'conflict') { const request = state.requests.find(r => url.pathname.includes(r.id)); request.status = 'answered'; request.answerRevision = 1; request.answer = { kind: 'approval', outcome: 'reject' }; return json({ error: '合成競合：他者回答済み' }, 409); }
      if (state.mode === 'uncertain') return json({ error: '合成応答不明' }, 503);
      if (state.mode === 'auth') return json({ error: '認証が必要です' }, 401);
      if (state.mode === 'hold') await new Promise(r => { state.hold = r; });
      const request = state.requests.find(r => url.pathname.includes(r.id));
      request.status = 'answered'; request.answerRevision = 1; request.answer = req.postDataJSON().answer;
      return json({ request });
    }
    if (url.pathname.startsWith('/api/')) { unexpected.push(`${req.method()} ${url.pathname}`); return json({ error: 'Unexpected synthetic API' }, 500); }
    let path = resolve(root, 'packages/web/dist', url.pathname.slice(1) || 'index.html');
    if (!extname(path)) path = resolve(root, 'packages/web/dist/index.html');
    if (!path.startsWith(resolve(root, 'packages/web/dist') + '/')) { unexpected.push(path); return route.abort(); }
    try { return await route.fulfill({ body: await readFile(path), contentType: ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'})[extname(path)] ?? 'application/octet-stream' }); }
    catch { unexpected.push(url.pathname); return route.abort(); }
  });
  Object.assign(state, options);
  await page.goto('https://hachi.test/');
  const trigger = page.getByRole('button', { name: /人間への確認/, includeHidden: true });
  await trigger.waitFor();
  if (!options.listHeld && !options.listError) await page.waitForFunction(() => [...document.querySelectorAll('button')].some(el => el.getAttribute('aria-label') === '人間への確認、2件'));
  return { context, page, state, trigger };
}
async function check(name, action) { await action(); results.push({ name, status: 'pass' }); }
async function geometry(page) {
  const value = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(value.scroll <= value.width, JSON.stringify(value));
  const boxes = await page.locator('header button').evaluateAll(els => els.map(el => { const b = el.getBoundingClientRect(); return { name: el.getAttribute('aria-label') ?? el.textContent, x: b.x, right: b.right, y: b.y, bottom: b.bottom, width: b.width, height: b.height }; }).filter(b => b.width && b.height));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(!(Math.min(a.right,b.right) - Math.max(a.x,b.x) > 1 && Math.min(a.bottom,b.bottom) - Math.max(a.y,b.y) > 1), JSON.stringify({a,b}));
  }
}
try {
  for (const width of (process.env.BROWSER_STATES_ONLY ? [] : [320, 375, 402, 768, 1280, 1440])) for (const theme of ['light', 'dark']) {
    const { context, page, trigger } = await setup(width, theme);
    await check(`${width}/${theme}: closed board and header geometry`, async () => { assert.equal(await page.getByRole('dialog').count(), 0); await geometry(page); });
    if (width === 1280 && theme === 'light') await page.screenshot({ path: `${out}/ui-closed-board.png` });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '人間への確認', exact: true });
    await dialog.waitFor();
    await check(`${width}/${theme}: drawer bounds`, async () => { await geometry(page); const b = await dialog.boundingBox(); assert.ok(b.x >= -1 && b.x + b.width <= width + 1); if (width < 768) assert.ok(b.width >= width - 2); });
    if (width === 1280 && theme === 'light') await page.screenshot({ path: `${out}/ui-desktop-drawer.png` });
    if (width === 375 && theme === 'dark') await page.screenshot({ path: `${out}/ui-mobile-drawer-dark.png` });
    await page.keyboard.press('Escape');
    await check(`${width}/${theme}: Escape focus restoration`, async () => { assert.equal(await page.getByRole('dialog').count(), 0); await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('人間への確認')); });
    const more = page.getByRole('button', { name: 'その他', exact: true });
    await more.click();
    await check(`${width}/${theme}: menu and theme`, async () => { for (const name of ['メトリクス', '利用状況', 'ナレッジ', 'スケジュール', '設定']) assert.ok(await page.getByRole('button', { name, exact: true }).isVisible()); await page.getByRole('radio', { name: 'ダーク', exact: true }).click(); assert.ok(await page.getByRole('radio', { name: 'ライト', exact: true }).isVisible()); await geometry(page); });
    if (width === 1280 && theme === 'dark') await page.screenshot({ path: `${out}/ui-desktop-menu-dark.png` });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'その他');
    await context.close();
  }
  {
    const { context, page, state, trigger } = await setup();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '人間への確認', exact: true });
    const waiting = page.getByRole('button', { name: /確認待ち/ });
    const answered = page.getByRole('button', { name: /回答済み/ });
    const history = page.getByRole('button', { name: /履歴/ });
    const comments = () => page.getByLabel('コメント（任意）').first();
    await check('draft survives tabs and close; reopen waiting', async () => {
      await comments().fill('合成の下書き'); await answered.click();
      assert.ok(await page.getByText('処理待ち', { exact: true }).isVisible());
      assert.ok(await page.getByText('処理中', { exact: true }).isVisible());
      await history.click();
      assert.ok(await page.getByText('解決済み', { exact: true }).isVisible());
      assert.ok(await page.getByText('取消済み', { exact: true }).isVisible());
      await page.keyboard.press('Escape'); await trigger.click();
      assert.equal(await waiting.getAttribute('aria-pressed'), 'true');
      assert.equal(await comments().inputValue(), '合成の下書き');
    });
    await check('outside pointer and keyboard focus remain modal', async () => {
      await page.mouse.click(10, 400); assert.ok(await dialog.isVisible());
      for (let i = 0; i < 24; i++) { await page.keyboard.press('Tab'); assert.ok(await dialog.evaluate(el => el.contains(document.activeElement))); }
      for (let i = 0; i < 24; i++) { await page.keyboard.press('Shift+Tab'); assert.ok(await dialog.evaluate(el => el.contains(document.activeElement))); }
    });
    await check('server confirmation required before badge and tab move', async () => {
      state.mode = 'hold'; await page.getByRole('button', { name: '承認する', exact: true }).first().click();
      await page.getByText('送信中', { exact: true }).waitFor();
      assert.match(await trigger.getAttribute('aria-label'), /2/);
      assert.equal(state.posts.length, 1); state.hold();
      await page.getByText('回答しました。回答済みで確認できます', { exact: true }).waitFor();
      assert.match(await trigger.getAttribute('aria-label'), /1/);
      assert.ok(await dialog.isVisible());
      assert.match(await page.evaluate(() => document.activeElement?.textContent), /確認待ち/);
    });
    await check('uncertain response preserves exact idempotency payload across close', async () => {
      state.mode = 'uncertain'; await page.getByRole('button', { name: '承認する', exact: true }).click();
      await page.getByRole('button', { name: '同じ回答を再送', exact: true }).waitFor();
      assert.match(await trigger.getAttribute('aria-label'), /1/);
      await page.keyboard.press('Escape'); await trigger.click();
      state.mode = 'success'; await page.getByRole('button', { name: '同じ回答を再送', exact: true }).click();
      await page.getByText('確認待ちはありません', { exact: true }).waitFor();
      assert.deepEqual(state.posts[1], state.posts[2]); assert.ok(await dialog.isVisible());
    });
    await context.close();
  }
  if (!process.env.BROWSER_SKIP_AUTH) {
    const { context, page, state, trigger } = await setup();
    await trigger.click(); state.mode = 'auth';
    await check('authentication Escape has priority and restores drawer focus', async () => {
      await page.getByRole('button', { name: '承認する', exact: true }).first().click();
      const auth = page.getByRole('dialog', { name: 'web write token', exact: true }); await auth.waitFor();
      assert.ok(await auth.evaluate(el => el.contains(document.activeElement)));
      await page.keyboard.press('Escape'); await auth.waitFor({ state: 'detached' });
      const drawer = page.getByRole('dialog', { name: '人間への確認', exact: true });
      assert.ok(await drawer.isVisible()); await page.waitForFunction(() => document.querySelector('[role=dialog]')?.contains(document.activeElement), { timeout: 3000 });
      await page.keyboard.press('Escape'); await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('人間への確認'));
    });
    await context.close();
  }
  {
    const { context, page, state, trigger } = await setup();
    await trigger.click(); state.mode = 'conflict';
    await check('rejected conflict followed by other actor answer gives no own-success notice', async () => {
      await page.getByRole('button', { name: '承認する', exact: true }).first().click();
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(el => el.getAttribute('aria-label') === '人間への確認、1件'));
      assert.equal(await page.getByText('回答しました。回答済みで確認できます', { exact: true }).count(), 0);
    });
    await context.close();
  }
  {
    const { context, page, state, trigger } = await setup(1280, 'light', { listHeld: true });
    await check('initial loading and failed fetch never report zero', async () => {
      assert.match(await trigger.getAttribute('aria-label'), /読み込み中/);
      state.listError = true; state.listHeld = false; state.holdList();
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(el => el.getAttribute('aria-label')?.includes('件数を取得できません')));
      await trigger.click(); await page.getByText('確認依頼の取得に失敗しました', { exact: true }).waitFor();
      state.listError = false; await page.getByRole('button', { name: '再取得', exact: true }).click();
      await page.getByText('合成デモ：公開前の確認', { exact: true }).waitFor();
    });
    await check('stale fetch preserves count and disables submission until refresh', async () => {
      state.listError = true; await page.clock.install(); await page.clock.fastForward(30_001);
      await page.getByText('更新に失敗しました。前回の内容を表示しています', { exact: true }).waitFor();
      assert.match(await trigger.getAttribute('aria-label'), /2件、更新失敗/);
      assert.ok(await page.getByRole('button', { name: '承認する', exact: true }).first().isDisabled());
      state.listError = false; await page.getByRole('button', { name: '再取得', exact: true }).click();
      await page.waitForFunction(() => !document.body.innerText.includes('更新に失敗しました。'));
    });
    await page.keyboard.press('Escape');
    await check('late tenant response does not enter the selected tenant', async () => {
      state.lateAlpha = true;
      await page.getByRole('button', { name: '絞り込みを開く', exact: true }).click();
      await page.getByRole('combobox', { name: 'tenant', exact: true }).click();
      await page.getByRole('option', { name: 'synthetic-alpha', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(el => el.getAttribute('aria-label')?.includes('件数を読み込み中')));
      await page.getByRole('combobox', { name: 'tenant', exact: true }).click();
      await page.getByRole('option', { name: 'synthetic-beta', exact: true }).click();
      await page.keyboard.press('Escape'); await trigger.click();
      await page.getByText('合成ベータ専用確認', { exact: true }).waitFor();
      state.holdList();
      assert.equal(await page.getByText('合成デモ：公開前の確認', { exact: true }).count(), 0);
      assert.match(await page.getByRole('dialog', { name: '人間への確認', exact: true }).innerText(), /synthetic-beta/);
    });
    await context.close();
  }
  {
    const { context, page } = await setup(320);
    await page.setViewportSize({ width: 320, height: 300 });
    const more = page.getByRole('button', { name: 'その他', exact: true });
    await more.click();
    await check('short viewport menu bounds and keyboard theme navigation', async () => {
      const menu = page.getByRole('dialog', { name: 'その他のナビゲーション', exact: true });
      const b = await menu.boundingBox(); assert.ok(b.x >= 0 && b.x + b.width <= 320 && b.y >= 0 && b.y + b.height <= 301);
      const light = page.getByRole('radio', { name: 'ライト', exact: true }); await light.focus();
      await page.keyboard.press('ArrowRight'); assert.ok(await page.getByRole('radio', { name: 'ダーク', exact: true }).isChecked());
      await page.keyboard.press('ArrowRight'); assert.ok(await page.getByRole('radio', { name: 'システム', exact: true }).isChecked());
      await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
      await page.keyboard.press('Escape'); await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'その他');
    });
    await more.click(); await page.getByRole('button', { name: 'ナレッジ', exact: true }).click();
    await check('navigation preserves route and closes menu', async () => { assert.equal(new URL(page.url()).pathname, '/knowledge'); assert.equal(await page.getByRole('radio').count(), 0); });
    await context.close();
  }
} catch (e) { for (const context of browser.contexts()) for (const page of context.pages()) { await writeFile(`${out}/browser-failure.txt`, await page.evaluate(() => JSON.stringify({ focus: document.activeElement?.outerHTML, body: document.body.innerText }))); await page.screenshot({path: `${out}/browser-failure.png`}); } results.push({ name: 'browser execution', status: 'fail', error: e.stack }); process.exitCode = 1; }
finally { await browser.close(); await writeFile(`${out}/browser-acceptance.json`, JSON.stringify({ results, unexpected, errors }, null, 2)); console.log(JSON.stringify({ passed: results.filter(r => r.status === 'pass').length, failures: results.filter(r => r.status === 'fail'), unexpected, errors })); if (unexpected.length || errors.length) process.exitCode = 1; }
