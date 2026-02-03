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

// MENU AJUDA ATUALIZADO
const MENU_AJUDA = `🤖 *Manual V12.4 (Completo)*

📸 *Visual:* Mande foto de recibos.
📝 *Registro:* "Gastei 50 padaria" ou Áudio.
📅 *Fixos:*
- "Cadastrar fixo Luz 200"
- "Lançar fixos" (todo mês)
📊 *Info:* "Gerar gráfico" ou "Resumo"
🆕 *Categorias:* Se não existir, eu sugiro criar.
🔔 *Avisos:* "Ativar lembretes"`;

// --- CRON JOBS ---
cron.schedule('40 09 * * 1-5', async () => {
    const usuarios = await sheets.getUsuariosAtivos();
    if (usuarios.length > 0) usuarios.forEach(num => sendMessage(num, "🥪 Hora do lanche! Se gastou, avise."));
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
                await sendMessage(from, "👁️ Analisando imagem...");
                ia = await analisarImagemComVision(message.image.id);
                if (!ia) await sendMessage(from, "❌ Não consegui ler.");
            } else if (message.type === 'audio') {
                textoParaIA = await transcreverAudio(message.audio.id);
            } else if (message.type === 'text') {
                textoParaIA = message.text.body;
            }

            // 2. FILTRO RÁPIDO (COMANDOS DIRETOS)
            if (textoParaIA && !ia) {
                const txt = textoParaIA.toLowerCase();
                
                // Gatilhos de Menu
                if (['ajuda', 'menu', 'o que voce faz', 'funciona'].some(g => txt.includes(g))) { 
                    await sendMessage(from, MENU_AJUDA); return res.sendStatus(200); 
                }
                
                // Gatilho de Lembrete
                if (txt.includes('ativar lembretes')) { 
                    await sendMessage(from, await sheets.inscreverUsuario(from)); return res.sendStatus(200); 
                }
                
                // 🚨 GATILHO RECUPERADO: LANÇAR FIXOS 🚨
                if (txt.includes('lancar fixos') || txt.includes('lançar fixos')) {
                    await sendMessage(from, "🔄 Processando gastos fixos...");
                    const relatorio = await sheets.lancarGastosFixos(from);
                    await sendMessage(from, relatorio);
                    return res.sendStatus(200);
                }

                // 3. SE NÃO FOR COMANDO DIRETO, VAI PARA IA
                const cats = await sheets.getCategoriasPermitidas();
                
                const prompt = `
                Input: "${textoParaIA}" | Data: ${getDataBrasilia()} | Categorias Atuais: [${cats}]

                REGRAS:
                1. Gasto encaixa na lista? -> REGISTRAR.
                2. Gasto NÃO encaixa (ex: "Ração" s/ ter "Pets") -> SUGERIR_CRIACAO.
                3. "Criar categoria X" -> CRIAR_CATEGORIA.
                4. "Cadastrar fixo X" -> CADASTRAR_FIXO.
                5. Outros -> CONSULTA ou CONVERSAR.

                SAÍDA JSON:
                1. {"acao": "REGISTRAR", "dados": {"data": "DD/MM/AAAA", "categoria": "Existente", "item": "Nome", "valor": "0.00", "tipo": "Saída"}}
                2. {"acao": "SUGERIR_CRIACAO", "dados": {"sugestao": "NomeNova", "item_original": "NomeGasto"}}
                3. {"acao": "CRIAR_CATEGORIA", "dados": {"nova_categoria": "Nome"}}
                4. {"acao": "CADASTRAR_FIXO", "dados": {"item": "Nome", "valor": "0.00", "categoria": "Uma das permitidas"}}
                5. {"acao": "CONSULTAR"}
                6. {"acao": "CONVERSAR", "resposta": "..."}
                `;
                
                const raw = await perguntarParaGroq(prompt);
                ia = limparEConverterJSON(raw);
            }

            // 4. EXECUÇÃO IA
            if (ia) {
                if (ia.acao === "REGISTRAR") {
                    const salvou = await sheets.adicionarNaPlanilha(ia.dados, from);
                    if (salvou) {
                        const alerta = await sheets.verificarMeta(ia.dados.categoria, ia.dados.valor, from);
                        await sendMessage(from, `✅ *Anotado!* \n📝 ${ia.dados.item}\n💸 R$ ${ia.dados.valor} (${ia.dados.categoria})${alerta}`);
                    }
                } 
                else if (ia.acao === "SUGERIR_CRIACAO") {
                    await sendMessage(from, `🤔 Sem categoria para *"${ia.dados.item_original}"*.\nSugiro criar: *${ia.dados.sugestao}*.\n\nConfirma? Responda: *"Criar categoria ${ia.dados.sugestao}"*`);
                }
                else if (ia.acao === "CRIAR_CATEGORIA") {
                    const criou = await sheets.criarNovaCategoria(ia.dados.nova_categoria);
                    if (criou) await sendMessage(from, `✨ Categoria *${ia.dados.nova_categoria}* criada! Pode usar.`);
                    else await sendMessage(from, `⚠️ Categoria *${ia.dados.nova_categoria}* já existe.`);
                }
                else if (ia.acao === "CADASTRAR_FIXO") {
                    await sheets.cadastrarNovoFixo(ia.dados);
                    await sendMessage(from, "📌 Fixo configurado!");
                } 
                else if (ia.acao === "CONSULTAR") {
                    if (textoParaIA && textoParaIA.toLowerCase().includes('grafico')) {
                        const url = await sheets.gerarGraficoPizza(from);
                        if (url) await sendMessage(from, "📊 *Seus Gastos:*", url);
                        else await sendMessage(from, "⚠️ Sem dados.");
                    } else {
                        const doc = await sheets.getDoc();
                        const sheetUser = await sheets.getSheetParaUsuario(from);
                        const rows = await sheetUser.getRows({limit:20});
                        let resumo = rows.map(r => `${r.get('Data')}: ${r.get('Item/Descrição')} - R$ ${r.get('Valor')}`).join('\n');
                        const resp = await perguntarParaGroq(`Dados: ${resumo}. Pergunta: "${textoParaIA || 'Resumo'}". Responda Zap.`);
                        await sendMessage(from, resp);
                    }
                } 
                else {
                    await sendMessage(from, ia.resposta || "Não entendi.");
                }
            }
        } catch (e) { console.error("Erro Controller:", e); }
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Servidor V12.4 (Restaurado) na porta ${PORT}`));