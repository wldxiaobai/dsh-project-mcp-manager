/**
 * 三个入口的运行时显隐同步，以及主页页面的返回动作。纯逻辑：槽位与布局
 * 通过依赖注入传入，测试可用假实现直接驱动。
 *
 * 开关幂等：已挂上的入口不会重复注册；关掉时先交还 `main`（如果正停在
 * 我们的页面），再释放这一组注册。
 */
import { ENTRY_KEYS, type EntryFlags, type EntryKey } from "./entries-settings.ts";

export interface EntryAttachment {
  /** 现在注册这一组入口；返回释放它们的 disposer。 */
  attach(): () => void;
  /** 拆注册之前调用一次，用于先离开这个入口打开的页面。 */
  onDetach?(): void;
}

export interface EntriesControllerOptions {
  readonly attachments: Record<EntryKey, EntryAttachment>;
}

export interface EntriesController {
  /** 按目标显隐状态增删注册；重复调用同一状态不产生动作。 */
  apply(flags: EntryFlags): void;
  /** 释放全部仍挂着的注册（插件卸载时）。 */
  dispose(): void;
}

export function createEntriesController(options: EntriesControllerOptions): EntriesController {
  const live = new Map<EntryKey, () => void>();

  const apply = (flags: EntryFlags): void => {
    for (const key of ENTRY_KEYS) {
      const detach = live.get(key);
      if (flags[key]) {
        if (detach === undefined) live.set(key, options.attachments[key].attach());
        continue;
      }
      if (detach === undefined) continue;
      options.attachments[key].onDetach?.();
      detach();
      live.delete(key);
    }
  };

  const dispose = (): void => {
    for (const detach of live.values()) detach();
    live.clear();
  };

  return { apply, dispose };
}

/** 布局服务里本模块用到的部分。 */
export interface PanelNavigator {
  readonly panelInfo: { getSnapshot(): { readonly activePanelId: string | null } };
  /** 传 null 选中会话界面，不改变当前会话。 */
  selectPanel(panelId: null): void;
}

/** 「回到当前工作区」：只换 `main` 的内容，不动当前会话。 */
export function backToWorkspace(navigator: PanelNavigator): void {
  navigator.selectPanel(null);
}

/** 关闭主页入口前先把 `main` 交还会话，避免它指向一个已注销的 key。 */
export function leavePanelIfOpen(navigator: PanelNavigator, panelId: string): boolean {
  if (navigator.panelInfo.getSnapshot().activePanelId !== panelId) return false;
  navigator.selectPanel(null);
  return true;
}
