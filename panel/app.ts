// Painel: desenha o estado que o worker manda. Nada aqui lê disco nem escreve arquivo.
import { cacheQuente, type Entrada, type Grupo, type Item } from '../src/comvoce'
import type { EstadoComVoce, EstadoPainel } from '../src/protocol'
import type { Tarefa } from '../src/tarefas'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const $inicio = $('inicio')
const $tela = $('tela')
const $lista = $('lista')
const $cabeca = $('cabeca')
const $grupos = $('grupos')
const $cabecaCv = $('cabeca-cv')
const $secaoCv = $('comvoce')
const $feitas = $('feitas')
const $secaoFeitas = $('secao-feitas')

let estado: EstadoPainel = { tarefas: [], erro: null, pasta: '' }
let comVoce: EstadoComVoce = { grupos: [], erro: null }
let concluidasAbertas = ler('concluidasAbertas', false)
let comVoceAberto = ler('comVoceAberto', true)
/** Fila de respostas por worktree (chave do grupo). Fica no navegador do painel até enviar. */
let fila = ler<Record<string, Entrada[]>>('fila', {})
/** Worktree aberta na tela de detalhe; null = tela inicial. */
let tela: string | null = null
let itemAberto: string | null = null
let rascunho = ''
let verFala = false
let verNota = false
let aviso: { texto: string; erro: boolean } | null = null
let enviando = false

function ler<T>(chave: string, padrao: T): T {
  try {
    const v = localStorage.getItem(chave)
    return v === null ? padrao : (JSON.parse(v) as T)
  } catch {
    return padrao
  }
}
function gravar(chave: string, valor: unknown): void {
  try { localStorage.setItem(chave, JSON.stringify(valor)) } catch { /* sem storage: só nesta sessão */ }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const comCodigo = (s: string): string => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')
const numero = (n: number): string => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })

function duracao(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h >= 48) return `${Math.round(h / 24)} dias`
  return min % 60 && h < 10 ? `${h} h ${min % 60} min` : `${h} h`
}
const ha = (t: number): string => `há ${duracao(Math.max(0, Date.now() - t))}`

/* ---------- Rodando ---------- */

function quantidade(t: Tarefa): string {
  const u = t.unidade ? ` ${esc(t.unidade)}` : ''
  return t.total > 0 ? `<b>${numero(t.feito)}</b> / ${numero(t.total)}${u}` : `<b>${numero(t.feito)}</b>${u}`
}

function linhaTarefa(t: Tarefa): string {
  const parada = t.estado === 'parada'
  const pct = t.pct === null ? '' : `<span class="pct">${Math.floor(t.pct)}<small>%</small></span>`
  const barra = t.pct === null
    ? '<div class="bar indet"><i></i></div>'
    : `<div class="bar"><i style="width:${t.pct.toFixed(1)}%"></i></div>`
  const direita = parada
    ? `<span class="warn">parada ${ha(t.atualizado)}</span>`
    : t.etaMs !== null ? `<span class="eta">falta <b>${duracao(t.etaMs)}</b></span>` : '<span class="eta">calculando…</span>'
  return `<div class="task${parada ? ' stall' : ''}">
    <div class="top"><span class="name" title="${esc(t.nome)}">${esc(t.nome)}</span>${t.detalhe ? `<span class="det" title="${esc(t.detalhe)}">${esc(t.detalhe)}</span>` : ''}${pct}</div>
    ${barra}
    <div class="meta"><span class="qty">${quantidade(t)}</span>${direita}</div>
  </div>`
}

function blocoConcluidas(ts: Tarefa[]): string {
  if (!ts.length) return ''
  const nomes = ts.map((t) => esc(t.nome)).join(' · ')
  const linhas = concluidasAbertas ? ts.map((t) => `<div class="drow"><span>${esc(t.nome)}</span><span>${ha(t.atualizado)}</span></div>`).join('') : ''
  return `<button class="done" id="concluidas" aria-expanded="${concluidasAbertas}">
    <span class="check">✓</span><strong>${ts.length} concluída${ts.length > 1 ? 's' : ''}</strong>
    <span class="list">${concluidasAbertas ? '' : nomes}</span><span class="caret">▸</span>
  </button>${linhas}`
}

