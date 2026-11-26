import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { nativeCommands } from '../dev/quality/commands.mjs';
import { copyTestWeakened, presentationCopy } from '../dev/quality/presentation.mjs';
import { planTree } from '../dev/quality/repository.mjs';

// Frozen, already-published inputs. These are historical business blobs, not expected planner output.
const before = 'f1b0e301e04f45a9968c20400d64f64e08d9db49';
const reviewed = '3848036594a8f73bb2adaec1df42ee4a3b6bad69';
const feedback = 'docs/ui/operation-feedback-registry.json';
const visual = 'docs/ui/visual-refactor.json';
const guard = 'src/__tests__/operationFeedbackPolicy.test.ts';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
const blob = (ref, file) => git(process.cwd(), 'show', ref + ':' + file);
function replaceOnce(source, from, to) {
  assert.notEqual(source.indexOf(from), -1, from);
  assert.equal(source.indexOf(from), source.lastIndexOf(from), from);
  return source.replace(from, () => to);
}

function fixture(t, page, suite) {
  const cwd = mkdtempSync(join(tmpdir(), 'zdm-presentation-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  function write(file, contents) {
    mkdirSync(join(cwd, dirname(file)), { recursive: true });
    writeFileSync(join(cwd, file), contents);
  }
  const read = file => readFileSync(join(cwd, file), 'utf8');
  function save() {
    git(cwd, 'add', '.');
    git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'snapshot');
    return git(cwd, 'rev-parse', 'HEAD').trim();
  }
  git(cwd, 'init', '-q', '-b', 'main');
  for (const file of [page, suite, feedback, visual, guard, 'src/router/index.ts',
    'src/components/foundation/index.ts', 'src/components/foundation/AdminDialog.vue',
    'src/services/adminPermissions.test.ts', 'tests/e2e/query-responsive.spec.ts',
    'tests/e2e/permission-center.spec.ts', 'tests/e2e/feedback-foundation.spec.ts']) write(file, blob(before, file));
  const base = save();
  const plan = () => planTree(cwd, base, base, save()).plan;
  return { write, read, plan };
}

for (const sample of ['store-category', 'store-level']) {
  test(sample + ' 的真实页面依次改展示、同步登记、补用例，单独识别混入的业务、放宽登记及断言', t => {
    const category = sample === 'store-category';
    const file = 'src/pages/' + sample + '/management/index.vue';
    const suite = 'tests/e2e/' + (category ? 'store-category-management' : 'store-level') + '.spec.ts';
    const f = fixture(t, file, suite);
    const original = f.read(file);
    const from = '          ><t-input v-model="formData.name" clearable placeholder="请输入级别名称"\n';
    const to = from.replace('请输入级别名称', '请填写级别名称');
    const changedPage = category ? blob(reviewed, file) : replaceOnce(original, from, to);
    f.write(file, changedPage);
    function checkCopy(registered) {
      const p = f.plan();
      assert.equal(p.risk, 'R0', JSON.stringify(p.facts));
      assert.equal(p.facts.find(fact => fact.path === file).kind, 'copy');
      assert.deepEqual(p.scopes.e2e, [suite]);
      assert.deepEqual(nativeCommands('e2e', p.scopes.e2e).at(-1).slice(2), ['test', suite]);
      assert.equal(p.dev.includes('backend'), false);
      assert.equal(p.delivery.includes('backend'), false);
      if (registered) {
        assert.deepEqual(p.scopes.unit, [guard]);
        assert.ok([feedback, visual].every(path => p.facts.find(fact => fact.path === path).kind === 'note'));
      }
    }
    checkCopy(false);
    for (const registry of [feedback, visual]) {
      if (category) f.write(registry, blob(reviewed, registry));
      else {
        const doc = JSON.parse(f.read(registry));
        if (registry === feedback) {
          const entry = doc.approvedChanges[file];
          entry.patches.push({ before: from, after: to });
          entry.patchCount++;
        } else {
          doc.contracts[file].approvedBusinessPatches.push({
            task: '019', stage: 'before-migrations', reason: '输入框提示措辞', before: from, after: to,
          });
        }
        f.write(registry, JSON.stringify(doc, null, 2) + '\n');
      }
    }
    checkCopy(true);
    const originalTest = f.read(suite);
    const updatedTest = category ? blob(reviewed, suite) : replaceOnce(originalTest,
      "  await dialog.getByPlaceholder('请输入级别名称').fill('4级');",
      "  await expect(dialog.getByPlaceholder('请填写级别名称', { exact: true })).toBeVisible();\n" +
      "  await dialog.getByPlaceholder('请填写级别名称').fill('4级');");
    f.write(suite, updatedTest);
    checkCopy(true);

    const oldRegistry = f.read(feedback);
    const extra = JSON.parse(oldRegistry);
    extra.approvedChanges[file].baseSha256 = '0'.repeat(64);
    f.write(feedback, JSON.stringify(extra));
    let p = f.plan();
    assert.equal(p.facts.find(fact => fact.path === feedback).kind, 'control');
    assert.equal(p.risk, 'R4');
    const stray = JSON.parse(oldRegistry);
    stray.approvedChanges[file].patches.push({ before: 'unrelated', after: 'new' });
    stray.approvedChanges[file].patchCount++;
    f.write(feedback, JSON.stringify(stray));
    assert.equal(f.plan().facts.find(fact => fact.path === feedback).kind, 'control');
    f.write(feedback, oldRegistry);

    const business = category ? ['if (parent) formData.parentId = parent.id;', 'if (parent) formData.parentId = null;']
      : ['v-model="formData.name" clearable placeholder', 'v-model="formData.remark" clearable placeholder'];
    f.write(file, replaceOnce(changedPage, ...business));
    p = f.plan();
    assert.ok(p.risk >= 'R2');
    assert.notEqual(p.facts.find(fact => fact.path === file).kind, 'copy');
    f.write(file, changedPage);

    const weaker = category ? [".getByText('新增下级', { exact: true })).toHaveCount(0)",
      ".getByText('新增下级', { exact: true })).toBeDefined()"] :
      ["expect(main.getByText('级别编码', { exact: true })).toHaveCount(0)", "expect(main.getByText('级别编码', { exact: true })).toBeDefined()"];
    f.write(suite, replaceOnce(updatedTest, ...weaker));
    p = f.plan();
    assert.equal(p.risk, 'R4');
    assert.equal(p.facts.find(fact => fact.path === suite).kind, 'guard');
    assert.ok(p.dev.includes('quality') && p.dev.includes('e2e'));
  });
}

