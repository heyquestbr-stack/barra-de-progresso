// Lógica pura do "Com você": junta, por worktree, o agente que espera você, o handoff pendente
// e os itens do PENDENCIAS.md. Sem Node e sem Orca, pra testar fácil.

export type Item = { tipo: 'ok' | 'input'; texto: string; detalhe: string[] }
export type EstadoAgente = 'travado' | 'esperando' | 'sua-vez'
export type Agente = {
  estado: EstadoAgente
  agente: string
  /** A última fala inteira (cortada em 4000 caracteres), pra "fala inteira". */
  mensagem: string
  desde: number
  /** Handle do terminal do chat (`orca terminal list`); null em chat nativo sem terminal. */
  terminal: string | null
}
/** `texto`: a nota de continuação (cortada em 6000 caracteres). */
export type Handoff = { arquivo: string; desde: number; texto: string }
export type Grupo = {
  chave: string
  nome: string
  path: string | null
  agente: Agente | null
  handoff: Handoff | null
  itens: Item[]
  total: number
  prioridade: number
  desde: number
  /** Uma linha: a ação que você precisa fazer agora (Haiku; sem ele, um resumo grátis). */
  acao: string
}
/** O que o worker extrai de `orca worktree ps --json` por worktree. */
export type WtInfo = {
  nome: string
  path: string
  unread: boolean
  agentes: { state: string; tipo: string; mensagem: string; desde: number; terminal: string | null }[]
}

const MAX_TEXTO = 240
const MAX_ITEM = 600
const MAX_FALA = 4000

/** Tira a marcação de markdown que atrapalha numa linha curta (mantém `código`). */
export function limpar(s: string, max = MAX_TEXTO): string {
  const t = s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length <= max) return t
  const corte = t.slice(0, max)
  const espaco = corte.lastIndexOf(' ')
  return `${corte.slice(0, espaco > max * 0.6 ? espaco : max)}…`
}

/** Itens abertos (`- [ ]`, ou `- ` sem caixa no formato velho) de "## Precisa do seu ok" e
 *  "## Precisa de input seu". `[x]` é resolvido e não entra; linhas recuadas viram detalhe. */
export function lerPendencias(md: string): Item[] {
  const itens: Item[] = []
  let tipo: Item['tipo'] | null = null
  let atual: Item | null = null
  for (const linha of md.split('\n')) {
    const h = /^##\s+(.*)/.exec(linha)
    if (h) {
      const titulo = h[1].toLowerCase()
      tipo = titulo.startsWith('precisa do seu ok') ? 'ok' : titulo.startsWith('precisa de input seu') ? 'input' : null
      atual = null
      continue
    }
    if (!tipo) continue
    const m = /^[-*]\s+(\[([ xX])\]\s+)?(.+)/.exec(linha)
    if (m) {
      atual = m[2] && m[2] !== ' ' ? null : { tipo, texto: limpar(m[3], MAX_ITEM), detalhe: [] }
      if (atual) itens.push(atual)
      continue
    }
    const sub = /^\s+(?:[-*]\s+)?(.+)/.exec(linha)
    if (sub && atual) atual.detalhe.push(limpar(sub[1], MAX_ITEM))
    else if (!linha.trim()) continue
    else atual = null
  }
  return itens
}

const PEDIDO = /(o que (eu )?preciso de (você|vc)|preciso de você|você decide|o que você faz agora|falta)/i

