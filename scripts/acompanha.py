#!/usr/bin/env python3
"""Le o log de uma tarefa e grava a barra do Painel em ~/.claude/state/progresso/auto-<nome>.json.

Uso: acompanha.py --log <arquivo> --nome "<nome da barra>" [--espera 30]
Normalmente quem chama e o acompanha_hook.py, sozinho, em toda tarefa em segundo plano do Claude Code.
Espera `--espera` segundos: se a tarefa ja acabou, sai sem barra. Depois le o fim do log a cada 3 s.
Acaba quando aparece `[exited with code N]` no log ou quando nenhum processo esta mais com o log aberto.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import time
import unicodedata

DIR = os.path.expanduser('~/.claude/state/progresso')
CAUDA, CABECA = 8 * 1024, 64 * 1024

ANSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')
HORA = re.compile(r'^\[\d{1,2}:\d{2}(?::\d{2})?\]\s*')
NUM = r'(\d{1,3}(?:[.,]\d{3})+|\d+)'
XY = re.compile(r'(?<![\[\d.,/])' + NUM + r'\s*/\s*' + NUM + r'(?![\d\]/])(?:\s+([A-Za-zÀ-ú]+))?')
PCT = re.compile(r'(\d+(?:[.,]\d+)?)\s*%')
UNI = {'B': 1, 'KB': 2**10, 'KIB': 2**10, 'MB': 2**20, 'MIB': 2**20, 'GB': 2**30, 'GIB': 2**30, 'TB': 2**40, 'TIB': 2**40}
RCLONE = re.compile(r'Transferred:\s*([\d.]+)\s*([KMGT]?i?B)\s*/\s*([\d.]+)\s*([KMGT]?i?B),\s*\d+%')
TEMPO = r'(\d+):(\d+):([\d.]+)'
FIM = re.compile(r'\[exited with code (-?\d+)\]')


def num(s):
    """'13,674' e '13.674' viram 13674 (separador de milhar)."""
    return int(re.sub(r'[.,]', '', s))


def seg(h, m, s):
    return int(h) * 3600 + int(m) * 60 + float(s)


def slug(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')


def prefixo(linha, ate):
    """Texto da linha antes do numero de progresso: vira o detalhe."""
    return linha[:ate].strip(' :,·-–|')[:40]


def limpa(l):
    return HORA.sub('', ANSI.sub('', l)).strip()


def ler(cauda, cabeca=''):
    """Fim do log -> {feito, total, unidade, detalhe}; total 0 = barra indeterminada. None se o log esta vazio."""
    linhas = [limpa(l) for l in re.split(r'[\r\n]+', cauda)]
    linhas = [l for l in linhas if l]
    if not linhas:
        return None

    hf = re.findall(r'@hf-progress (\{.*?\})', cauda)
    if hf:
        try:
            h = json.loads(hf[-1])
            return {'feito': float(h.get('pct', 0)), 'total': 100, 'unidade': '%',
                    'detalhe': f"{h.get('code', '')} {h.get('done')}/{h.get('total')}".strip()}
        except ValueError:
            pass

    rc = RCLONE.findall(cauda)
    if rc:
        a, ua, b, ub = rc[-1]
        gb = lambda v, u: round(float(v) * UNI[u.upper()] / 2**30, 3)
        return {'feito': gb(a, ua), 'total': gb(b, ub), 'unidade': 'GB', 'detalhe': ''}

    dur = re.search(r'Duration: ' + TEMPO, cabeca + cauda)
    t = re.findall(r'time=' + TEMPO, cauda)
    if dur and t and seg(*dur.groups()) > 0:
        pct = min(100.0, 100 * seg(*t[-1]) / seg(*dur.groups()))
        return {'feito': round(pct, 1), 'total': 100, 'unidade': '%', 'detalhe': ''}

    bl = re.findall(r'Sample (\d+)/(\d+)', cauda)
    if bl and int(bl[-1][1]) > 0:
        a, b = map(int, bl[-1])
        return {'feito': round(100 * a / b, 1), 'total': 100, 'unidade': '%', 'detalhe': f'amostra {a}/{b}'}

    for l in reversed(linhas):
        for m in XY.finditer(l):
            a, b, u = num(m.group(1)), num(m.group(2)), m.group(3)
            if b <= 0 or a > b or (not u and b < 100):
                continue
            p = PCT.search(l)
            ini = min(m.start(), p.start()) if p else m.start()
            return {'feito': a, 'total': b, 'unidade': u or '', 'detalhe': prefixo(l, ini)}
        p = PCT.search(l)
        if p:
            v = float(p.group(1).replace(',', '.'))
            if v <= 100:
                return {'feito': v, 'total': 100, 'unidade': '%', 'detalhe': prefixo(l, p.start())}

    return {'feito': 0, 'total': 0, 'unidade': '', 'detalhe': linhas[-1][:60]}


def pedaco(caminho, inicio, tamanho):
    with open(caminho, 'rb') as f:
        if inicio < 0:
            f.seek(max(0, os.path.getsize(caminho) - tamanho))
        return f.read(tamanho).decode('utf-8', 'ignore')


def escrevendo(caminho):
    """Algum processo ainda esta com o log aberto?"""
    try:
        r = subprocess.run(['lsof', '-t', '--', caminho], capture_output=True, text=True, timeout=10)
        return bool(r.stdout.strip())
    except Exception:
        return True


def grava(arq, d):
    os.makedirs(DIR, exist_ok=True)
    tmp = arq + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, arq)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--log', required=True)
    ap.add_argument('--nome', required=True)
    ap.add_argument('--espera', type=float, default=30)
    ap.add_argument('--intervalo', type=float, default=3)
    a = ap.parse_args()

    inicio = int(time.time() * 1000)
    arq = os.path.join(DIR, f"auto-{slug(a.nome)[:40]}-{hashlib.md5(a.log.encode()).hexdigest()[:4]}.json")

    def acabou():
        if not os.path.exists(a.log):
            return True
        return bool(FIM.search(pedaco(a.log, -1, CAUDA))) or not escrevendo(a.log)

    fim_espera = time.time() + a.espera
    while time.time() < fim_espera:
        if acabou():
            return
        time.sleep(min(a.intervalo, max(0.1, fim_espera - time.time())))

    ultimo, quietas = None, 0
    while True:
        if not os.path.exists(a.log):
            d = dict(ultimo or {'feito': 0, 'total': 0, 'unidade': ''}, detalhe='log sumiu')
            grava(arq, dict(d, nome=a.nome, inicio=inicio, atualizado=int(time.time() * 1000), fim=True))
            return
        cauda = pedaco(a.log, -1, CAUDA)
        r = ler(cauda, pedaco(a.log, 0, CABECA)) or {'feito': 0, 'total': 0, 'unidade': '', 'detalhe': 'começando'}
        ultimo = r
        m = FIM.search(cauda)
        quietas = 0 if escrevendo(a.log) else quietas + 1
        fim = bool(m) or quietas >= 2
        if fim:
            codigo = int(m.group(1)) if m else 0
            if codigo:
                r = dict(r, detalhe=f'erro (código {codigo})')
            elif r['total'] > 0:
                r = dict(r, feito=r['total'], detalhe='')
        grava(arq, dict(r, nome=a.nome, inicio=inicio, atualizado=int(time.time() * 1000), fim=fim))
        if fim:
            return
        time.sleep(a.intervalo)


if __name__ == '__main__':
    main()
