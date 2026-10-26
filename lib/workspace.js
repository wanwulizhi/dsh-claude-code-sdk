/**
 * 工作区变更追踪与回退。
 *
 * 委派前对 cwd 拍一次快照（记录 size+mtime 作为变更指纹，并把内容备份进快照目录），
 * 委派后重扫一遍，比对得出新增/修改/删除。备份内容用于回退。
 *
 * 设计取舍：
 * - 用 size+mtime 而不是内容 hash 判变更：省掉全量读取，agent 改文件必然更新 mtime。
 * - 备份有预算（总字节 / 单文件大小 / 文件数），超预算则退化为「只报告不可回退」，
 *   不因为项目太大而让委派变慢或失败。
 * - 回退只处理快照里记录过的路径，且逐条校验仍在 root 之内；不递归删目录。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** 默认跳过的目录名（构建产物、依赖、缓存，不是 agent 的编辑目标）。 */
const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", ".next", ".nuxt", "dist", "build",
  "out", "target", "coverage", ".cache", ".turbo", ".parcel-cache",
  "__pycache__", ".venv", "venv", ".idea", ".gradle", ".terraform",
]);

/** 快照根目录。 */
export function snapshotRoot() {
  return path.join(os.homedir(), ".dsh", "claude-code-sdk", "snapshots");
}

