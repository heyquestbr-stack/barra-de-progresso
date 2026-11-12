import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('tarefas.get lê a pasta, ignora JSON quebrado e ordena', async () => {
  const pasta = mkdtempSync(join(tmpdir(), 'painel-'))
  const agora = Date.now()
  writeFileSync(join(pasta, 'a.json'), JSON.stringify({ nome: 'A', feito: 5, total: 10, unidade: 'min', atualizado: agora, fim: false }))
  writeFileSync(join(pasta, 'b.json'), JSON.stringify({ nome: 'B', feito: 1, total: 1, unidade: 'GB', atualizado: agora, fim: true }))
  writeFileSync(join(pasta, 'quebrado.json'), '{"nome": "meio escr')
  writeFileSync(join(pasta, 'a.log'), 'não é json')
  const worker = await mountWorker(main, { host: mockHost({ settings: { pasta, minutosParada: 2, campos: '' } }) })
  const r = await worker.request('tarefas.get')
  assert.equal(r.erro, null)
  assert.deepEqual(r.tarefas.map((t) => [t.nome, t.estado, t.pct]), [['A', 'ativa', 50], ['B', 'concluida', 100]])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('pasta que não existe devolve erro e lista vazia', async () => {
  const worker = await mountWorker(main, { host: mockHost({ settings: { pasta: '/nao/existe/painel', minutosParada: 2, campos: '' } }) })
  const r = await worker.request('tarefas.get')
  assert.deepEqual(r.tarefas, [])
  assert.match(r.erro ?? '', /não achei/i)
  await worker.deactivate()
})

test('expandir troca ~ pela home', () => {
  assert.ok(!main.expandir('~/x').startsWith('~'))
  assert.equal(main.expandir('/abs'), '/abs')
})

test('worktreesDoPs lê o JSON do orca e ignora outros hosts', () => {
  const ps = { result: { worktrees: [
    { displayName: 'beta', path: '/w/beta', hostId: 'local', unread: true, agents: [{ state: 'done', agentType: 'claude', lastAssistantMessage: 'oi', mainAgent: { stateStartedAt: 5 } }] },
    { displayName: 'longe', path: '/r/x', hostId: 'ssh:1', agents: [] }
  ] } }
  assert.deepEqual(main.worktreesDoPs(ps), [
    { nome: 'beta', path: '/w/beta', unread: true, agentes: [{ state: 'done', tipo: 'claude', mensagem: 'oi', desde: 5, terminal: null }] }
  ])
  assert.deepEqual(main.worktreesDoPs(null), [])
})

test('lerComVoce junta PENDENCIAS.md e handoff da worktree', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'painel-wt-'))
  const hand = mkdtempSync(join(tmpdir(), 'painel-hand-'))
  writeFileSync(join(wt, 'PENDENCIAS.md'), '## Precisa do seu ok\n- Aprovar o corte\n')
  writeFileSync(join(hand, `PENDENTE--${wt.replace(/[^A-Za-z0-9]/g, '-').replace(/^-+/, '')}.md`), 'x')
  writeFileSync(join(hand, 'GUARDADO-x.md'), 'x')
  const r = await main.lerComVoce([{ nome: 'wt', path: wt, unread: false, agentes: [] }], hand, 'PENDENCIAS.md')
  assert.equal(r.grupos.length, 1)
  assert.deepEqual(r.grupos[0].itens, [{ tipo: 'ok', texto: 'Aprovar o corte', detalhe: [] }])
  assert.ok(r.grupos[0].handoff)
})
