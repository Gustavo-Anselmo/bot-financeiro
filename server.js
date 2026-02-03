// server.js
const express = require('express');
const cron = require('node-cron');
const { getDataBrasilia, limparEConverterJSON } = require('./src/utils');
const { sendMessage, markMessageAsRead } = require('./src/services/whatsapp');
const { perguntarParaGroq, transcreverAudio, analisarImagemComVision } = require('./src/services/ai');
const sheets = require('./src/services/sheets'); 
require('dotenv').config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const MY_TOKEN = process.env.MY_TOKEN;

// MENU PROFISSIONAL
const MENU_AJUDA = `Olá. Sou seu Assistente Financeiro.
Abaixo, listo os comandos disponíveis para auxiliá-lo:

*1. Registro de Despesas*
Envie textos, áudios ou fotos de recibos.
Ex: "Gastei 150 em mercado"

*2. Gestão de Contas Fixas*
Configure despesas recorrentes.
Ex: "Cadastrar fixo Aluguel 1200"
Mensalmente, envie: "Lançar fixos"

*3. Categorias*
Gerencio suas categorias automaticamente. Caso informe uma inexistente, sugerirei a criação.

*4. Consultas e Alertas*
Solicite: "Gerar gráfico" ou "Resumo do mês".
Configure avisos: "Ativar lembretes".

Como posso prosseguir?`;

// --- CRON JOBS ---
cron.schedule('40 09 * * 1-5', async () => {
    const usuarios = await sheets.getUsuariosAtivos();
    if (usuarios.length > 0) usuarios.forEach(num => sendMessage(num, "Bom dia.\n\nLembrete diário: por favor, registre seus gastos recentes para manter o controle financeiro atualizado."));
}, { scheduled: true, timezone: "America/Sao_Paulo" });

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === MY_TOKEN) res.status(200).send(req.query['hub.challenge']);
    else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        const message = body.entry[0].changes[0].value.messages[0];
        const from = message.from;

        try {
            await markMessageAsRead(message.id);
            let textoParaIA = null;
            let ia = null;

            // 1. INPUTS
            if (message.type === 'image') {
                await sendMessage(from, "Imagem recebida. Analisando dados...");
                ia = await analisarImagemComVision(message.image.id);
                if (!ia) await sendMessage(from, "Não foi possível extrair dados da imagem. Tente uma foto mais clara.");
            } else if (message.type === 'audio') {
                textoParaIA = await transcreverAudio(message.audio.id);
            } else if (message.type === 'text') {
                textoParaIA = message.text.body;
            }

            // 2. FILTRO DE TEXTO
            if (textoParaIA && !ia) {
                const txt = textoParaIA.toLowerCase();
                
                // Menu e Ajuda
                if (['ajuda', 'menu', 'o que voce faz', 'funciona', 'funcoes'].some(g => txt.includes(g))) { 
                    await sendMessage(from, MENU_AJUDA); return res.sendStatus(200); 
                }
                
                // Lembretes
                if (txt.includes('ativar lembretes')) { 
                    await sendMessage(from, await sheets.inscreverUsuario(from)); return res.sendStatus(200); 
                }
                
                // ✅ GATILHO DE FIXOS CONFIRMADO
                if (txt.includes('lancar fixos') || txt.includes('lançar fixos')) {
                    await sendMessage(from, "Processando lançamentos fixos...");
                    const relatorio = await sheets.lancarGastosFixos(from);
                    await sendMessage(from, relatorio);
                    return res.sendStatus(200);
                }

                // Inteligência Artificial
                const cats = await sheets.getCategoriasPermitidas();
                
                const prompt = `
                Input: "${textoParaIA}" | Data: ${getDataBrasilia()} | Categorias: [${cats}]
                
                DIRETRIZES:
                - Identifique a ação correta.
                - Se gasto não tem categoria, SUGERIR_CRIACAO.
                - Se pergunta, responda profissionalmente.

                JSON SAÍDA:
                {"acao": "REGISTRAR", "dados": {"data": "DD/MM/AAAA", "categoria": "Existente", "item": "Nome", "valor": "0.00", "tipo": "Saída"}}
                {"acao": "SUGERIR_CRIACAO", "dados": {"sugestao": "NomeNova", "item_original": "NomeGasto"}}
                {"acao": "CRIAR_CATEGORIA", "dados": {"nova_categoria": "Nome"}}
                {"acao": "CADASTRAR_FIXO", "dados": {"item": "Nome", "valor": "0.00", "categoria": "Uma das permitidas"}}
                {"acao": "CONSULTAR"}
                {"acao": "CONVERSAR", "resposta": "..."}
                `;
                
                const raw = await perguntarParaGroq(prompt);
                ia = limparEConverterJSON(raw);
            }

            // 3. EXECUÇÃO
            if (ia) {
                if (ia.acao === "REGISTRAR") {
                    const salvou = await sheets.adicionarNaPlanilha(ia.dados, from);
                    if (salvou) {
                        const alerta = await sheets.verificarMeta(ia.dados.categoria, ia.dados.valor, from);
                        // Feedback Limpo
                        await sendMessage(from, `Registro confirmado.\n\n*${ia.dados.item}*\nValor: R$ ${ia.dados.valor}\nCategoria: ${ia.dados.categoria}${alerta}`);
                    }
                } 
                else if (ia.acao === "SUGERIR_CRIACAO") {
                    await sendMessage(from, `O item *"${ia.dados.item_original}"* não corresponde às categorias atuais.\n\nSugiro criar a categoria: *${ia.dados.sugestao}*.\n\nPara prosseguir, responda: "Criar categoria ${ia.dados.sugestao}"`);
                }
                else if (ia.acao === "CRIAR_CATEGORIA") {
                    const criou = await sheets.criarNovaCategoria(ia.dados.nova_categoria);
                    if (criou) await sendMessage(from, `Categoria *${ia.dados.nova_categoria}* criada com sucesso.`);
                    else await sendMessage(from, `A categoria *${ia.dados.nova_categoria}* já existe no sistema.`);
                }
                else if (ia.acao === "CADASTRAR_FIXO") {
                    await sheets.cadastrarNovoFixo(ia.dados);
                    await sendMessage(from, "Despesa fixa configurada com sucesso.");
                } 
                else if (ia.acao === "CONSULTAR") {
                    if (textoParaIA && textoParaIA.toLowerCase().includes('grafico')) {
                        const url = await sheets.gerarGraficoPizza(from);
                        if (url) await sendMessage(from, "Segue a análise gráfica dos seus gastos:", url);
                        else await sendMessage(from, "Dados insuficientes para geração de gráfico neste período.");
                    } else {
                        const doc = await sheets.getDoc();
                        const sheetUser = await sheets.getSheetParaUsuario(from);
                        const rows = await sheetUser.getRows({limit:20});
                        let resumo = rows.map(r => `${r.get('Data')}: ${r.get('Item/Descrição')} - R$ ${r.get('Valor')}`).join('\n');
                        const resp = await perguntarParaGroq(`Dados financeiros:\n${resumo}\n\nPergunta do usuário: "${textoParaIA || 'Resumo'}". Responda de forma analítica e clara.`);
                        await sendMessage(from, resp);
                    }
                } 
                else {
                    await sendMessage(from, ia.resposta || "Não compreendi sua solicitação. Poderia detalhar?");
                }
            }
        } catch (e) { console.error("Erro Controller:", e); }
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Servidor V12.5 (Auditado) na porta ${PORT}`));