function desenharRodando(): void {
  const vivas = estado.tarefas.filter((t) => t.estado !== 'concluida')
  const feitas = estado.tarefas.filter((t) => t.estado === 'concluida')
  const ativas = vivas.filter((t) => t.estado === 'ativa').length
  const paradas = vivas.length - ativas
  const contadores = [
    ativas ? `<span class="n lime">${ativas} ativa${ativas > 1 ? 's' : ''}</span>` : '',
    paradas ? `<span class="n hot">${paradas} parada${paradas > 1 ? 's' : ''}</span>` : ''
  ].join('')
  $cabeca.innerHTML = `<h2>Rodando</h2>${contadores}<span class="live"><span class="pulse"></span>ao vivo</span>`
  $secaoFeitas.hidden = feitas.length === 0
  $feitas.innerHTML = blocoConcluidas(feitas)
  if (estado.erro) {
    $lista.innerHTML = `<div class="err">${esc(estado.erro)}<p>Confira a pasta nas configurações do plugin: <code>${esc(estado.pasta)}</code></p></div>`
    return
  }
  const vazio = vivas.length ? '' : `<div class="empty"><h3>Nada rodando agora</h3>
    <p>Qualquer script que gravar um JSON em <code>${esc(estado.pasta)}</code> aparece aqui.</p></div>`
  $lista.innerHTML = vivas.map(linhaTarefa).join('') + vazio
}

/* ---------- Com você: lista ---------- */

const ROTULO = { travado: ['travado', 'c-rose'], esperando: ['esperando', 'c-hot'], 'sua-vez': ['sua vez', 'c-lime'] } as const

function chipDe(g: Grupo): string {
  if (g.agente) return `<span class="chip ${ROTULO[g.agente.estado][1]}">${ROTULO[g.agente.estado][0]}</span>`
  return g.handoff ? '<span class="chip c-lilac">handoff</span>' : ''
}

function linhaDoGrupo(g: Grupo): string {
  const naFila = fila[g.chave]?.length ? `<span class="n lime">${fila[g.chave].length} na fila</span>` : ''
  return `<button class="wt" data-grupo="${esc(g.chave)}">
    <span class="gh"><span class="wt-nome">${esc(g.nome)}</span>${naFila}${chipDe(g)}<span class="count">${g.total}</span></span>
    <span class="acao">${comCodigo(g.acao || 'Abrir pra ver.')}</span>
  </button>`
}

function desenharLista(): void {
  const gs = comVoce.grupos
  $secaoCv.hidden = gs.length === 0 && !comVoce.erro
  const total = gs.reduce((s, g) => s + g.total, 0)
  $cabecaCv.innerHTML = `<button class="titulo-cv" id="titulo-cv" aria-expanded="${comVoceAberto}"><h2>Com você</h2><span class="caret">▸</span></button>${gs.length ? `<span class="n faint">${total} em ${gs.length} worktree${gs.length > 1 ? 's' : ''}</span>` : ''}`
  if (!comVoceAberto) {
    const urgentes = gs.filter((g) => g.agente).length
    const nomes = gs.map((g) => esc(g.nome)).join(' · ')
    $grupos.innerHTML = `<button class="done" id="guardar-cv" aria-expanded="false">
      ${urgentes ? `<span class="chip c-lime">${urgentes} sua vez</span>` : ''}<span class="list">${nomes}</span><span class="caret">▸</span></button>`
    return
  }
  $grupos.innerHTML = (comVoce.erro ? `<div class="err">${esc(comVoce.erro)}</div>` : '') + gs.map(linhaDoGrupo).join('') +
    '<button class="done guardar" id="guardar-cv" aria-expanded="true"><span class="list">Guardar</span><span class="caret">▸</span></button>'
}

/* ---------- Com você: tela da worktree ---------- */

const entradasDe = (chave: string): Entrada[] => fila[chave] ?? []
const naFila = (chave: string, item: string): Entrada | undefined => entradasDe(chave).find((e) => e.item === item)

function linhaCache(g: Grupo): string {
  if (!g.agente) return ''
  if (!g.agente.terminal) return '<span class="cache frio"><i></i>chat sem terminal · resposta abre chat novo</span>'
  const quente = cacheQuente(g.agente, Date.now())
  return `<span class="cache${quente ? '' : ' frio'}"><i></i>cache ${quente ? 'quente' : 'frio'} · ${duracao(Date.now() - g.agente.desde)}</span>`
}