/** 把路径统一成用 / 分隔的相对路径，便于跨平台展示。 */
function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** 判断某个绝对路径是否仍在 root 之内（防目录穿越）。 */
function isInside(root, abs) {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 遍历工作区，返回「相对路径 → 变更指纹」的映射。
 *
 * @param {string} root 工作区根目录
 * @param {object} options maxFiles / ignoredDirs
 * @returns {{files: Map<string, {size: number, mtimeMs: number}>, truncated: boolean}}
 */
export function scanWorkspace(root, options = {}) {
  const maxFiles = options.maxFiles ?? 20000;
  const ignoredDirs = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
  const files = new Map();
  let truncated = false;

  const walk = (dir) => {
    if (truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const abs = path.join(dir, entry.name);
      // 跳过符号链接：不跟随，避免越界与环路
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      files.set(toRel(root, abs), { size: st.size, mtimeMs: st.mtimeMs });
      if (files.size >= maxFiles) {
        truncated = true;
        return;
      }
    }
  };

  walk(root);
  return { files, truncated };
}

/** 两个指纹是否一致。 */
function sameEntry(a, b) {
  return a !== undefined && b !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * 比对两次扫描，得出变更集合。
 * @param {Map} before 委派前
 * @param {Map} after 委派后
 * @returns {{added: string[], modified: string[], removed: string[]}}
 */
export function diffScans(before, after) {
  const added = [];
  const modified = [];
  const removed = [];
  for (const [rel, entry] of after) {
    const prev = before.get(rel);
    if (prev === undefined) added.push(rel);
    else if (!sameEntry(prev, entry)) modified.push(rel);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) removed.push(rel);
  }
  added.sort();
  modified.sort();
  removed.sort();
  return { added, modified, removed };
}

/** 递归复制单个文件，必要时建父目录。 */
function copyInto(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/**
 * 委派前拍快照：记录指纹，并在预算内备份内容。
 *
 * @param {string} root 工作区根目录
 * @param {object} options maxFiles / maxFileSize / maxTotalBytes / ignoredDirs
 * @returns {object} 快照描述（含 scan 结果与备份状态）
 */
export function createSnapshot(root, options = {}) {
  const maxFileSize = options.maxFileSize ?? 512 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;

  const scan = scanWorkspace(root, options);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(snapshotRoot(), id);
  const filesDir = path.join(dir, "files");

  let backedUp = 0;
  let bytes = 0;
  let budgetExceeded = false;
  const backedUpPaths = new Set();

  for (const [rel, entry] of scan.files) {
    if (entry.size > maxFileSize) continue;
    if (bytes + entry.size > maxTotalBytes) {
      budgetExceeded = true;
      break;
    }
    const abs = path.join(root, rel.split("/").join(path.sep));
    const dest = path.join(filesDir, rel.split("/").join(path.sep));
    try {
      copyInto(abs, dest);
      backedUp += 1;
      bytes += entry.size;
      backedUpPaths.add(rel);
    } catch {
      /* 单个文件备份失败不影响整体 */
    }
  }

  const meta = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    root,
    fileCount: scan.files.size,
    truncated: scan.truncated,
    backedUp,
    bytes,
    budgetExceeded,
    files: Object.fromEntries(scan.files),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

  return { id, dir, root, scan, backedUp, bytes, budgetExceeded, backedUpPaths };
}

/**
 * 读取一个已存在的快照（用于回退）。
 * @param {string} id 快照 id
 * @returns {object} 快照元信息与目录
 * @throws 快照不存在或 meta 损坏
 */
export function loadSnapshot(id) {
  if (typeof id !== "string" || !/^[a-z0-9-]+$/i.test(id)) {
    throw new Error(`快照 id 非法：${JSON.stringify(id)}`);
  }
  const dir = path.join(snapshotRoot(), id);
  const metaPath = path.join(dir, "meta.json");
  if (!fs.existsSync(metaPath)) throw new Error(`快照不存在：${id}`);
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  if (meta.id !== id) throw new Error(`快照元信息不匹配：${id}`);
  return { id, dir, meta };
}

/**
 * 把工作区还原到快照时刻的状态。
 *
 * 只处理快照记录过的路径：
 * - 快照里有、现在没有 → 恢复
 * - 两边都有但内容不同 → 用快照覆盖
 * - 快照里没有、现在有 → 删除（agent 新建的）
 *
 * 删除仅限单文件，且校验仍在 root 内；不递归删目录。
 *
 * @param {string} id 快照 id
 * @param {object} options dryRun=true 时只报告不执行
 * @returns {{restored: string[], deleted: string[], skipped: string[], failed: {path: string, error: string}[]}}
 */
export function restoreSnapshot(id, options = {}) {
  const dryRun = options.dryRun === true;
  const { dir, meta } = loadSnapshot(id);
  const root = meta.root;
  const filesDir = path.join(dir, "files");

  const recorded = new Map(Object.entries(meta.files ?? {}));
  const current = scanWorkspace(root, { maxFiles: options.maxFiles ?? 20000 });

  const restored = [];
  const deleted = [];
  const skipped = [];
  const failed = [];

  const ensureSafe = (rel) => {
    const abs = path.join(root, rel.split("/").join(path.sep));
    if (!isInside(root, abs)) {
      failed.push({ path: rel, error: "路径越出工作区，已拒绝" });
      return undefined;
    }
    return abs;
  };

  // 1) 恢复快照里存在但被改/删的文件
  for (const [rel, entry] of recorded) {
    const abs = ensureSafe(rel);
    if (abs === undefined) continue;
    const backup = path.join(filesDir, rel.split("/").join(path.sep));
    if (!fs.existsSync(backup)) {
      skipped.push(rel);
      continue;
    }
    const now = current.files.get(rel);
    if (now !== undefined && sameEntry(now, entry)) continue; // 没变，跳过
    if (dryRun) {
      restored.push(rel);
      continue;
    }
    try {
      copyInto(backup, abs);
      restored.push(rel);
    } catch (error) {
      failed.push({ path: rel, error: String(error && error.message ? error.message : error) });
    }
  }

  // 2) 删除快照之后新建的文件
  for (const rel of current.files.keys()) {
    if (recorded.has(rel)) continue;
    const abs = ensureSafe(rel);
    if (abs === undefined) continue;
    if (dryRun) {
      deleted.push(rel);
      continue;
    }
    try {
      fs.unlinkSync(abs);
      deleted.push(rel);
    } catch (error) {
      failed.push({ path: rel, error: String(error && error.message ? error.message : error) });
    }
  }

  return { restored, deleted, skipped, failed, dryRun };
}

/**
 * 只保留最近 N 个快照，清掉更早的。
 * @param {number} keep 保留数量
 * @returns {number} 删除的目录数
 */
export function pruneSnapshots(keep = 20) {
  const base = snapshotRoot();
  let names;
  try {
    names = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return 0;
  }
  const excess = names.slice(0, Math.max(0, names.length - keep));
  let removed = 0;
  for (const name of excess) {
    try {
      fs.rmSync(path.join(base, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      /* 忽略 */
    }
  }
  return removed;
}

/**
 * 把变更集合格式化成一段人可读的摘要，附在返回正文后面。
 * @param {{added: string[], modified: string[], removed: string[]}} diff 变更集合
 * @param {object} snapshot 快照描述
 * @returns {string} 摘要文本（无变更时为空串）
 */
export function formatChangeSummary(diff, snapshot) {
  const total = diff.added.length + diff.modified.length + diff.removed.length;
  if (total === 0) return "";
  const lines = ["", "---", `改动 ${total} 个文件（快照 ${snapshot.id}）`];
  const list = (label, items) => {
    if (items.length === 0) return;
    const shown = items.slice(0, 8);
    lines.push(`${label} ${items.length}：${shown.join("、")}${items.length > shown.length ? ` 等` : ""}`);
  };
  list("新增", diff.added);
  list("修改", diff.modified);
  list("删除", diff.removed);
  if (snapshot.budgetExceeded || snapshot.backedUp < snapshot.scan.files.size) {
    lines.push("（部分文件超出备份预算，这些文件的回退不可用）");
  }
  return lines.join("\n");
}
