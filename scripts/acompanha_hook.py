#!/usr/bin/env python3
"""Hook PostToolUse (matcher Bash) do Claude Code: liga o acompanha.py em toda tarefa em segundo plano.

Acha o log da tarefa (o `> arquivo` de um `nohup`, ou o `.../tasks/<id>.output` que o Claude Code
cria pra tarefa em segundo plano) e o nome (a descricao do comando). Solta o leitor e sai.
Nunca falha: qualquer erro vira exit 0, pra nao atrapalhar o Claude.
Pular uma tarefa: ponha `# sem-barra` no comando.
"""
import glob
import json
import os
import re
import shlex
import subprocess
import sys

# comandos que ja gravam a propria barra (ou pediram pra nao ter)
PULA = re.compile(r'#\s*sem-barra|state/progresso|progresso[-\w]*\.(?:py|sh)\b|com-barra|copia-rapida|acompanha(?:_hook)?\.py')
TAREFA = re.compile(r'(/[^\s"\'\\]*?/tasks/[\w-]+\.output)')
NOHUP = re.compile(r'\bnohup\b.*?(?:&>|\d?>>?)\s*([^\s;&|]+)')


def achar(p):
    """Payload do hook -> (log, nome), ou None se nao e tarefa pra acompanhar."""
    ti = p.get('tool_input') or {}
    cmd = ti.get('command') or ''
    if PULA.search(cmd) or re.search(r'#\s*sem-barra', ti.get('description') or ''):
        return None
    # sem descricao: nunca o comando cru (ilegivel no Painel); diz de que pasta veio
    pasta = os.path.basename((p.get('cwd') or '').rstrip('/')) or 'outra aba'
    nome = (ti.get('description') or '').strip() or f'Tarefa sem nome ({pasta})'

    m = NOHUP.search(cmd)
    if m:
        alvo = m.group(1)
        if alvo.startswith('&') or alvo == '/dev/null':
            return None
        alvo = os.path.expanduser(alvo)
        if not os.path.isabs(alvo):
            alvo = os.path.join(p.get('cwd') or os.getcwd(), alvo)
        return alvo, nome

    resp = p.get('tool_response')
    m = TAREFA.search(json.dumps(resp, ensure_ascii=False))
    if m:
        return m.group(1), nome
    tid = resp.get('backgroundTaskId') if isinstance(resp, dict) else None
    if tid:
        return tarefa(p, tid), nome
    return None


RM = re.compile(r'\brm\s+((?:-\w+\s+)+)([^;&|>]+)')
CD = re.compile(r'\bcd\s+("[^"]+"|\'[^\']+\'|[^\s;&|]+)\s*&&')


def apagando(cmd, cwd):
    """Caminhos de um `rm -r` no comando (absolutos), pra barra medir o espaco que volta. [] se nao tem."""
    out = []
    for m in RM.finditer(cmd):
        if 'r' not in m.group(1).lower():
            continue
        cds = [shlex.split(c)[0] for c in CD.findall(cmd[:m.start()])]
        base = os.path.expanduser(cds[-1]) if cds else cwd
        try:
            partes = shlex.split(m.group(2))
        except ValueError:
            continue
        for c in partes:
            c = os.path.expanduser(c)
            out.append(c if os.path.isabs(c) else os.path.join(base, c))
    return out


def tarefa(p, tid):
    """O Claude Code grava a saida da tarefa em <pasta da sessao>/tasks/<id>.output; a pasta da sessao e a mae do scratchpad."""
    sp = p.get('scratchpad_dir')
    if sp:
        return os.path.join(os.path.dirname(sp.rstrip('/')), 'tasks', f'{tid}.output')
    achados = glob.glob(f"/private/tmp/claude-*/*/{p.get('session_id', '*')}/tasks/{tid}.output")
    return achados[0] if achados else f'/private/tmp/claude-{os.getuid()}/tasks/{tid}.output'


def main():
    try:
        p = json.load(sys.stdin)
        r = achar(p)
        # ultimo payload visto, pra conferir o formato quando a barra nao aparece
        d = os.path.expanduser('~/.claude/state/acompanha')
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'ultimo-hook.json'), 'w') as f:
            json.dump({'payload': p, 'achou': r}, f, ensure_ascii=False)
        if r:
            leitor = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'acompanha.py')
            cmd = (p.get('tool_input') or {}).get('command') or ''
            extra = ['--apaga', *apagando(cmd, p.get('cwd') or os.getcwd())] if apagando(cmd, '/') else []
            subprocess.Popen([sys.executable, leitor, '--log', r[0], '--nome', r[1], *extra],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
    except Exception:
        pass
    sys.exit(0)


if __name__ == '__main__':
    main()