/** Resumo grátis: o trecho depois de "O que eu preciso de você" / "Você decide"; senão o último parágrafo. */
export function resumoHeuristico(fala: string): string {
  const linhas = fala.split('\n').map((l) => l.trim())
  const i = linhas.findIndex((l) => PEDIDO.test(l) && l.length < 80)
  if (i >= 0) {
    const resto = linhas.slice(i + 1).filter((l) => l && !/^#+\s/.test(l)).slice(0, 2)
    const tit = linhas[i].replace(/^[#*\s]+|[*:\s]+$/g, '')
    const corpo = resto.map((l) => l.replace(/^(\d+[.)]|[-*])\s+/, '')).join(' ')
    if (corpo) return limpar(corpo, 200)
    if (tit) return limpar(tit, 200)
  }
  const paragrafos = fala.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  return limpar((paragrafos[paragrafos.length - 1] ?? '').replace(/^(\d+[.)]|[-*])\s+/gm, ''), 200)
}

/** Caminho → o slug que o hook de handoff usa no nome do arquivo (sem os traços do começo). */
export function slug(caminho: string): string {
  return caminho.replace(/[^A-Za-z0-9]/g, '-').replace(/^-+/, '')
}

/** `PENDENTE---Users-ana-x.md` → `Users-ana-x`. null se não é handoff pendente. */
export function slugDoHandoff(arquivo: string): string | null {
  const m = /^PENDENTE-+(.+)\.md$/.exec(arquivo)
  return m ? m[1].replace(/^-+/, '') : null
}

/** blocked = travado; waiting = esperando; done numa worktree não lida = sua vez. */
export function estadoDoAgente(state: string, unread: boolean): EstadoAgente | null {
  if (state === 'blocked') return 'travado'
  if (state === 'waiting') return 'esperando'
  if (state === 'done' && unread) return 'sua-vez'
  return null
}

const PESO: Record<EstadoAgente, number> = { travado: 0, esperando: 1, 'sua-vez': 2 }

function agenteMaisUrgente(wt: WtInfo): Agente | null {
  let melhor: Agente | null = null
  for (const a of wt.agentes) {
    const estado = estadoDoAgente(a.state, wt.unread)
    if (!estado) continue
    const candidato: Agente = {
      estado, agente: a.tipo,
      mensagem: a.mensagem.slice(0, MAX_FALA), desde: a.desde, terminal: a.terminal
    }
    if (!melhor || PESO[estado] < PESO[melhor.estado] || (PESO[estado] === PESO[melhor.estado] && a.desde > melhor.desde)) {
      melhor = candidato
    }
  }
  return melhor
}

function prioridadeDe(agente: Agente | null, handoff: Handoff | null): number {
  if (agente) return PESO[agente.estado]
  return handoff ? 3 : 4
}

function grupo(chave: string, nome: string, path: string | null, agente: Agente | null, handoff: Handoff | null, itens: Item[]): Grupo {
  return {
    chave, nome, path, agente, handoff, itens,
    total: itens.length + (handoff ? 1 : 0) + (agente ? 1 : 0),
    prioridade: prioridadeDe(agente, handoff),
    desde: Math.max(agente?.desde ?? 0, handoff?.desde ?? 0),
    acao: acaoHeuristica(agente, handoff, itens)
  }
}

/** Um grupo por worktree com algo pra você; handoffs sem worktree viram grupo próprio. */
export function montarGrupos(worktrees: readonly WtInfo[], handoffs: readonly Handoff[], pendencias: ReadonlyMap<string, Item[]>): Grupo[] {
  const porSlug = new Map<string, Handoff>()
  for (const h of handoffs) {
    const s = slugDoHandoff(h.arquivo)
    if (s) porSlug.set(s, h)
  }
  const grupos: Grupo[] = []
  for (const wt of worktrees) {
    const s = slug(wt.path)
    const handoff = porSlug.get(s) ?? null
    porSlug.delete(s)
    const g = grupo(wt.path, wt.nome, wt.path, agenteMaisUrgente(wt), handoff, pendencias.get(wt.path) ?? [])
    if (g.total) grupos.push(g)
  }
  for (const [s, h] of porSlug) {
    grupos.push(grupo(`handoff:${s}`, s.split('-').slice(-3).join('-'), null, null, h, []))
  }
  return grupos.sort((a, b) => a.prioridade - b.prioridade || b.desde - a.desde || a.nome.localeCompare(b.nome))
}

/** Uma entrada da fila: uma resposta a uma pendência, ou "isso já foi feito". */
export type Entrada = { tipo: 'resposta' | 'feito'; item: string; texto?: string }

/** Cache do Claude Code dura 1 h; com folga, conta como quente até 55 min depois da última fala. */
export const CACHE_QUENTE_MS = 55 * 60_000

/** Quente = tem terminal pra receber texto e a última fala é recente. */
export function cacheQuente(agente: Pick<Agente, 'desde' | 'terminal'> | null, agora: number): boolean {
  return !!agente?.terminal && agora - agente.desde < CACHE_QUENTE_MS
}

/** A mensagem que vai pro agente: todas as entradas da fila numa só. */
export function montarMensagem(entradas: readonly Entrada[], chatNovo: boolean): string {
  const linhas = entradas.map((e, i) => e.tipo === 'feito'
    ? `${i + 1}. FEITO: "${e.item}" → marque [x] e mova pra ## Resolvido.`
    : `${i + 1}. Pendência: "${e.item}" → sua resposta: ${e.texto ?? ''}`)
  const abertura = chatNovo
    ? 'Respostas do dono às pendências desta worktree, mandadas pelo Painel. Antes, leia o PENDENCIAS.md (e o STATE.md, se existir).'
    : 'Respostas do dono às pendências desta worktree, mandadas pelo Painel.'
  return [abertura, ...linhas, 'Siga com cada uma e atualize o PENDENCIAS.md no formato fixo (só [ ] conta; resolvido vira [x] em ## Resolvido).'].join('\n')
}

/** O texto que explica o que falta, pela ordem: fala do agente, nota do handoff, lista de pendências. */
export function fonteDaAcao(g: Pick<Grupo, 'agente' | 'handoff' | 'itens'>): { tipo: 'agente' | 'handoff' | 'pendencias'; texto: string } | null {
  if (g.agente?.mensagem) return { tipo: 'agente', texto: g.agente.mensagem }
  if (g.handoff?.texto) return { tipo: 'handoff', texto: g.handoff.texto }
  if (g.itens.length) {
    return { tipo: 'pendencias', texto: g.itens.map((i) => `- [${i.tipo}] ${i.texto}`).join('\n') }
  }
  return null
}

/** Resumo grátis, enquanto o Haiku não responde (ou se ele estiver desligado). */
export function acaoHeuristica(agente: Agente | null, handoff: Handoff | null, itens: readonly Item[]): string {
  if (agente?.mensagem) return resumoHeuristico(agente.mensagem)
  if (handoff?.texto) return resumoHeuristico(handoff.texto)
  if (itens.length) return limpar(`${itens.length === 1 ? '' : `${itens.length} pendências. Primeira: `}${itens[0].texto}`, 160)
  return handoff ? 'Continuar o chat que fechou.' : ''
}
