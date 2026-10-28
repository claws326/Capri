---
name: screen-actions
description: Opera o computador do usuário (abrir e focar programas, pesquisar na web, ver a tela, ler texto por OCR, clicar, arrastar, rolar, digitar e pressionar teclas) pelas ferramentas MCP de tela. Ative quando o pedido for uma ação no computador ou perguntar o que está na tela; não ative para escrever, explicar ou responder perguntas gerais.
---

# Operação de tela (ciclo Percepção → Ação → Observação)

Este guia é carregado automaticamente quando o pedido exige ferramentas de tela. As coordenadas de todas as ferramentas usam o **espaço da imagem** do `capture_screen` (tela reduzida para no máximo 1280 px de largura); o servidor já converte para pixels reais, então não faça contas de escala. Cada captura informa um `view_id`; passe-o em `mouse_click`, `scroll` e `drag` para garantir que as coordenadas pertencem à imagem mais recente (se vier "view_id obsoleto", capture de novo). Sem captura prévia, cliques são recusados.

## 1. Escolha o caminho mais curto (do mais confiável ao menos)

1. **Ferramenta direta**, sem mouse: `launch_app` (abrir programa), `open_url` (site ou pesquisa), `focus_window` (trazer app aberto para a frente), `list_windows` (saber se algo está aberto).
2. **Teclado**: `press_key` (atalhos e navegação) e `keyboard_type` (texto).
3. **Mouse**: `mouse_click`, `drag`, `scroll`, somente depois de ver a tela.

Nunca clique no Menu Iniciar para abrir um programa nem digite na barra de endereço para pesquisar.

## 2. Ciclo de trabalho

1. **Pré-checagem** (só se for usar mouse): `get_screen_info` informa o espaço de coordenadas e onde o mouse está.
2. **Percepção**: `capture_screen`. Para um app pequeno (Calculadora, diálogos) use `active_window: true`, que recorta e amplia só a janela em primeiro plano; para outros detalhes use `region` (`[x, y, largura, altura]`); para texto exato use `read_screen_text`. Depois de `launch_app` espere o app aparecer (`focus_window`) antes de capturar.
3. **Ação**: uma ação por vez. Clique no **centro** do alvo, nunca nas bordas.
4. **Observação**: toda ação já devolve `Janela ativa agora: "..."`. Compare com o esperado. Se o título não mudou como previsto, olhe a tela (`capture_screen`) antes de continuar. No modo feedback o app também anexa um print novo e avisa quando a tela não mudou.
5. **Conclusão**: relate só o que o resultado das ferramentas confirmou.

## 3. Teclado primeiro

* Campo com texto: `keyboard_type` com `replace: true` (seleciona tudo antes) em vez de apagar à mão; `press_enter: true` envia depois.
* Rolar: `scroll` (`notches` positivo = para baixo; `x`,`y` opcionais para posicionar o mouse). Alternativas: `{PGDN}`, `{PGUP}`.
* `press_key` usa sintaxe SendKeys: `{ENTER}`, `{TAB}`, `{ESC}`, `{DOWN}`, `^c` (Ctrl+C), `^v`, `^a`, `%{F4}` (Alt+F4), `%{TAB}` (Alt+Tab), `^{ESC}` (Menu Iniciar).
* Arrastar janelas, arquivos ou barras: `drag` com origem e destino.

## 4. Falhas e recuperação

* **Clique sem efeito**: recapture (a janela pode ter se movido ou haver um diálogo na frente), recalcule o centro e tente o atalho de teclado equivalente.
* **Janela não veio para a frente**: `list_windows` com `filter`; se existir, `focus_window`; se não existir, `launch_app`.
* **Mesma ação falhou duas vezes seguidas**: pare e diga ao usuário o que tentou e o que viu; não repita uma terceira vez (o app também interrompe repetições idênticas).
* **Texto digitado errado**: use `keyboard_type` com `replace: true` e o texto inteiro de uma vez.
* **Imagem sem o detalhe necessário**: use `region` (zoom) ou `read_screen_text`.
* Apenas o **monitor principal** é capturado e controlado.
* Limite de 60 segundos por pedido: seja objetiva e diga o que ficou pendente.

## 5. Dados sensíveis

* Se a tela mostrar senha, chave privada ou token, não os transcreva na resposta.
* Ao chegar numa tela de login/UAC pedindo credenciais, pare e avise o usuário.

## 6. Base de conhecimento

* Notas do usuário: arquivos `.md` e `.txt` em `%APPDATA%\capri\knowledge`.
* `search_knowledge` busca nessas notas e nos guias de `skills/`; responda só com o que encontrar e cite o arquivo.
