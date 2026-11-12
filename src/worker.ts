// Worker do Painel: lê a pasta de progresso de 2 em 2 s e avisa o painel e a status bar quando muda.
// Roda no processo Node do Orca ("Full access") só porque é o único jeito de ler um arquivo do disco.
// Só lê a pasta configurada; não grava nada e não usa rede.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { cacheQuente, fonteDaAcao, lerPendencias, montarGrupos, montarMensagem, type Entrada, type Grupo, type Handoff, type Item, type WtInfo } from './comvoce'
import type { EstadoComVoce, EstadoPainel } from './protocol'
import {
  anotar, camposDe, estadoDe, etaDe, lerTarefa, ordenar, pctDe, REGRAS_PADRAO, resumo,
  type Amostra, type Campos, type Regras, type Tarefa
} from './tarefas'

const PASTA_PADRAO = '~/.claude/state/progresso'
const GIRO_MS = 2000
const GIRO_COMVOCE_MS = 10_000
const ORCA_BIN = '/Applications/Orca.app/Contents/Resources/bin'
let timerComVoce: ReturnType<typeof setInterval> | undefined
let timer: ReturnType<typeof setInterval> | undefined

export function expandir(p: string): string {
  if (p === '~') return homedir()
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

export async function lerPasta(
  pasta: string, campos: Campos, regras: Regras, amostras: Map<string, Amostra[]>, agora: number,
  vistos: Map<string, number> = new Map()
): Promise<{ tarefas: Tarefa[]; erro: string | null }> {
  let nomes: string[]
  try {
    nomes = (await readdir(pasta)).filter((n) => n.endsWith('.json'))
  } catch {
    return { tarefas: [], erro: `Não achei a pasta ${pasta}` }
  }
  const tarefas: Tarefa[] = []
  for (const nome of nomes) {
    let bruto: unknown
    try {
      bruto = JSON.parse(await readFile(join(pasta, nome), 'utf8'))
    } catch {
      continue // script no meio da escrita: tenta no próximo giro
    }
    const b = lerTarefa(nome.slice(0, -5), bruto, campos)
    if (!b) continue
    if (!vistos.has(nome)) vistos.set(nome, agora)
    b.inicio ??= vistos.get(nome)!
    const estado = estadoDe(b, agora, regras)
    if (!estado) continue
    const lista = anotar(amostras.get(nome) ?? [], b)
    amostras.set(nome, lista)
    tarefas.push({ ...b, estado, pct: pctDe(b), etaMs: estado === 'ativa' ? etaDe(lista, b) : null })
  }
  for (const k of amostras.keys()) if (!nomes.includes(k)) amostras.delete(k)
  for (const k of vistos.keys()) if (!nomes.includes(k)) vistos.delete(k)
  return { tarefas: ordenar(tarefas), erro: null }
}

function rodar(bin: string, args: string[], timeout = 8000, cwd?: string, env?: Record<string, string>): Promise<string> {
  const path = `${process.env.PATH ?? '/usr/bin:/bin'}:${ORCA_BIN}:${join(homedir(), '.local/bin')}`
  // env dado = ambiente limpo e com USER: o worker do Orca roda sem USER, e sem ele o `claude -p` não acha o login no chaveiro.
  const base = env
    ? { HOME: homedir(), USER: process.env.USER || userInfo().username, LOGNAME: process.env.USER || userInfo().username, LANG: process.env.LANG ?? 'pt_BR.UTF-8', ...env, PATH: path }
    : { ...process.env, PATH: path }
  return new Promise((resolve, reject) => {
    const filho = execFile(bin, args, {
      env: base,
      timeout, cwd, maxBuffer: 16 * 1024 * 1024
    }, (erro, saida, stderr) => (erro ? reject(new Error(`${bin}: ${String(stderr || saida || erro.message).slice(-400)}`)) : resolve(saida)))
    filho.stdin?.end() // sem isso o `claude -p` espera 3 s por stdin e avisa no stderr
  })
}
const orcaJson = async (args: string[]): Promise<unknown> => JSON.parse(await rodar('orca', [...args, '--json']))

/** tabId → handle do terminal (o paneKey de um agente começa com o tabId). */
export function terminaisDoList(json: unknown): Map<string, string> {
  const r = (json as { result?: { terminals?: { tabId?: string; handle?: string }[] } })?.result
  const mapa = new Map<string, string>()
  for (const t of r?.terminals ?? []) if (t.tabId && t.handle) mapa.set(t.tabId, t.handle)
  return mapa
}

type LinhaPs = {
  displayName?: string; path?: string; hostId?: string; unread?: boolean; lastActivityAt?: number
  agents?: { paneKey?: string; state?: string; agentType?: string; lastAssistantMessage?: string; mainAgent?: { stateStartedAt?: number } }[]
}

export function worktreesDoPs(json: unknown, terminais: ReadonlyMap<string, string> = new Map()): WtInfo[] {
  const linhas = ((json as { result?: { worktrees?: LinhaPs[] } })?.result?.worktrees) ?? []
  return linhas
    .filter((w) => w.path && (w.hostId ?? 'local') === 'local')
    .map((w) => ({
      nome: w.displayName || (w.path as string).split('/').pop() || (w.path as string),
      path: w.path as string,
      unread: w.unread === true,
      agentes: (w.agents ?? []).map((a) => ({
        state: a.state ?? '',
        tipo: a.agentType ?? 'agente',
        mensagem: a.lastAssistantMessage ?? '',
        desde: a.mainAgent?.stateStartedAt ?? w.lastActivityAt ?? 0,
        terminal: terminais.get((a.paneKey ?? '').split(':')[0]) ?? null
      }))
    }))
}

async function lerHandoffs(pasta: string): Promise<Handoff[]> {
  let nomes: string[]
  try { nomes = await readdir(pasta) } catch { return [] }
  const out: Handoff[] = []
  for (const arquivo of nomes.filter((n) => /^PENDENTE-.*\.md$/.test(n))) {
    try {
      const caminho = join(pasta, arquivo)
      out.push({ arquivo, desde: (await stat(caminho)).mtimeMs, texto: (await readFile(caminho, 'utf8')).slice(0, 6000) })
    } catch { /* sumiu no meio */ }
  }
  return out
}

export async function lerComVoce(worktrees: WtInfo[], pastaHandoffs: string, arquivoPendencias: string): Promise<EstadoComVoce> {
  const pendencias = new Map<string, Item[]>()
  for (const wt of worktrees) {
    try { pendencias.set(wt.path, lerPendencias(await readFile(join(wt.path, arquivoPendencias), 'utf8'))) } catch { /* sem arquivo */ }
  }
  return { grupos: montarGrupos(worktrees, await lerHandoffs(pastaHandoffs), pendencias), erro: null }
}

const PROMPT_RESUMO = 'Você escreve pro dono destes projetos, dizendo o que ELE precisa fazer agora. Recebe um texto: a última fala de um agente de código, a nota de continuação de um chat que fechou, ou uma lista de pendências. Responda só com UMA linha em português, até 14 palavras, começando com um verbo no infinitivo que diga a ação dele (ex.: "Rodar gh auth refresh e mandar o usuário do GitHub", "Aprovar o merge do PR #34", "Escolher entre a voz A e a voz B"). Nunca escreva "perguntar ao dono" nem fale dele na terceira pessoa. Use nomes concretos do texto. Se não houver nada pra ele fazer, comece com "Nada:" e diga o estado em poucas palavras. Sem markdown, sem aspas.'
/** Muda quando o prompt muda, pra não reaproveitar resumo velho. */
const VERSAO_RESUMO = 'v2'

/** Conta do Claude que o Orca usa: configuração do plugin, senão a do ambiente, senão o perfil ativo do Orca. */
async function pastaConfigClaude(configurada: string): Promise<string | undefined> {
  if (configurada) return expandir(configurada)
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR
  try {
    const ativo = (await readFile(join(homedir(), 'Library/Application Support/orca/claude-profiles/selected-host'), 'utf8')).trim()
    return ativo || undefined
  } catch {
    return undefined
  }
}

/** Uma frase pelo Haiku, via `claude -p` sem ferramentas e com prompt de sistema curto (~1 mil tokens). */
async function resumirComIA(tipo: string, texto: string, modelo: string, configDir: string | undefined): Promise<string> {
  const rotulo = tipo === 'agente' ? 'Última fala do agente' : tipo === 'handoff' ? 'Nota de continuação' : 'Pendências abertas'
  const saida = await rodar('claude', [
    '-p', `${rotulo}:\n${texto.slice(0, 6000)}`, '--model', modelo, '--max-turns', '1',
    '--no-session-persistence', '--output-format', 'json', '--setting-sources', 'project', '--tools=',
    '--system-prompt', PROMPT_RESUMO
  ], 60_000, tmpdir(), configDir ? { CLAUDE_CONFIG_DIR: configDir } : {})
  const j = JSON.parse(saida) as { result?: string; is_error?: boolean }
  const r = j.result?.trim()
  if (j.is_error || !r) throw new Error(r || 'resumo vazio')
  return r.replace(/\s+/g, ' ')
}

const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16)

