import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agente_barra import achar, estado, marca_fim, passos  # noqa: E402

OUT = '/private/tmp/claude-501/proj/sess/tasks/a1b2c3d4e5.output'


def payload(**k):
    p = {'tool_input': {'run_in_background': True, 'description': 'revisar o PR'},
         'tool_response': {'isAsync': True, 'outputFile': OUT}}
    p.update(k)
    return p


class Achar(unittest.TestCase):
    def test_agente_em_segundo_plano(self):
        self.assertEqual(achar(payload()), (OUT, 'a1b2c3d4e5', 'Agente: revisar o PR'))

    def test_agente_em_primeiro_plano_nao_vira_barra(self):
        p = payload(tool_input={'description': 'x'}, tool_response={'result': 'ok'})
        self.assertIsNone(achar(p))

    def test_sem_caminho_no_retorno(self):
        self.assertIsNone(achar(payload(tool_response={'isAsync': True})))

    def test_sem_descricao_usa_o_tipo(self):
        p = payload(tool_input={'run_in_background': True, 'subagent_type': 'Explore'})
        self.assertEqual(achar(p)[2], 'Agente: Explore')


class Estado(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.arq = os.path.join(self.d.name, 'agente.jsonl')
        with open(self.arq, 'w') as f:
            f.write('{"type":"tool_use","id":"t1","name":"Read"}\n{"type": "tool_use", "id": "t2", "name": "Grep"}\n')
        self.marcas = os.path.join(self.d.name, 'fim')
        self.t = os.path.getmtime(self.arq)

    def tearDown(self):
        self.d.cleanup()

    def test_conta_passos_e_ultima_ferramenta(self):
        self.assertEqual(passos(self.arq), (2, 'Grep'))

    def test_rodando(self):
        e = estado('ag1', 'Agente: x', self.t - 5, self.arq, self.t + 10, self.marcas)
        self.assertFalse(e['fim'])
        self.assertEqual(e['detalhe'], '2 passos · Grep')

    def test_marca_de_fim_fecha_como_terminou(self):
        marca_fim({'agent_id': 'ag1'}, self.marcas)
        e = estado('ag1', 'Agente: x', self.t - 5, self.arq, self.t + 10, self.marcas)
        self.assertEqual((e['fim'], e['detalhe']), (True, 'terminou'))

    def test_marca_de_outro_agente_nao_fecha(self):
        marca_fim({'agent_id': 'outro'}, self.marcas)
        self.assertFalse(estado('ag1', 'x', self.t - 5, self.arq, self.t + 10, self.marcas)['fim'])

    def test_20_min_parado_fecha_sem_resposta(self):
        e = estado('ag1', 'x', self.t - 5, self.arq, self.t + 20 * 60 + 1, self.marcas)
        self.assertEqual((e['fim'], e['detalhe']), (True, 'parou sem resposta'))

    def test_arquivo_ainda_nao_nasceu_espera(self):
        nada = os.path.join(self.d.name, 'nao-existe')
        self.assertFalse(estado('ag1', 'x', 1000, nada, 1060, self.marcas)['fim'])   # 1 min: espera
        self.assertTrue(estado('ag1', 'x', 1000, nada, 1121, self.marcas)['fim'])    # 2 min: desiste

    def test_marca_ignora_id_estranho(self):
        marca_fim({'agent_id': '../../x'}, self.marcas)
        self.assertFalse(os.path.exists(self.marcas))


if __name__ == '__main__':
    unittest.main()
