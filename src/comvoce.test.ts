import { assert, test } from 'orca/testing'
import { acaoHeuristica, cacheQuente, fonteDaAcao, estadoDoAgente, lerPendencias, limpar, montarGrupos, montarMensagem, resumoHeuristico, slug, slugDoHandoff, type WtInfo } from './comvoce'

const MD = `# Pendências
## Precisa do seu ok
- [ ] **Subir** a 0.8.28
  - comando: npx tsx x
- [x] Já feito, não conta
  - detalhe do feito
- Testar [Lucca](http://x) do zero

## Precisa de input seu
* [ ] Usuário do GitHub da Bia

## Resolvido
- [x] algo

## Arquivo (antes de 09/11/2026: o Painel não conta)
### Precisa do seu ok (20/10)
- não entra
`

test('lerPendencias: só [ ] (ou sem caixa), detalhe recuado, ignora Resolvido e Arquivo', () => {
  assert.deepEqual(lerPendencias(MD), [
    { tipo: 'ok', texto: 'Subir a 0.8.28', detalhe: ['comando: npx tsx x'] },
    { tipo: 'ok', texto: 'Testar Lucca do zero', detalhe: [] },
    { tipo: 'input', texto: 'Usuário do GitHub da Bia', detalhe: [] }
  ])
  assert.deepEqual(lerPendencias('# nada aqui'), [])
})

test('resumoHeuristico: pega o que vem depois de "O que eu preciso de você"', () => {
  const fala = 'Onde estou: rodei a revisão.\n\n**O que eu preciso de você:**\n1. Rode o gh auth refresh.\n2. Me diga o usuário da Bia.\n\nDepois eu convido.'
  assert.equal(resumoHeuristico(fala), 'Rode o gh auth refresh. Me diga o usuário da Bia.')
  assert.equal(resumoHeuristico('Primeiro.\n\nÚltimo parágrafo aqui.'), 'Último parágrafo aqui.')
})

test('cacheQuente: precisa de terminal e fala com menos de 55 min', () => {
  assert.equal(cacheQuente({ desde: 0, terminal: 't' }, 10 * 60_000), true)
  assert.equal(cacheQuente({ desde: 0, terminal: 't' }, 60 * 60_000), false)
  assert.equal(cacheQuente({ desde: 0, terminal: null }, 1000), false)
  assert.equal(cacheQuente(null, 1000), false)
})

test('montarMensagem: junta respostas e feitos; chat novo pede pra ler o arquivo', () => {
  const m = montarMensagem([{ tipo: 'resposta', item: 'Subir', texto: 'pode' }, { tipo: 'feito', item: 'Testar' }], true)
  assert.match(m, /leia o PENDENCIAS\.md/)
  assert.match(m, /1\. Pendência: "Subir" → sua resposta: pode/)
  assert.match(m, /2\. FEITO: "Testar"/)
  assert.ok(!/leia o/.test(montarMensagem([{ tipo: 'feito', item: 'x' }], false)))
})

test('limpar: corta texto longo numa palavra e põe reticências', () => {
  const t = limpar('palavra '.repeat(60))
  assert.ok(t.length <= 241)
  assert.ok(t.endsWith('…'))
})

test('slug e slugDoHandoff batem com o nome que o hook grava', () => {
  assert.equal(slug('/Users/ana/Desktop/NOTAS?'), 'Users-ana-Desktop-NOTAS-')
  assert.equal(slugDoHandoff('PENDENTE---Users-ana-Desktop-NOTAS-.md'), 'Users-ana-Desktop-NOTAS-')
  assert.equal(slugDoHandoff('PENDENTE--Users-ana-x.md'), 'Users-ana-x')
  assert.equal(slugDoHandoff('GUARDADO-x.md'), null)
})

test('estadoDoAgente: blocked, waiting e done não lido', () => {
  assert.equal(estadoDoAgente('blocked', false), 'travado')
  assert.equal(estadoDoAgente('waiting', false), 'esperando')
  assert.equal(estadoDoAgente('done', true), 'sua-vez')
  assert.equal(estadoDoAgente('done', false), null)
  assert.equal(estadoDoAgente('working', true), null)
})

test('montarGrupos: junta agente, handoff e pendências por worktree e ordena por urgência', () => {
  const wts: WtInfo[] = [
    { nome: 'beta-rush', path: '/w/beta', unread: true, agentes: [{ state: 'done', tipo: 'claude', mensagem: 'pronto', desde: 5, terminal: null }] },
    { nome: 'vault', path: '/w/vault', unread: false, agentes: [{ state: 'blocked', tipo: 'claude', mensagem: 'posso?', desde: 1, terminal: 't1' }] },
    { nome: 'prosp', path: '/w/prosp', unread: false, agentes: [{ state: 'done', tipo: 'claude', mensagem: 'x', desde: 9, terminal: null }] },
    { nome: 'vazio', path: '/w/vazio', unread: false, agentes: [] }
  ]
  const handoffs = [
    { arquivo: 'PENDENTE--w-prosp.md', desde: 7, texto: 'nota' },
    { arquivo: 'PENDENTE---Users-ana-Desktop-WORK-CLIENTE-X.md', desde: 3, texto: '' }
  ]
  const pend = new Map([['/w/beta', [{ tipo: 'ok' as const, texto: 'a', detalhe: [] }]]])
  const g = montarGrupos(wts, handoffs, pend)
  assert.deepEqual(g.map((x) => [x.nome, x.agente?.estado ?? null, !!x.handoff, x.total]), [
    ['vault', 'travado', false, 1],
    ['beta-rush', 'sua-vez', false, 2],
    ['prosp', null, true, 1],
    ['WORK-CLIENTE-X', null, true, 1]
  ])
})

test('fonteDaAcao: agente, depois handoff, depois pendências', () => {
  const ag = { estado: 'sua-vez' as const, agente: 'claude', mensagem: 'fala', desde: 1, terminal: null }
  const ho = { arquivo: 'PENDENTE--x.md', desde: 1, texto: 'nota' }
  const it = [{ tipo: 'ok' as const, texto: 'Aprovar PR', detalhe: [] }]
  assert.equal(fonteDaAcao({ agente: ag, handoff: ho, itens: it })?.tipo, 'agente')
  assert.equal(fonteDaAcao({ agente: null, handoff: ho, itens: it })?.tipo, 'handoff')
  assert.equal(fonteDaAcao({ agente: null, handoff: null, itens: it })?.texto, '- [ok] Aprovar PR')
  assert.equal(fonteDaAcao({ agente: null, handoff: null, itens: [] }), null)
  assert.equal(acaoHeuristica(null, null, it), 'Aprovar PR')
})
