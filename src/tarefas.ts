// Lógica pura do Painel: um JSON de progresso vira uma tarefa. Sem Node e sem Orca, pra testar fácil.

export type Estado = 'ativa' | 'parada' | 'concluida'
export type Campos = { nome: string; feito: string; total: string; unidade: string; detalhe: string; inicio: string; atualizado: string; fim: string }
/** canceladaMs: parada há mais que isso = o processo morreu sem avisar (cancelado); sai da lista. */
export type Regras = { paradaMs: number; concluidaMs: number; canceladaMs: number }
/** inicio: hora em que a tarefa começou (ms), ou null se o JSON não diz; o worker põe a 1ª vez que viu o arquivo. */
export type Bruta = { id: string; nome: string; feito: number; total: number; unidade: string; detalhe: string; inicio: number | null; atualizado: number; fim: boolean }
export type Amostra = { t: number; feito: number }
export type Tarefa = Bruta & { estado: Estado; pct: number | null; etaMs: number | null }

export const CAMPOS_PADRAO: Campos = { nome: 'nome', feito: 'feito', total: 'total', unidade: 'unidade', detalhe: 'detalhe', inicio: 'inicio', atualizado: 'atualizado', fim: 'fim' }
export const REGRAS_PADRAO: Regras = { paradaMs: 2 * 60_000, concluidaMs: 24 * 3_600_000, canceladaMs: 30 * 60_000 }
const JANELA_MS = 5 * 60_000

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** null quando o JSON não serve (sem `feito` ou `atualizado`, ou não é objeto). */
export function lerTarefa(id: string, bruto: unknown, campos: Campos = CAMPOS_PADRAO): Bruta | null {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null
  const o = bruto as Record<string, unknown>
  const feito = num(o[campos.feito])
  let atualizado = num(o[campos.atualizado])
  if (feito === null || atualizado === null) return null
  if (atualizado < 1e12) atualizado *= 1000 // veio em segundos
  const nome = o[campos.nome]
  const unidade = o[campos.unidade]
  const detalhe = o[campos.detalhe]
  let inicio = num(o[campos.inicio])
  if (inicio !== null && inicio < 1e12) inicio *= 1000
  return {
    id,
    nome: typeof nome === 'string' && nome.trim() ? nome.trim() : id,
    feito,
    total: num(o[campos.total]) ?? 0,
    unidade: typeof unidade === 'string' ? unidade : '',
    detalhe: typeof detalhe === 'string' ? detalhe.trim() : '',
    inicio,
    atualizado,
    fim: o[campos.fim] === true
  }
}

/** null = não mostrar (concluída há mais de `concluidaMs`, ou parada há mais de `canceladaMs`). */
export function estadoDe(b: Bruta, agora: number, regras: Regras = REGRAS_PADRAO): Estado | null {
  const idade = agora - b.atualizado
  if (b.fim) return idade > regras.concluidaMs ? null : 'concluida'
  if (idade > Math.max(regras.canceladaMs, regras.paradaMs)) return null
  return idade > regras.paradaMs ? 'parada' : 'ativa'
}

/** null = sem total: barra indeterminada. */
export function pctDe(b: Bruta): number | null {
  if (b.fim) return 100
  if (!(b.total > 0)) return null
  return Math.min(100, Math.max(0, (b.feito / b.total) * 100))
}

/** Guarda uma amostra nova quando `atualizado` muda; zera se `feito` voltou; corta o que passou da janela. */
export function anotar(amostras: readonly Amostra[], b: Bruta, janelaMs = JANELA_MS): Amostra[] {
  const ultima = amostras[amostras.length - 1]
  const nova = { t: b.atualizado, feito: b.feito }
  if (ultima && b.feito < ultima.feito) return [nova]
  const lista = ultima && ultima.t === b.atualizado ? [...amostras] : [...amostras, nova]
  return lista.filter((s) => b.atualizado - s.t <= janelaMs)
}

/** Tempo que falta em ms, pelo ritmo entre a primeira e a última amostra. */
export function etaDe(amostras: readonly Amostra[], b: Bruta): number | null {
  if (b.fim || !(b.total > 0) || amostras.length < 2) return null
  const a = amostras[0]
  const z = amostras[amostras.length - 1]
  const ritmo = (z.feito - a.feito) / (z.t - a.t)
  if (!(ritmo > 0)) return null
  return Math.max(0, (b.total - b.feito) / ritmo)
}

/** Ordem fixa: quem começou primeiro fica em cima (ativa ou parada, tanto faz); concluídas no fim. Empate pelo id. */
export function ordenar(tarefas: readonly Tarefa[]): Tarefa[] {
  const fim = (t: Tarefa) => (t.estado === 'concluida' ? 1 : 0)
  const ini = (t: Tarefa) => t.inicio ?? t.atualizado
  return [...tarefas].sort((x, y) => fim(x) - fim(y) || ini(x) - ini(y) || x.id.localeCompare(y.id))
}

/** A configuração `campos` é um JSON parcial; o que faltar ou vier errado usa o padrão. */
export function camposDe(texto: unknown): Campos {
  if (typeof texto !== 'string' || !texto.trim()) return CAMPOS_PADRAO
  try {
    const o = JSON.parse(texto) as Record<string, unknown>
    if (!o || typeof o !== 'object') return CAMPOS_PADRAO
    const out = { ...CAMPOS_PADRAO }
    for (const k of Object.keys(out) as (keyof Campos)[]) {
      const v = o[k]
      if (typeof v === 'string' && v) out[k] = v
    }
    return out
  } catch {
    return CAMPOS_PADRAO
  }
}

export function resumo(tarefas: readonly Tarefa[]): { ativas: number; paradas: number; concluidas: number } {
  const r = { ativas: 0, paradas: 0, concluidas: 0 }
  for (const t of tarefas) {
    if (t.estado === 'ativa') r.ativas++
    else if (t.estado === 'parada') r.paradas++
    else r.concluidas++
  }
  return r
}
