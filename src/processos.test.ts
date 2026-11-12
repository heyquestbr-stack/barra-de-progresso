import { assert, test } from 'orca/testing'
import { etimeMs, lerProcessos, nomeDoProcesso, parsearPs, reconhecer, sanitizar, type Proc } from './processos'

const AGORA = 1_794_204_550_812
const proc = (p: Partial<Proc> & { cmd: string }): Proc => ({ pid: 100, ppid: 1, idadeMs: 120_000, ...p })

test('etimeMs: mm:ss, hh:mm:ss e d-hh:mm:ss', () => {
  assert.equal(etimeMs('00:05'), 5_000)
  assert.equal(etimeMs('02:10'), 130_000)
  assert.equal(etimeMs('01:02:03'), 3_723_000)
  assert.equal(etimeMs('01-21:57:31'), (24 + 21) * 3_600_000 + 57 * 60_000 + 31_000)
  assert.equal(etimeMs('lixo'), null)
})

test('parsearPs: pula o cabeçalho e guarda o comando inteiro', () => {
  const texto = '  PID  PPID     ELAPSED COMMAND\n  812     1       02:10 rclone copy a: b: --dry-run\n  9 1 xx quebrado\n'
  assert.deepEqual(parsearPs(texto), [{ pid: 812, ppid: 1, idadeMs: 130_000, cmd: 'rclone copy a: b: --dry-run' }])
})

test('sanitizar: tira user:senha@, query e fragmento de URL', () => {
  assert.equal(sanitizar('https://quest:ghp_SEGREDO@github.com/org/repo.git?token=abc#x'), 'github.com/org/repo.git')
  assert.equal(sanitizar('ssh://git@host.com:2222/a/b'), 'host.com/a/b')
  assert.equal(sanitizar('user:senha@host:/pasta'), 'host:/pasta')
  assert.equal(sanitizar('git@github.com:org/repo.git'), 'github.com:org/repo.git')
  assert.equal(sanitizar(':s3,access_key_id=AKIA,secret_access_key=XYZ:bucket/dir'), ':s3:bucket/dir')
  assert.equal(sanitizar('compdrive:CLIENTES'), 'compdrive:CLIENTES')
})

test('reconhecer: rclone só os subcomandos de transferência; ls/lsf só com -R', () => {
  for (const sc of ['copy', 'copyto', 'sync', 'move', 'moveto', 'size']) assert.ok(reconhecer(`rclone ${sc} a: b:`), sc)
  assert.ok(reconhecer('/opt/homebrew/bin/rclone lsf -R compdrive:X'))
  assert.ok(reconhecer('rclone lsl --recursive compdrive:X'))
  assert.equal(reconhecer('rclone lsf compdrive:X'), null)
  assert.equal(reconhecer('rclone ls compdrive:X'), null)
  assert.equal(reconhecer('rclone mount compdrive: /mnt'), null)
  assert.equal(reconhecer('rclone listremotes'), null)
})

test('reconhecer: rclone com --stats ou --rc já tem barra com número: não duplica', () => {
  assert.equal(reconhecer('rclone copy a: b: --stats 5s'), null)
  assert.equal(reconhecer('rclone copy a: b: --stats=5s'), null)
  assert.equal(reconhecer('rclone copy a: b: --rc'), null)
  assert.equal(reconhecer('rclone copy a: b: --rc-addr :5572'), null)
  assert.ok(reconhecer('rclone copy a: b: --transfers 6'))
})

test('reconhecer: rsync, ditto, scp, cp -R, git (push/clone/fetch/pull/lfs)', () => {
  assert.ok(reconhecer('rsync -a /a /b'))
  assert.ok(reconhecer('/usr/bin/ditto /a /b'))
  assert.ok(reconhecer('scp a.mov host:/x'))
  assert.ok(reconhecer('cp -R /a /b'))
  assert.ok(reconhecer('cp -rp /a /b'))
  assert.equal(reconhecer('cp /a /b'), null)
  for (const sc of ['push', 'clone', 'fetch', 'pull', 'lfs']) assert.ok(reconhecer(`git ${sc} x`), sc)
  assert.ok(reconhecer('git -C /repo push origin main'))
  assert.equal(reconhecer('git status'), null)
  assert.equal(reconhecer('git pack-objects --all-progress-implied'), null)
  assert.equal(reconhecer('git-remote-https origin https://x'), null)
})

