// Detector de processos longos de transferência (rclone, rsync, ditto, cp -R, git, scp), sem wrapper nem hook.
// Lógica pura: o worker passa o texto de `ps -axo pid,ppid,etime,command` e recebe tarefas sem total ("rodando há X").
import type { Bruta } from './tarefas'

export type Proc = { pid: number; ppid: number; idadeMs: number; cmd: string }
/** O que importa das barras que já existem (JSON) pra não duplicar. */
export type BarraExistente = { id: string; nome: string; inicio: number | null; fim: boolean }

export const MINIMO_MS = 30_000
/** Barra do hook ou do progresso.py nasce junto com o processo: até 90 s de diferença conta como a mesma. */
const JANELA_DEDUPE_MS = 90_000
const MAX_NOME = 28

const WRAPPERS = /(?:^|\/)(?:progresso[-\w]*\.(?:py|sh)|acompanha(?:_hook)?\.py|copia-rapida\.sh)(?:\s|$)/
const PREFIXOS = new Set(['env', 'nice', 'time', 'caffeinate', 'sudo', 'nohup', 'command', 'exec'])
const RCLONE_TRANSFERE = new Set(['copy', 'copyto', 'sync', 'move', 'moveto', 'size'])
const RCLONE_LISTA = new Set(['ls', 'lsf', 'lsl'])
const GIT_SUB = new Set(['push', 'clone', 'fetch', 'pull', 'lfs'])
const GIT_GLOBAL_COM_VALOR = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const COM_VALOR: Record<string, Set<string>> = {
  rclone: new Set(['--transfers', '--checkers', '--drive-chunk-size', '--exclude', '--include', '--filter', '--exclude-from', '--include-from', '--filter-from', '--bwlimit', '--config', '--log-file', '--log-level', '--max-age', '--min-age', '--max-size', '--min-size', '--max-depth', '--drive-client-id', '--drive-client-secret', '--drive-token', '--timeout', '--contimeout', '--retries', '--low-level-retries', '--tpslimit', '--user-agent', '--backup-dir', '--suffix', '--order-by', '--max-transfer', '--multi-thread-streams', '--buffer-size', '--password-command', '--drive-impersonate', '--drive-root-folder-id', '--drive-service-account-file', '--files-from', '--max-delete', '--header', '--compare-dest', '--copy-dest']),
  rsync: new Set(['-e', '--rsh', '--exclude', '--include', '--exclude-from', '--include-from', '--bwlimit', '--port', '--timeout', '--partial-dir', '--rsync-path', '--log-file', '-f', '--filter', '--chmod', '--chown', '--link-dest', '--compare-dest', '--temp-dir', '-T', '--files-from', '--max-size', '--min-size', '--password-file']),
  scp: new Set(['-P', '-i', '-o', '-F', '-l', '-c', '-J', '-S', '-D', '-X']),
  ditto: new Set(['--arch']),
  cp: new Set(),
  git: new Set(['-b', '--branch', '--depth', '-o', '--origin', '--template', '--config', '-c', '--reference', '--separate-git-dir', '-j', '--jobs', '--filter', '--server-option', '--push-option', '--receive-pack', '--repo', '--upload-pack', '-u', '--recurse-submodules']),
}

/** `01-21:57:31` | `01:02:03` | `02:10` -> ms. */
export function etimeMs(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim())
  if (!m) return null
  const [, d, h, mi, se] = m
  return (((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(se)) * 1000
}

export function parsearPs(texto: string): Proc[] {
  const out: Proc[] = []
  for (const linha of texto.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(linha)
    if (!m) continue
    const idade = etimeMs(m[3])
    if (idade === null) continue
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), idadeMs: idade, cmd: m[4] })
  }
  return out
}

/** Tira user:senha@, query e fragmento de URL; user@ de scp/ssh; opções de connection string do rclone. */
export function sanitizar(s: string): string {
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:?#]+)(?::\d+)?([^?#]*)/i.exec(s)
  if (url) return url[1] + url[2]
  if (s.startsWith(':') && s.includes(',')) {
    const m = /^(:[\w-]+)(?:,[^:]*)?(:.*)?$/.exec(s)
    if (m) return m[1] + (m[2] ?? '')
  }
  return s.replace(/^[^/@:]+(?::[^@/]*)?@/, '')
}

