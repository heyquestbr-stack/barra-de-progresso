#!/usr/bin/env python3
"""Barra no Painel pra agente em segundo plano (ferramenta Agent com run_in_background).

Tres jeitos de chamar:
  hook PostToolUse (matcher Agent):  agente_barra.py --hook   (payload no stdin) -> solta o leitor e sai
  hook SubagentStop:                 agente_barra.py --fim    (payload no stdin) -> marca o agente como terminado
  leitor (solto pelo --hook):        agente_barra.py --ler <transcript> <agent_id> <nome>
Workflow (matcher Workflow, mesmo --hook): le o journal.jsonl da pasta do workflow e mostra "fase · N de M agentes prontos".
  leitor do workflow:                agente_barra.py --ler-wf <pasta> <task_id> <nome>
Grava ~/.claude/state/progresso/auto-agente-<id>.json a cada 3 s: "N passos · <ultima ferramenta>".
Fim: a marca do SubagentStop, ou 20 min sem o arquivo do agente mudar ("parou sem resposta").
Nunca falha: qualquer erro vira exit 0, pra nao atrapalhar o Claude.
"""
import json
import os
import re
import subprocess
import sys
import time

DIR = os.path.expanduser('~/.claude/state/progresso')
MARCAS = os.path.expanduser('~/.claude/state/acompanha/agentes-fim')
PARADO_MAX = 20 * 60   # sem escrever nada por 20 min = considera morto
WF_FIM = 3 * 60       # workflow com todos os agentes prontos e 3 min parado = terminou
ESPERA_ARQUIVO = 120   # o .output nasce uns segundos depois do hook: espera ate 2 min
TASKS = re.compile(r'(/[^\s"\']*?/tasks/([\w-]+)\.output)')
USO = re.compile(r'"type":\s?"tool_use",\s?"id":\s?"[^"]+",\s?"name":\s?"([^"]+)"')


def achar(p):
    """Payload do PostToolUse -> (caminho, agent_id, nome), ou None se nao e agente em segundo plano."""
    ti, resp = p.get('tool_input') or {}, p.get('tool_response') or {}
    if not ti.get('run_in_background') and not (isinstance(resp, dict) and resp.get('isAsync')):
        return None
    m = TASKS.search(json.dumps(resp, ensure_ascii=False))
    if not m:
        return None
    nome = (ti.get('description') or '').strip() or ti.get('subagent_type') or 'sem nome'
    return m.group(1), m.group(2), 'Agente: ' + nome


def achar_wf(p):
    """Payload do PostToolUse Workflow -> (pasta do journal, task_id, nome), ou None."""
    resp = p.get('tool_response')
    if not isinstance(resp, dict) or not resp.get('transcriptDir') or not resp.get('taskId'):
        return None
    nome = resp.get('workflowName') or (resp.get('summary') or '').strip() or 'sem nome'
    return resp['transcriptDir'], str(resp['taskId']), 'Workflow: ' + nome


def estado_wf(tid, nome, inicio, pasta, agora):
    """Um giro do workflow. Fim: todo agente que comecou ja respondeu e nada mudou ha 3 min, ou nada mudou ha 20 min."""
    ini = fim_ag = 0
    fase = ''
    try:
        with open(os.path.join(pasta, 'journal.jsonl'), encoding='utf-8', errors='replace') as f:
            for linha in f:
                try:
                    e = json.loads(linha)
                except ValueError:
                    continue
                if e.get('type') == 'started':
                    ini += 1
                    fase = e.get('phase') or fase
                elif e.get('type') == 'result':
                    fim_ag += 1
        mexeu = max(os.path.getmtime(os.path.join(pasta, x)) for x in os.listdir(pasta))
        parado = agora - mexeu
    except (OSError, ValueError):  # a pasta nasce uns segundos depois do hook
        parado = 0 if agora - inicio < ESPERA_ARQUIVO else PARADO_MAX + 1
    fim = (ini > 0 and fim_ag >= ini and parado > WF_FIM) or parado > PARADO_MAX
    if fim:
        detalhe = 'terminou' if ini and fim_ag >= ini else 'parou sem resposta'
    else:
        detalhe = (f'{fase} · ' if fase else '') + f'{fim_ag} de {ini} agentes prontos' if ini else 'começando'
    return {'nome': nome, 'feito': 100 if fim else fim_ag, 'total': 100 if fim else 0, 'unidade': '', 'detalhe': detalhe,
            'inicio': int(inicio * 1000), 'atualizado': int(agora * 1000), 'fim': fim}


def passos(caminho):
    """(quantas ferramentas o agente ja usou, nome da ultima)."""
    try:
        with open(caminho, encoding='utf-8', errors='replace') as f:
            txt = f.read()
    except OSError:
        return 0, ''
    nomes = USO.findall(txt)
    return len(nomes), (nomes[-1] if nomes else '')


def estado(aid, nome, inicio, caminho, agora, marcas=MARCAS):
    """Um giro: o JSON da barra. Funcao pura (so le disco), pra testar sem esperar."""
    n, ult = passos(caminho)
    try:
        parado = agora - os.path.getmtime(caminho)
    except OSError:
        parado = 0 if agora - inicio < ESPERA_ARQUIVO else PARADO_MAX + 1
    acabou = os.path.exists(os.path.join(marcas, aid))
    fim = acabou or parado > PARADO_MAX
    detalhe = ('terminou' if acabou else 'parou sem resposta') if fim else f'{n} passos' + (f' · {ult}' if ult else '')
    return {'nome': nome, 'feito': 100 if fim else 0, 'total': 100 if fim else 0, 'unidade': '', 'detalhe': detalhe,
            'inicio': int(inicio * 1000), 'atualizado': int(agora * 1000), 'fim': fim}


def grava(aid, d, pasta=DIR, prefixo='auto-agente-'):
    os.makedirs(pasta, exist_ok=True)
    arq = os.path.join(pasta, f'{prefixo}{aid[:8]}.json')
    with open(arq + '.tmp', 'w') as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(arq + '.tmp', arq)


def ler(caminho, aid, nome):
    inicio = time.time()
    while True:
        d = estado(aid, nome, inicio, caminho, time.time())
        grava(aid, d)
        if d['fim']:
            return
        time.sleep(3)


def ler_wf(pasta, tid, nome):
    inicio = time.time()
    while True:
        d = estado_wf(tid, nome, inicio, pasta, time.time())
        grava(tid, d, prefixo='auto-workflow-')
        if d['fim']:
            return
        time.sleep(3)


def hook():
    p = json.load(sys.stdin)
    wf = p.get('tool_name') == 'Workflow'
    r = achar_wf(p) if wf else achar(p)
    if r:
        subprocess.Popen([sys.executable, os.path.realpath(__file__), '--ler-wf' if wf else '--ler', *r],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)


def marca_fim(p, marcas=MARCAS):
    aid = p.get('agent_id') or ''
    if aid and re.fullmatch(r'[\w-]+', aid):
        os.makedirs(marcas, exist_ok=True)
        open(os.path.join(marcas, aid), 'w').close()


if __name__ == '__main__':
    try:
        if sys.argv[1] == '--hook':
            hook()
        elif sys.argv[1] == '--fim':
            marca_fim(json.load(sys.stdin))
        elif sys.argv[1] == '--ler-wf':
            ler_wf(sys.argv[2], sys.argv[3], sys.argv[4])
        elif sys.argv[1] == '--ler':
            ler(sys.argv[2], sys.argv[3], sys.argv[4])
    except Exception:
        pass
    sys.exit(0)