test('动态格式验证所有合法输入，表达式、危险措辞、稳定值和未知组件保留独立判断', () => {
  const source = expr => '<template><span :title="' + expr + '">等级</span></template>\n' +
    '<script setup>const value = ref<1 | 2 | 3>(1);</script>';
  const prove = (a, b) => presentationCopy({ path: 'src/unknown.vue', before: a, after: b });
  const raw = '`第${value}步`', fmt = "`第${['一', '二', '三'][value - 1]}步`";
  assert.ok(prove(source(raw), source(fmt)));
  assert.ok(prove(source(fmt), source(raw)));
  assert.equal(prove(source(raw), source(fmt.replace(", '三'", ''))), undefined);
  assert.equal(prove(source(raw), source(fmt.replace("'二'", "'三'"))), undefined);
  assert.equal(prove(source(raw).replace('1 | 2 | 3', 'number'), source(fmt).replace('1 | 2 | 3', 'number')), undefined);
  assert.equal(prove(source('`${send(\'第一级\')}`'), source('`${send(\'第1级\')}`')), undefined);
  assert.equal(prove(source("'永久删除'"), source("'移入回收站'")), undefined);
  assert.equal(prove(source(raw).replace(':title', ':value'), source(fmt).replace(':title', ':value')), undefined);
  assert.equal(prove(source(raw).replaceAll('span', 'Unknown'), source(fmt).replaceAll('span', 'Unknown')), undefined);
});

test('定向用例可新增独立准备和等价文字定位，现有拒绝断言不能移到别的用例', () => {
  const terms = new Set(['请输入名称', '请填写名称']);
  const old = "  await expect(page.getByPlaceholder('请输入名称')).toBeDisabled();";
  const next = old.replace('请输入名称', '请填写名称');
  const cases = (a, b = '') => "test('refusal', async () => {\n" + a + "\n});\n" +
    "test('other', async () => {\n" + b + "\n});";
  const change = (before, after, removed, added) => ({ before, after, removed, added });
  assert.equal(copyTestWeakened(change(cases(old), cases(next), [old], [next]), terms), false);
  assert.equal(copyTestWeakened(change(cases(old), cases('', next), [old], [next]), terms), true);
  const extra = cases("  await page.route('/example', route => { return route.fulfill({ status: 200 }); });\n" + next);
  assert.equal(copyTestWeakened(change('', extra, [], extra.split('\n')), terms), false);
  const skipped = extra.replace('test(', 'test.skip(');
  assert.equal(copyTestWeakened(change('', skipped, [], skipped.split('\n')), terms), true);
});

test('正常开发入口分别给出本轮 R0 和整项 R4，失效的环境证据留给交付，损坏的原始记录触发补验', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'zdm-copy-round-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.ZDM_QUALITY_TIMING_CONTEXT;
  const command = (...args) => JSON.parse(execFileSync(process.execPath, [join(process.cwd(), 'dev/quality.mjs'), ...args],
    { cwd, env, encoding: 'utf8', stdio: 'pipe' }));
  const page = 'src/pages/report/index.vue';
  const write = (file, body) => {
    mkdirSync(join(cwd, dirname(file)), { recursive: true });
    writeFileSync(join(cwd, file), body + '\n');
  };
  git(cwd, 'init', '-q', '-b', 'main');
  write(page, '<template><span>第1步</span></template>');
  write('dev/acceptance.mjs', 'export const revision = 1;');
  write('tests/acceptance.test.mjs', "import test from 'node:test';test('registered fixture', () => {});");
  git(cwd, 'add', '.');
  git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const id = 'ref:copy-feedback';
  const intent = { kind: 'start', event: 'start', expected: 0, name: '报表', thread: 'fixture', source: 'assignment',
    references: ['fixture'], before: '旧版本', after: '新版本', consumers: ['验收'], data: '回执', reason: '验证交付控制',
    behaviors: ['control'] };
  command('assess', 'start', id, JSON.stringify(intent));
  write('dev/acceptance.mjs', 'export const revision = 2;');
  const previous = command('dev');
  assert.equal(previous.risk, 'R4');
  command('assess', 'start', id, JSON.stringify({ ...intent, kind: 'rework', event: 'wording',
    expected: command('assess', 'show', id).revision, behaviors: ['control', 'copy'], roundBehaviors: ['copy'] }));
  write(page, '<template><span>第一步</span></template>');
  env.LANG = 'fixture_changed_locale';
  const p = command('plan');
  assert.equal(p.risk, 'R0');
  assert.equal(p.wholeRisk, 'R4');
  assert.equal(p.dev.includes('acceptance'), false);
  assert.ok(p.delivery.includes('acceptance'));
  assert.ok(p.evidence.some(row => row.check === 'acceptance' && row.reason.includes('交付')));
  writeFileSync(previous.results.find(row => row.id === 'acceptance').log, 'damaged log');
  assert.ok(command('plan').dev.includes('acceptance'));
});
