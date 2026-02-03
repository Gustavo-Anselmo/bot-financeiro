// server.js (Raiz do projeto)
const express = require('express');
const cron = require('node-cron');
const { getDataBrasilia, limparEConverterJSON } = require('./src/utils');
const { sendMessage, markMessageAsRead } = require('./src/services/whatsapp');
const { perguntarParaGroq, transcreverAudio, analisarImagemComVision } = require('./src/services/ai');
const sheets = require('./src/services/sheets'); // Importa TUDO de sheets
require('dotenv').config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const MY_TOKEN = process.env.MY_TOKEN;

const MENU_AJUDA = `🤖 *Manual V12.1 Modular*
📸 Mande foto de recibo.
📊 Digite "Gerar gráfico".
🔔 Digite "Ativar lembretes".
📝 Digite gastos ou áudio.`;

// --- CRON JOBS (DESPERTADOR) ---
cron.schedule('40 09 * * 1-5', async () => {
    const usuarios = await sheets.getUsuariosAtivos();
    usuarios.forEach(num => sendMessage(num, "🥪 Hora do lanche! Se gastou, avise."));
}, { scheduled: true, timezone: "America/Sao_Paulo" });

// --- WEBHOOK ---
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
                const json = await analisarImagemComVision(message.image.id);
                if (json) ia = json;
                else await sendMessage(from, "❌ Não entendi a imagem.");
            } else if (message.type === 'audio') {
                textoParaIA = await transcreverAudio(message.audio.id);
            } else if (message.type === 'text') {
                textoParaIA = message.text.body;
            }

            // 2. PROCESSAMENTO
            if (textoParaIA && !ia) {
                const txt = textoParaIA.toLowerCase();
                
                if (txt.includes('ajuda') || txt.includes('menu')) {
                    await sendMessage(from, MENU_AJUDA);
                    return res.sendStatus(200);
                }
                if (txt.includes('ativar lembretes')) { 
                    await sendMessage(from, await sheets.inscreverUsuario(from)); 
                    return res.sendStatus(200); 
                }

                const cats = await sheets.getCategoriasPermitidas();
                const prompt = `Entrada: "${textoParaIA}". Data: ${getDataBrasilia()}. Categorias: [${cats}].
                Classifique JSON:
                1. REGISTRAR: {"acao": "REGISTRAR", "dados": {"data": "DD/MM/AAAA", "categoria": "Uma das permitidas", "item": "Nome", "valor": "0.00", "tipo": "Saída"}}
                2. CADASTRAR FIXO: {"acao": "CADASTRAR_FIXO", "dados": {"item": "Nome", "valor": "0.00", "categoria": "Uma das permitidas"}}
                3. CONSULTA (Se pedir GRÁFICO, use esta): {"acao": "CONSULTAR"}
                4. CONVERSA: {"acao": "CONVERSAR", "resposta": "..."}`;
                
                const raw = await perguntarParaGroq(prompt);
                ia = limparEConverterJSON(raw);
            }

            // 3. AÇÃO FINAL
            if (ia) {
                if (ia.acao === "REGISTRAR") {
                    const salvou = await sheets.adicionarNaPlanilha(ia.dados, from);
                    if (salvou) {
                        const alerta = await sheets.verificarMeta(ia.dados.categoria, ia.dados.valor, from);
                        await sendMessage(from, `✅ *Anotado!* \n📝 ${ia.dados.item}\n💸 R$ ${ia.dados.valor} (${ia.dados.categoria})${alerta}`);
                    }
                } else if (ia.acao === "CADASTRAR_FIXO") {
                    await sheets.cadastrarNovoFixo(ia.dados);
                    await sendMessage(from, "📌 Fixo configurado!");
                } else if (ia.acao === "CONSULTAR") {
                    if (textoParaIA && (textoParaIA.toLowerCase().includes('grafico') || textoParaIA.toLowerCase().includes('gráfico'))) {
                        const url = await sheets.gerarGraficoPizza(from);
                        if (url) await sendMessage(from, "Seus gastos:", url);
                        else await sendMessage(from, "⚠️ Sem dados para gráfico.");
                    } else {
                        const doc = await sheets.getDoc();
                        const sheetUser = await sheets.getSheetParaUsuario(from);
                        const rows = await sheetUser.getRows({limit:20});
                        let resumo = rows.map(r => `${r.get('Data')}: ${r.get('Item/Descrição')} - R$ ${r.get('Valor')}`).join('\n');
                        const resp = await perguntarParaGroq(`Dados: ${resumo}. Pergunta: "${textoParaIA || 'Resumo'}". Responda Zap.`);
                        await sendMessage(from, resp);
                    }
                } else {
                    await sendMessage(from, ia.resposta || "Ok!");
                }
            }
        } catch (e) { console.error("Erro Controller:", e); }
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Servidor Modular V12.1 Rodando na porta ${PORT}`));