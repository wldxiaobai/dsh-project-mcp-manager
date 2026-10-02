/** Token-only layout. Primitives bring their own component CSS. */
export const PANEL_CSS = `
.dsh-mcp-ui {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 760px;
  color: var(--dsw-alias-label-primary);
}
.dsh-mcp-ui .intro,
.dsh-mcp-ui .empty,
.dsh-mcp-ui .hint {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
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
  gap: 8px;
}
.dsh-mcp-ui .section h3 {
  margin: 8px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}
.dsh-mcp-ui .project {
  margin: 0;
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-mcp-ui .card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
  padding: 12px 14px;
}
.dsh-mcp-ui .row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.dsh-mcp-ui .identity {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dsh-mcp-ui .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 500;
}
.dsh-mcp-ui .status {
  margin: 0;
  width: fit-content;
  max-width: 100%;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}
.dsh-mcp-ui .status-done {
  color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary));
}
.dsh-mcp-ui .status-error {
  color: var(--dsw-alias-state-error-primary);
}
.dsh-mcp-ui .endpoint {
  display: flex;
  align-items: baseline;
  gap: 8px;
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
  gap: 8px;
  align-items: center;
}
.dsh-mcp-ui .danger {
  color: var(--dsw-alias-state-error-primary);
}
.dsh-mcp-ui .banner {
  margin: 0;
  font-size: 13px;
  color: var(--dsw-alias-state-error-primary);
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
`;
