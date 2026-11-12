import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acompanha import ler, slug  # noqa: E402
from acompanha_hook import achar  # noqa: E402


class Ler(unittest.TestCase):
    def test_nxnative_build(self):
        r = ler('[03:55:43] [4/6] Mac shaders · compiling: 35%, 15,068/42,854 shaders, 29,045 not cached, 8:27 · ETA 43:36\n')
        self.assertEqual((r['feito'], r['total'], r['unidade']), (15068, 42854, 'shaders'))
        self.assertEqual(r['detalhe'], '[4/6] Mac shaders · compiling')

    def test_milhar_com_ponto(self):
        r = ler('copiando 1.234/5.000 arquivos\n')
        self.assertEqual((r['feito'], r['total'], r['unidade']), (1234, 5000, 'arquivos'))

    def test_colchete_e_data_ignorados(self):
        r = ler('[2/5] baixando em 11/12\n')
        self.assertEqual(r['total'], 0)

    def test_so_porcentagem(self):
        r = ler('lixo\nrender 47% pronto\n')
        self.assertEqual((r['feito'], r['total'], r['unidade']), (47.0, 100, '%'))
        self.assertEqual(r['detalhe'], 'render')

    def test_ultima_linha_com_numero_vence(self):
        r = ler('etapa 10%\netapa 20%\nlinha sem nada\n')
        self.assertEqual(r['feito'], 20.0)

    def test_carriage_return(self):
        r = ler('baixando 10%\rbaixando 55%\rbaixando 80%')
        self.assertEqual(r['feito'], 80.0)

    def test_rclone(self):
        r = ler('Transferred:   \t    1.500 GiB / 6 GiB, 25%, 40 MiB/s, ETA 2m\n')
        self.assertEqual((r['feito'], r['total'], r['unidade']), (1.5, 6.0, 'GB'))

    def test_rclone_mib(self):
        r = ler('Transferred:   512 MiB / 1 GiB, 50%, 10 MiB/s, ETA 1m\n')
        self.assertEqual((r['feito'], r['total']), (0.5, 1.0))

    def test_ffmpeg(self):
        cabeca = '  Duration: 00:01:40.00, start: 0.000000, bitrate: 900 kb/s\n'
        r = ler('frame= 100 fps=30 q=28.0 size= 1024kB time=00:00:25.00 bitrate=335.5kbits/s speed=1x\r', cabeca)
        self.assertEqual((r['feito'], r['total'], r['unidade']), (25.0, 100, '%'))

    def test_hyperframes(self):
        r = ler('@hf-progress {"code":"capture","done":30,"total":120,"pct":25}\n')
        self.assertEqual((r['feito'], r['total']), (25.0, 100))
        self.assertEqual(r['detalhe'], 'capture 30/120')

    def test_blender(self):
        r = ler('Fra:1 Mem:120M | Scene | Sample 32/128\n')
        self.assertEqual((r['feito'], r['total']), (25.0, 100))

    def test_sem_numero_fica_indeterminada(self):
        r = ler('[01:00:00] preparando a cena com um texto bem comprido que passa de sessenta caracteres fácil\n')
        self.assertEqual(r['total'], 0)
        self.assertTrue(r['detalhe'].startswith('preparando a cena'))
        self.assertLessEqual(len(r['detalhe']), 60)

    def test_vazio(self):
        self.assertIsNone(ler(''))

    def test_slug(self):
        self.assertEqual(slug('Copia o cache pro Mac!'), 'copia-o-cache-pro-mac')
        self.assertEqual(slug('Barra automática'), 'barra-automatica')


def payload(cmd, resp, bg=True, desc='Copia o cache'):
    return {'tool_name': 'Bash', 'cwd': '/w',
            'tool_input': {'command': cmd, 'description': desc, 'run_in_background': bg},
            'tool_response': resp}


SAIDA = {'stdout': '', 'backgroundTaskId': 'abc123',
         'note': 'Output is being written to: /private/tmp/claude-501/x/tasks/abc123.output'}


class Achar(unittest.TestCase):
    def test_segundo_plano(self):
        self.assertEqual(achar(payload('rsync -a a b', SAIDA)),
                         ('/private/tmp/claude-501/x/tasks/abc123.output', 'Copia o cache'))

    def test_movido_pro_segundo_plano(self):
        resp = {'stdout': 'Command did not complete within its 120s timeout and was moved to the background (ID: z9). '
                          'Output is being written to: /tmp/s/tasks/z9.output.'}
        self.assertEqual(achar(payload('make', resp, bg=False))[0], '/tmp/s/tasks/z9.output')

    def test_nohup_com_log(self):
        self.assertEqual(achar(payload('nohup ./build.sh > logs/b.log 2>&1 &', {'stdout': ''}, bg=False))[0], '/w/logs/b.log')

    def test_nohup_dev_null(self):
        self.assertIsNone(achar(payload('nohup ./x.sh >/dev/null 2>&1 &', {'stdout': ''}, bg=False)))

    def test_comando_comum(self):
        self.assertIsNone(achar(payload('ls', {'stdout': 'a'}, bg=False)))

    def test_sem_barra(self):
        self.assertIsNone(achar(payload('rsync a b # sem-barra', SAIDA)))

    def test_ja_tem_barra_propria(self):
        for c in ['~/.claude/scripts/progresso.py "x" rclone copy a b', 'blender-com-barra.py x', 'copia-rapida.sh x a b',
                  'echo 1 > ~/.claude/state/progresso/x.json']:
            self.assertIsNone(achar(payload(c, SAIDA)), c)

    def test_pasta_com_progresso_no_nome_nao_pula(self):
        self.assertIsNotNone(achar(payload('cd ~/orca-progresso && make', SAIDA)))

    def test_id_da_tarefa_e_scratchpad(self):
        p = payload('rsync a b', {'stdout': '', 'backgroundTaskId': 'bn1'})
        p['scratchpad_dir'] = '/private/tmp/claude-501/-W-/sess/scratchpad'
        self.assertEqual(achar(p)[0], '/private/tmp/claude-501/-W-/sess/tasks/bn1.output')

    def test_sem_descricao_usa_comando(self):
        self.assertEqual(achar(payload('rsync -a a b', SAIDA, desc=''))[1], 'rsync -a a b')


if __name__ == '__main__':
    unittest.main()
