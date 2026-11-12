// Contrato painel <-> worker, declarado uma vez.
import type { Entrada, Grupo } from './comvoce'
import type { Tarefa } from './tarefas'
export type EstadoPainel = { tarefas: Tarefa[]; erro: string | null; pasta: string }
export type EstadoComVoce = { grupos: Grupo[]; erro: string | null }

declare module 'orca' {
  interface PluginRequests {
    /** Lê a pasta agora e devolve o estado. */
    'tarefas.get': { output: EstadoPainel }
    /** Lê worktrees, handoffs e PENDENCIAS.md agora. */
    'comvoce.get': { output: EstadoComVoce }
    /** Mostra a worktree desse caminho no Orca. */
    'workspace.abrir': { input: { path: string }; output: { aberto: boolean } }
    /** Manda a fila de respostas da worktree: pro chat aberto (cache quente) ou pra um chat novo. */
    'fila.enviar': { input: { path: string; entradas: Entrada[] }; output: { via: 'chat' | 'novo' } }
  }
  interface PluginPanelEvents {
    /** Mandado a todo painel aberto quando o estado muda. */
    'tarefas.changed': EstadoPainel
    'comvoce.changed': EstadoComVoce
  }
}
