/** Token-only layout. Primitives bring their own component CSS. */
export const PANEL_CSS = `
.dsh-mcp-ui {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 760px;
  color: var(--dsw-alias-label-primary);
}
.dsh-mcp-ui .intro {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-mcp-ui .intro p,
.dsh-mcp-ui .empty,
.dsh-mcp-ui .hint {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-mcp-ui .intro-help {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: help;
}
.dsh-mcp-ui .intro-help:hover,
.dsh-mcp-ui .intro-help:focus-visible {
  color: var(--dsw-alias-label-secondary);
}
.dsh-mcp-ui .toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.dsh-mcp-ui .section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dsh-mcp-ui .section h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-mcp-ui .groups {
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.dsh-mcp-ui .group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dsh-mcp-ui .group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
}
.dsh-mcp-ui .group-head svg {
  flex: none;
}
.dsh-mcp-ui .group-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ds-font-family-code);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
}
.dsh-mcp-ui .group-count {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-mcp-ui .card {
  display: flex;
  flex-direction: column;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
  padding: 8px 12px;
}
.dsh-mcp-ui .head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.dsh-mcp-ui .identity {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dsh-mcp-ui .name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 500;
}
.dsh-mcp-ui .badge {
  flex: none;
  min-width: 0;
}
.dsh-mcp-ui .meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 16px;
  row-gap: 2px;
  margin-top: 2px;
  min-width: 0;
}
.dsh-mcp-ui .status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  width: fit-content;
  max-width: 100%;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-mcp-ui .status-running {
  color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary));
}
.dsh-mcp-ui .status-error {
  color: var(--dsw-alias-state-error-primary);
}
.dsh-mcp-ui .status-off {
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-mcp-ui .detail,
.dsh-mcp-ui .shadow-note {
  flex: 1 0 100%;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-mcp-ui .endpoint {
  display: flex;
  flex: 1 1 160px;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-mcp-ui .endpoint-kind {
  flex: none;
  font-family: var(--dsw-font-family, inherit);
  color: var(--dsw-alias-label-tertiary);
}
.dsh-mcp-ui .endpoint-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.dsh-mcp-ui .actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-mcp-ui .danger-wrap {
  display: inline-flex;
  margin-left: auto;
}
.dsh-mcp-ui .danger {
  margin-left: 0;
  color: var(--dsw-alias-state-error-primary);
}

/* 开关的官方 on 轨走 brand。暗色主题里这个 brand 是浅色，看起来像关掉。
   这里只改轨道颜色，拇指仍用组件自己的前景色。弹窗 portal 到 body，所以选择器不套面板。
   已启用但还在等会话时轨道改白，和正在运行的绿色分开。 */
button.dsh-mcp-switch[aria-checked="true"] {
  background: var(--dsw-alias-state-success-primary);
}
button.dsh-mcp-switch.dsh-mcp-switch-waiting[aria-checked="true"] {
  background: #fff;
}
button.dsh-mcp-switch.dsh-mcp-switch-waiting[aria-checked="true"] > span {
  background: #2c2c2c;
}

/* 错误条在面板里，也在 portal 出去的添加弹窗里。 */
.dsh-mcp-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 8px 10px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent);
  border-radius: var(--dsw-radius-md);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-mcp-banner svg {
  flex: none;
  margin-top: 2px;
}

/* Modal 挂到 document.body，选择器不能套在 .dsh-mcp-ui 下。
   官方 .dialog / .content / .body 是嵌套的纵向 flex，子项默认 flex-shrink: 1，
   工具一多就会把行高压扁而不是出滚动条。滚动口必须是列表自己（block + max-height），
   每一行用两列网格把开关钉在右列，避免行宽被内容撑死时开关贴在文字右侧。 */
.dsh-mcp-tools-dialog {
  width: min(440px, 100%);
  font-family: var(--dsw-font-family);
  color: var(--dsw-alias-label-primary);
}
.dsh-mcp-tools-content {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  overflow: visible;
}
.dsh-mcp-tools-list {
  display: block;
  align-self: stretch;
  box-sizing: border-box;
  width: 100%;
  max-height: min(420px, calc(100vh - 230px));
  padding-right: 16px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  flex: 0 0 auto;
}
@supports (height: 100dvh) {
  .dsh-mcp-tools-list {
    max-height: min(420px, calc(100dvh - 230px));
  }
}
.dsh-mcp-tools-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 16px;
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  padding: 10px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-mcp-tools-row:last-child {
  border-bottom: 0;
}
.dsh-mcp-tools-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--dsw-font-family);
  font-size: 14px;
  line-height: 22px;
  font-weight: 400;
  color: var(--dsw-alias-label-primary);
}
.dsh-mcp-tools-switch {
  justify-self: end;
}
.dsh-mcp-confirm-note {
  margin: 0;
  font-family: var(--dsw-font-family);
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-mcp-tools-status {
  margin: 0;
  font-family: var(--dsw-font-family);
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-mcp-add-dialog {
  width: min(440px, 100%);
  max-height: 100%;
  font-family: var(--dsw-font-family);
  color: var(--dsw-alias-label-primary);
}
.dsh-mcp-add-content {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  overflow: visible;
}
.dsh-mcp-add-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-sizing: border-box;
  width: 100%;
  max-height: min(480px, calc(100vh - 240px));
  padding-right: 16px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
@supports (height: 100dvh) {
  .dsh-mcp-add-form {
    max-height: min(480px, calc(100dvh - 240px));
  }
}
.dsh-mcp-add-paste {
  align-self: flex-start;
}
.dsh-mcp-add-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.dsh-mcp-add-label {
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-mcp-add-input {
  width: 100%;
  box-sizing: border-box;
}
.dsh-mcp-add-area {
  box-sizing: border-box;
  width: 100%;
  min-height: 72px;
  resize: vertical;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  padding: 8px;
  font-family: var(--ds-font-family-code);
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dsh-mcp-add-area:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.dsh-mcp-add-area::placeholder {
  color: var(--dsw-alias-label-dimmed);
}
.dsh-mcp-add-path {
  margin: 0;
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}
.dsh-mcp-add-error {
  margin-top: 10px;
}
`;