async function atualizarBarra(orca: OrcaWorkerApi, tarefas: Tarefa[]): Promise<void> {
  const { ativas, paradas } = resumo(tarefas)
  const partes = [ativas ? `${ativas} rodando` : '', paradas ? `${paradas} parada${paradas > 1 ? 's' : ''}` : ''].filter(Boolean)
  await orca.host.call('statusBar.update', {
    id: 'tarefas',
    text: partes.length ? partes.join(' · ') : 'nada rodando',
    tone: paradas ? 'warning' : ativas ? 'accent' : 'neutral'
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  const amostras = new Map<string, Amostra[]>()
  const vistos = new Map<string, number>()
  let estado: EstadoPainel = { tarefas: [], erro: null, pasta: '' }
  let ultimo = ''

  async function girar(): Promise<EstadoPainel> {
    const pasta = expandir(String((await orca.settings.get('pasta')) || PASTA_PADRAO))
    const campos = camposDe(await orca.settings.get('campos'))
    const minutos = Number(await orca.settings.get('minutosParada')) || 2
    const regras = { ...REGRAS_PADRAO, paradaMs: minutos * 60_000 }
    estado = { ...(await lerPasta(pasta, campos, regras, amostras, Date.now(), vistos)), pasta }
    const texto = JSON.stringify(estado)
    if (texto !== ultimo) {
      ultimo = texto
      orca.panels.post('tarefas.changed', estado)
      await atualizarBarra(orca, estado.tarefas).catch((e) => orca.log(`status bar: ${String(e)}`))
    }
    return estado
  }

  let comVoce: EstadoComVoce = { grupos: [], erro: null }
  let ultimoComVoce = ''
  let resumos: Record<string, string> = {}
  let resumosCarregados = false
  const pedindo = new Set<string>()
  /** Depois de uma falha, o resumo com IA descansa 10 min (sem isso ele tentava em loop). */
  let pausaAte = 0

  /** Troca o resumo grátis pelo do Haiku quando já tem; pede o que falta, um por vez, em segundo plano. */
  async function aplicarResumos(grupos: Grupo[]): Promise<void> {
    if (!resumosCarregados) {
      resumos = ((await orca.storage.get('resumos')) as Record<string, string> | null) ?? {}
      resumosCarregados = true
    }
    const ligado = (await orca.settings.get('resumoIA')) !== false
    const modelo = String((await orca.settings.get('modeloResumo')) || 'claude-haiku-5-5')
    const configDir = await pastaConfigClaude(String((await orca.settings.get('pastaConfigClaude')) || ''))
    for (const g of grupos) {
      const fonte = fonteDaAcao(g)
      if (!fonte) continue
      const h = hash(`${VERSAO_RESUMO}:${fonte.tipo}:${fonte.texto}`)
      if (resumos[h]) { g.acao = resumos[h]; continue }
      if (!ligado || pedindo.size || Date.now() < pausaAte) continue
      pedindo.add(h)
      void resumirComIA(fonte.tipo, fonte.texto, modelo, configDir)
        .then(async (r) => {
          resumos[h] = r
          const chaves = Object.keys(resumos)
          for (const k of chaves.slice(0, Math.max(0, chaves.length - 200))) delete resumos[k]
          await orca.storage.set('resumos', resumos)
        })
        .catch((e) => {
          pausaAte = Date.now() + 10 * 60_000
          orca.log(`resumo (pausa de 10 min): ${String((e as Error).message ?? e).slice(-300)}`)
        })
        .finally(() => { pedindo.delete(h); void girarComVoce() })
    }
  }

  async function girarComVoce(): Promise<EstadoComVoce> {
    const pastaHandoffs = expandir(String((await orca.settings.get('pastaHandoffs')) || '~/.claude/handoffs'))
    const arquivo = String((await orca.settings.get('arquivoPendencias')) || 'PENDENCIAS.md')
    try {
      const [ps, terms] = await Promise.all([orcaJson(['worktree', 'ps']), orcaJson(['terminal', 'list']).catch(() => null)])
      comVoce = await lerComVoce(worktreesDoPs(ps, terminaisDoList(terms)), pastaHandoffs, arquivo)
      await aplicarResumos(comVoce.grupos)
    } catch (e) {
      orca.log(`com você: ${String(e)}`)
      comVoce = { grupos: comVoce.grupos, erro: 'Não consegui falar com o Orca (orca worktree ps).' }
    }
    const texto = JSON.stringify(comVoce)
    if (texto !== ultimoComVoce) {
      ultimoComVoce = texto
      orca.panels.post('comvoce.changed', comVoce)
    }
    return comVoce
  }

  /** Cache quente: escreve no terminal do chat. Frio (ou chat sem terminal): abre um chat novo na worktree. */
  async function enviarFila(path: string, entradas: Entrada[]): Promise<{ via: 'chat' | 'novo' }> {
    const g = comVoce.grupos.find((x) => x.path === path)
    if (g?.agente && cacheQuente(g.agente, Date.now())) {
      // Colagem entre marcadores (bracketed paste): as quebras de linha não enviam antes da hora.
      const texto = `\x1b[200~${montarMensagem(entradas, false)}\x1b[201~`
      await rodar('orca', ['terminal', 'send', '--terminal', g.agente.terminal as string, '--text', texto, '--enter', '--json'])
      return { via: 'chat' }
    }
    const { workspaces } = await orca.host.call('workspace.list')
    const ws = workspaces.find((w) => w.path === path)
    if (!ws) throw Object.assign(new Error('Não achei essa worktree no Orca.'), { code: 'invalid_params' })
    await orca.host.call('agent.launch', { workspaceId: ws.id, agent: 'claude', prompt: montarMensagem(entradas, true) })
    return { via: 'novo' }
  }

  orca.panels.handle('tarefas.get', () => girar())
  orca.panels.handle('comvoce.get', () => girarComVoce())
  orca.panels.handle('workspace.abrir', async ({ path }) => {
    const { workspaces } = await orca.host.call('workspace.list')
    const ws = workspaces.find((w) => w.path === path)
    if (!ws) return { aberto: false }
    await orca.host.call('workspace.open', { workspaceId: ws.id })
    return { aberto: true }
  })
  orca.panels.handle('fila.enviar', async ({ path, entradas }) => {
    const r = await enviarFila(path, entradas)
    void girarComVoce()
    return r
  })
  timerComVoce = setInterval(() => void girarComVoce(), GIRO_COMVOCE_MS)
  timer = setInterval(() => void girar().catch((e) => orca.log(`giro: ${String(e)}`)), GIRO_MS)
  void girar().catch((e) => orca.log(`giro: ${String(e)}`))
}

export function deactivate(): void {
  if (timer) clearInterval(timer)
  if (timerComVoce) clearInterval(timerComVoce)
  timer = undefined
  timerComVoce = undefined
}
