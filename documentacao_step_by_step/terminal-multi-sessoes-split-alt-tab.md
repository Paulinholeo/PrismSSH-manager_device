# Terminal — várias sessões SSH, split entre secções, títulos e Alt+Tab (PrismSSH)

**Data:** 2026-04-29

## Objetivo

- **Split entre secções de terminal**: o utilizador escolhe **uma sessão** / **lado a lado** / **empilhado** para ver vários SSH ao mesmo tempo.
- **Título por painel**: cada secção `.terminal-pane` tem cabeçalho com o nome da ligação (ex.: etiqueta ou `user@host`).
- **Alternar foco**: **Alt+Tab** / **Alt+Shift+Tab** cicla entre terminais visíveis no modo split; se o SO capturar Alt+Tab, usar **Ctrl+PageDown** / **Ctrl+PageUp**.

## Estado e persistência

| Variável / chave | Descrição |
|------------------|-----------|
| `focusedSessionId` | Sessão cujo terminal recebe teclado e para onde vai o texto enviado. |
| `sessionViewLayout` | `single` \| `split-h` \| `split-v`. |
| `SESSION_VIEW_LAYOUT_KEY` (`localStorage`) | Lembra o layout ao reabrir. |

## Ficheiros

| Ficheiro | Função |
|----------|--------|
| `src/ui/template.html` | `#sessionSplitToolbar` (botões 1 sessão / lado a lado / empilhado / maximizar); `#terminalWrapper` com classes raiz dos painéis de sessão. |
| `src/ui/static/styles.css` | `.terminal-pane`, cabeçalho, layouts `terminal-session-layout-*`, painéis com `min-width: 0` / `min-height: 0` para ocupar a área disponível. |
| `src/ui/static/app.js` | `createTerminalForSession` (DOM pane + ResizeObserver); `restartGlobalOutputPolling`; `cycleTerminalPaneFocus`; `installSessionPaneKeyboardCycle`; `initSessionViewLayout` + `notifyTerminalViewportResizeAll` no resize de janela e após ferramentas. |

## Inicialização

No `DOMContentLoaded`: `initSessionViewLayout()` aplica classe guardada; `installSessionPaneKeyboardCycle()` regista Alt+Tab e Ctrl+Page Down/Up quando há ≥2 sessões ligadas e o layout não é `single`.

## Correção de resize

O `#terminalWrapper` precisa voltar como `display: flex` quando a sessão aparece. Se ele for mostrado como `display: block`, os `.terminal-pane` não esticam, e o xterm fica preso em uma faixa pequena no topo. O split lado a lado também usa `flex-wrap: nowrap` e `min-width: 0` para não quebrar para baixo em janelas menores.

## Relação com maximizar

O documento **workspace-terminal-max-split** agora descreve apenas o modo de maximizar/restaurar. O split antigo entre terminal e ferramentas foi removido da interface principal.

## Melhorias futuras

- Renumeração ou arrastar tabs para mudar ordem no ciclo Alt+Tab.
- Lembrar qual painel tinha foco ao mudar entre `single` e split.

## Atualização do README e imagem

- O `README.md` passou a citar o layout de múltiplas sessões, títulos por painel, foco via Alt+Tab/Ctrl+PageDown e maximização do terminal.
- A captura atual da interface foi adicionada em `docs/images/terminal-session-split-current.png`.
- A imagem documenta o estado visual esperado: duas sessões SSH em modo lado a lado, cada uma em seu painel com título próprio.
