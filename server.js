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

// 🎨 MENU BONITO E FORMATADO
const MENU_AJUDA = `👋 *Olá! Sou seu Assistente Financeiro.*

Estou aqui para organizar seu dinheiro de forma simples. Veja o que posso fazer:

📝 *1. Registrar Gastos*
Envie texto, áudio ou foto.
_"Gastei 150 no mercado"_
_"Recebi 500 de pix"_

🔄 *2. Contas Fixas*
Organize seus boletos mensais.
_"Cadastrar fixo Aluguel 1200"_
_"Lançar fixos"_ (para confirmar no mês)

📂 *3. Categorias Inteligentes*
Eu organizo tudo. Se a categoria não existir, eu crio para você.

📊 *4. Consultas*
_"Gerar gráfico"_ ou _"Resumo do mês"_

🔔 *Dica:* Digite _"Ativar lembretes"_ para eu te avisar todo dia.

Como quer começar?`;

// CRON JOB
cron.schedule('40 09 * * 1-5', async () => {
    const usuarios = await sheets.getUsuariosAtivos();
    if (usuarios.length > 0) usuarios.forEach(num => sendMessage(num, "☀️ *Bom dia!*\n\nLembrete rápido: teve algum gasto ontem ou hoje? Registre agora para manter o controle em dia."));
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

            // --- 🆕 BOAS-VINDAS PARA NOVATOS ---
            const isNovo = await sheets.verificarUsuarioNovo(from);
            if (isNovo) {
                // Se é novo, cria a aba dele (silenciosamente) e manda o menu
                await sheets.getSheetParaUsuario(from); 
                await sendMessage(from, MENU_AJUDA);
                return res.sendStatus(200);
            }

            // INPUTS
            if (message.type === 'image') {
                await sendMessage(from, "📸 *Imagem recebida!* Processando...");
                ia = await analisarImagemComVision(message.image.id);
                if (!ia) await sendMessage(from, "⚠️ Não consegui ler a imagem. Tente uma foto mais clara.");
            } else if (message.type === 'audio') {
                textoParaIA = await transcreverAudio(message.audio.id);
            } else if (message.type === 'text') {
                textoParaIA = message.text.body;
            }

            if (textoParaIA && !ia) {
                const txt = textoParaIA.toLowerCase();
                const gatilhos = ['ajuda', 'menu', 'o que voce faz', 'funciona', 'funcoes', 'funções', 'ola', 'oi', 'comecar'];
                
                if (gatilhos.some(g => txt.includes(g))) { 
                    await sendMessage(from, MENU_AJUDA); return res.sendStatus(200); 
                }
                
                if (txt.includes('ativar lembretes')) { 
                    await sendMessage(from, await sheets.inscreverUsuario(from)); return res.sendStatus(200); 
                }
                
                if (txt.includes('lancar fixos') || txt.includes('lançar fixos')) {
                    await sendMessage(from, "🔄 *Processando fixos...*");
                    const relatorio = await sheets.lancarGastosFixos(from);
                    await sendMessage(from, relatorio);
                    return res.sendStatus(200);
                }

                const cats = await sheets.getCategoriasPermitidas();
                
                const prompt = `
                Input: "${textoParaIA}" | Data: ${getDataBrasilia()} | Categorias: [${cats}]
                
                JSON:
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

            if (ia) {
                if (ia.acao === "REGISTRAR") {
                    const salvou = await sheets.adicionarNaPlanilha(ia.dados, from);
                    if (salvou) {
                        const alerta = await sheets.verificarMeta(ia.dados.categoria, ia.dados.valor, from);
                        await sendMessage(from, `✅ *Anotado!*\n\n📝 *${ia.dados.item}*\n💰 R$ ${ia.dados.valor}\n📂 ${ia.dados.categoria}${alerta}`);
                    }
                } 
                else if (ia.acao === "SUGERIR_CRIACAO") {
                    await sendMessage(from, `🤔 Sem categoria para *"${ia.dados.item_original}"*.\n\nSugiro criar: *${ia.dados.sugestao}*.\n\nPara aceitar, responda: "Criar categoria ${ia.dados.sugestao}"`);
                }
                else if (ia.acao === "CRIAR_CATEGORIA") {
                    const criou = await sheets.criarNovaCategoria(ia.dados.nova_categoria);
                    if (criou) await sendMessage(from, `✨ Categoria *${ia.dados.nova_categoria}* criada com sucesso!`);
                    else await sendMessage(from, `⚠️ A categoria *${ia.dados.nova_categoria}* já existe.`);
                }
                else if (ia.acao === "CADASTRAR_FIXO") {
                    await sheets.cadastrarNovoFixo(ia.dados);
                    await sendMessage(from, `📌 *Fixo Configurado!*\n\nItem: ${ia.dados.item}\nValor: R$ ${ia.dados.valor}\n\nLembre de usar "Lançar fixos" mensalmente.`);
                } 
                else if (ia.acao === "CONSULTAR") {
                    if (textoParaIA && textoParaIA.toLowerCase().includes('grafico')) {
                        const url = await sheets.gerarGraficoPizza(from);
                        if (url) await sendMessage(from, "📊 *Sua Análise:*", url);
                        else await sendMessage(from, "📉 Sem dados suficientes.");
                    } else {
                        const doc = await sheets.getDoc();
                        const sheetUser = await sheets.getSheetParaUsuario(from);
                        const rows = await sheetUser.getRows({limit:20});
                        let resumo = rows.map(r => `${r.get('Data')}: ${r.get('Item/Descrição')} - R$ ${r.get('Valor')}`).join('\n');
                        const resp = await perguntarParaGroq(`Dados:\n${resumo}\n\nPergunta: "${textoParaIA || 'Resumo'}". Responda de forma analítica e bonita.`);
                        await sendMessage(from, resp);
                    }
                } 
                else {
                    await sendMessage(from, ia.resposta || "Desculpe, não entendi.");
                }
            }
        } catch (e) { console.error("Erro Controller:", e); }
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Servidor V13.0 (Polido) na porta ${PORT}`));