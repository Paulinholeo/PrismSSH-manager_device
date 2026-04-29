# Workspace do terminal — maximizar (PrismSSH)

**Data:** 2026-04-29  

## Objetivo

Permitir ao utilizador:

- **Maximizar o terminal**: ocupa a zona principal por completo ao esconder a sidebar esquerda (bookmarks/conexões) e a zona direita (ícones SFTP / port-forward / monitor e painéis).
- O split antigo entre terminal e ferramentas foi removido da interface principal. O split ativo agora é somente entre sessões SSH dentro do terminal.

O estado maximizado fica em memória durante a sessão atual.

**Ver também:** [terminal-multi-sessoes-split-alt-tab.md](./terminal-multi-sessoes-split-alt-tab.md) — split entre **várias sessões SSH**, títulos por painel e **Alt+Tab** para focar outro terminal.

## Ficheiros alterados

| Ficheiro | Função |
|----------|--------|
| `src/ui/template.html` | Botão de maximizar movido para `#sessionSplitToolbar`; wrapper `#workspaceSide` permanece para ferramentas auxiliares. |
| `src/ui/static/styles.css` | `.app.terminal-layout-max` oculta sidebars e libera área para o terminal. |
| `src/ui/static/app.js` | Estado `workspaceMaximized`, `applyTerminalWorkspaceDOM`, `toggleTerminalMaximized`, `initTerminalWorkspaceLayout` e `notifyTerminalViewportResize` para reflow do xterm. |

## Fluxo técnico

1. Ao **maximizar**, aplicam-se classes em `.app` que reduzem `.sidebar` a largura zero (com overflow e pointer-events desativados) e ocultam `.workspace-side` completamente.
2. O `#btnLayoutToggleMax` alterna ícones de maximizar/restaurar dentro da barra de sessões.
3. Cada mudança chama `notifyTerminalViewportResize()`, que recalcula todos os terminais visíveis, não apenas a sessão atual.

## Possíveis melhorias futuras

- Permitir redimensionamento manual entre painéis de sessão, caso seja necessário além da divisão igual.
- Opcionalmente lembrar o estado maximizado também em `localStorage`.