function linhaItem(g: Grupo, item: Item): string {
  const entrada = naFila(g.chave, item.texto)
  const aberto = itemAberto === item.texto
  const detalhe = aberto && item.detalhe.length ? `<ul class="det">${item.detalhe.map((d) => `<li>${comCodigo(d)}</li>`).join('')}</ul>` : ''
  let acoes = ''
  if (entrada) {
    const o_que = entrada.tipo === 'feito' ? 'marcar como feito' : `responder: “${esc(entrada.texto ?? '')}”`
    acoes = `<p class="na-fila">Na fila: ${o_que}</p>${aberto ? '<div class="acoes"><button class="btn2" data-acao="tirar">Tirar da fila</button></div>' : ''}`
  } else if (aberto) {
    acoes = `<textarea id="resposta" placeholder="Sua resposta…">${esc(rascunho)}</textarea>
      <div class="acoes"><button class="btn" data-acao="responder">Pôr na fila</button><button class="btn2" data-acao="feito">✓ Feito</button><button class="btn2" data-acao="fechar">Cancelar</button></div>`
  }
  const classe = ['pend', aberto ? 'open' : '', entrada?.tipo === 'feito' ? 'riscado' : '', entrada ? 'fila' : ''].filter(Boolean).join(' ')
  return `<div class="${classe}" data-item="${esc(item.texto)}"><span class="bola">${entrada ? '•' : ''}</span>
    <div class="txt"><p>${comCodigo(item.texto)}</p>${detalhe}${acoes}</div></div>`
}

function blocoItens(g: Grupo, tipo: Item['tipo'], titulo: string): string {
  const itens = g.itens.filter((i) => i.tipo === tipo)
  if (!itens.length) return ''
  return `<div class="sub"><h3>${titulo}</h3><span class="n c">${itens.length}</span></div>
    <div class="card">${itens.map((i) => linhaItem(g, i)).join('')}</div>`
}

function barraFila(g: Grupo): string {
  if (aviso) return `<div class="fila${aviso.erro ? ' erro' : ''}"><div class="q">${esc(aviso.texto)}</div></div>`
  const n = entradasDe(g.chave).length
  if (!n) return ''
  const destino = cacheQuente(g.agente, Date.now()) ? 'vão juntas pro chat aberto · cache quente' : 'vão pra um chat novo · cache frio'
  return `<div class="fila"><div class="q">${n} resposta${n > 1 ? 's' : ''} na fila<small>${destino}</small></div>
    <button class="ghost" data-acao="limpar">Limpar</button><button data-acao="enviar"${enviando ? ' disabled' : ''}>${enviando ? 'Enviando…' : 'Enviar'}</button></div>`
}

function desenharTela(): void {
  const g = comVoce.grupos.find((x) => x.chave === tela)
  if (!g) { tela = null; return }
  const abrir = g.path ? `<button class="btn2" data-acao="abrir">Abrir</button>` : ''
  const resumo = g.agente ? `<div class="card resumo">
      <p class="frase">${comCodigo(g.acao || 'Terminou e espera você.')}</p>
      ${verFala ? `<div class="fala">${comCodigo(g.agente.mensagem)}</div>` : ''}
      <div class="meta">${linhaCache(g)}<button class="link" data-acao="fala">${verFala ? 'esconder fala' : 'fala inteira'}</button></div>
    </div>` : ''
  const handoff = g.handoff ? `<div class="card resumo">
      ${g.agente ? '' : `<p class="frase">${comCodigo(g.acao || 'Continuar o chat que fechou.')}</p>`}
      ${verNota ? `<div class="fala">${comCodigo(g.handoff.texto)}</div>` : ''}
      <div class="meta"><span class="cache frio"><i></i>handoff · ${ha(g.handoff.desde)}</span><button class="link" data-acao="nota">${verNota ? 'esconder nota' : 'nota inteira'}</button></div></div>` : ''
  const vazio = g.itens.length ? '' : '<div class="card empty"><p>Nenhuma pendência aberta no PENDENCIAS.md.</p></div>'
  const foco = document.activeElement?.id === 'resposta'
  $tela.innerHTML = `<div class="voltar"><button class="seta" data-acao="voltar" aria-label="Voltar">←</button><h2>${esc(g.nome)}</h2>${chipDe(g)}${abrir}</div>
    ${resumo}${handoff}
    ${blocoItens(g, 'ok', 'Precisa do seu ok')}${blocoItens(g, 'input', 'Precisa de input seu')}${vazio}
    ${barraFila(g)}`
  const ta = document.getElementById('resposta') as HTMLTextAreaElement | null
  if (ta && foco) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) }
}

/* ---------- desenhar tudo ---------- */

function desenhar(): void {
  $inicio.hidden = tela !== null
  $tela.hidden = tela === null
  if (tela !== null) desenharTela()
  if (tela === null) {
    $inicio.hidden = false
    $tela.hidden = true
    desenharRodando()
    desenharLista()
  }
}