/** Nome curto: remoto mantém o prefixo; caminho longo vira `…/último`; local fica só com a última pasta. */
function encurtar(bruto: string): string {
  const s = sanitizar(bruto)
  const pos = s.indexOf(':')
  const remoto = pos > 0 && !s.startsWith('/') && !s.startsWith('.')
  const prefixo = remoto ? s.slice(0, pos + 1) : ''
  const resto = (remoto ? s.slice(pos + 1) : s).replace(/\/+$/, '')
  const partes = resto.split('/').filter(Boolean)
  let r: string
  if (remoto) r = prefixo + (partes.length > 1 ? `…/${partes[partes.length - 1]}` : partes[0] ?? '')
  else if (/^[\w.-]+\.[a-z]{2,}\//i.test(s)) r = s
  else r = partes[partes.length - 1] ?? resto ?? s
  if (!r) r = s
  return r.length > MAX_NOME ? `${r.slice(0, MAX_NOME - 1)}…` : r
}

type Analise = { programa: string; sub: string; args: string[] }

function analisar(cmd: string): Analise | null {
  if (WRAPPERS.test(cmd)) return null
  const t = cmd.trim().split(/\s+/)
  let i = 0
  while (i < t.length && (PREFIXOS.has(t[i]) || /^[A-Za-z_]\w*=/.test(t[i]) || (i > 0 && /^-/.test(t[i]) && PREFIXOS.has(t[0])))) i++
  const exe = t[i]?.split('/').pop() ?? ''
  const args = t.slice(i + 1)

  if (exe === 'rclone') {
    const sub = args.find((a) => !a.startsWith('-')) ?? ''
    const rec = args.some((a) => a === '-R' || a === '--recursive')
    if (!(RCLONE_TRANSFERE.has(sub) || (RCLONE_LISTA.has(sub) && rec))) return null
    if (args.some((a) => /^--stats(=|$)/.test(a) || /^--rc(-|=|$)/.test(a))) return null // já tem barra com número
    return { programa: 'rclone', sub, args: args.slice(args.indexOf(sub) + 1) }
  }
  if (exe === 'git') {
    let j = 0
    while (j < args.length && args[j].startsWith('-')) j += GIT_GLOBAL_COM_VALOR.has(args[j]) ? 2 : 1
    const sub = args[j] ?? ''
    if (!GIT_SUB.has(sub)) return null
    let resto = args.slice(j + 1)
    if (sub === 'lfs') { const l = resto.findIndex((a) => !a.startsWith('-')); const s2 = resto[l] ?? ''; resto = resto.slice(l + 1); return { programa: 'git', sub: `lfs ${s2}`.trim(), args: resto } }
    return { programa: 'git', sub, args: resto }
  }
  if (exe === 'rsync' || exe === 'ditto' || exe === 'scp') return { programa: exe, sub: '', args }
  if (exe === 'cp') {
    const flags = args.filter((a) => /^-[A-Za-z]+$/.test(a)).join('')
    return /[Rra]/.test(flags) ? { programa: 'cp', sub: '-R', args } : null
  }
  return null
}

export function reconhecer(cmd: string): string | null {
  return analisar(cmd) ? cmd : null
}

/** Argumentos que não são opção nem valor de opção. */
function posicionais(programa: string, args: string[]): string[] {
  const valor = COM_VALOR[programa] ?? new Set<string>()
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') { out.push(...args.slice(i + 1)); break }
    if (a.startsWith('-')) { if (!a.includes('=') && valor.has(a)) i++; continue }
    out.push(a)
  }
  return out
}

export function nomeDoProcesso(cmd: string): string {
  const a = analisar(cmd)
  if (!a) return sanitizar(cmd).slice(0, 60)
  const pos = posicionais(a.programa, a.args)
  const titulo = [a.programa, a.sub].filter(Boolean).join(' ')
  if (!pos.length) return titulo
  const origens = pos.length > 1 ? pos.slice(0, -1) : pos
  const destino = pos.length > 1 ? pos[pos.length - 1] : null
  if (a.programa === 'git' && (a.sub === 'clone' || a.sub === 'fetch' || a.sub === 'pull') && pos.length === 1) return `${titulo}: ${encurtar(pos[0])}`
  const de = encurtar(origens[0]) + (origens.length > 1 ? ` +${origens.length - 1}` : '')
  return destino ? `${titulo}: ${de} → ${encurtar(destino)}` : `${titulo}: ${de}`
}

/** Processos de transferência com mais de 30 s de vida, prontos pra entrar na lista como tarefa sem total. */
export function lerProcessos(procs: readonly Proc[], agora: number, barras: readonly BarraExistente[]): Bruta[] {
  const porPid = new Map(procs.map((p) => [p.pid, p]))
  const programaDe = (p: Proc): string | null => analisar(p.cmd)?.programa ?? null
  const daVez = procs.filter((p) => p.idadeMs >= MINIMO_MS && programaDe(p))
  const out: Bruta[] = []
  for (const p of daVez) {
    // filho de wrapper (progresso.py, acompanha.py...) ou de outro processo do mesmo programa (git pull -> git fetch)
    let pai = porPid.get(p.ppid)
    let filho = false
    for (let n = 0; pai && n < 8; n++) {
      if (WRAPPERS.test(pai.cmd) || (programaDe(pai) === programaDe(p) && pai.pid !== p.pid)) { filho = true; break }
      pai = porPid.get(pai.ppid)
    }
    if (filho) continue
    const inicio = agora - p.idadeMs
    if (barras.some((b) => !b.fim && b.inicio !== null && Math.abs(b.inicio - inicio) <= JANELA_DEDUPE_MS)) continue
    out.push({
      id: `proc-${p.pid}`, nome: nomeDoProcesso(p.cmd), feito: 0, total: 0, unidade: '', detalhe: '',
      inicio, atualizado: agora, fim: false
    })
  }
  return out
}
