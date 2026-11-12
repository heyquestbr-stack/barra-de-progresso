#!/usr/bin/env python3
"""Roda um rclone e mostra o progresso na barra do mod barra-de-progresso.
Uso: progresso.py "<nome na barra>" rclone copy <origem> <destino> [opções...]
Vários ao mesmo tempo: cada nome vira uma barra. Roda solto do chat com nohup ... & disown."""
import json, os, re, subprocess, sys, time
nome, cmd = sys.argv[1], sys.argv[2:]
if not cmd or os.path.basename(cmd[0]) != "rclone":
    sys.exit("uso: progresso.py <nome> rclone ...")
DIR = os.path.expanduser("~/.claude/state/progresso")
PF = os.path.join(DIR, re.sub(r"[^a-z0-9]+", "-", nome.lower()).strip("-") + ".json")
GB = 1024**3
INICIO = int(time.time()*1000)
os.makedirs(DIR, exist_ok=True)
def save(feito, total, fim=False):
    json.dump({"nome": nome, "feito": feito/GB, "total": total/GB, "unidade": "GB", "inicio": INICIO,
               "atualizado": int(time.time()*1000), "fim": fim}, open(PF, "w"))
save(0, 0)
# ._* e .DS_Store: lixo do macOS em SSD exFAT, nunca sobe
p = subprocess.Popen(cmd + ["--exclude", "._*", "--exclude", ".DS_Store", "--use-json-log", "--stats", "5s", "--stats-log-level", "NOTICE", "-v"],
                     stderr=subprocess.PIPE, text=True)
feito = total = 0
for line in p.stderr:
    try: j = json.loads(line)
    except Exception: continue
    st = j.get("stats")
    if st:
        feito, total = st.get("bytes", 0), st.get("totalBytes", 0) or total
        save(feito, total)
    elif j.get("level") == "error":
        print(j.get("msg"), flush=True)
p.wait()
save(total if p.returncode == 0 else feito, total, fim=p.returncode == 0)
print("ok" if p.returncode == 0 else f"ERRO {p.returncode}")
sys.exit(p.returncode)