function porNaFila(chave: string, entrada: Entrada): void {
  fila = { ...fila, [chave]: [...entradasDe(chave).filter((e) => e.item !== entrada.item), entrada] }
  gravar('fila', fila)
}

async function enviar(g: Grupo): Promise<void> {
  if (!g.path || enviando) return
  enviando = true
  desenhar()
  try {
    const r = await orca.plugin.request('fila.enviar', { path: g.path, entradas: entradasDe(g.chave) })
    fila = { ...fila, [g.chave]: [] }
    gravar('fila', fila)
    aviso = { texto: r.via === 'chat' ? 'Mandei pro chat aberto ✓' : 'Abri um chat novo na worktree ✓', erro: false }
  } catch (e) {
    aviso = { texto: `Não deu pra enviar: ${(e as Error).message ?? e}`, erro: true }
  } finally {
    enviando = false
    desenhar()
    setTimeout(() => { aviso = null; desenhar() }, 4000)
  }
}

/* ---------- cliques ---------- */

$feitas.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('#concluidas')) {
    concluidasAbertas = !concluidasAbertas
    gravar('concluidasAbertas', concluidasAbertas)
    desenhar()
  }
})

$grupos.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('#guardar-cv')) {
    comVoceAberto = !comVoceAberto
    gravar('comVoceAberto', comVoceAberto)
    desenhar()
    return
  }
  const linha = (e.target as HTMLElement).closest('[data-grupo]') as HTMLElement | null
  if (!linha) return
  tela = linha.dataset.grupo ?? null
  itemAberto = null
  rascunho = ''
  verFala = false
  verNota = false
  desenhar()
  window.scrollTo(0, 0)
})

$cabecaCv.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('#titulo-cv')) return
  comVoceAberto = !comVoceAberto
  gravar('comVoceAberto', comVoceAberto)
  desenhar()
})

$tela.addEventListener('input', (e) => {
  if ((e.target as HTMLElement).id === 'resposta') rascunho = (e.target as HTMLTextAreaElement).value
})

$tela.addEventListener('click', (e) => {
  const alvo = e.target as HTMLElement
  const g = comVoce.grupos.find((x) => x.chave === tela)
  if (!g) return
  const acao = (alvo.closest('[data-acao]') as HTMLElement | null)?.dataset.acao
  const item = (alvo.closest('[data-item]') as HTMLElement | null)?.dataset.item ?? null
  if (!acao) {
    if (item && alvo.tagName !== 'TEXTAREA') {
      itemAberto = itemAberto === item ? null : item
      rascunho = ''
      desenhar()
    }
    return
  }
  if (acao === 'voltar') { tela = null; desenhar(); return }
  if (acao === 'abrir' && g.path) { void orca.plugin.request('workspace.abrir', { path: g.path }); return }
  if (acao === 'fala') { verFala = !verFala; desenhar(); return }
  if (acao === 'nota') { verNota = !verNota; desenhar(); return }
  if (acao === 'limpar') { fila = { ...fila, [g.chave]: [] }; gravar('fila', fila); desenhar(); return }
  if (acao === 'enviar') { void enviar(g); return }
  if (!item) return
  if (acao === 'responder') {
    if (!rascunho.trim()) { (document.getElementById('resposta') as HTMLTextAreaElement | null)?.focus(); return }
    porNaFila(g.chave, { tipo: 'resposta', item, texto: rascunho.trim() })
  } else if (acao === 'feito') {
    porNaFila(g.chave, { tipo: 'feito', item })
  } else if (acao === 'tirar') {
    fila = { ...fila, [g.chave]: entradasDe(g.chave).filter((x) => x.item !== item) }
    gravar('fila', fila)
  }
  itemAberto = acao === 'tirar' ? item : null
  rascunho = ''
  desenhar()
})

/* ---------- dados ---------- */

orca.plugin.on('tarefas.changed', (novo) => { estado = novo; if (tela === null) desenhar() })
orca.plugin.on('comvoce.changed', (novo) => { comVoce = novo; desenhar() })
setInterval(() => { if (document.activeElement?.id !== 'resposta') desenhar() }, 15_000) // "há X min" anda sozinho
desenhar()
void orca.plugin.request('tarefas.get').then((novo) => { estado = novo; desenhar() })
void orca.plugin.request('comvoce.get').then((novo) => { comVoce = novo; desenhar() })
