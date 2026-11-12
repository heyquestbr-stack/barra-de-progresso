# Painel

Plugin do Orca que mostra, ao vivo na sidebar, o progresso de tarefas longas: upload, cópia, render, build. Qualquer script pode aparecer nele.

```
Rodando  2 ativas                       ● AO VIVO
┌──────────────────────────────────────────────┐
│ Build do jogo · shaders   traduzindo     93% │
│ ██████████████████████████████████░░░        │
│ 80.125 / 85.708 shaders         falta 3 min  │
├──────────────────────────────────────────────┤
│ Backup do Drive                          91% │
│ █████████████████████████████████░░░░        │
│ 37 / 40,2 GB                    falta 2 min  │
└──────────────────────────────────────────────┘
```

O plugin também tem a seção **Com você**. Ela mostra, por worktree, o que espera por você: um agente travado, um handoff pendente, itens `- [ ]` do `PENDENCIAS.md`.

## Instalar

```sh
orca plugin install heyquestbr-stack/barra-de-progresso
```

O Orca mostra o que o plugin pede e um código (fingerprint). Rode o mesmo comando com `--approve <fingerprint>`.

Pra atualizar: `orca plugin update`.

## Como um script aparece no Painel

O script grava um arquivo JSON em `~/.claude/state/progresso/<id>.json`. O Painel lê essa pasta a cada 2 segundos. A pasta muda nas configurações do plugin.

```json
{ "nome": "Backup do Drive", "feito": 37, "total": 40.2, "unidade": "GB", "detalhe": "enviando", "inicio": 1730000000000, "atualizado": 1730000600000, "fim": false }
```

| Campo | O que é |
|---|---|
| `nome` | Título curto da tarefa. |
| `feito` | Quanto já foi. Obrigatório. |
| `total` | Quanto é no total. `0` ou sem o campo = total ainda não sabido: a barra fica em movimento, sem porcentagem. |
| `unidade` | Opcional. Ex.: `GB`, `%`, `shaders`. |
| `detalhe` | Opcional. Texto curto ao lado da porcentagem, como a fase da tarefa. Não ponha o tempo que falta: o Painel calcula pelo ritmo. |
| `inicio` | Opcional. Hora em que a tarefa começou (ms ou segundos). Define a ordem: quem começou primeiro fica em cima. Sem ele, vale a hora em que o Painel viu o arquivo pela primeira vez. |
| `atualizado` | Hora da última gravação (ms ou segundos). Obrigatório. Sem novidade por 2 minutos, a tarefa aparece como parada. Parada por mais de 30 minutos, ela sai da lista (o processo foi cancelado). |
| `fim` | `true` quando acabou. A tarefa desce pro cartão de concluídas e some depois de 24 horas. |

Se o seu script já grava JSON com outros nomes de campo, ajuste em **Nomes dos campos** nas configurações. Ex.: `{"feito":"done","total":"size"}`.

## Barra automática pra toda tarefa do Claude Code

Com o hook ligado, toda tarefa que o Claude Code põe em segundo plano e que passa de 30 segundos ganha uma barra sozinha. Não precisa de script por tarefa.

- **Nome da barra:** a descrição do comando.
- **O que ele lê no log:** `45%`, `1.234/5.000 arquivos`, o rclone (`Transferred: 1 GiB / 5 GiB`), o ffmpeg (`time=` contra `Duration:`), o HyperFrames (`@hf-progress`) e o Blender (`Sample N/M`). Sem número, a barra fica em movimento, com a última linha do log ao lado.
- **Fim:** quando a tarefa termina, a barra vira concluída. Se ela sair com erro, aparece `erro (código N)`.
- Também pega `nohup comando > arquivo.log &`.
- **Apagar (`rm -r`):** a barra mede o tamanho no começo e mostra quantos GB já voltaram pro disco.
- **Pular uma tarefa:** ponha `# sem-barra` no comando ou na descrição. Scripts que já gravam a própria barra ficam de fora.

**Ligar** (troque `<pasta do plugin>` pelo caminho onde o Orca guardou o plugin, ou pelo seu clone):

```sh
mkdir -p ~/.claude/scripts
ln -sf "<pasta do plugin>/scripts/acompanha.py" ~/.claude/scripts/acompanha.py
ln -sf "<pasta do plugin>/scripts/acompanha_hook.py" ~/.claude/scripts/acompanha_hook.py
```

E no `~/.claude/settings.json`, dentro de `"hooks"`:

```json
"PostToolUse": [
  { "matcher": "Bash", "hooks": [ { "type": "command", "command": "python3 \"$HOME/.claude/scripts/acompanha_hook.py\"", "timeout": 5 } ] }
]
```

Testes: `python3 -m unittest scripts/test_acompanha.py`.

## Extra: upload com rclone

`scripts/progresso-rclone.py` roda um `rclone` e grava o JSON sozinho:

```sh
nohup python3 scripts/progresso-rclone.py "Backup do Drive" rclone copy ./pasta remoto:destino & disown
```

Problema conhecido: num envio, ele reenviou o mesmo arquivo várias vezes. Em upload grande, confira os bytes com `nettop` depois de 5 minutos.

## Com você e o resumo por IA

A seção Com você pode resumir a última fala de cada agente numa linha, com `claude -p` (custa uns US$ 0,0004 por resumo). Desligue em **Resumir a fala do agente com IA** se não quiser.

## Desenvolver

```sh
orca plugin dev load .   # carrega a pasta no Orca
orca plugin test .       # roda os testes do plugin
python3 -m unittest scripts/test_acompanha.py   # testes da barra automática
```

## Licença

MIT
