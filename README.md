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
| `atualizado` | Hora da última gravação (ms ou segundos). Obrigatório. Sem novidade por 2 minutos, a tarefa aparece como parada. |
| `fim` | `true` quando acabou. A tarefa desce pro cartão de concluídas e some depois de 24 horas. |

Se o seu script já grava JSON com outros nomes de campo, ajuste em **Nomes dos campos** nas configurações. Ex.: `{"feito":"done","total":"size"}`.

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
orca plugin test .       # roda os testes
```

## Licença

MIT
