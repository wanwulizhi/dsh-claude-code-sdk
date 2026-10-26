// workspace.js 的安全与正确性验证：快照 / 比对 / 回退 / 越界防护
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createSnapshot,
  diffScans,
  scanWorkspace,
  restoreSnapshot,
  loadSnapshot,
  pruneSnapshots,
  formatChangeSummary,
  snapshotRoot,
} from '../lib/workspace.js';

const root = path.join(os.tmpdir(), 'ws-test-' + Date.now());
fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(root, 'a.txt'), 'AAA');
fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'BBB');
fs.writeFileSync(path.join(root, 'node_modules', 'ignored.txt'), 'IGNORED');

console.log('工作区:', root);

// 1) 快照
const snap = createSnapshot(root, {});
console.log('\n[1] 快照', snap.id, '| 文件数', snap.scan.files.size, '| 已备份', snap.backedUp);
const names = [...snap.scan.files.keys()].sort();
console.log('    收录:', names.join(', '));
console.log('    node_modules 是否被跳过:', names.some((n) => n.includes('node_modules')) ? '❌ 未跳过' : '✅ 已跳过');

// 2) 模拟 worker 改动
fs.writeFileSync(path.join(root, 'a.txt'), 'AAA-changed-by-worker');
fs.unlinkSync(path.join(root, 'sub', 'b.txt'));
fs.writeFileSync(path.join(root, 'c.txt'), 'CREATED');

const after = scanWorkspace(root, {});
const diff = diffScans(snap.scan.files, after.files);
console.log('\n[2] 比对结果');
console.log('    新增:', JSON.stringify(diff.added));
console.log('    修改:', JSON.stringify(diff.modified));
console.log('    删除:', JSON.stringify(diff.removed));
const diffOk =
  diff.added.length === 1 && diff.added[0] === 'c.txt' &&
  diff.modified.length === 1 && diff.modified[0] === 'a.txt' &&
  diff.removed.length === 1 && diff.removed[0] === 'sub/b.txt';
console.log('    判定:', diffOk ? '✅' : '❌');

console.log('\n[3] 变更摘要');
console.log(formatChangeSummary(diff, snap).trim());

// 4) 预演：不应改动任何文件
const dry = restoreSnapshot(snap.id, { dryRun: true });
console.log('\n[4] 预演 | 将还原', dry.restored.length, '| 将删除', dry.deleted.length);
console.log('    a.txt 内容未被改动:', fs.readFileSync(path.join(root, 'a.txt'), 'utf8') === 'AAA-changed-by-worker' ? '✅' : '❌');
console.log('    c.txt 仍存在:', fs.existsSync(path.join(root, 'c.txt')) ? '✅' : '❌');

// 5) 真正回退
const real = restoreSnapshot(snap.id, {});
console.log('\n[5] 回退 | 还原', real.restored.length, '| 删除', real.deleted.length, '| 跳过', real.skipped.length, '| 失败', real.failed.length);
const checks = {
  'a.txt 恢复原内容': fs.readFileSync(path.join(root, 'a.txt'), 'utf8') === 'AAA',
  'sub/b.txt 被恢复': fs.existsSync(path.join(root, 'sub', 'b.txt')) && fs.readFileSync(path.join(root, 'sub', 'b.txt'), 'utf8') === 'BBB',
  'c.txt 被删除': !fs.existsSync(path.join(root, 'c.txt')),
  'node_modules 未受影响': fs.existsSync(path.join(root, 'node_modules', 'ignored.txt')),
};
for (const [k, v] of Object.entries(checks)) console.log(`    ${k}: ${v ? '✅' : '❌'}`);

// 6) 越界防护：伪造一个含 ../ 的快照，回退必须拒绝
const evilId = 'evil' + Date.now().toString(36);
const evilDir = path.join(snapshotRoot(), evilId);
fs.mkdirSync(path.join(evilDir, 'files'), { recursive: true });
fs.writeFileSync(path.join(evilDir, 'meta.json'), JSON.stringify({ version: 1, id: evilId, root, files: { '../outside.txt': { size: 3, mtimeMs: 1 } } }));
fs.writeFileSync(path.join(evilDir, 'files', 'x'), 'PWN');
const outside = path.join(path.dirname(root), 'outside.txt');
fs.writeFileSync(outside, 'ORIGINAL');
const evil = restoreSnapshot(evilId, {});
console.log('\n[6] 越界防护 | 失败条目:', JSON.stringify(evil.failed));
console.log('    工作区外文件未被覆盖:', fs.readFileSync(outside, 'utf8') === 'ORIGINAL' ? '✅' : '❌');

// 7) 非法 id
try {
  loadSnapshot('../../etc');
  console.log('\n[7] 非法 id: ❌ 未拦截');
} catch (e) {
  console.log('\n[7] 非法 id: ✅ 已拒绝 -', e.message.slice(0, 60));
}

// 清理
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(evilDir, { recursive: true, force: true });
fs.rmSync(outside, { force: true });
pruneSnapshots(5);
console.log('\n清理完成');
