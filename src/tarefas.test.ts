import { assert, test } from 'orca/testing'
import {
  anotar, camposDe, CAMPOS_PADRAO, estadoDe, etaDe, lerTarefa, ordenar, pctDe, resumo,
  type Bruta, type Tarefa
} from './tarefas'

const AGORA = 1_794_204_550_812
const base: Bruta = { id: 'a', nome: 'A', feito: 12, total: 36, unidade: 'min', detalhe: '', inicio: null, atualizado: AGORA, fim: false }
const tarefa = (p: Partial<Tarefa>): Tarefa => ({ ...base, estado: 'ativa', pct: 0, etaMs: null, ...p })

test('lerTarefa: lê o contrato padrão', () => {
  const b = lerTarefa('render', { nome: 'Render', feito: 12.5, total: 36, unidade: 'min', atualizado: AGORA, fim: false })
  assert.deepEqual(b, { id: 'render', nome: 'Render', feito: 12.5, total: 36, unidade: 'min', detalhe: '', inicio: null, atualizado: AGORA, fim: false })
})

test('lerTarefa: segundos viram ms, sem nome usa o id, sem total vira 0', () => {
  const b = lerTarefa('x', { feito: 3, atualizado: 1_794_204_550 })
  assert.equal(b?.atualizado, 1_794_204_550_000)
  assert.equal(b?.nome, 'x')
  assert.equal(b?.total, 0)
})

test('lerTarefa: sem feito ou atualizado, ou não é objeto, é ignorado', () => {
  assert.equal(lerTarefa('x', { atualizado: AGORA }), null)
  assert.equal(lerTarefa('x', { feito: 1 }), null)
  assert.equal(lerTarefa('x', [1, 2]), null)
  assert.equal(lerTarefa('x', null), null)
})

test('lerTarefa: aceita nomes de campos próprios', () => {
  const campos = { ...CAMPOS_PADRAO, feito: 'done', total: 'size' }
  assert.equal(lerTarefa('x', { done: 4, size: 8, atualizado: AGORA }, campos)?.total, 8)
})

test('estadoDe: ativa, parada, concluída e concluída velha some', () => {
  assert.equal(estadoDe(base, AGORA + 60_000), 'ativa')
  assert.equal(estadoDe(base, AGORA + 3 * 60_000), 'parada')
  assert.equal(estadoDe({ ...base, fim: true }, AGORA + 3 * 60_000), 'concluida')
  assert.equal(estadoDe({ ...base, fim: true }, AGORA + 9 * 60_000), 'concluida')
  assert.equal(estadoDe({ ...base, fim: true }, AGORA + 11 * 60_000), null)
})

test('estadoDe: parada há mais de 30 min foi cancelada e sai da lista', () => {
  assert.equal(estadoDe(base, AGORA + 29 * 60_000), 'parada')
  assert.equal(estadoDe(base, AGORA + 31 * 60_000), null)
})

test('pctDe: conta, limita a 100, fim = 100, sem total = null', () => {
  assert.equal(pctDe({ ...base, feito: 9, total: 36 }), 25)
  assert.equal(pctDe({ ...base, feito: 50, total: 36 }), 100)
  assert.equal(pctDe({ ...base, fim: true, feito: 0, total: 0 }), 100)
  assert.equal(pctDe({ ...base, total: 0 }), null)
})

test('anotar + etaDe: ritmo das amostras dá o tempo que falta', () => {
  let s = anotar([], { ...base, feito: 10, atualizado: AGORA })
  s = anotar(s, { ...base, feito: 10, atualizado: AGORA }) // mesmo atualizado: não duplica
  s = anotar(s, { ...base, feito: 12, atualizado: AGORA + 60_000 })
  assert.equal(s.length, 2)
  // 2 unidades por minuto, faltam 24 → 12 min
  assert.equal(etaDe(s, { ...base, feito: 12, total: 36 }), 12 * 60_000)
})

test('anotar: feito voltou zera as amostras; janela de 5 min corta as velhas', () => {
  const s = anotar([{ t: AGORA, feito: 20 }], { ...base, feito: 1, atualizado: AGORA + 1000 })
  assert.deepEqual(s, [{ t: AGORA + 1000, feito: 1 }])
  const v = anotar([{ t: AGORA, feito: 1 }], { ...base, feito: 2, atualizado: AGORA + 6 * 60_000 })
  assert.deepEqual(v, [{ t: AGORA + 6 * 60_000, feito: 2 }])
})

test('etaDe: sem ritmo, sem total ou com fim = null', () => {
  assert.equal(etaDe([{ t: AGORA, feito: 5 }], base), null)
  assert.equal(etaDe([{ t: AGORA, feito: 5 }, { t: AGORA + 1000, feito: 5 }], base), null)
  assert.equal(etaDe([{ t: AGORA, feito: 1 }, { t: AGORA + 1000, feito: 2 }], { ...base, total: 0 }), null)
})

test('ordenar: quem começou primeiro em cima, parada não pula; concluídas no fim', () => {
  const lista = ordenar([
    tarefa({ id: 'c', estado: 'concluida', inicio: AGORA - 900 }),
    tarefa({ id: 'p', estado: 'parada', inicio: AGORA - 100 }),
    tarefa({ id: 'a1', estado: 'ativa', inicio: AGORA - 50, atualizado: AGORA }),
    tarefa({ id: 'a2', estado: 'ativa', inicio: AGORA - 200, atualizado: AGORA - 5 })
  ])
  assert.deepEqual(lista.map((t) => t.id), ['a2', 'p', 'a1', 'c'])
})

test('ordenar: atualizar não muda a ordem', () => {
  const x = tarefa({ id: 'x', inicio: AGORA - 10, atualizado: AGORA })
  const y = tarefa({ id: 'y', inicio: AGORA - 20, atualizado: AGORA - 9 })
  assert.deepEqual(ordenar([x, y]).map((t) => t.id), ['y', 'x'])
  assert.deepEqual(ordenar([{ ...y, atualizado: AGORA + 5 }, x]).map((t) => t.id), ['y', 'x'])
})

test('lerTarefa: lê detalhe e inicio (segundos viram ms)', () => {
  const b = lerTarefa('z', { feito: 1, atualizado: AGORA, detalhe: ' traduzindo ', inicio: 1_794_204_000 })
  assert.equal(b?.detalhe, 'traduzindo')
  assert.equal(b?.inicio, 1_794_204_000_000)
  assert.equal(lerTarefa('z', { feito: 1, atualizado: AGORA })?.inicio, null)
})

test('camposDe: vazio ou inválido usa o padrão; parcial completa', () => {
  assert.deepEqual(camposDe(''), CAMPOS_PADRAO)
  assert.deepEqual(camposDe('{quebrado'), CAMPOS_PADRAO)
  assert.equal(camposDe('{"feito":"done"}').feito, 'done')
  assert.equal(camposDe('{"feito":"done"}').total, 'total')
})

test('resumo: conta por estado', () => {
  const r = resumo([tarefa({ estado: 'ativa' }), tarefa({ estado: 'ativa' }), tarefa({ estado: 'parada' })])
  assert.deepEqual(r, { ativas: 2, paradas: 1, concluidas: 0 })
})
