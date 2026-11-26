import { git } from './repository.mjs';

const designStage = 'design-preview';
const stageKey = (branch) => 'branch.' + branch + '.zdm-task-stage';

export function setTaskStage(cwd, args) {
  const [stage] = args;
  if (args.length !== 1 || ![designStage, 'development'].includes(stage))
    throw Error('请指定任务阶段 design-preview 或 development。');
  const branch = git(cwd, ['branch', '--show-current']).trim();
  if (!branch || branch === 'main') throw Error('请在当前任务分支上登记阶段。');
  git(cwd, ['config', '--local', stageKey(branch), stage]);
  return { branch, stage };
}

function registeredStage(cwd) {
  const branch = git(cwd, ['branch', '--show-current']).trim();
  if (!branch) return;
  try {
    return git(cwd, ['config', '--local', '--get', stageKey(branch)]).trim();
  } catch (error) {
    if (error.status !== 1) throw error;
  }
}

function previewPath(path) {
  return path.startsWith('design-previews/');
}

function onlyPreviewChanges(cwd) {
  const dirty = git(cwd, ['status', '--porcelain=v1', '--no-renames', '--untracked-files=all', '-z'])
    .split('\0').filter(Boolean).map((row) => row.slice(3));
  if (!dirty.every(previewPath)) return false;

  // A saved design can have a clean working tree; exclude unrelated advances on main.
  let base;
  for (const ref of ['refs/remotes/origin/main', 'refs/heads/main']) {
    try {
      base = git(cwd, ['merge-base', ref, 'HEAD']).trim();
      break;
    } catch (error) {
      if (![1, 128].includes(error.status)) throw error;
    }
  }
  if (!base) return false; // Without a common baseline the branch may also contain development work.
  const saved = git(cwd, ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD', '--'])
    .split('\0').filter(Boolean);
  return (dirty.length > 0 || saved.length > 0) && saved.every(previewPath);
}

export function guardDesignPreview(cwd) {
  // The published CI checks the actual PR/merge candidate independently of local task state.
  if (process.env.GITHUB_ACTIONS === 'true') return;
  let root;
  try {
    root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch (error) {
    if (error.status === 128) return; // Native commands also support exported sources.
    throw error;
  }
  const stage = registeredStage(root);
  if (stage === 'development') return;
  if (stage === designStage || onlyPreviewChanges(root))
    throw Error('纯 UI 设计阶段已拦截工程验证。请核对效果图、专用预览及约定的模拟交互，交付后结束本轮。已有实施或正式交付授权时，先用 node dev/quality-entry.mjs stage development 切换阶段。');
}
