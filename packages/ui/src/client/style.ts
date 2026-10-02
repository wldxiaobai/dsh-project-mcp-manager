/** Token-only layout. Primitives bring their own component CSS. */
export const PANEL_CSS = `
.dsh-mcp-ui {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 760px;
  color: var(--dsw-alias-label-primary);
}
.dsh-mcp-ui h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.dsh-mcp-ui .intro,
.dsh-mcp-ui .empty,
.dsh-mcp-ui .hint {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
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
  color: var(--dsw-alias-label-tertiary);
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
.dsh-mcp-ui .meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.dsh-mcp-ui .endpoint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-mcp-ui .actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-mcp-ui .tools {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  overflow: auto;
}
.dsh-mcp-ui .tool {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-mcp-ui .tool code {
  font-family: var(--ds-font-family-code);
  font-size: 12px;
}
.dsh-mcp-ui .banner {
  margin: 0;
  font-size: 13px;
  color: var(--dsw-alias-state-error-primary);
}
`;