test('reconhecer: shell que só carrega o comando no texto não conta', () => {
  assert.equal(reconhecer('/bin/zsh -c rclone copy a: b:'), null)
  assert.equal(reconhecer('python3 progresso.py nome rclone copy a: b:'), null)
  assert.equal(reconhecer('vim rsync.txt'), null)
})

test('nomeDoProcesso: programa subcomando: origem → destino, curto e sem segredo', () => {
  assert.equal(nomeDoProcesso('rclone copy compdrive:CLIENTES/2026/Boma xtdrive:BKP --transfers 6 --exclude ._* --dry-run'), 'rclone copy: compdrive:…/Boma → xtdrive:BKP')
  assert.equal(nomeDoProcesso('rclone size compdrive:CLIENTES'), 'rclone size: compdrive:CLIENTES')
  assert.equal(nomeDoProcesso('rsync -av --exclude *.tmp /Volumes/T7/cache/ /Users/q/cache'), 'rsync: cache → cache')
  assert.equal(nomeDoProcesso('git clone https://quest:ghp_SEGREDO@github.com/org/repo.git?x=1'), 'git clone: github.com/org/repo.git')
  assert.equal(nomeDoProcesso('git -C /r push origin main'), 'git push: origin → main')
  assert.equal(nomeDoProcesso('cp -R /a/pasta /b/'), 'cp -R: pasta → b')
  assert.equal(nomeDoProcesso('git lfs push origin main'), 'git lfs push: origin → main')
  assert.ok(!nomeDoProcesso('rclone copy a: b: --drive-client-secret SEGREDO').includes('SEGREDO'))
})

test('lerProcessos: só passa de 30 s; mostra "há" via inicio; sem total', () => {
  const ps = [
    proc({ pid: 101, cmd: 'rclone size compdrive:CLIENTES', idadeMs: 29_000 }),
    proc({ pid: 102, cmd: 'rclone size compdrive:CLIENTES', idadeMs: 120_000 })
  ]
  const r = lerProcessos(ps, AGORA, [])
  assert.equal(r.length, 1)
  assert.deepEqual(
    { id: r[0].id, nome: r[0].nome, total: r[0].total, fim: r[0].fim, inicio: r[0].inicio, atualizado: r[0].atualizado },
    { id: 'proc-102', nome: 'rclone size: compdrive:CLIENTES', total: 0, fim: false, inicio: AGORA - 120_000, atualizado: AGORA }
  )
})

test('lerProcessos: filho de wrapper (progresso.py / acompanha.py) não duplica', () => {
  const ps = [
    proc({ pid: 10, ppid: 1, cmd: 'python3 /Users/q/.claude/scripts/progresso.py Backup rclone copy a: b:' }),
    proc({ pid: 11, ppid: 10, cmd: 'rclone copy a: b: --transfers 6' })
  ]
  assert.deepEqual(lerProcessos(ps, AGORA, []), [])
})

test('lerProcessos: filho do mesmo programa (git pull -> git fetch) conta uma vez', () => {
  const ps = [
    proc({ pid: 20, ppid: 1, cmd: 'git pull origin main' }),
    proc({ pid: 21, ppid: 20, cmd: 'git fetch --update-head-ok origin' })
  ]
  const r = lerProcessos(ps, AGORA, [])
  assert.deepEqual(r.map((t) => t.nome), ['git pull: origin → main'])
})

test('lerProcessos: barra do hook ou do progresso.py já ativa para o mesmo comando não duplica', () => {
  const ps = [proc({ pid: 30, cmd: 'rclone copy a: b:', idadeMs: 100_000 })]
  const base = { id: 'auto-x-1', nome: 'Copia o cache', inicio: AGORA - 99_000, fim: false }
  assert.equal(lerProcessos(ps, AGORA, [base]).length, 0)
  assert.equal(lerProcessos(ps, AGORA, [{ ...base, fim: true }]).length, 1)
  assert.equal(lerProcessos(ps, AGORA, [{ ...base, inicio: AGORA - 3_000_000 }]).length, 1)
})
