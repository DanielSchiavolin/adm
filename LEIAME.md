# Front Security — ADM · Controle de Gastos

App: https://danielschiavolin.github.io/adm/

Controle de gastos administrativos por posto (QTH) e categoria. Dados em `/adm` do mesmo Firebase
dos apps Coberturas e Pagamentos (`front-security-coberturas`), com a mesma senha da equipe.

## Como usar
- **➕ (botão laranja)**: novo gasto. Data, valor, categoria (toque no chip), QTH, descrição, responsável,
  observação e foto do comprovante (é comprimida antes de enviar).
  - **3/6 – Dobra**: aparece o funcionário que dobrou e a data da dobra.
  - **Manutenção / Preventivos**: aparece o subtipo (chaves, cadeados, guarita, alarmes, refletores...).
  - **Perdas – furtos**: status pendente/ressarcido, valor e data do ressarcimento.
  - O app lembra o último QTH, categoria e responsável usados, para lançar mais rápido.
- **📊 Dashboard**: total do mês, comparação com o mês anterior, total por categoria e por QTH, gráficos
  e a lista de perdas pendentes de ressarcimento (de todos os meses).
- **🧾 Lançamentos**: filtros por período, QTH e categoria, busca, editar, excluir e **Exportar Excel (CSV)**.
- **🖨️ Relatório**: fechamento do mês por QTH, por categoria, QTH × categoria, perdas e lista detalhada.
  "Imprimir / Salvar PDF" → no celular escolha "Salvar como PDF".
- **⚙️ Config.**: postos, funcionários, categorias (nome, cor, subtipos) e backup JSON (exportar/importar).

## Sem internet
O lançamento fica guardado no aparelho (⏳ no topo mostra quantos faltam enviar) e é enviado sozinho
quando a internet voltar. Lançamentos ainda não enviados aparecem com borda tracejada.

## Regras do Firebase (obrigatório uma vez)
Cole `Documentos\seguranca-firebase\regras-coberturas.json` (já com o nó `adm`) em
https://console.firebase.google.com/project/front-security-coberturas/database/front-security-coberturas-default-rtdb/rules
→ **Publicar**. Sem isso o banco recusa os gastos.

## Publicar uma versão nova
Aumente `APP_VERSION` (app.js) e `version.json` com o mesmo valor; os apps abertos se atualizam sozinhos.
